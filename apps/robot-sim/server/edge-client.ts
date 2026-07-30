import { spawn } from "node:child_process";

/**
 * Rust Edge daemon 客户端：把执行写动作前的准入判定交给独立的 Rust 进程
 * （架构里的 Edge 权威安全层）。行协议见 edge/runtime/src/protocol.rs。
 *
 * 串行请求-应答（一次一行）；进程崩溃 → fail-closed（拒绝），因为它是安全层。
 * spawn 可注入以便测试。
 */
export interface EdgeAdmitReq {
  commandId: string;
  idempotencyKey: string;
  capabilityId: string;
  safetyClass: string;
  concurrencyKey: string;
  deadlineMs?: number | undefined;
  leaseEpoch?: number | undefined;
}

export type EdgeDecision =
  | { kind: "accepted" }
  | { kind: "deduplicated"; cachedState: string }
  | { kind: "rejected"; reason: string };

export interface ProcLike {
  stdout: { on(ev: "data", cb: (d: Buffer | string) => void): void };
  stderr: { on(ev: "data", cb: (d: Buffer | string) => void): void };
  stdin: { write(s: string): void };
  on(ev: "exit" | "error", cb: () => void): void;
  kill(): void;
}
export type SpawnFn = (bin: string) => ProcLike | null;

const defaultSpawn: SpawnFn = (bin) => {
  try {
    return spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ProcLike;
  } catch {
    return null;
  }
};

const dash = (n?: number) => (n == null ? "-" : String(n));

export class EdgeClient {
  private proc: ProcLike | null = null;
  private buffer = "";
  private readonly pending: Array<(line: string) => void> = [];
  private alive = false;

  constructor(
    private bin: string,
    private spawnFn: SpawnFn = defaultSpawn,
  ) {}

  start(): boolean {
    if (this.proc) return true;
    const p = this.spawnFn(this.bin);
    if (!p) return false;
    this.proc = p;
    this.alive = true;
    p.stdout.on("data", (d) => this.onData(d.toString()));
    p.stderr.on("data", () => {});
    const gone = () => this.onGone();
    p.on("exit", gone);
    p.on("error", gone);
    return true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      const resolve = this.pending.shift();
      if (resolve) resolve(line);
    }
  }

  private onGone(): void {
    this.alive = false;
    this.proc = null;
    // fail-closed：所有在途请求按拒绝收尾。
    for (const resolve of this.pending.splice(0)) resolve("REJECT\t-\tedge daemon exited");
  }

  private send(line: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.alive || !this.proc) {
        resolve("REJECT\t-\tedge daemon unavailable");
        return;
      }
      this.pending.push(resolve);
      try {
        this.proc.stdin.write(line + "\n");
      } catch {
        // 写失败：从队列取回并拒绝
        const idx = this.pending.lastIndexOf(resolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        resolve("REJECT\t-\tedge write failed");
      }
    });
  }

  async admit(req: EdgeAdmitReq, nowMs: number): Promise<EdgeDecision> {
    const line = [
      "ADMIT", req.commandId, req.idempotencyKey, req.capabilityId,
      req.safetyClass, req.concurrencyKey, dash(req.deadlineMs), dash(req.leaseEpoch),
      String(nowMs),
    ].join("\t");
    const reply = (await this.send(line)).split("\t");
    switch (reply[0]) {
      case "ACCEPTED":
        return { kind: "accepted" };
      case "DEDUP":
        return { kind: "deduplicated", cachedState: reply[2] ?? "SUCCEEDED" };
      default:
        return { kind: "rejected", reason: reply.slice(2).join("\t") || "edge rejected" };
    }
  }

  /** 推送本地状态快照给 Edge（供 S2/S3 安全重校验读本地实时状态）。 */
  async setState(estop: boolean, locHealthy: boolean, battery: number): Promise<void> {
    const line = ["STATE", estop ? "1" : "0", locHealthy ? "1" : "0", String(battery)].join("\t");
    await this.send(line);
  }

  async complete(
    req: EdgeAdmitReq,
    finalState: string,
    nowMs: number,
  ): Promise<void> {
    const line = [
      "COMPLETE", req.commandId, req.idempotencyKey, req.capabilityId,
      req.concurrencyKey, finalState, dash(req.leaseEpoch), String(nowMs),
    ].join("\t");
    await this.send(line); // 等 OK，保持管道同步
  }

  stop(): void {
    this.alive = false;
    this.proc?.kill();
    this.proc = null;
  }
}
