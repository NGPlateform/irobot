import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EdgeClient, type ProcLike, type EdgeAdmitReq } from "./edge-client.js";

const req = (over: Partial<EdgeAdmitReq> = {}): EdgeAdmitReq => ({
  commandId: "cmd1",
  idempotencyKey: "k1",
  capabilityId: "robot.navigation.navigate_relative",
  safetyClass: "S2_GUARDED",
  concurrencyKey: "base_motion",
  deadlineMs: 60000,
  leaseEpoch: 5,
  ...over,
});

/** 假进程：每次 stdin 写入，按 handler 生成一行回复。 */
function fakeProc(handler: (line: string) => string) {
  let onData: ((d: Buffer) => void) | null = null;
  const listeners: Record<string, () => void> = {};
  const proc: ProcLike & { fire: (ev: "exit" | "error") => void } = {
    stdout: { on: (_e, cb) => { onData = cb as (d: Buffer) => void; } },
    stderr: { on: () => {} },
    stdin: {
      write: (s: string) => {
        const line = s.replace(/\n$/, "");
        const reply = handler(line);
        queueMicrotask(() => onData?.(Buffer.from(reply + "\n")));
      },
    },
    on: (ev, cb) => { listeners[ev] = cb; },
    kill: () => {},
    fire: (ev) => listeners[ev]?.(),
  };
  return proc;
}

describe("EdgeClient（假进程）", () => {
  it("accepted / rejected 映射", async () => {
    const proc = fakeProc((line) => {
      const cmd = line.split("\t")[1];
      return line.includes("S4_FORBIDDEN") ? `REJECT\t${cmd}\tforbidden` : `ACCEPTED\t${cmd}`;
    });
    const c = new EdgeClient("x", () => proc);
    c.start();
    expect(await c.admit(req(), 0)).toEqual({ kind: "accepted" });
    expect(await c.admit(req({ safetyClass: "S4_FORBIDDEN" }), 0)).toEqual({
      kind: "rejected",
      reason: "forbidden",
    });
    c.stop();
  });

  it("dedup 映射", async () => {
    const proc = fakeProc((line) => `DEDUP\t${line.split("\t")[1]}\tSUCCEEDED`);
    const c = new EdgeClient("x", () => proc);
    c.start();
    expect(await c.admit(req(), 0)).toEqual({ kind: "deduplicated", cachedState: "SUCCEEDED" });
    c.stop();
  });

  it("进程退出 → fail-closed 拒绝", async () => {
    const proc = fakeProc(() => "ACCEPTED\tc");
    const c = new EdgeClient("x", () => proc);
    c.start();
    proc.fire("exit");
    const d = await c.admit(req(), 0);
    expect(d.kind).toBe("rejected");
  });

  it("spawn 失败 → admit 拒绝", async () => {
    const c = new EdgeClient("x", () => null);
    expect(c.start()).toBe(false);
    const d = await c.admit(req(), 0);
    expect(d.kind).toBe("rejected");
  });
});

// 对真实 Rust edge-daemon 的集成测试（需先 cargo build --bin edge-daemon）。
const DAEMON = fileURLToPath(new URL("../../../edge/runtime/target/debug/edge-daemon", import.meta.url));
const hasDaemon = existsSync(DAEMON);

describe.skipIf(!hasDaemon)("EdgeClient ↔ 真实 Rust edge-daemon", () => {
  it("并发互斥/去重由 Rust 进程真实判定", async () => {
    const c = new EdgeClient(DAEMON);
    expect(c.start()).toBe(true);
    // 首个占用 base_motion
    expect((await c.admit(req({ commandId: "a", idempotencyKey: "ka" }), 100)).kind).toBe("accepted");
    // 同 key 第二个 → Rust 拒绝 busy
    const busy = await c.admit(req({ commandId: "b", idempotencyKey: "kb" }), 100);
    expect(busy.kind).toBe("rejected");
    expect(busy.kind === "rejected" && busy.reason).toContain("busy");
    // 完成 a → 释放
    await c.complete(req({ commandId: "a", idempotencyKey: "ka" }), "SUCCEEDED", 200);
    // 现在同 key 可通过
    expect((await c.admit(req({ commandId: "c", idempotencyKey: "kc" }), 300)).kind).toBe("accepted");
    // 幂等重放：同 idempotencyKey ka（已 SUCCEEDED）→ Rust DEDUP
    const dedup = await c.admit(req({ commandId: "a2", idempotencyKey: "ka", concurrencyKey: "arm" }), 400);
    expect(dedup.kind).toBe("deduplicated");
    c.stop();
  });
});
