import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseActionEnvelope, ActionEnvelope } from "./index.js";

const url = new URL(
  "../fixtures/navigate_relative.envelope.json",
  import.meta.url,
);
const golden = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));

describe("Action Envelope v0.1（golden fixture）", () => {
  it("golden envelope 通过校验", () => {
    const e = parseActionEnvelope(golden);
    expect(e.commandId).toBe(golden.commandId);
    expect(e.leaseEpoch).toBe(72);
    expect(e.safetyClass).toBe("S2_GUARDED");
  });

  it("strict：拒绝未知字段防协议漂移", () => {
    expect(() => parseActionEnvelope({ ...golden, extra: true })).toThrow();
  });

  it("缺少 idempotencyKey 被拒绝（恰好一次效果的前提）", () => {
    const { idempotencyKey, ...rest } = golden;
    void idempotencyKey;
    expect(() => parseActionEnvelope(rest)).toThrow();
  });

  it("缺少 leaseEpoch 被拒绝（fencing 前提）", () => {
    const { leaseEpoch, ...rest } = golden;
    void leaseEpoch;
    expect(() => parseActionEnvelope(rest)).toThrow();
  });

  it("非 ISO deadline 被拒绝", () => {
    expect(() =>
      parseActionEnvelope({ ...golden, deadline: "2026-07-30 10:00" }),
    ).toThrow();
  });

  it("模型快照缺字段被拒绝（Mission 快照必须完整）", () => {
    const bad = {
      ...golden,
      modelSnapshot: { provider: "p", model: "m" },
    };
    expect(() => ActionEnvelope.parse(bad)).toThrow();
  });
});
