import type { NluResult } from "./nlu.js";
import {
  OUTPUT_SCHEMA,
  systemPrompt,
  stateLine,
  mapAgentOutput,
  type AgentWorldContext,
} from "./agent-claude.js";

/**
 * 直连 Anthropic Messages API 的近实时 Agent 后端。
 *
 * 相比常驻 CLI，绕开 Claude Code harness 的额外 turn 与开销，配合 prompt 缓存
 * （system + 工具定义标记 cache_control），热调用可到亚秒级。零依赖：用全局 fetch。
 *
 * 与其它后端同形：强制模型调用 emit_decision 工具产出结构化提案（tool_choice），
 * 只提议不执行；出错/无 key 返回 null，由 Session 回退。需 ANTHROPIC_API_KEY。
 */

const API_URL = process.env.ANTHROPIC_BASE_URL
  ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/$/, "")}/v1/messages`
  : "https://api.anthropic.com/v1/messages";

const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
  fable: "claude-fable-5",
};

function resolveModel(): string {
  const explicit = process.env.IROBOT_API_MODEL;
  if (explicit) return explicit;
  const alias = process.env.IROBOT_AGENT_MODEL ?? "haiku";
  return MODEL_ALIASES[alias] ?? MODEL_ALIASES.haiku!;
}

export function apiKeyAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

/** 构造 Messages API 请求体。system + tools 标记 cache_control 以命中 prompt 缓存。 */
export function buildRequest(messages: ApiMessage[], model: string): unknown {
  return {
    model,
    max_tokens: 400,
    system: [
      { type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "emit_decision",
        description: "输出机器人控制决策（唯一允许的输出方式）",
        input_schema: OUTPUT_SCHEMA,
        cache_control: { type: "ephemeral" },
      },
    ],
    tool_choice: { type: "tool", name: "emit_decision" },
    messages,
  };
}

/** 从 API 响应中取出被强制调用的 emit_decision 工具输入并映射为 NluResult。 */
export function parseApiResponse(json: unknown): NluResult | null {
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "tool_use" &&
      (block as { name?: string }).name === "emit_decision"
    ) {
      return mapAgentOutput((block as { input?: unknown }).input);
    }
  }
  return null;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export class ApiAgent {
  private history: ApiMessage[] = [];
  private readonly model = resolveModel();

  constructor(
    private fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike,
    private timeoutMs = 15000,
  ) {}

  async ask(text: string, ctx: AgentWorldContext): Promise<NluResult | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const userMsg: ApiMessage = { role: "user", content: stateLine(ctx, text) };
    const messages = [...this.history, userMsg];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(buildRequest(messages, this.model)),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const result = parseApiResponse(await res.json());
      if (result) {
        // 存精简历史（用户话 + 助手口播），供多轮指代；不做工具回执 plumbing。
        this.history.push(userMsg, { role: "assistant", content: result.reply });
        if (this.history.length > 12) this.history = this.history.slice(-12);
      }
      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this.history = [];
  }
}
