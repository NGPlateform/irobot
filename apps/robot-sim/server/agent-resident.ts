import { spawn } from "node:child_process";
import type { NluResult } from "./nlu.js";
import {
  OUTPUT_SCHEMA,
  systemPrompt,
  stateLine,
  mapAgentOutput,
  type AgentWorldContext,
} from "./agent-claude.js";

const MODEL = process.env.IROBOT_AGENT_MODEL ?? "haiku";
const TURN_TIMEOUT_MS = Number(process.env.IROBOT_AGENT_TIMEOUT_MS ?? 30000);

/** 进程的最小接口，便于注入假实现测试。 */
export interface ProcLike {
  stdout: { on(ev: "data", cb: (d: Buffer | string) => void): void };
  stderr: { on(ev: "data", cb: (d: Buffer | string) => void): void };
  stdin: { write(s: string): void };
  on(ev: "exit" | "error", cb: () => void): void;
  removeAllListeners(): void;
  kill(): void;
}
export type SpawnFn = () => ProcLike | null;

function defaultSpawn(): ProcLike | null {
  try {
    return spawn(
      "claude",
      [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", MODEL,
        "--append-system-prompt", systemPrompt(),
        "--json-schema", JSON.stringify(OUTPUT_SCHEMA),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ) as unknown as ProcLike;
  } catch {
    return null;
  }
}

interface Pending {
  resolve: (r: NluResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 常驻 LLM Agent：一个长驻 `claude` 进程，stream-json 双向流。多轮对话由进程原生保持，
 * prompt 缓存跨轮复用（首轮建缓存，后续 cache_read 命中），无需每轮重启或重发历史。
 *
 * 契约不变：仍只产出声明式提案（NluResult）。串行处理（一次一轮）；超时或崩溃自动
 * 重启并对当前轮返回 null，由 Session 回退规则式 NLU（fail-closed，不阻塞对话）。
 */
export class ResidentAgent {
  private proc: ProcLike | null = null;
  private buffer = "";
  private pending: Pending | null = null;
  private queue: Array<{ text: string; ctx: AgentWorldContext; resolve: (r: NluResult | null) => void }> = [];
  private stopped = false;

  constructor(private spawnProc: SpawnFn = defaultSpawn) {}

  private ensureProc(): boolean {
    if (this.proc) return true;
    const proc = this.spawnProc();
    if (!proc) {
      this.proc = null;
      return false;
    }
    this.proc = proc;
    this.buffer = "";
    proc.stdout.on("data", (d) => this.onStdout(d.toString()));
    proc.stderr.on("data", () => {}); // 忽略 CLI 诊断/hook 噪声
    const onGone = () => this.onProcGone();
    proc.on("exit", onGone);
    proc.on("error", onGone);
    return true;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg: { type?: string; structured_output?: unknown; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "result") this.onResult(msg);
    }
  }

  private onResult(msg: { structured_output?: unknown; result?: unknown }): void {
    if (!this.pending) return;
    let candidate: unknown = msg.structured_output;
    if (candidate === undefined && typeof msg.result === "string") {
      try {
        candidate = JSON.parse(msg.result);
      } catch {
        candidate = undefined;
      }
    }
    this.settle(mapAgentOutput(candidate));
  }

  private onProcGone(): void {
    this.proc = null;
    this.buffer = "";
    // 当前轮失败 → null（回退）。队列在下次 pump 时重启进程重试。
    if (this.pending) this.settle(null);
    else if (!this.stopped) this.pump();
  }

  private settle(result: NluResult | null): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(result);
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.pending || this.queue.length === 0) return;
    if (!this.ensureProc() || !this.proc) {
      // 无法启动 CLI：整队回退。
      for (const item of this.queue.splice(0)) item.resolve(null);
      return;
    }
    const item = this.queue.shift()!;
    const timer = setTimeout(() => {
      // 超时：为避免请求/响应错位，杀掉重启。
      this.settle(null);
      this.restart();
    }, TURN_TIMEOUT_MS);
    this.pending = { resolve: item.resolve, timer };
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: stateLine(item.ctx, item.text) },
    });
    try {
      this.proc.stdin.write(payload + "\n");
    } catch {
      this.settle(null);
      this.restart();
    }
  }

  private restart(): void {
    const p = this.proc;
    this.proc = null;
    this.buffer = "";
    if (p) {
      p.removeAllListeners();
      p.kill();
    }
  }

  /** 提交一轮。返回 NluResult 或 null（调用方回退规则式）。串行排队。 */
  ask(text: string, ctx: AgentWorldContext): Promise<NluResult | null> {
    if (this.stopped) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.queue.push({ text, ctx, resolve });
      this.pump();
    });
  }

  /** 预热：启动进程（可选；首轮也会自动启动）。 */
  warmup(): void {
    this.ensureProc();
  }

  stop(): void {
    this.stopped = true;
    if (this.pending) this.settle(null);
    this.restart();
  }
}
