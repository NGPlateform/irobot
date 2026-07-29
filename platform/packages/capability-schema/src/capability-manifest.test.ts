import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCapabilityManifest, CapabilityManifest } from "./index.js";

const exampleUrl = new URL(
  "../manifests/robot.navigation.navigate_relative.v1.json",
  import.meta.url,
);
const example = JSON.parse(readFileSync(fileURLToPath(exampleUrl), "utf8"));

describe("Capability Manifest v0.1", () => {
  it("首个能力 navigate_relative 通过校验", () => {
    const m = parseCapabilityManifest(example);
    expect(m.capabilityId).toBe("robot.navigation.navigate_relative");
    expect(m.safetyClass).toBe("S2_GUARDED");
    expect(m.concurrencyKey).toBe("base_motion");
  });

  it("拒绝未知字段（strict，防止协议漂移）", () => {
    expect(() => parseCapabilityManifest({ ...example, rogue: 1 })).toThrow();
  });

  it("kind=query 的写等级被拒绝", () => {
    const bad = { ...example, kind: "query", safetyClass: "S2_GUARDED" };
    expect(() => parseCapabilityManifest(bad)).toThrow();
  });

  it("非法 capabilityId 被拒绝", () => {
    expect(() =>
      parseCapabilityManifest({ ...example, capabilityId: "NavigateRelative" }),
    ).toThrow();
  });

  it("非法版本被拒绝", () => {
    expect(() =>
      parseCapabilityManifest({ ...example, version: "1.0" }),
    ).toThrow();
  });

  it("preconditions 默认空数组", () => {
    const { preconditions, ...rest } = example;
    void preconditions;
    const m = CapabilityManifest.parse(rest);
    expect(m.preconditions).toEqual([]);
  });
});
