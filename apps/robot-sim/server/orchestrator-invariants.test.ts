import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { parseActionEnvelope } from "@irobot/action-protocol";
import { SimRobot } from "./sim-robot.js";
import { Orchestrator } from "./orchestrator.js";

function stack() {
  const robot = new SimRobot(() => {});
  robot.start(10);
  return { robot, orch: new Orchestrator(robot) };
}

function envelope(over: Record<string, unknown> = {}) {
  return parseActionEnvelope({
    commandId: `cmd_${randomUUID()}`,
    idempotencyKey: "sess:tc-1",
    deviceId: "sim-robot-001",
    capabilityId: "robot.navigation.navigate_relative",
    capabilityVersion: "1.0.0",
    arguments: { distanceM: 0.3, maxSpeedMps: 0.6 },
    expectedStateVersion: 1,
    preconditions: [],
    deadline: new Date(Date.now() + 60000).toISOString(),
    priority: 50,
    safetyClass: "S2_GUARDED",
    leaseEpoch: 5,
    actor: { type: "user", id: "u1" },
    traceId: "t1",
    modelSnapshot: { provider: "p", model: "m", promptHash: "h", toolCatalogVersion: "v", policyVersion: "1" },
    ...over,
  });
}

describe("Orchestrator 安全不变量（开发计划 §8.2）", () => {
  it("幂等去重：相同 idempotencyKey 重试不产生第二次物理动作", async () => {
    const { robot, orch } = stack();
    const x0 = robot.telemetry().pose.x;
    const key = "sess:same-key";
    const e1 = envelope({ idempotencyKey: key });
    const first = await orch.executeEnvelope(e1, () => {});
    const xAfter1 = robot.telemetry().pose.x;
    // 同一 idempotencyKey、不同 commandId 的重试
    const e2 = envelope({ idempotencyKey: key });
    let secondStates: string[] = [];
    const second = await orch.executeEnvelope(e2, (ev) => ev.state && secondStates.push(ev.state));
    const xAfter2 = robot.telemetry().pose.x;
    robot.stop();

    expect(first.state).toBe("SUCCEEDED");
    expect(xAfter1).toBeGreaterThan(x0 + 0.2); // 第一次真的动了
    // 第二次重放：不再移动，标记 deduplicated
    expect((second.payload as { deduplicated?: boolean }).deduplicated).toBe(true);
    expect(Math.abs(xAfter2 - xAfter1)).toBeLessThan(0.05); // 没有二次位移
    expect(secondStates).not.toContain("EXECUTING"); // 未再进入执行
  });

  it("过期命令（deadline 已过）→ REJECTED，不执行", async () => {
    const { robot, orch } = stack();
    const e = envelope({ idempotencyKey: "sess:expired", deadline: new Date(Date.now() - 1000).toISOString() });
    const final = await orch.executeEnvelope(e, () => {});
    robot.stop();
    expect(final.state).toBe("REJECTED");
    expect(String((final.payload as { reason: string }).reason)).toContain("过期");
  });

  it("租约 fencing：较旧 leaseEpoch 被拒，新 epoch 通过", async () => {
    const { robot, orch } = stack();
    // 先用 epoch 10 建立当前世代
    await orch.executeEnvelope(envelope({ idempotencyKey: "k-new", leaseEpoch: 10 }), () => {});
    // 再来一个旧 epoch 8 → 拒绝
    const stale = await orch.executeEnvelope(envelope({ idempotencyKey: "k-stale", leaseEpoch: 8 }), () => {});
    robot.stop();
    expect(stale.state).toBe("REJECTED");
    expect(String((stale.payload as { reason: string }).reason)).toContain("旧租约");
  });

  it("concurrencyKey 互斥：同 key 第二个写动作被拒；不同 key(查询)不受阻", async () => {
    const { robot, orch } = stack();
    // 动作1：导航到远站点（base_motion），不 await，让它进入执行并占用 key
    const p1 = orch.propose(
      { capabilityId: "robot.navigation.navigate_to_station", arguments: { station: "二号站点" } },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 40)); // 等 base_motion 占用
    // 动作2：同 concurrencyKey(base_motion) → 应被拒
    const busy = await orch.propose(
      { capabilityId: "robot.navigation.navigate_relative", arguments: { distanceM: 1 } },
      () => {},
    );
    expect(busy.state).toBe("REJECTED");
    expect(String((busy.payload as { reason: string }).reason)).toContain("concurrencyKey");
    // 查询(telemetry key，只读) → 不受 base_motion 占用影响
    const q = await orch.propose(
      { capabilityId: "robot.telemetry.query_battery", arguments: {} },
      () => {},
    );
    expect(q.state).toBe("SUCCEEDED");
    // 取消动作1收尾并确认 key 释放：随后同 key 动作可被接受(进入执行)
    orch.cancelActive();
    await p1;
    const states: string[] = [];
    const p3 = orch.propose(
      { capabilityId: "robot.navigation.navigate_relative", arguments: { distanceM: 0.2, maxSpeedMps: 0.6 } },
      (e) => e.state && states.push(e.state),
    );
    await p3;
    robot.stop();
    expect(states).toContain("EXECUTING"); // key 已释放，可再次执行
  });

  it("Action Ledger：每个命令落一条终态审计，去重项标记 deduplicated", async () => {
    const { robot, orch } = stack();
    await orch.executeEnvelope(envelope({ idempotencyKey: "led-1" }), () => {});
    await orch.executeEnvelope(envelope({ idempotencyKey: "led-1" }), () => {}); // 去重
    await orch.executeEnvelope(envelope({ idempotencyKey: "led-2", leaseEpoch: 5 }), () => {});
    robot.stop();
    const led = orch.ledger();
    expect(led.length).toBe(3);
    expect(led.every((e) => e.finalState && e.capabilityId && e.at)).toBe(true);
    expect(led.filter((e) => e.deduplicated).length).toBe(1);
  });
});
