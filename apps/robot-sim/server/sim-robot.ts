import type { ActionEvent, ActionEnvelope } from "@irobot/action-protocol";
import type { WorldMap } from "./world-map.js";

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
  /** 机械臂：extension 0(收起)..1(伸展)，gripper 0(张开)..1(闭合)。 */
  arm: { extension: number; gripper: number; moving: boolean };
}

interface ActiveMotion {
  commandId: string;
  capabilityId: string;
  goal: { x: number; y: number }; // 最终目标（用于充电坞判定）
  waypoints: Array<{ x: number; y: number }>; // A* 避障航点（末位=goal），空世界为单点直线
  wpIndex: number;
  speed: number;
  distanceTotal: number;
  distanceDone: number;
  lastFeedbackAt: number;
  seq: number;
  cancelled: boolean;
  emit: (ev: ActionEvent) => void;
  resolve: (ev: ActionEvent) => void;
}

interface ActiveArm {
  commandId: string;
  pose: string;
  startExt: number;
  targetExt: number;
  startGrip: number;
  targetGrip: number;
  durationS: number;
  elapsed: number;
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
  private pose: Pose;
  private battery = 82;
  private estop = false;
  private localizationHealthy = true;
  private stateVersion = 1;
  private charging = false;
  private active: ActiveMotion | null = null;
  private activeArm: ActiveArm | null = null;
  private armExtension = 0;
  private armGripper = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanTick = 0;

  readonly stations: Record<string, { x: number; y: number }> = {
    一号站点: { x: 8, y: 1.5 },
    二号站点: { x: 8, y: 6 },
    大厅: { x: 4.5, y: 6.5 },
  };
  readonly dock: { x: number; y: number };
  readonly restrictedZone = { x: 6, y: 3, label: "危险区" };

  constructor(
    private onTelemetry: (t: Telemetry) => void,
    start: { x: number; y: number } = { x: 1, y: 1 },
    private worldMap?: WorldMap, // 共享世界地图（障碍/占据）；无图时退化为直线导航
  ) {
    this.pose = { x: start.x, y: start.y, heading: 0 };
    this.dock = { x: start.x, y: start.y }; // 各机器人回自己的起始/充电位
  }

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
      arm: {
        extension: Math.round(this.armExtension * 1000) / 1000,
        gripper: Math.round(this.armGripper * 1000) / 1000,
        moving: this.activeArm !== null,
      },
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
    return this.active !== null || this.activeArm !== null;
  }

  activeCommandId(): string | null {
    return this.active?.commandId ?? this.activeArm?.commandId ?? null;
  }

  /** 请求取消某个进行中的动作（base 或 arm）。 */
  requestCancel(commandId: string): boolean {
    if (this.active && this.active.commandId === commandId) {
      this.active.cancelled = true;
      return true;
    }
    if (this.activeArm && this.activeArm.commandId === commandId) {
      this.activeArm.cancelled = true;
      return true;
    }
    return false;
  }

  /** 取消所有进行中的动作（base + arm）。 */
  cancelAll(): boolean {
    let any = false;
    if (this.active) { this.active.cancelled = true; any = true; }
    if (this.activeArm) { this.activeArm.cancelled = true; any = true; }
    return any;
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
    this.charging = false;
    // A* 避障路径（空世界/无障碍时 = 单点直线到 goal）。
    const waypoints =
      this.worldMap && this.worldMap.obstacles.length > 0
        ? this.worldMap.pathfind(this.pose, goal)
        : [{ x: goal.x, y: goal.y }];
    if (waypoints.length === 0) waypoints.push({ x: goal.x, y: goal.y });
    // 路径总长（从当前位姿穿过所有航点）。
    let distanceTotal = 0;
    let px = this.pose.x, py = this.pose.y;
    for (const wp of waypoints) { distanceTotal += Math.hypot(wp.x - px, wp.y - py); px = wp.x; py = wp.y; }
    // 立即转向第一个航点。
    const first = waypoints[0]!;
    this.pose.heading = Math.atan2(first.y - this.pose.y, first.x - this.pose.x);

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
        waypoints,
        wpIndex: 0,
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

  /**
   * 开始一个机械臂动作（concurrencyKey=arm，与导航并行）。到目标 extension/gripper。
   * arm 忙时拒绝（单写者，但独立于 base_motion）。
   */
  executeArm(
    commandId: string,
    poseName: string,
    targetExt: number,
    targetGrip: number,
    durationS: number,
    emit: (ev: ActionEvent) => void,
  ): Promise<ActionEvent> {
    if (this.activeArm) {
      return Promise.resolve(
        this.finalEvent(commandId, 0, "FAILED", {
          reason: "device_busy",
          activeCommandId: this.activeArm.commandId,
        }),
      );
    }
    emit({ commandId, kind: "state_changed", state: "EXECUTING", seq: 0, at: nowIso(), payload: {} });
    return new Promise<ActionEvent>((resolve) => {
      this.activeArm = {
        commandId,
        pose: poseName,
        startExt: this.armExtension,
        targetExt,
        startGrip: this.armGripper,
        targetGrip,
        durationS: Math.max(durationS, 0.1),
        elapsed: 0,
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
    // base_motion 与 arm 两个资源并行推进。
    this.tickBase(dt);
    this.tickArm(dt);
    if (!this.active && !this.activeArm && this.charging && this.battery < 100) {
      this.battery = Math.min(100, this.battery + 6 * dt);
      this.stateVersion++;
    }
    // 激光雷达建图：每 2 tick（~10Hz）用当前位姿累积占据栅格。
    if (this.worldMap && ++this.scanTick % 2 === 0 && !this.estop) {
      this.worldMap.integrateScan(this.pose);
    }
    // 每 tick 推一次遥测，让画面平滑。
    this.onTelemetry(this.telemetry());
  }

  private tickBase(dt: number): void {
    const a = this.active;
    if (!a) return;
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
  }

  private tickArm(dt: number): void {
    const a = this.activeArm;
    if (!a) return;
    if (this.estop) {
      this.completeArm("FAILED", { reason: "estop" });
      return;
    }
    if (a.cancelled) {
      a.emit({
        commandId: a.commandId,
        kind: "state_changed",
        state: "CANCEL_REQUESTED",
        seq: a.seq++,
        at: nowIso(),
        payload: {},
      });
      this.completeArm("CANCELLED", { reason: "user_cancel" });
      return;
    }
    a.elapsed += dt;
    const t = Math.min(1, a.elapsed / a.durationS);
    this.armExtension = a.startExt + (a.targetExt - a.startExt) * t;
    this.armGripper = a.startGrip + (a.targetGrip - a.startGrip) * t;
    this.battery = Math.max(0, this.battery - 0.4 * dt); // 机械臂能耗较低
    this.stateVersion++;
    a.lastFeedbackAt += dt;
    if (a.lastFeedbackAt >= 0.2 || t >= 1) {
      a.lastFeedbackAt = 0;
      a.emit({
        commandId: a.commandId,
        kind: "feedback",
        seq: a.seq++,
        at: nowIso(),
        progress: t,
        payload: { extension: Math.round(this.armExtension * 1000) / 1000, gripper: Math.round(this.armGripper * 1000) / 1000 },
      });
    }
    if (t >= 1) {
      this.completeArm("SUCCEEDED", { pose: a.pose, extension: this.armExtension, gripper: this.armGripper });
    }
  }

  private completeArm(
    state: "SUCCEEDED" | "FAILED" | "CANCELLED",
    payload: Record<string, unknown>,
  ): void {
    const a = this.activeArm;
    if (!a) return;
    this.activeArm = null;
    const ev = this.finalEvent(a.commandId, a.seq, state, payload);
    a.emit(ev);
    a.resolve(ev);
    this.bump();
  }

  private advance(a: ActiveMotion, dt: number): void {
    let step = a.speed * dt;
    this.battery = Math.max(0, this.battery - 1.2 * dt);
    // 沿航点前进：吃掉本 tick 的步长，跨过到达的航点、更新朝向。
    while (step > 1e-9 && a.wpIndex < a.waypoints.length) {
      const wp = a.waypoints[a.wpIndex]!;
      const dx = wp.x - this.pose.x, dy = wp.y - this.pose.y;
      const d = Math.hypot(dx, dy);
      if (d <= 1e-9) { a.wpIndex++; continue; }
      this.pose.heading = Math.atan2(dy, dx);
      if (step >= d) {
        this.pose.x = wp.x; this.pose.y = wp.y; a.distanceDone += d; step -= d; a.wpIndex++;
      } else {
        this.pose.x += (dx / d) * step; this.pose.y += (dy / d) * step; a.distanceDone += step; step = 0;
      }
    }
    this.stateVersion++;
    const t = Math.min(1, a.distanceDone / a.distanceTotal);
    const arrived = a.wpIndex >= a.waypoints.length;

    // 每 ~200ms 发一次 feedback。
    a.lastFeedbackAt += dt;
    if (a.lastFeedbackAt >= 0.2 || arrived) {
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

    if (arrived) {
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
