import { randomUUID } from "node:crypto";
import {
  parseActionEnvelope,
  applyTransition,
  isTerminal,
  type ActionEnvelope,
  type ActionEvent,
  type ActionState,
} from "@irobot/action-protocol";
import {
  SAFETY_CLASS_META,
  agentMayPropose,
  type SafetyClass,
  type Precondition,
} from "@irobot/policy-contract";
import { getCapability } from "./capabilities.js";
import type { SimRobot } from "./sim-robot.js";
import { MemoryLedgerStore, type LedgerStore, type LedgerEntry } from "./ledger-store.js";
import type { EdgeClient, EdgeAdmitReq } from "./edge-client.js";

export interface Proposal {
  capabilityId: string;
  arguments: Record<string, unknown>;
}

/** 解算后的动作：base 导航（goal+speed）或 arm 机械臂（pose+ext/grip/dur）。 */
type ResolvedAction =
  | { kind: "base"; goal: { x: number; y: number }; speed: number }
  | { kind: "arm"; pose: string; ext: number; grip: number; durationS: number };

/** 北向 envelope 携带的守卫字段（本地提案不带，逐次唯一）。 */
export interface DecisionMeta {
  idempotencyKey: string;
  deadline?: string;
  leaseEpoch?: number;
  expectedStateVersion?: number;
}

const nowIso = () => new Date().toISOString();

function evalPrecondition(
  p: Precondition,
  snap: Record<string, number | boolean>,
): boolean {
  const actual = snap[p.path];
  if (actual === undefined) return false; // fail-closed：未知路径视为不满足
  switch (p.op) {
    case "==":
      return actual === p.value;
    case "!=":
      return actual !== p.value;
    case ">=":
      return typeof actual === "number" && actual >= (p.value as number);
    case "<=":
      return typeof actual === "number" && actual <= (p.value as number);
    case ">":
      return typeof actual === "number" && actual > (p.value as number);
    case "<":
      return typeof actual === "number" && actual < (p.value as number);
  }
}

/**
 * Command Orchestrator（demo 版）。慢环与快环之间的关卡：校验提案、跑确定性前置条件、
 * 施加安全等级处置、构造并校验 Action Envelope、驱动状态机、把动作交给仿真机器人。
 * 状态机转移全部经 applyTransition 守卫，非法转移抛错——不能绕过。
 */
type ApprovalDecision = "approve" | "deny" | "timeout";

const APPROVAL_TIMEOUT_MS = Number(process.env.IROBOT_APPROVAL_TIMEOUT_MS ?? 30000);

export class Orchestrator {
  private leaseEpoch = 1;
  // 每设备已见的最新租约世代（fencing，安全不变量 §9.2：旧 epoch 一律拒绝）。
  private deviceLeaseEpoch = 0;
  // 正在占用的 concurrencyKey（§8.2：同一 concurrencyKey 不允许两个写动作同时执行）。
  private readonly busyConcurrency = new Set<string>();
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (d: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private robot: SimRobot,
    private approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
    private store: LedgerStore = new MemoryLedgerStore(),
    // 可选：Rust Edge daemon。设置后，写动作执行前经它权威准入（云/边进程分离）。
    private edge?: EdgeClient,
    private deviceId = "sim-robot-001",
  ) {}

  cancelActive(): boolean {
    return this.robot.cancelAll(); // 取消所有进行中动作（base + arm）
  }

  /** 界面审批决策入口。返回是否命中一个待审批命令。 */
  resolveApproval(commandId: string, approved: boolean): boolean {
    const p = this.pendingApprovals.get(commandId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pendingApprovals.delete(commandId);
    p.resolve(approved ? "approve" : "deny");
    return true;
  }

  private awaitApproval(commandId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(commandId);
        resolve("timeout");
      }, this.approvalTimeoutMs);
      this.pendingApprovals.set(commandId, { resolve, timer });
    });
  }

  private buildEnvelope(
    proposal: Proposal,
    safetyClass: SafetyClass,
    commandId: string,
  ): ActionEnvelope {
    return parseActionEnvelope({
      commandId,
      idempotencyKey: `web-session:${commandId}`,
      deviceId: this.deviceId,
      capabilityId: proposal.capabilityId,
      capabilityVersion: getCapability(proposal.capabilityId)?.version ?? "1.0.0",
      arguments: proposal.arguments,
      expectedStateVersion: this.robot.telemetry().stateVersion,
      preconditions: [],
      deadline: new Date(Date.now() + 90000).toISOString(),
      priority: 50,
      safetyClass,
      leaseEpoch: this.leaseEpoch,
      actor: { type: "user", id: "web-user" },
      traceId: `trace-${randomUUID().slice(0, 8)}`,
      modelSnapshot: {
        provider: "sim-nlu",
        model: "rule-based",
        promptHash: "sha256:sim",
        toolCatalogVersion: "2026-07-30.1",
        policyVersion: "1",
      },
    });
  }

  private resolveGoal(proposal: Proposal): ResolvedAction | { error: string } {
    const t = this.robot.telemetry();
    switch (proposal.capabilityId) {
      case "robot.arm.move_to_pose": {
        const pose = String(proposal.arguments.pose ?? "");
        const ARM: Record<string, { ext: number; grip: number; dur: number }> = {
          stow: { ext: 0, grip: 0, dur: 1.5 },
          reach: { ext: 1, grip: 0, dur: 2 },
          grasp: { ext: 1, grip: 1, dur: 2 },
          lift: { ext: 0.6, grip: 1, dur: 1.5 },
        };
        const a = ARM[pose];
        if (!a) return { error: `未知机械臂位姿：${pose || "（空）"}` };
        return { kind: "arm", pose, ext: a.ext, grip: a.grip, durationS: a.dur };
      }
      case "robot.navigation.navigate_relative": {
        const d = Number(proposal.arguments.distanceM);
        if (!Number.isFinite(d)) return { error: "缺少有效的移动距离" };
        const speed = Number(proposal.arguments.maxSpeedMps) || 0.4;
        return {
          kind: "base",
          goal: {
            x: t.pose.x + Math.cos(t.pose.heading) * d,
            y: t.pose.y + Math.sin(t.pose.heading) * d,
          },
          speed,
        };
      }
      case "robot.navigation.navigate_to_station": {
        const name = String(proposal.arguments.station ?? "");
        const s = t.stations[name];
        if (!s) return { error: `未知站点：${name || "（空）"}` };
        return { kind: "base", goal: { x: s.x, y: s.y }, speed: 0.5 };
      }
      case "robot.navigation.return_to_dock":
        return { kind: "base", goal: { x: t.dock.x, y: t.dock.y }, speed: 0.5 };
      case "robot.navigation.enter_restricted_zone":
        return {
          kind: "base",
          goal: { x: t.restrictedZone.x, y: t.restrictedZone.y },
          speed: 0.4,
        };
      default:
        return { error: `不支持的动作：${proposal.capabilityId}` };
    }
  }

  /**
   * 本地提案入口：分配 commandId 后走统一决策路径。emit 流式发出全部 ActionEvent。
   */
  async propose(
    proposal: Proposal,
    emit: (ev: ActionEvent) => void,
  ): Promise<ActionEvent> {
    const commandId = `cmd_${randomUUID()}`;
    // 本地提案逐次唯一幂等键：不做去重（每次都是新请求）。
    return this.runDecision(commandId, proposal, emit, {
      idempotencyKey: `local:${commandId}`,
    });
  }

  /**
   * 北向（OpenClaw 插件）入口：接收已构造的 Action Envelope。校验后走同一决策路径。
   * 安全关键：capabilityId/arguments 取自 envelope，但 safetyClass 一律由本地 manifest
   * 派生，绝不信任北向声明（纵深防御，安全不变量 §4.1）。
   */
  async executeEnvelope(
    envelope: unknown,
    emit: (ev: ActionEvent) => void,
  ): Promise<ActionEvent> {
    const e = parseActionEnvelope(envelope); // 不合规即抛错（fail-closed）
    return this.runDecision(
      e.commandId,
      { capabilityId: e.capabilityId, arguments: e.arguments },
      emit,
      {
        idempotencyKey: e.idempotencyKey,
        deadline: e.deadline,
        leaseEpoch: e.leaseEpoch,
        expectedStateVersion: e.expectedStateVersion,
      },
    );
  }

  /** 只读审计访问（G1：全链路审计可查询）。 */
  ledger(): readonly LedgerEntry[] {
    return this.store.all();
  }

  private appendLedger(e: LedgerEntry): void {
    this.store.append(e);
  }

  /**
   * 统一决策入口 = 幂等去重 + 决策核心 + 审计落账。
   * 相同 idempotencyKey 重试：重放缓存终态，绝不二次执行（恰好一次效果，安全不变量 §4.1#6）。
   */
  private async runDecision(
    commandId: string,
    proposal: Proposal,
    emit: (ev: ActionEvent) => void,
    meta: DecisionMeta,
  ): Promise<ActionEvent> {
    const cached = this.store.getIdempotent(meta.idempotencyKey);
    if (cached && isTerminal(cached.state ?? "SUCCEEDED")) {
      // 重放：不进状态机、不触达执行器。
      emit({ commandId, kind: "state_changed", state: "PROPOSED", seq: 0, at: nowIso(), payload: { deduplicated: true } });
      const replay: ActionEvent = {
        ...cached,
        commandId,
        payload: { ...cached.payload, deduplicated: true, originalCommandId: cached.commandId },
      };
      emit(replay);
      this.appendLedger({
        commandId,
        idempotencyKey: meta.idempotencyKey,
        capabilityId: proposal.capabilityId,
        finalState: cached.state as ActionState,
        reason: "deduplicated",
        deduplicated: true,
        leaseEpoch: meta.leaseEpoch,
        expectedStateVersion: meta.expectedStateVersion,
        deviceId: this.deviceId,
        at: nowIso(),
      });
      return replay;
    }

    const final = await this.decideCore(commandId, proposal, emit, meta);
    // 仅缓存"已实际决策"的终态（重放事件不会走到这里）。
    this.store.putIdempotent(meta.idempotencyKey, final);
    this.appendLedger({
      commandId,
      idempotencyKey: meta.idempotencyKey,
      capabilityId: proposal.capabilityId,
      finalState: (final.state ?? "SUCCEEDED") as ActionState,
      reason: (final.payload as { reason?: string })?.reason,
      leaseEpoch: meta.leaseEpoch,
      expectedStateVersion: meta.expectedStateVersion,
      deviceId: this.deviceId,
      at: nowIso(),
    });
    return final;
  }

  private async decideCore(
    commandId: string,
    proposal: Proposal,
    emit: (ev: ActionEvent) => void,
    meta: DecisionMeta,
  ): Promise<ActionEvent> {
    const manifest = getCapability(proposal.capabilityId);

    let current: ActionState = "PROPOSED";
    const to = (state: ActionState, payload: Record<string, unknown> = {}) => {
      current = applyTransition(current, state); // 非法转移即抛错
      const ev: ActionEvent = {
        commandId,
        kind: state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED"
          ? "result"
          : "state_changed",
        state,
        seq: 0,
        at: nowIso(),
        payload,
      };
      emit(ev);
      return ev;
    };
    const reject = (reason: string): ActionEvent => {
      to("VALIDATING");
      return to("REJECTED", { reason });
    };

    // PROPOSED 是状态机入口（[*] -> PROPOSED），直接发出，不走 applyTransition。
    emit({
      commandId,
      kind: "state_changed",
      state: "PROPOSED",
      seq: 0,
      at: nowIso(),
      payload: {},
    });

    if (!manifest) return reject(`未知能力：${proposal.capabilityId}`);

    const safetyClass = manifest.safetyClass;
    // 安全闸：S4 或不可提案等级从入口拒绝（安全不变量 §4.1）。
    if (!agentMayPropose(safetyClass)) {
      return reject(`${safetyClass} 不允许由 Agent 发起`);
    }

    // 期限强制（§8.2：deadline 之后不能开始新动作）。
    if (meta.deadline) {
      const deadlineMs = Date.parse(meta.deadline);
      if (Number.isFinite(deadlineMs) && deadlineMs < Date.now()) {
        return reject(`命令已过期（deadline ${meta.deadline}）`);
      }
    }

    // 租约 fencing（§9.2 / §8.2：较旧 leaseEpoch 永远不能覆盖较新 epoch）。
    if (meta.leaseEpoch != null) {
      if (meta.leaseEpoch < this.deviceLeaseEpoch) {
        return reject(`旧租约 epoch ${meta.leaseEpoch} < 当前 ${this.deviceLeaseEpoch}`);
      }
      this.deviceLeaseEpoch = Math.max(this.deviceLeaseEpoch, meta.leaseEpoch);
    }

    // 查询类（S0）：同步返回，不进物理状态机。
    if (manifest.kind === "query") {
      to("VALIDATING");
      to("ACCEPTED");
      const result = this.robot.runQuery(proposal.capabilityId);
      current = "EXECUTING";
      emit({
        commandId,
        kind: "state_changed",
        state: "EXECUTING",
        seq: 0,
        at: nowIso(),
        payload: {},
      });
      current = applyTransition(current, "SUCCEEDED");
      const ev: ActionEvent = {
        commandId,
        kind: "result",
        state: "SUCCEEDED",
        seq: 1,
        at: nowIso(),
        payload: result,
      };
      emit(ev);
      return ev;
    }

    to("VALIDATING");

    // 确定性前置条件（由策略解释器计算，非 LLM）。
    const snap = this.robot.stateSnapshot();
    for (const p of manifest.preconditions) {
      if (!evalPrecondition(p, snap)) {
        return to("REJECTED", {
          reason: `前置条件不满足：${p.path} ${p.op} ${p.value}`,
        });
      }
    }

    const resolved = this.resolveGoal(proposal);
    if ("error" in resolved) return to("REJECTED", { reason: resolved.error });

    // 安全等级处置。S3 需人工审批：进入 PENDING_APPROVAL 等界面决策，绝不静默放行。
    const disposition = SAFETY_CLASS_META[safetyClass].defaultDisposition;
    if (disposition === "manual_approval") {
      const expiresAt = new Date(Date.now() + this.approvalTimeoutMs).toISOString();
      to("PENDING_APPROVAL", {
        requiresApproval: true,
        capabilityId: proposal.capabilityId,
        arguments: proposal.arguments,
        safetyClass,
        expiresAt,
      });
      const decision = await this.awaitApproval(commandId);
      if (decision === "timeout") return to("EXPIRED", { reason: "审批超时，已放弃" });
      if (decision === "deny") return to("REJECTED", { reason: "审批被拒绝" });
      // approve → 落到下方 ACCEPTED + 执行
    }

    // 并发互斥：同一 concurrencyKey 已有写动作在执行则拒绝（§8.2）。不同 key（如 arm）可并行。
    // 此处已处于 VALIDATING（前置条件已跑），故直接转 REJECTED，不再走 reject() 的 VALIDATING。
    const ckey = manifest.concurrencyKey;
    if (this.busyConcurrency.has(ckey)) {
      return to("REJECTED", { reason: `资源忙：concurrencyKey ${ckey} 正在执行其它写动作` });
    }

    // Rust Edge 权威准入（若启用）：独立进程二次守卫。拒绝即不执行（安全层 fail-closed）。
    const edgeReq: EdgeAdmitReq = {
      commandId,
      idempotencyKey: meta.idempotencyKey,
      capabilityId: proposal.capabilityId,
      safetyClass,
      concurrencyKey: ckey,
      deadlineMs: meta.deadline ? Date.parse(meta.deadline) : undefined,
      leaseEpoch: meta.leaseEpoch,
    };
    if (this.edge) {
      // 先把本地实时状态推给 Edge，供其对 S2/S3 做安全重校验（读本地状态重判）。
      const snap = this.robot.stateSnapshot();
      await this.edge.setState(
        Boolean(snap["safety.estop"]),
        Boolean(snap["localization.healthy"]),
        Number(snap["battery.percent"]),
      );
      const adm = await this.edge.admit(edgeReq, Date.now());
      // 把 Rust Edge 的独立准入决策落库（source=edge，SQLite 持久、可经 /edge-journal 查）。
      this.store.append({
        commandId,
        idempotencyKey: meta.idempotencyKey,
        capabilityId: proposal.capabilityId,
        finalState: adm.kind === "rejected" ? "REJECTED" : "ACCEPTED",
        reason: adm.kind === "rejected" ? adm.reason : adm.kind === "deduplicated" ? "deduplicated" : undefined,
        deduplicated: adm.kind === "deduplicated",
        leaseEpoch: meta.leaseEpoch,
        source: "edge",
        deviceId: this.deviceId,
        at: nowIso(),
      });
      if (adm.kind === "rejected") {
        return to("REJECTED", { reason: `edge: ${adm.reason}` });
      }
    }

    // 构造并校验 Envelope（审计留痕，同时证明与 action-protocol 一致）。
    this.buildEnvelope(proposal, safetyClass, commandId);

    to("ACCEPTED");
    this.busyConcurrency.add(ckey);

    // 交给仿真机器人执行；它发出 EXECUTING/feedback/result。用 forward 守卫其状态转移。
    const forward = (ev: ActionEvent) => {
      if (ev.state) current = applyTransition(current, ev.state);
      emit({ ...ev, commandId });
    };
    let finalEv: ActionEvent | undefined;
    try {
      finalEv = await (resolved.kind === "arm"
        ? this.robot.executeArm(commandId, resolved.pose, resolved.ext, resolved.grip, resolved.durationS, forward)
        : this.robot.execute(
            { commandId, capabilityId: proposal.capabilityId } as ActionEnvelope,
            resolved.goal,
            resolved.speed,
            forward,
          ));
      return finalEv;
    } finally {
      this.busyConcurrency.delete(ckey); // 终态（成功/失败/取消）后释放
      if (this.edge) void this.edge.complete(edgeReq, finalEv?.state ?? "FAILED", Date.now());
    }
  }
}
