// 地图存取：state/maps/<name>.json（Nav2 map_server 风格，可读、可导出、易 list/load）。
import { mkdirSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorldMapData } from "./world-map.js";

export interface MapMeta {
  name: string;
  obstacles: number;
  coverage: number;
  savedAt: string;
}

/** 清洗地图名，防目录穿越；只留中英文数字下划线连字符。 */
export function sanitizeName(name: string): string {
  const clean = String(name || "").trim().replace(/[^0-9a-zA-Z一-龥_-]/g, "").slice(0, 40);
  return clean || "map";
}

export class MapStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return join(this.dir, sanitizeName(name) + ".json");
  }

  async save(name: string, data: WorldMapData): Promise<string> {
    const safe = sanitizeName(name);
    const payload = { name: safe, savedAt: new Date().toISOString(), ...data };
    await writeFile(this.file(safe), JSON.stringify(payload), "utf8");
    return safe;
  }

  async load(name: string): Promise<WorldMapData> {
    const raw = await readFile(this.file(name), "utf8");
    return JSON.parse(raw) as WorldMapData;
  }

  async list(): Promise<MapMeta[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const metas: MapMeta[] = [];
    for (const f of files) {
      try {
        const d = JSON.parse(await readFile(join(this.dir, f), "utf8"));
        const occ: number[] = d.occupancy ?? [];
        const known = occ.reduce((a: number, v: number) => a + (v !== 0 ? 1 : 0), 0);
        metas.push({
          name: f.replace(/\.json$/, ""),
          obstacles: (d.obstacles ?? []).length,
          coverage: occ.length ? known / occ.length : 0,
          savedAt: d.savedAt ?? "",
        });
      } catch {
        /* 跳过损坏文件 */
      }
    }
    metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return metas;
  }
}
