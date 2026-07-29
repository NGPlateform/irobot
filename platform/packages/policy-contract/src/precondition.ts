import { z } from "zod";

/**
 * 前置条件 — 由确定性策略解释器计算，绝不由 LLM 自行判断（架构设计 §7.1）。
 *
 * v0.1 采用受限的 `path op value` 三元式，而非任意表达式：可静态解析、可审计、
 * 无法注入。表达式语言的扩展需要提升协议主版本并配套解释器测试。
 */
export const PreconditionOp = z.enum(["==", "!=", ">=", "<=", ">", "<"]);
export type PreconditionOp = z.infer<typeof PreconditionOp>;

export const Precondition = z.object({
  /** 状态路径，例如 "battery.percent"、"safety.estop"、"localization.healthy"。 */
  path: z.string().min(1),
  op: PreconditionOp,
  /** 期望值，限定为标量，避免任意结构比较。 */
  value: z.union([z.number(), z.boolean(), z.string()]),
});
export type Precondition = z.infer<typeof Precondition>;

/** 策略/前置条件评估结果。fail-closed：未知一律视为不满足。 */
export const PolicyDecision = z.enum([
  "accept",
  "reject",
  "require_approval",
]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;
