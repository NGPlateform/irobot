import { execFile } from "node:child_process";
import { z } from "zod";
import type { NluResult } from "./nlu.js";
import { CAPABILITIES } from "./capabilities.js";

/**
 * 用本机 `claude` CLI 作为认知慢环的 LLM Agent。
 *
 * 关键：LLM 只产出**声明式提案**（与规则式 NLU 完全同形的 NluResult），绝不直接控制
 * 执行器。产出的提案照旧经 Orchestrator 的安全等级判定、前置条件、状态机校验——即便
 * 模型幻觉出不存在的能力，也会被 Orchestrator REJECTED。这正是"LLM 提议、确定性层处置"。
 *
 * CLI 不可用/超时/输出不合规时返回 null，由调用方回退到规则式 NLU（fail-closed，不阻塞）。
 */

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "say"],
  properties: {
    kind: { type: "string", enum: ["proposal", "control", "smalltalk"] },
    capabilityId: { type: "string" },
    arguments: { type: "object" },
    control: { type: "string", enum: ["cancel", "estop", "clear_estop"] },
    say: { type: "string" },
  },
} as const;

const AgentOutput = z.object({
  kind: z.enum(["proposal", "control", "smalltalk"]),
  capabilityId: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  control: z.enum(["cancel", "estop", "clear_estop"]).optional(),
  say: z.string(),
});

export interface AgentWorldContext {
  battery: number;
  pose: { x: number; y: number };
  estop: boolean;
  charging: boolean;
  stations: string[];
  history: Array<{ role: "user" | "agent"; text: string }>;
}

const MODEL = process.env.IROBOT_AGENT_MODEL ?? "haiku";

function capabilityCatalog(): string {
  return [...CAPABILITIES.values()]
    .map((m) => {
      const props = Object.keys(
        (m.inputSchema.properties as Record<string, unknown>) ?? {},
      );
      const args = props.length ? `参数：${props.join(", ")}` : "无参数";
      return `- ${m.capabilityId}（${m.description}，${m.safetyClass}，${args}）`;
    })
    .join("\n");
}

export function systemPrompt(): string {
  return [
    "你是一台低速室内移动机器人的控制助手。把用户的自然语言转成一个结构化动作提案，绝不虚构机器人做不到的事。",
    "只能使用下列能力，capabilityId 必须逐字精确：",
    capabilityCatalog(),
    "输出规则：",
    "- 移动/导航/查询 → kind=proposal，给出 capabilityId 与 arguments（严格匹配该能力参数；navigate_relative 的 distanceM 单位为米，后退用负数；navigate_to_station 的 station 用中文站名）。",
    "- 停止/取消当前动作 → kind=control, control=cancel。急停 → control=estop。解除急停 → control=clear_estop。",
    "- 闲聊、无法映射、信息不足 → kind=smalltalk，用 say 追问或说明。",
    "- say 始终是一句简短自然的中文，会被语音朗读。不要输出除结构化字段外的任何内容。",
    "你只负责提议；是否真正执行由下游安全系统裁决，你无需担心安全判断。",
  ].join("\n");
}

function userPrompt(text: string, ctx: AgentWorldContext): string {
  const hist = ctx.history
    .slice(-6)
    .map((h) => `${h.role === "user" ? "用户" : "机器人"}：${h.text}`)
    .join("\n");
  return [
    `当前状态：电量 ${ctx.battery}%${ctx.charging ? "(充电中)" : ""}，位置 (${ctx.pose.x.toFixed(1)}, ${ctx.pose.y.toFixed(1)})，急停${ctx.estop ? "已触发" : "未触发"}。`,
    `可用站点：${ctx.stations.join("、")}。`,
    hist ? `最近对话：\n${hist}` : "",
    `用户最新一句：${text}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 动态状态一行，随每轮用户消息发送（常驻进程记住对话，故无需再带历史）。 */
export function stateLine(ctx: AgentWorldContext, text: string): string {
  return [
    `[状态] 电量${ctx.battery}%${ctx.charging ? "(充电中)" : ""}，位置(${ctx.pose.x.toFixed(1)},${ctx.pose.y.toFixed(1)})，急停${ctx.estop ? "已触发" : "未触发"}，站点：${ctx.stations.join("、")}`,
    `[用户] ${text}`,
  ].join("\n");
}

/** 把结构化候选映射为 NluResult。null 表示不合规（fail-closed）。 */
export function mapAgentOutput(candidate: unknown): NluResult | null {
  const parsed = AgentOutput.safeParse(candidate);
  if (!parsed.success) return null;
  const o = parsed.data;
  if (o.kind === "control") {
    return { kind: "control", control: o.control ?? "cancel", reply: o.say };
  }
  if (o.kind === "proposal" && o.capabilityId) {
    return {
      kind: "proposal",
      proposal: { capabilityId: o.capabilityId, arguments: o.arguments ?? {} },
      reply: o.say,
    };
  }
  return { kind: "smalltalk", reply: o.say };
}

/** 从 `claude -p --output-format json` 的 stdout 解析出 NluResult。纯函数，可测。 */
export function parseClaudeEnvelope(stdout: string): NluResult | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return null;
  }
  const e = envelope as { structured_output?: unknown; result?: unknown; is_error?: boolean };
  if (e.is_error) return null;

  // 优先用 structured_output；否则尝试把 result 文本当 JSON 解析。
  let candidate: unknown = e.structured_output;
  if (candidate === undefined && typeof e.result === "string") {
    try {
      candidate = JSON.parse(e.result);
    } catch {
      return null;
    }
  }
  return mapAgentOutput(candidate);
}

/** 调用 claude CLI。失败/超时返回 null（调用方回退规则式 NLU）。 */
export function runClaudeAgent(
  text: string,
  ctx: AgentWorldContext,
  timeoutMs = 25000,
): Promise<NluResult | null> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      userPrompt(text, ctx),
      "--append-system-prompt",
      systemPrompt(),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(OUTPUT_SCHEMA),
      "--model",
      MODEL,
    ];
    execFile(
      "claude",
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        resolve(parseClaudeEnvelope(stdout));
      },
    );
  });
}

/** 探测 CLI 是否可用（启动时调用一次）。 */
export function claudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 8000 }, (err) => resolve(!err));
  });
}
