import { SimRobot, type Telemetry } from "./sim-robot.js";
import { Orchestrator } from "./orchestrator.js";
import type { LedgerStore } from "./ledger-store.js";
import type { EdgeClient } from "./edge-client.js";

export interface FleetMember {
  deviceId: string;
  robot: SimRobot;
  orchestrator: Orchestrator;
}

/**
 * 舰队：多台机器人，每台一个独立 deviceId + 独立 Orchestrator（各自单写者、租约世代）。
 * 不同设备是不同控制域，可完全并行；同一设备内仍单写者（架构 §9.2）。共享一个审计 store
 * （条目按 deviceId 区分）。Edge daemon 仅接主设备（其 EdgeGuard 为单设备状态）。
 */
export class Fleet {
  private readonly members: FleetMember[] = [];

  constructor(
    count: number,
    onTelemetry: (deviceId: string, t: Telemetry) => void,
    store: LedgerStore,
    edge?: EdgeClient,
  ) {
    const starts = [
      { x: 1, y: 1 },
      { x: 1, y: 7 },
      { x: 8.5, y: 1 },
      { x: 8.5, y: 7 },
    ];
    for (let i = 0; i < count; i++) {
      const deviceId = `robot-${i + 1}`;
      const start = starts[i % starts.length]!;
      const robot = new SimRobot((t) => onTelemetry(deviceId, t), start);
      const orchestrator = new Orchestrator(robot, undefined, store, i === 0 ? edge : undefined, deviceId);
      this.members.push({ deviceId, robot, orchestrator });
    }
  }

  all(): readonly FleetMember[] {
    return this.members;
  }
  deviceIds(): string[] {
    return this.members.map((m) => m.deviceId);
  }
  get(deviceId: string): FleetMember | undefined {
    return this.members.find((m) => m.deviceId === deviceId);
  }
  primary(): FleetMember {
    return this.members[0]!;
  }
  start(): void {
    for (const m of this.members) m.robot.start();
  }
  stop(): void {
    for (const m of this.members) m.robot.stop();
  }
}
