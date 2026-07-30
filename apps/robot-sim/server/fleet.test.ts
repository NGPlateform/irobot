import { describe, it, expect } from "vitest";
import { Fleet } from "./fleet.js";
import { MemoryLedgerStore, type LedgerStore } from "./ledger-store.js";

function makeFleet(n: number): { f: Fleet; store: LedgerStore } {
  const store = new MemoryLedgerStore();
  const f = new Fleet(n, () => {}, store);
  for (const m of f.all()) m.robot.start(10); // 快 tick 便于测试
  return { f, store };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const navTo = (station: string) => ({
  capabilityId: "robot.navigation.navigate_to_station",
  arguments: { station },
});
const navRel = (d: number) => ({
  capabilityId: "robot.navigation.navigate_relative",
  arguments: { distanceM: d, maxSpeedMps: 0.6 },
});

describe("Fleet 多机器人（不同控制域并行，同设备单写者）", () => {
  it("跨设备并行：robot-1 与 robot-2 同时导航", async () => {
    const { f } = makeFleet(2);
    let e1 = false, e2 = false;
    const p1 = f.get("robot-1")!.orchestrator.propose(navTo("二号站点"), (e) => { if (e.state === "EXECUTING") e1 = true; });
    const p2 = f.get("robot-2")!.orchestrator.propose(navTo("大厅"), (e) => { if (e.state === "EXECUTING") e2 = true; });
    await waitFor(() => e1 && e2);
    expect(f.get("robot-1")!.robot.isBusy()).toBe(true);
    expect(f.get("robot-2")!.robot.isBusy()).toBe(true);
    f.get("robot-1")!.orchestrator.cancelActive();
    f.get("robot-2")!.orchestrator.cancelActive();
    await Promise.all([p1, p2]);
    f.stop();
  });

  it("每设备独立单写者：robot-1 同 base_motion 冲突，robot-2 不受影响", async () => {
    const { f } = makeFleet(2);
    let e1 = false;
    const p1 = f.get("robot-1")!.orchestrator.propose(navTo("二号站点"), (e) => { if (e.state === "EXECUTING") e1 = true; });
    await waitFor(() => e1);
    // robot-1 第二个 base_motion → 拒（同设备单写者）
    const busy = await f.get("robot-1")!.orchestrator.propose(navRel(1), () => {});
    expect(busy.state).toBe("REJECTED");
    // robot-2 base_motion → 接受（不同控制域，并行）
    let e2 = false;
    const p2 = f.get("robot-2")!.orchestrator.propose(navRel(0.3), (e) => { if (e.state === "EXECUTING") e2 = true; });
    await waitFor(() => e2);
    f.get("robot-1")!.orchestrator.cancelActive();
    await Promise.all([p1, p2]);
    f.stop();
  });

  it("共享审计带 deviceId 区分每台机器人", async () => {
    const { f, store } = makeFleet(2);
    await f.get("robot-1")!.orchestrator.propose({ capabilityId: "robot.telemetry.query_battery", arguments: {} }, () => {});
    await f.get("robot-2")!.orchestrator.propose({ capabilityId: "robot.telemetry.query_battery", arguments: {} }, () => {});
    f.stop();
    const led = store.all();
    expect(led.some((e) => e.deviceId === "robot-1")).toBe(true);
    expect(led.some((e) => e.deviceId === "robot-2")).toBe(true);
  });

  it("默认 1 台（兼容单机行为）", () => {
    const { f } = makeFleet(1);
    expect(f.deviceIds()).toEqual(["robot-1"]);
    expect(f.primary().deviceId).toBe("robot-1");
    f.stop();
  });
});
