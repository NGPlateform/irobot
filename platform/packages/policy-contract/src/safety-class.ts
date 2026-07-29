import { z } from "zod";

/**
 * 安全等级 — 架构设计 §7.2 的机器可读形式。
 *
 * 这是全系统对"一个动作有多危险"的唯一权威分类。Capability Manifest 声明它，
 * Command Orchestrator 和 Edge Safety Supervisor 依据它决定是否自动执行、是否需要
 * 审批、是否永久拒绝。等级只增不改语义：新增等级追加枚举，绝不复用已发布的含义。
 */
export const SAFETY_CLASSES = [
  "S0_OBSERVE",
  "S1_REVERSIBLE",
  "S2_GUARDED",
  "S3_HAZARDOUS",
  "S4_FORBIDDEN",
] as const;

export const SafetyClass = z.enum(SAFETY_CLASSES);
export type SafetyClass = z.infer<typeof SafetyClass>;

/**
 * 默认处置。安全监督器和编排器的策略解释器以此为起点；具体策略可在更严格方向上覆盖，
 * 但永远不能放松：例如 S3 不可被降级为自动执行。
 */
export type DefaultDisposition =
  | "auto_allow" // 自动允许
  | "auto_if_policy" // 策略允许时自动执行
  | "supervised" // 安全监督器校验，按场景审批
  | "manual_approval" // 人工审批 + 本地安全条件
  | "always_deny"; // 永久拒绝，任何用户/模型输入均无法发起

export interface SafetyClassMeta {
  readonly class: SafetyClass;
  readonly meaning: string;
  readonly defaultDisposition: DefaultDisposition;
  /** 是否允许由 Agent 发起提案。S4 为 false，从提案入口即拒绝。 */
  readonly agentMayPropose: boolean;
  /** 是否要求 Edge 侧重新读取本地实时状态做二次判断（安全关键条件）。 */
  readonly requiresEdgeRevalidation: boolean;
}

export const SAFETY_CLASS_META: Readonly<Record<SafetyClass, SafetyClassMeta>> = {
  S0_OBSERVE: {
    class: "S0_OBSERVE",
    meaning: "只读，无物理副作用",
    defaultDisposition: "auto_allow",
    agentMayPropose: true,
    requiresEdgeRevalidation: false,
  },
  S1_REVERSIBLE: {
    class: "S1_REVERSIBLE",
    meaning: "低影响、可逆",
    defaultDisposition: "auto_if_policy",
    agentMayPropose: true,
    requiresEdgeRevalidation: false,
  },
  S2_GUARDED: {
    class: "S2_GUARDED",
    meaning: "物理动作，需要环境约束",
    defaultDisposition: "supervised",
    agentMayPropose: true,
    requiresEdgeRevalidation: true,
  },
  S3_HAZARDOUS: {
    class: "S3_HAZARDOUS",
    meaning: "高风险或不可逆",
    defaultDisposition: "manual_approval",
    agentMayPropose: true,
    requiresEdgeRevalidation: true,
  },
  S4_FORBIDDEN: {
    class: "S4_FORBIDDEN",
    meaning: "禁止由 Agent 发起",
    defaultDisposition: "always_deny",
    agentMayPropose: false,
    requiresEdgeRevalidation: true,
  },
};

/** 快速判定：该安全等级是否允许 Agent 提案。用于提案入口的 fail-closed 检查。 */
export function agentMayPropose(cls: SafetyClass): boolean {
  return SAFETY_CLASS_META[cls].agentMayPropose;
}
