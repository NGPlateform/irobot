import { randomUUID } from "node:crypto";
import {
  parseActionEnvelope,
  applyTransition,
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

export interface Proposal {
  capabilityId: string;
  arguments: Record<string, unknown>;
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
export class Orchestrator {
  private leaseEpoch = 1;

  constructor(private robot: SimRobot) {}

  cancelActive(): boolean {
    const id = this.robot.activeCommandId();
    return id ? this.robot.requestCancel(id) : false;
  }

  private buildEnvelope(
    proposal: Proposal,
    safetyClass: SafetyClass,
    commandId: string,
  ): ActionEnvelope {
    return parseActionEnvelope({
      commandId,
      idempotencyKey: `web-session:${commandId}`,
      deviceId: "sim-robot-001",
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

  private resolveGoal(
    proposal: Proposal,
  ): { goal: { x: number; y: number }; speed: number } | { error: string } {
    const t = this.robot.telemetry();
    switch (proposal.capabilityId) {
      case "robot.navigation.navigate_relative": {
        const d = Number(proposal.arguments.distanceM);
        if (!Number.isFinite(d)) return { error: "缺少有效的移动距离" };
        const speed = Number(proposal.arguments.maxSpeedMps) || 0.4;
        return {
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
        return { goal: { x: s.x, y: s.y }, speed: 0.5 };
      }
      case "robot.navigation.return_to_dock":
        return { goal: { x: t.dock.x, y: t.dock.y }, speed: 0.5 };
      default:
        return { error: `不支持的动作：${proposal.capabilityId}` };
    }
  }

  /**
   * 处理一次提案。emit 流式发出全部 ActionEvent（含生命周期状态）。返回终态事件。
   */
  async propose(
    proposal: Proposal,
    emit: (ev: ActionEvent) => void,
  ): Promise<ActionEvent> {
    const manifest = getCapability(proposal.capabilityId);
    const commandId = `cmd_${randomUUID()}`;

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

    // 安全等级处置。S3 需人工审批（demo 中所用能力为 S0/S2，此为纵深防御分支）。
    const disposition = SAFETY_CLASS_META[safetyClass].defaultDisposition;
    if (disposition === "manual_approval") {
      to("PENDING_APPROVAL");
      // demo 无审批 UI：保守拒绝而非静默放行。
      return to("REJECTED", { reason: "S3 危险动作需人工审批，本 demo 未启用" });
    }

    // 构造并校验 Envelope（审计留痕，同时证明与 action-protocol 一致）。
    this.buildEnvelope(proposal, safetyClass, commandId);

    to("ACCEPTED");

    // 交给仿真机器人执行；它发出 EXECUTING/feedback/result。用 forward 守卫其状态转移。
    const forward = (ev: ActionEvent) => {
      if (ev.state) current = applyTransition(current, ev.state);
      emit({ ...ev, commandId });
    };
    return this.robot.execute(
      { commandId, capabilityId: proposal.capabilityId } as ActionEnvelope,
      resolved.goal,
      resolved.speed,
      forward,
    );
  }
}
