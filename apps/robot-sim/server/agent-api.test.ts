import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildRequest,
  parseApiResponse,
  apiKeyAvailable,
  ApiAgent,
  type ApiMessage,
} from "./agent-api.js";
import type { AgentWorldContext } from "./agent-claude.js";

const ctx: AgentWorldContext = {
  battery: 80, pose: { x: 1, y: 1 }, estop: false, charging: false,
  stations: ["一号站点"], history: [],
};

const toolResponse = (input: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({
    content: [{ type: "tool_use", name: "emit_decision", input }],
  }),
});

describe("buildRequest：强制工具 + prompt 缓存", () => {
  it("system 与 tool 标记 cache_control，且强制 tool_choice", () => {
    const body = buildRequest([{ role: "user", content: "hi" }], "claude-haiku-4-5-20251001") as any;
    expect(body.system[0].cache_control.type).toBe("ephemeral");
    expect(body.tools[0].cache_control.type).toBe("ephemeral");
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_decision" });
    expect(body.tools[0].name).toBe("emit_decision");
    expect(body.messages).toHaveLength(1);
  });
});

describe("parseApiResponse：tool_use → NluResult", () => {
  it("取出 emit_decision 输入并映射", () => {
    const r = parseApiResponse({
      content: [
        { type: "text", text: "…" },
        { type: "tool_use", name: "emit_decision", input: { kind: "proposal", capabilityId: "robot.navigation.return_to_dock", arguments: {}, say: "返回充电" } },
      ],
    });
    expect(r?.proposal?.capabilityId).toBe("robot.navigation.return_to_dock");
  });
  it("无工具块 → null", () => {
    expect(parseApiResponse({ content: [{ type: "text", text: "x" }] })).toBeNull();
  });
});

describe("ApiAgent.ask", () => {
  const KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = "sk-test"; });
  afterEach(() => { if (KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = KEY; });

  it("无 key → null", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const agent = new ApiAgent(async () => toolResponse({}) as any);
    expect(await agent.ask("前进", ctx)).toBeNull();
  });

  it("成功调用 → 提案，并携带鉴权头", async () => {
    let seenHeaders: any;
    const agent = new ApiAgent(async (_url, init) => {
      seenHeaders = (init as any).headers;
      return toolResponse({ kind: "proposal", capabilityId: "robot.navigation.navigate_relative", arguments: { distanceM: 2 }, say: "前进2米" }) as any;
    });
    const r = await agent.ask("前进两米", ctx);
    expect(r?.proposal?.arguments.distanceM).toBe(2);
    expect(seenHeaders["x-api-key"]).toBe("sk-test");
    expect(seenHeaders["anthropic-version"]).toBe("2023-06-01");
  });

  it("多轮携带历史（第二次请求 messages 增长）", async () => {
    const lens: number[] = [];
    const agent = new ApiAgent(async (_url, init) => {
      lens.push(JSON.parse((init as any).body).messages.length);
      return toolResponse({ kind: "smalltalk", say: "好" }) as any;
    });
    await agent.ask("你好", ctx);
    await agent.ask("再说一次", ctx);
    expect(lens[0]).toBe(1);
    expect(lens[1]).toBe(3); // user + assistant + 新 user
  });

  it("非 200 → null（回退）", async () => {
    const agent = new ApiAgent(async () => ({ ok: false, status: 429, json: async () => ({}) }) as any);
    expect(await agent.ask("前进", ctx)).toBeNull();
  });

  it("apiKeyAvailable 反映 env", () => {
    expect(apiKeyAvailable()).toBe(true);
  });
});
