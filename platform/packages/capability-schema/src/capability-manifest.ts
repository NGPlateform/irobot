import { z } from "zod";
import { SafetyClass, Precondition } from "@irobot/policy-contract";

/**
 * Capability Manifest v0.1 — 架构设计 §7.1 的机器可读契约。
 *
 * 每项高层设备能力对应一个版本化 Manifest，而不是直接对应硬件函数。低层执行器
 * （PWM、关节力矩、原始电机速度）永远不作为能力暴露给 Agent（安全不变量 §4.1）。
 */

/** 能力类别：query 为只读查询，action 为可反馈、可取消的长动作。 */
export const CapabilityKind = z.enum(["query", "action"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

/** 中断模式：cancel 取消未开始/可安全撤销；abort 安全终止进行中动作；non_interruptible 不可中断。 */
export const InterruptMode = z.enum(["cancel", "abort", "non_interruptible"]);
export type InterruptMode = z.infer<typeof InterruptMode>;

/**
 * 断网策略（架构设计 §8.3）。租约过期后的行为由能力自身声明，不统一假设继续或停止。
 */
export const OfflinePolicy = z.enum([
  "stop_on_disconnect", // Gateway 租约失效后安全终止
  "complete_current_action", // 完成当前已验证动作，不接受新动作
  "execute_with_valid_lease", // 租约未过期时继续执行
  "local_autonomy_only", // 只允许本地控制器或本地操作员
]);
export type OfflinePolicy = z.infer<typeof OfflinePolicy>;

/** 语义化版本，用于 Manifest 与命令的版本协商。 */
export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "版本必须为 major.minor.patch");

/**
 * 内嵌的 JSON Schema。v0.1 仅约束其为对象，不在 Manifest 层校验其内部结构；
 * 由 Orchestrator 加载时用 JSON Schema 校验器解释 inputSchema/resultSchema。
 */
const JsonSchemaObject = z.record(z.string(), z.unknown());

export const CapabilityManifest = z
  .object({
    /** 领域能力 ID，例如 robot.navigation.navigate_relative。 */
    capabilityId: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    version: SemVer,
    kind: CapabilityKind,
    description: z.string().min(1),
    /** 决定是否允许自动执行、是否需要审批。 */
    safetyClass: SafetyClass,
    /** 同一资源域的动作互斥键，例如 base_motion、arm。 */
    concurrencyKey: z.string().min(1),
    interruptMode: InterruptMode,
    defaultTimeoutMs: z.number().int().positive(),
    offlinePolicy: OfflinePolicy,
    inputSchema: JsonSchemaObject,
    /** 由确定性策略解释器计算，不能由 LLM 自行判断。 */
    preconditions: z.array(Precondition).default([]),
    resultSchema: JsonSchemaObject,
  })
  .strict()
  .superRefine((m, ctx) => {
    // query 类能力应为只读安全等级；写动作不得声明为 query。
    if (m.kind === "query" && m.safetyClass !== "S0_OBSERVE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "kind=query 的能力必须是 S0_OBSERVE",
        path: ["safetyClass"],
      });
    }
    // 只读观察不应携带中断/断网写语义之外的组合：query 必须 cancel 或 non_interruptible。
    if (m.kind === "query" && m.interruptMode === "abort") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "query 能力不应使用 abort 中断模式",
        path: ["interruptMode"],
      });
    }
  });

export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

/** 解析并校验一个 Manifest，失败即抛出（fail-closed）。 */
export function parseCapabilityManifest(input: unknown): CapabilityManifest {
  return CapabilityManifest.parse(input);
}
