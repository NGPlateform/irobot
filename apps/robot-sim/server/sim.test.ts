import { describe, it, expect } from "vitest";
import type { ActionEvent } from "@irobot/action-protocol";
import { SimRobot } from "./sim-robot.js";
import { Orchestrator } from "./orchestrator.js";
import { parseIntent, parseDistance } from "./nlu.js";

function makeStack() {
  const robot = new SimRobot(() => {});
  robot.start(10); // 快速 tick 便于测试
  const orch = new Orchestrator(robot);
  return { robot, orch };
}

describe("NLU 中文意图解析", () => {
  it("相对移动含中文/阿拉伯数字与方向", () => {
    expect(parseDistance("前进两米")).toBe(2);
    expect(parseDistance("往前走1.5米")).toBe(1.5);
    expect(parseDistance("后退一米")).toBe(-1);
    expect(parseDistance("一点五米")).toBe(1.5);
  });
  it("站点/查询/控制意图", () => {
    expect(parseIntent("去一号站点").proposal?.capabilityId).toBe("robot.navigation.navigate_to_station");
    expect(parseIntent("还有多少电").proposal?.capabilityId).toBe("robot.telemetry.query_battery");
    expect(parseIntent("急停").control).toBe("estop");
    expect(parseIntent("取消").control).toBe("cancel");
    expect(parseIntent("返回充电").proposal?.capabilityId).toBe("robot.navigation.return_to_dock");
  });
});

describe("仿真闭环：Orchestrator + SimRobot", () => {
  it("navigate_relative 走完整状态机到 SUCCEEDED，并有流式 feedback", async () => {
    const { robot, orch } = makeStack();
    const events: ActionEvent[] = [];
    const final = await orch.propose(
      { capabilityId: "robot.navigation.navigate_relative", arguments: { distanceM: 0.3, maxSpeedMps: 0.6 } },
      (e) => events.push(e),
    );
    robot.stop();
    const states = events.filter((e) => e.state).map((e) => e.state);
    expect(states).toEqual(
      expect.arrayContaining(["PROPOSED", "VALIDATING", "ACCEPTED", "EXECUTING", "SUCCEEDED"]),
    );
    expect(events.some((e) => e.kind === "feedback")).toBe(true);
    expect(final.state).toBe("SUCCEEDED");
  });

  it("query_battery 同步返回电量", async () => {
    const { robot, orch } = makeStack();
    const final = await orch.propose(
      { capabilityId: "robot.telemetry.query_battery", arguments: {} },
      () => {},
    );
    robot.stop();
    expect(final.state).toBe("SUCCEEDED");
    expect(typeof (final.payload as { percent: number }).percent).toBe("number");
  });

  it("急停时前置条件不满足 → REJECTED，动作不触达执行", async () => {
    const { robot, orch } = makeStack();
    robot.setEstop(true);
    const final = await orch.propose(
      { capabilityId: "robot.navigation.navigate_relative", arguments: { distanceM: 1 } },
      () => {},
    );
    robot.stop();
    expect(final.state).toBe("REJECTED");
    expect(String((final.payload as { reason: string }).reason)).toContain("safety.estop");
  });

  it("执行中取消 → CANCELLED", async () => {
    const { robot, orch } = makeStack();
    const p = orch.propose(
      { capabilityId: "robot.navigation.navigate_to_station", arguments: { station: "二号站点" } },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 60));
    orch.cancelActive();
    const final = await p;
    robot.stop();
    expect(final.state).toBe("CANCELLED");
  });

  it("未知站点 → REJECTED", async () => {
    const { robot, orch } = makeStack();
    const final = await orch.propose(
      { capabilityId: "robot.navigation.navigate_to_station", arguments: { station: "月球" } },
      () => {},
    );
    robot.stop();
    expect(final.state).toBe("REJECTED");
  });
});
