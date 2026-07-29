import { randomUUID } from "node:crypto";
import {
  ActionEnvelope,
  parseActionEnvelope,
  type ActionEvent,
} from "@irobot/action-protocol";
import { agentMayPropose, type SafetyClass } from "@irobot/policy-contract";
import { submitProposal } from "./orchestrator-client.js";

/**
 * OpenClaw 工具执行上下文的最小镜像（对应 src/plugin-sdk/tool-plugin.ts 的
 * ToolPluginExecutionContext）。刻意不 import openclaw，使桥接逻辑可独立单测；
 * 真正的插件入口（openclaw-plugin.ts）再把它接到 api.registerTool。
 */
export interface ToolResultLike {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface ToolExecCtxLike {
  toolCallId: string;
  /** OpenClaw 传入的取消信号：turn interruption → cancel/abort。 */
  signal?: AbortSignal;
  /** OpenClaw 的流式回传回调。 */
  onUpdate?: (partial: ToolResultLike) => void;
}

/** 由 Gateway 会话解析、注入到每次提案的绑定上下文（设备目录 + 身份 + 租约 + 模型快照）。 */
export interface MissionBinding {
  sessionId: string;
  deviceId: string;
  leaseEpoch: number;
  expectedStateVersion: number;
  traceId: string;
  actor: { type: "user" | "agent" | "operator" | "system"; id: string };
  modelSnapshot: {
    provider: string;
    model: string;
    promptHash: string;
    toolCatalogVersion: string;
    policyVersion: string;
  };
  /** 提案默认期限（毫秒）。 */
  proposalTimeoutMs: number;
}

/** 插件配置（来自 openclaw.plugin.json configSchema）。 */
export interface GatewayAdapterConfig {
  orchestratorUrl: string;
}

/** 模型可见的工具参数。设备编排细节（租约、快照）不暴露给模型。 */
export interface ProposeActionParams {
  capabilityId: string;
  capabilityVersion: string;
  arguments: Record<string, unknown>;
  safetyClass: SafetyClass;
}

const isoDeadline = (fromMs: number, timeoutMs: number): string =>
  new Date(fromMs + timeoutMs).toISOString();

/** 从工具参数 + 会话绑定构造并校验 Action Envelope（fail-closed）。 */
export function buildEnvelope(
  params: ProposeActionParams,
  binding: MissionBinding,
  nowMs: number,
  toolCallId: string,
): ActionEnvelope {
  const envelope = {
    commandId: `cmd_${randomUUID()}`,
    idempotencyKey: `${binding.sessionId}:${toolCallId}`,
    deviceId: binding.deviceId,
    capabilityId: params.capabilityId,
    capabilityVersion: params.capabilityVersion,
    arguments: params.arguments,
    expectedStateVersion: binding.expectedStateVersion,
    preconditions: [],
    deadline: isoDeadline(nowMs, binding.proposalTimeoutMs),
    priority: 50,
    safetyClass: params.safetyClass,
    leaseEpoch: binding.leaseEpoch,
    actor: binding.actor,
    traceId: binding.traceId,
    modelSnapshot: binding.modelSnapshot,
  } satisfies ActionEnvelope;
  // 二次校验：即便上游构造有误也 fail-closed，绝不把不合规载荷发往 Orchestrator。
  return parseActionEnvelope(envelope);
}

const feedbackText = (ev: ActionEvent): string => {
  if (ev.kind === "feedback" && typeof ev.progress === "number") {
    return `执行中，已完成 ${Math.round(ev.progress * 100)}%`;
  }
  if (ev.kind === "state_changed" && ev.state) {
    return `状态：${ev.state}`;
  }
  return `事件：${ev.kind}`;
};

/**
 * propose_action 工具的 execute 实现。构造 Envelope → 提交外部 Orchestrator →
 * 把回流事件流式转发给 Agent（onUpdate）→ 返回终态结果。取消信号原样透传。
 *
 * 这即是 "文本消息 → 外部 Orchestrator → 流式闭环" 的 OpenClaw 侧落点。
 */
export async function executeProposeAction(
  params: ProposeActionParams,
  config: GatewayAdapterConfig,
  binding: MissionBinding,
  ctx: ToolExecCtxLike,
  nowMs: number = Date.now(),
): Promise<ToolResultLike> {
  // 纵深防御：S4 在桥接层即拒，不依赖 Orchestrator 兜底（安全不变量 §4.1）。
  if (!agentMayPropose(params.safetyClass)) {
    return {
      content: [
        { type: "text", text: `拒绝：${params.safetyClass} 不允许由 Agent 发起。` },
      ],
      details: { rejected: true, reason: "safety_class_forbidden" },
    };
  }

  const envelope = buildEnvelope(params, binding, nowMs, ctx.toolCallId);

  const { finalEvent, events } = await submitProposal(
    config.orchestratorUrl,
    envelope,
    {
      signal: ctx.signal,
      onFeedback: (ev) =>
        ctx.onUpdate?.({
          content: [{ type: "text", text: feedbackText(ev) }],
          details: ev,
        }),
    },
  );

  return {
    content: [
      {
        type: "text",
        text: `动作 ${envelope.capabilityId} 终态：${finalEvent.state ?? "UNKNOWN"}`,
      },
    ],
    details: {
      commandId: envelope.commandId,
      finalState: finalEvent.state,
      result: finalEvent.payload,
      eventCount: events.length,
    },
  };
}
