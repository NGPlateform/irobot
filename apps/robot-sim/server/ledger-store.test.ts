import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLedgerStore, MemoryLedgerStore, type LedgerEntry } from "./ledger-store.js";
import type { ActionEvent } from "@irobot/action-protocol";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  commandId: "cmd_1",
  idempotencyKey: "k1",
  capabilityId: "robot.navigation.navigate_relative",
  finalState: "SUCCEEDED",
  at: new Date(0).toISOString(),
  ...over,
});

const event = (): ActionEvent => ({
  commandId: "cmd_1",
  kind: "result",
  state: "SUCCEEDED",
  seq: 3,
  at: new Date(0).toISOString(),
  payload: { distanceTravelledM: 2 },
});

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("MemoryLedgerStore", () => {
  it("落账与幂等读写", () => {
    const s = new MemoryLedgerStore();
    s.append(entry());
    s.putIdempotent("k1", event());
    expect(s.all()).toHaveLength(1);
    expect(s.getIdempotent("k1")?.state).toBe("SUCCEEDED");
    expect(s.getIdempotent("nope")).toBeNull();
  });
});

describe("SqliteLedgerStore：重启不丢（§8.2 重启不丢已接受动作审计）", () => {
  it("落盘 → 关闭 → 重开同一文件，审计与幂等仍在", () => {
    dir = mkdtempSync(join(tmpdir(), "irobot-ledger-"));
    const path = join(dir, "orchestrator.sqlite");

    const s1 = new SqliteLedgerStore(path);
    s1.append(entry({ commandId: "cmd_A", idempotencyKey: "kA" }));
    s1.append(entry({ commandId: "cmd_B", idempotencyKey: "kB", deduplicated: true, reason: "deduplicated" }));
    s1.putIdempotent("kA", event());
    s1.close(); // 模拟进程退出

    const s2 = new SqliteLedgerStore(path); // 模拟重启后重新打开
    const all = s2.all();
    expect(all).toHaveLength(2);
    expect(all[0]!.commandId).toBe("cmd_A");
    expect(all[1]!.deduplicated).toBe(true);
    expect(all[1]!.reason).toBe("deduplicated");
    // 幂等缓存跨重启存活 → 重启后重复命令仍会去重
    expect(s2.getIdempotent("kA")?.state).toBe("SUCCEEDED");
    expect(s2.getIdempotent("kA")?.payload.distanceTravelledM).toBe(2);
    s2.close();
  });

  it("putIdempotent 幂等键去重（ON CONFLICT 覆盖，不重复行）", () => {
    dir = mkdtempSync(join(tmpdir(), "irobot-ledger-"));
    const s = new SqliteLedgerStore(join(dir, "d.sqlite"));
    s.putIdempotent("k", event());
    s.putIdempotent("k", { ...event(), seq: 9 });
    expect(s.getIdempotent("k")?.seq).toBe(9);
    s.close();
  });
});
