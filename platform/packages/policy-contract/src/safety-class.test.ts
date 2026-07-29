import { describe, it, expect } from "vitest";
import {
  SAFETY_CLASSES,
  SAFETY_CLASS_META,
  SafetyClass,
  agentMayPropose,
} from "./index.js";

describe("SafetyClass 契约不变量", () => {
  it("每个等级都有元数据", () => {
    for (const cls of SAFETY_CLASSES) {
      expect(SAFETY_CLASS_META[cls]).toBeDefined();
      expect(SAFETY_CLASS_META[cls].class).toBe(cls);
    }
  });

  it("S4_FORBIDDEN 永远拒绝且 Agent 不可提案（架构安全不变量 §4.1）", () => {
    expect(SAFETY_CLASS_META.S4_FORBIDDEN.defaultDisposition).toBe("always_deny");
    expect(agentMayPropose("S4_FORBIDDEN")).toBe(false);
  });

  it("S2/S3 必须要求 Edge 侧二次校验（安全关键条件读本地实时状态）", () => {
    expect(SAFETY_CLASS_META.S2_GUARDED.requiresEdgeRevalidation).toBe(true);
    expect(SAFETY_CLASS_META.S3_HAZARDOUS.requiresEdgeRevalidation).toBe(true);
  });

  it("只有 S0/S1 可能无需 Edge 二次校验", () => {
    expect(SAFETY_CLASS_META.S0_OBSERVE.requiresEdgeRevalidation).toBe(false);
    expect(SAFETY_CLASS_META.S1_REVERSIBLE.requiresEdgeRevalidation).toBe(false);
  });

  it("枚举与 zod schema 一致", () => {
    for (const cls of SAFETY_CLASSES) {
      expect(SafetyClass.parse(cls)).toBe(cls);
    }
    expect(() => SafetyClass.parse("S9_UNKNOWN")).toThrow();
  });
});
