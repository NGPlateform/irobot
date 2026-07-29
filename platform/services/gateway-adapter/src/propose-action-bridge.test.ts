import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  executeProposeAction,
  type GatewayAdapterConfig,
  type MissionBinding,
  type ProposeActionParams,
  type ToolResultLike,
} from "./index.js";

/**
 * Mock Command Orchestrator：接受 ActionEnvelope，流式回 NDJSON 事件
 * （feedback×N → result）。用于证明 OpenClaw 侧桥接的"提案→流式→终态/取消"闭环，
 * 无需启动完整 OpenClaw 网关与模型（那是 Phase 1 e2e）。
 */
function ndjson(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/actions") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const envelope = JSON.parse(body);
      const commandId = envelope.commandId;
      res.writeHead(200, { "content-type": "application/x-ndjson" });

      // 慢动作导航被客户端取消时，req 的 aborted 会触发，我们停止推流。
      let aborted = false;
      req.on("aborted", () => {
        aborted = true;
      });

      res.write(
        ndjson({ commandId, kind: "state_changed", state: "EXECUTING", seq: 0, at: new Date().toISOString(), payload: {} }),
      );
      for (let i = 1; i <= 3; i++) {
        if (aborted) return;
        await new Promise((r) => setTimeout(r, 15));
        res.write(
          ndjson({ commandId, kind: "feedback", seq: i, at: new Date().toISOString(), progress: i / 3, payload: {} }),
        );
      }
      if (aborted) return;
      res.write(
        ndjson({
          commandId,
          kind: "result",
          state: "SUCCEEDED",
          seq: 4,
          at: new Date().toISOString(),
          payload: { distanceTravelledM: 2, finalPose: { x: 2, y: 0 } },
        }),
      );
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const config = (): GatewayAdapterConfig => ({ orchestratorUrl: baseUrl });

const binding = (): MissionBinding => ({
  sessionId: "session-456",
  deviceId: "robot-001",
  leaseEpoch: 72,
  expectedStateVersion: 1842,
  traceId: "trace-789",
  actor: { type: "user", id: "user-123" },
  modelSnapshot: {
    provider: "provider-name",
    model: "model-name",
    promptHash: "sha256:abc",
    toolCatalogVersion: "2026-07-30.1",
    policyVersion: "42",
  },
  proposalTimeoutMs: 60000,
});

const navParams = (): ProposeActionParams => ({
  capabilityId: "robot.navigation.navigate_relative",
  capabilityVersion: "1.0.0",
  arguments: { distanceM: 2, maxSpeedMps: 0.3 },
  safetyClass: "S2_GUARDED",
});

describe("OpenClaw 接入 Spike：propose_action → 外部 Orchestrator 流式闭环", () => {
  it("完成文本提案到外部 Orchestrator 的流式闭环，收到进度并以 SUCCEEDED 收尾", async () => {
    const updates: ToolResultLike[] = [];
    const result = await executeProposeAction(
      navParams(),
      config(),
      binding(),
      { toolCallId: "tc-1", onUpdate: (u) => updates.push(u) },
    );

    // 流式进度确实回传（feedback 映射到 onUpdate）。
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.some((u) => u.content[0]!.text.includes("已完成 100%"))).toBe(true);

    // 终态正确回落到工具结果。
    const details = result.details as { finalState: string; result: unknown };
    expect(details.finalState).toBe("SUCCEEDED");
    expect(result.content[0]!.text).toContain("SUCCEEDED");
  });

  it("S4_FORBIDDEN 在桥接层即被拒，永不触达 Orchestrator", async () => {
    const result = await executeProposeAction(
      { ...navParams(), safetyClass: "S4_FORBIDDEN" },
      config(),
      binding(),
      { toolCallId: "tc-2" },
    );
    const details = result.details as { rejected?: boolean };
    expect(details.rejected).toBe(true);
  });

  it("AbortSignal 透传：turn interruption 取消进行中的提案", async () => {
    const controller = new AbortController();
    // 首个进度到达后立即取消，模拟用户中途 barge-in。
    const promise = executeProposeAction(
      navParams(),
      config(),
      binding(),
      {
        toolCallId: "tc-3",
        signal: controller.signal,
        onUpdate: () => controller.abort(),
      },
    );
    await expect(promise).rejects.toThrow();
  });

  it("幂等键由 sessionId + toolCallId 稳定构成（重试不产生第二动作的前提）", async () => {
    // 相同 toolCallId → 相同 idempotencyKey；这里通过两次构造对比其确定性。
    const { buildEnvelope } = await import("./propose-action-bridge.js");
    const e1 = buildEnvelope(navParams(), binding(), 1_700_000_000_000, "tc-9");
    const e2 = buildEnvelope(navParams(), binding(), 1_700_000_000_000, "tc-9");
    expect(e1.idempotencyKey).toBe(e2.idempotencyKey);
    expect(e1.idempotencyKey).toBe("session-456:tc-9");
    // commandId 每次唯一（新提案），但幂等去重靠 idempotencyKey。
    expect(e1.commandId).not.toBe(e2.commandId);
  });
});
