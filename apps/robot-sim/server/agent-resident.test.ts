import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { ResidentAgent, type ProcLike } from "./agent-resident.js";
import type { AgentWorldContext } from "./agent-claude.js";

const ctx: AgentWorldContext = {
  battery: 80, pose: { x: 1, y: 1 }, estop: false, charging: false,
  stations: ["一号站点"], history: [],
};

/** 假 claude 进程：每收到一次 stdin 写入，就按脚本回一个 result 行。 */
function fakeProc(replies: unknown[]) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  let turn = 0;
  const proc: ProcLike & { _emit: (ev: "exit" | "error") => void } = {
    stdout: { on: (ev, cb) => void stdout.on(ev, cb) },
    stderr: { on: (ev, cb) => void stderr.on(ev, cb) },
    stdin: {
      write: () => {
        const reply = replies[turn++];
        queueMicrotask(() => {
          const line = JSON.stringify({ type: "result", structured_output: reply }) + "\n";
          stdout.emit("data", Buffer.from(line));
        });
      },
    },
    on: (ev, cb) => void emitter.on(ev, cb),
    removeAllListeners: () => emitter.removeAllListeners(),
    kill: () => {},
    _emit: (ev) => emitter.emit(ev),
  };
  return proc;
}

describe("ResidentAgent 常驻队列", () => {
  it("串行处理多轮并正确映射", async () => {
    const proc = fakeProc([
      { kind: "proposal", capabilityId: "robot.navigation.navigate_relative", arguments: { distanceM: 1 }, say: "前进1米" },
      { kind: "control", control: "cancel", say: "取消" },
    ]);
    const agent = new ResidentAgent(() => proc);
    const r1 = await agent.ask("前进一米", ctx);
    const r2 = await agent.ask("停", ctx);
    expect(r1?.proposal?.arguments.distanceM).toBe(1);
    expect(r2?.control).toBe("cancel");
    agent.stop();
  });

  it("不合规输出 → null（回退）", async () => {
    const proc = fakeProc([{ kind: "proposal" /* 缺 say */ }]);
    const agent = new ResidentAgent(() => proc);
    expect(await agent.ask("x", ctx)).toBeNull();
    agent.stop();
  });

  it("无法启动进程 → null", async () => {
    const agent = new ResidentAgent(() => null);
    expect(await agent.ask("x", ctx)).toBeNull();
  });

  it("stop 后 ask 直接返回 null", async () => {
    const agent = new ResidentAgent(() => fakeProc([]));
    agent.stop();
    expect(await agent.ask("x", ctx)).toBeNull();
  });
});
