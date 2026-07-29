import { describe, it, expect } from "vitest";
import {
  ACTION_STATES,
  TERMINAL_STATES,
  isTerminal,
  canTransition,
  applyTransition,
  IllegalTransitionError,
  type ActionState,
} from "./index.js";

describe("动作状态机不变量（架构 §7.4 / §8.2）", () => {
  it("五个终态且均不可再转移", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      ["CANCELLED", "EXPIRED", "FAILED", "REJECTED", "SUCCEEDED"].sort(),
    );
    for (const s of TERMINAL_STATES) {
      for (const to of ACTION_STATES) {
        expect(canTransition(s, to)).toBe(false);
      }
    }
  });

  it("终态不可变：从终态出发的任何转移抛错", () => {
    expect(() => applyTransition("SUCCEEDED", "EXECUTING")).toThrow(
      IllegalTransitionError,
    );
    expect(() => applyTransition("CANCELLED", "EXECUTING")).toThrow(
      IllegalTransitionError,
    );
  });

  it("正常路径 PROPOSED→...→SUCCEEDED 全程合法", () => {
    const path: ActionState[] = [
      "PROPOSED",
      "VALIDATING",
      "ACCEPTED",
      "EXECUTING",
      "SUCCEEDED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(applyTransition(path[i]!, path[i + 1]!)).toBe(path[i + 1]);
    }
  });

  it("取消路径 EXECUTING→CANCEL_REQUESTED→CANCELLED 合法", () => {
    expect(applyTransition("EXECUTING", "CANCEL_REQUESTED")).toBe(
      "CANCEL_REQUESTED",
    );
    expect(applyTransition("CANCEL_REQUESTED", "CANCELLED")).toBe("CANCELLED");
  });

  it("审批路径与过期路径合法", () => {
    expect(applyTransition("VALIDATING", "PENDING_APPROVAL")).toBe(
      "PENDING_APPROVAL",
    );
    expect(applyTransition("PENDING_APPROVAL", "EXPIRED")).toBe("EXPIRED");
    expect(applyTransition("ACCEPTED", "EXPIRED")).toBe("EXPIRED");
  });

  it("跳过校验直接执行是非法的（不能绕过 Orchestrator）", () => {
    expect(() => applyTransition("PROPOSED", "EXECUTING")).toThrow(
      IllegalTransitionError,
    );
    expect(() => applyTransition("PROPOSED", "ACCEPTED")).toThrow(
      IllegalTransitionError,
    );
  });

  it("isTerminal 与 TERMINAL_STATES 一致", () => {
    for (const s of ACTION_STATES) {
      expect(isTerminal(s)).toBe(TERMINAL_STATES.has(s));
    }
  });
});
