import { z } from "zod";
import { ActionState } from "./action-state.js";

/**
 * Action Event v0.1 — 沿 Gateway ↔ Orchestrator ↔ Edge 回流的结构化事件。
 * 用于进度、结果、诊断上报。所有安全/审计事件必须结构化，不依赖自由文本日志（§11）。
 */
export const ActionEventKind = z.enum([
  "state_changed",
  "feedback",
  "result",
  "diagnostic",
]);
export type ActionEventKind = z.infer<typeof ActionEventKind>;

export const ActionEvent = z
  .object({
    commandId: z.string().min(1),
    kind: ActionEventKind,
    /** state_changed 事件携带新状态。 */
    state: ActionState.optional(),
    /** 单调递增的事件序号，用于去重与顺序恢复。 */
    seq: z.number().int().nonnegative(),
    /** 事件产生时间（ISO-8601）。 */
    at: z.string().datetime(),
    /** 关联 ROS Goal（§11 关键关联 ID）。 */
    rosGoalId: z.string().optional(),
    /** 进度 0..1，仅 feedback 事件。 */
    progress: z.number().min(0).max(1).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type ActionEvent = z.infer<typeof ActionEvent>;
