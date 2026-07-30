import { createRequire } from "node:module";
import type { ActionEvent, ActionState } from "@irobot/action-protocol";

// node:sqlite 是较新的内置模块，vite/vitest 的静态解析器不认（会把 "node:sqlite"
// 误当成 npm 包 "sqlite"）。用运行时 require 绕过静态分析，node/tsx/vitest 均可用。
const nodeRequire = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (path: string) => SqliteDb;

/** Action Ledger 条目：每个命令一生一条终态审计（安全不变量：每次动作可追踪）。 */
export interface LedgerEntry {
  commandId: string;
  idempotencyKey: string;
  capabilityId: string;
  finalState: ActionState;
  reason?: string;
  leaseEpoch?: number;
  expectedStateVersion?: number;
  deduplicated?: boolean;
  /** 决策来源：orchestrator（TS 慢环）或 edge（Rust 权威准入）。 */
  source?: "orchestrator" | "edge";
  at: string;
}

/**
 * 审计 + 幂等的持久化契约。Orchestrator 只依赖此接口：
 * 测试用内存实现；生产用 SQLite 实现（重启不丢已接受动作审计，§8.2）。
 */
export interface LedgerStore {
  append(entry: LedgerEntry): void;
  all(): LedgerEntry[];
  getIdempotent(key: string): ActionEvent | null;
  putIdempotent(key: string, event: ActionEvent): void;
  close(): void;
}

/** 内存实现（默认；有界）。 */
export class MemoryLedgerStore implements LedgerStore {
  private readonly entries: LedgerEntry[] = [];
  private readonly idem = new Map<string, ActionEvent>();

  append(entry: LedgerEntry): void {
    this.entries.push(entry);
    if (this.entries.length > 1000) this.entries.shift();
  }
  all(): LedgerEntry[] {
    return [...this.entries];
  }
  getIdempotent(key: string): ActionEvent | null {
    return this.idem.get(key) ?? null;
  }
  putIdempotent(key: string, event: ActionEvent): void {
    this.idem.set(key, event);
  }
  close(): void {}
}

/**
 * SQLite 实现（node:sqlite，同步，WAL）。审计与幂等均落盘，进程重启后仍可查、仍去重。
 * 符合架构 SQLite-first 与"写事务为同步提交段"的约束。
 */
export class SqliteLedgerStore implements LedgerStore {
  private readonly db: SqliteDb;

  constructor(path: string) {
    const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        final_state TEXT NOT NULL,
        reason TEXT,
        lease_epoch INTEGER,
        expected_state_version INTEGER,
        deduplicated INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'orchestrator',
        at TEXT NOT NULL
      );
    `);
    // 兼容旧库：若无 source 列则补上（新库已含）。
    try {
      this.db.exec(`ALTER TABLE action_ledger ADD COLUMN source TEXT NOT NULL DEFAULT 'orchestrator'`);
    } catch {
      /* 列已存在 */
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `);
  }

  append(e: LedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO action_ledger
         (command_id, idempotency_key, capability_id, final_state, reason, lease_epoch, expected_state_version, deduplicated, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.commandId,
        e.idempotencyKey,
        e.capabilityId,
        e.finalState,
        e.reason ?? null,
        e.leaseEpoch ?? null,
        e.expectedStateVersion ?? null,
        e.deduplicated ? 1 : 0,
        e.source ?? "orchestrator",
        e.at,
      );
  }

  all(): LedgerEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM action_ledger ORDER BY seq ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      commandId: String(r.command_id),
      idempotencyKey: String(r.idempotency_key),
      capabilityId: String(r.capability_id),
      finalState: String(r.final_state) as ActionState,
      reason: r.reason == null ? undefined : String(r.reason),
      leaseEpoch: r.lease_epoch == null ? undefined : Number(r.lease_epoch),
      expectedStateVersion:
        r.expected_state_version == null ? undefined : Number(r.expected_state_version),
      deduplicated: Number(r.deduplicated) === 1,
      source: (r.source == null ? "orchestrator" : String(r.source)) as "orchestrator" | "edge",
      at: String(r.at),
    }));
  }

  getIdempotent(key: string): ActionEvent | null {
    const row = this.db
      .prepare(`SELECT event_json FROM idempotency WHERE key = ?`)
      .get(key) as { event_json?: string } | undefined;
    if (!row?.event_json) return null;
    try {
      return JSON.parse(row.event_json) as ActionEvent;
    } catch {
      return null;
    }
  }

  putIdempotent(key: string, event: ActionEvent): void {
    this.db
      .prepare(
        `INSERT INTO idempotency (key, event_json, at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET event_json = excluded.event_json, at = excluded.at`,
      )
      .run(key, JSON.stringify(event), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
