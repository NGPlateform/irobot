import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  executeProposeAction,
  type MissionBinding,
  type ToolResultLike,
} from "@irobot/gateway-adapter";
import { Session } from "./session.js";
import { createSimServer } from "./server.js";

/**
 * 端到端集成：OpenClaw 侧插件代码（gateway-adapter）→ 真实 HTTP /v1/actions →
 * robot-sim 的 Orchestrator + SimRobot。这打通了架构里"北向插件 ↔ 外部 Command
 * Orchestrator"的真实线级连接（唯一未覆盖的是 OpenClaw 进程调用插件那一跳，需合规主机）。
 */
let session: Session;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  session = new Session();
  session.robot.start(10); // 只启机器人，不启 Agent（避免 spawn claude）
  server = createSimServer(session);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  session.robot.stop();
  await new Promise<void>((r) => server.close(() => r()));
});

const binding = (): MissionBinding => ({
  sessionId: "web-session",
  deviceId: "sim-robot-001",
  leaseEpoch: 1,
  expectedStateVersion: 1,
  traceId: "trace-int",
  actor: { type: "user", id: "u1" },
  modelSnapshot: {
    provider: "p", model: "m", promptHash: "sha256:x",
    toolCatalogVersion: "v1", policyVersion: "1",
  },
  proposalTimeoutMs: 60000,
});

describe("OpenClaw 插件 → robot-sim 外部 Orchestrator（真实 HTTP）", () => {
  it("navigate_relative：流式进度回传 + 终态 SUCCEEDED，机器人真的移动", async () => {
    const before = session.robot.telemetry().pose.x;
    const updates: ToolResultLike[] = [];
    const result = await executeProposeAction(
      {
        capabilityId: "robot.navigation.navigate_relative",
        capabilityVersion: "1.0.0",
        arguments: { distanceM: 0.3, maxSpeedMps: 0.6 },
        safetyClass: "S2_GUARDED",
      },
      { orchestratorUrl: baseUrl },
      binding(),
      { toolCallId: "tc-int-1", onUpdate: (u) => updates.push(u) },
    );
    const details = result.details as { finalState: string };
    expect(details.finalState).toBe("SUCCEEDED");
    expect(updates.length).toBeGreaterThan(0); // 收到流式 feedback
    expect(session.robot.telemetry().pose.x).toBeGreaterThan(before + 0.2); // 真的动了
  });

  it("query_battery：经插件链路返回电量（S0 同步）", async () => {
    const result = await executeProposeAction(
      {
        capabilityId: "robot.telemetry.query_battery",
        capabilityVersion: "1.0.0",
        arguments: {},
        safetyClass: "S0_OBSERVE",
      },
      { orchestratorUrl: baseUrl },
      binding(),
      { toolCallId: "tc-int-2" },
    );
    expect((result.details as { finalState: string }).finalState).toBe("SUCCEEDED");
  });

  it("safetyClass 由本地 manifest 派生，不信任北向声明：谎报 S0 的导航仍按 S2 前置条件校验", async () => {
    // 急停下即便声称 S0，导航前置条件 estop==false 不满足 → REJECTED（不会执行）。
    session.robot.setEstop(true);
    const result = await executeProposeAction(
      {
        capabilityId: "robot.navigation.navigate_relative",
        capabilityVersion: "1.0.0",
        arguments: { distanceM: 0.3 },
        safetyClass: "S0_OBSERVE", // 谎报
      },
      { orchestratorUrl: baseUrl },
      binding(),
      { toolCallId: "tc-int-3" },
    );
    session.robot.setEstop(false);
    expect((result.details as { finalState: string }).finalState).toBe("REJECTED");
  });
});
