import { z } from "zod";

/**
 * 动作状态机 v0.1 — 架构设计 §7.4。
 *
 * 核心不变量：终态不可变。晚到的重复结果只写入诊断事件，不得修改终态
 * （安全不变量 §4.1 第 6 条：重试不能导致物理动作重复执行）。
 */
export const ACTION_STATES = [
  "PROPOSED",
  "VALIDATING",
  "PENDING_APPROVAL",
  "ACCEPTED",
  "EXECUTING",
  "CANCEL_REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "REJECTED",
] as const;

export const ActionState = z.enum(ACTION_STATES);
export type ActionState = z.infer<typeof ActionState>;

/** 五个终态。进入后不可再转移。 */
export const TERMINAL_STATES: ReadonlySet<ActionState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "REJECTED",
]);

/** 合法转移表。未列出的转移一律非法（fail-closed）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  PROPOSED: ["VALIDATING"],
  VALIDATING: ["REJECTED", "PENDING_APPROVAL", "ACCEPTED"],
  PENDING_APPROVAL: ["ACCEPTED", "REJECTED", "EXPIRED"],
  ACCEPTED: ["EXECUTING", "EXPIRED"],
  EXECUTING: ["SUCCEEDED", "FAILED", "CANCEL_REQUESTED"],
  CANCEL_REQUESTED: ["CANCELLED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: [],
};

export function isTerminal(state: ActionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ActionState,
    readonly to: ActionState,
  ) {
    super(`非法状态转移: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * 应用一次状态转移。若源已是终态，或转移不在允许表中，抛出 IllegalTransitionError。
 * 这是所有 Ledger / Journal 写入前的强制守卫。
 */
export function applyTransition(from: ActionState, to: ActionState): ActionState {
  if (isTerminal(from)) {
    throw new IllegalTransitionError(from, to);
  }
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return to;
}
