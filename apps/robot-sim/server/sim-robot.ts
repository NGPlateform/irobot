import type { ActionEvent, ActionEnvelope } from "@irobot/action-protocol";

export interface Pose {
  x: number;
  y: number;
  heading: number; // 弧度
}

export interface Telemetry {
  pose: Pose;
  battery: number; // 0..100
  estop: boolean;
  localizationHealthy: boolean;
  stateVersion: number;
  activeCommandId: string | null;
  charging: boolean;
  stations: Record<string, { x: number; y: number }>;
  dock: { x: number; y: number };
  restrictedZone: { x: number; y: number; label: string };
}

interface ActiveMotion {
  commandId: string;
  capabilityId: string;
  goal: { x: number; y: number };
  speed: number;
  distanceTotal: number;
  distanceDone: number;
  lastFeedbackAt: number;
  seq: number;
  cancelled: boolean;
  emit: (ev: ActionEvent) => void;
  resolve: (ev: ActionEvent) => void;
}

const nowIso = () => new Date().toISOString();

/**
 * 仿真低速移动机器人。持有权威物理状态，按固定步长推进，向 SSE 推送遥测，
 * 执行导航动作并流式发出 ActionEvent。急停与取消即时生效。base_motion 单写。
 *
 * 这是架构里 Edge Runtime + 设备物理的合并仿真：它是设备状态的权威来源
 * （架构 §7 数据分类：设备状态只能来自设备/数字孪生）。
 */
export class SimRobot {
  private pose: Pose = { x: 1, y: 1, heading: 0 };
  private battery = 82;
  private estop = false;
  private localizationHealthy = true;
  private stateVersion = 1;
  private charging = false;
  private active: ActiveMotion | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly stations: Record<string, { x: number; y: number }> = {
    一号站点: { x: 8, y: 1.5 },
    二号站点: { x: 8, y: 6 },
    大厅: { x: 4.5, y: 6.5 },
  };
  readonly dock = { x: 1, y: 1 };
  readonly restrictedZone = { x: 6, y: 3, label: "危险区" };

  constructor(private onTelemetry: (t: Telemetry) => void) {}

  start(dtMs = 50): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(dtMs / 1000), dtMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  telemetry(): Telemetry {
    return {
      pose: { ...this.pose },
      battery: Math.round(this.battery * 10) / 10,
      estop: this.estop,
      localizationHealthy: this.localizationHealthy,
      stateVersion: this.stateVersion,
      activeCommandId: this.active?.commandId ?? null,
      charging: this.charging,
      stations: this.stations,
      dock: this.dock,
      restrictedZone: this.restrictedZone,
    };
  }

  /** 只读状态快照，供 Orchestrator 计算前置条件（不暴露给模型推测）。 */
  stateSnapshot(): Record<string, number | boolean> {
    return {
      "safety.estop": this.estop,
      "localization.healthy": this.localizationHealthy,
      "battery.percent": this.battery,
    };
  }

  /** 硬件急停/解除。独立于命令链路（架构安全不变量 §4.1 第 3 条）。 */
  setEstop(on: boolean): void {
    this.estop = on;
    this.bump();
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  activeCommandId(): string | null {
    return this.active?.commandId ?? null;
  }

  /** 请求取消当前动作（Orchestrator 侧收到 cancel/abort 后调用）。 */
  requestCancel(commandId: string): boolean {
    if (this.active && this.active.commandId === commandId) {
      this.active.cancelled = true;
      return true;
    }
    return false;
  }

  /** 同步查询能力（S0）。 */
  runQuery(capabilityId: string): Record<string, unknown> {
    if (capabilityId === "robot.telemetry.query_battery") {
      return { percent: Math.round(this.battery * 10) / 10 };
    }
    if (capabilityId === "robot.telemetry.query_pose") {
      return {
        x: Math.round(this.pose.x * 100) / 100,
        y: Math.round(this.pose.y * 100) / 100,
        heading: Math.round(this.pose.heading * 100) / 100,
      };
    }
    return {};
  }

  /**
   * 开始执行一个导航动作。返回在终态（SUCCEEDED/FAILED/CANCELLED）resolve 的 Promise。
   * 中间态通过 emit 回调流式发出。base_motion 忙时拒绝（单写者）。
   */
  execute(
    envelope: ActionEnvelope,
    goal: { x: number; y: number },
    speed: number,
    emit: (ev: ActionEvent) => void,
  ): Promise<ActionEvent> {
    if (this.active) {
      return Promise.resolve(
        this.finalEvent(envelope.commandId, 0, "FAILED", {
          reason: "device_busy",
          activeCommandId: this.active.commandId,
        }),
      );
    }
    const dx = goal.x - this.pose.x;
    const dy = goal.y - this.pose.y;
    const distanceTotal = Math.hypot(dx, dy);
    this.charging = false;
    // 立即转向目标（仿真简化）。
    this.pose.heading = Math.atan2(dy, dx);

    // EXECUTING 进入。
    emit({
      commandId: envelope.commandId,
      kind: "state_changed",
      state: "EXECUTING",
      seq: 0,
      at: nowIso(),
      payload: {},
    });

    return new Promise<ActionEvent>((resolve) => {
      this.active = {
        commandId: envelope.commandId,
        capabilityId: envelope.capabilityId,
        goal,
        speed,
        distanceTotal: Math.max(distanceTotal, 1e-6),
        distanceDone: 0,
        lastFeedbackAt: 0,
        seq: 1,
        cancelled: false,
        emit,
        resolve,
      };
    });
  }

  // ---- 内部 ----

  private bump(): void {
    this.stateVersion++;
    this.onTelemetry(this.telemetry());
  }

  private finalEvent(
    commandId: string,
    seq: number,
    state: "SUCCEEDED" | "FAILED" | "CANCELLED",
    payload: Record<string, unknown>,
  ): ActionEvent {
    return { commandId, kind: "result", state, seq, at: nowIso(), payload };
  }

  private tick(dt: number): void {
    const a = this.active;
    if (a) {
      // 急停优先：即时安全终止进行中的动作。
      if (this.estop) {
        this.completeActive("FAILED", { reason: "estop" });
      } else if (a.cancelled) {
        // 状态机要求 EXECUTING → CANCEL_REQUESTED → CANCELLED，不能直达。
        a.emit({
          commandId: a.commandId,
          kind: "state_changed",
          state: "CANCEL_REQUESTED",
          seq: a.seq++,
          at: nowIso(),
          payload: {},
        });
        this.completeActive("CANCELLED", { reason: "user_cancel" });
      } else {
        this.advance(a, dt);
      }
    } else if (this.charging && this.battery < 100) {
      this.battery = Math.min(100, this.battery + 6 * dt);
      this.bump();
      return;
    }
    // 常规遥测心跳（即便无动作也推送，让画面平滑）。
    this.onTelemetry(this.telemetry());
  }

  private advance(a: ActiveMotion, dt: number): void {
    const step = a.speed * dt;
    a.distanceDone += step;
    const t = Math.min(1, a.distanceDone / a.distanceTotal);
    const startToGoalX = a.goal.x;
    const startToGoalY = a.goal.y;
    // 线性插值当前位置：从"剩余距离"反推，保证到点精确。
    const remaining = Math.max(0, a.distanceTotal - a.distanceDone);
    const dirX = Math.cos(this.pose.heading);
    const dirY = Math.sin(this.pose.heading);
    if (remaining <= 1e-3) {
      this.pose.x = startToGoalX;
      this.pose.y = startToGoalY;
    } else {
      this.pose.x += dirX * step;
      this.pose.y += dirY * step;
    }
    this.battery = Math.max(0, this.battery - 1.2 * dt);
    this.stateVersion++;

    // 每 ~200ms 发一次 feedback。
    a.lastFeedbackAt += dt;
    if (a.lastFeedbackAt >= 0.2 || t >= 1) {
      a.lastFeedbackAt = 0;
      a.emit({
        commandId: a.commandId,
        kind: "feedback",
        seq: a.seq++,
        at: nowIso(),
        progress: t,
        payload: {
          pose: { x: this.pose.x, y: this.pose.y },
          battery: Math.round(this.battery * 10) / 10,
        },
      });
    }

    this.onTelemetry(this.telemetry());

    if (t >= 1) {
      const isDock =
        a.capabilityId === "robot.navigation.return_to_dock" ||
        (Math.abs(a.goal.x - this.dock.x) < 0.05 &&
          Math.abs(a.goal.y - this.dock.y) < 0.05);
      this.completeActive("SUCCEEDED", {
        distanceTravelledM: Math.round(a.distanceTotal * 100) / 100,
        finalPose: { x: this.pose.x, y: this.pose.y },
      });
      if (isDock) this.charging = true;
    }
  }

  private completeActive(
    state: "SUCCEEDED" | "FAILED" | "CANCELLED",
    payload: Record<string, unknown>,
  ): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const ev = this.finalEvent(a.commandId, a.seq, state, payload);
    a.emit(ev);
    a.resolve(ev);
    this.bump();
  }
}
