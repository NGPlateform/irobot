import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapStore, sanitizeName } from "./map-store.js";
import { WorldMap } from "./world-map.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "irobot-maps-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("MapStore（保存 / 加载 / 列表 / 名称清洗）", () => {
  it("sanitizeName 防目录穿越", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeName("我的地图 A/b")).toBe("我的地图Ab");
    expect(sanitizeName("")).toBe("map");
  });

  it("save → load 往返一致", async () => {
    const store = new MapStore(dir);
    const m = new WorldMap(); m.generate(11); m.integrateScan({ x: 1, y: 1 });
    const name = await store.save("仓库A", m.serialize());
    const loaded = await store.load(name);
    expect(loaded.obstacles).toEqual(m.obstacles);
    expect(loaded.occupancy.length).toBe(m.serialize().occupancy.length);
  });

  it("list 返回已存地图的元信息", async () => {
    const store = new MapStore(dir);
    const m = new WorldMap(); m.generate(22);
    await store.save("图二", m.serialize());
    const metas = await store.list();
    expect(metas.length).toBeGreaterThanOrEqual(2);
    const names = metas.map((x) => x.name);
    expect(names).toContain("图二");
    expect(metas.every((x) => typeof x.obstacles === "number")).toBe(true);
  });
});
