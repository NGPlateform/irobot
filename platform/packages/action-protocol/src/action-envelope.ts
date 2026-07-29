import { z } from "zod";
import { SafetyClass, Precondition } from "@irobot/policy-contract";

/**
 * Action Envelope v0.1 — 架构设计 §7.3。
 *
 * Agent 向 Command Orchestrator 提交的唯一写入口载荷。Envelope 自带幂等键、期限、
 * 租约世代、状态版本和模型快照，使"至少一次传输 + 恰好一次效果"（§9.1）与
 * 租约/fencing（§9.2）成为协议级保证，而非实现细节。
 *
 * 说明：preconditions 采用结构化三元式（policy-contract），而非架构 §7.3 示例中的
 * 字符串写法。结构化形式可静态解析、可审计、无法注入，是对示例的有意收紧。
 */

export const ActorType = z.enum(["user", "agent", "operator", "system"]);

export const Actor = z
  .object({
    type: ActorType,
    id: z.string().min(1),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

/** 模型快照：固定单次 Mission 的模型、Prompt、Tool 目录和策略版本（§6.5 限制）。 */
export const ModelSnapshot = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    promptHash: z.string().min(1),
    toolCatalogVersion: z.string().min(1),
    policyVersion: z.string().min(1),
  })
  .strict();

export const ActionEnvelope = z
  .object({
    commandId: z.string().min(1),
    /** 稳定幂等键，例如 "conversation-turn:tool-call"。同键重试不得产生第二次物理效果。 */
    idempotencyKey: z.string().min(1),
    deviceId: z.string().min(1),
    capabilityId: z.string().min(1),
    capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    arguments: z.record(z.string(), z.unknown()),
    /** 期望的设备状态版本，用于前置条件一致性（§9.3）。 */
    expectedStateVersion: z.number().int().nonnegative(),
    preconditions: z.array(Precondition).default([]),
    /** ISO-8601 期限。超过后不得开始新动作。 */
    deadline: z.string().datetime(),
    priority: z.number().int().min(0).max(100),
    safetyClass: SafetyClass,
    /** 租约世代。Edge 只接受当前或更新的 epoch（§9.2）。 */
    leaseEpoch: z.number().int().nonnegative(),
    actor: Actor,
    traceId: z.string().min(1),
    modelSnapshot: ModelSnapshot,
  })
  .strict();

export type ActionEnvelope = z.infer<typeof ActionEnvelope>;

export function parseActionEnvelope(input: unknown): ActionEnvelope {
  return ActionEnvelope.parse(input);
}
