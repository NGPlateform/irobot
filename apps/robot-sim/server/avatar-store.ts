// 自定义 VRM 头像存储：state/avatars/<name>.vrm（运行时可写、跨重启保留、不入库）。
// 与内置默认 Seed-san 并存；上传体已在路由层校验 glTF 魔数 + 大小。
import { mkdirSync } from "node:fs";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface AvatarMeta {
  name: string;
  size: number;
}

/** 清洗头像名，防目录穿越；只留中英文数字下划线连字符。 */
export function sanitizeName(name: string): string {
  const clean = String(name || "")
    .replace(/\.vrm$/i, "")
    .trim()
    .replace(/[^0-9a-zA-Z一-龥_-]/g, "")
    .slice(0, 40);
  return clean || "avatar";
}

export class AvatarStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return join(this.dir, sanitizeName(name) + ".vrm");
  }

  async save(name: string, buf: Buffer): Promise<string> {
    const safe = sanitizeName(name);
    mkdirSync(this.dir, { recursive: true }); // 目录可能被运行时删除，写前确保存在
    await writeFile(this.file(safe), buf);
    return safe;
  }

  async list(): Promise<AvatarMeta[]> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.toLowerCase().endsWith(".vrm"));
    } catch {
      return [];
    }
    const metas: AvatarMeta[] = [];
    for (const f of files) {
      try {
        const buf = await readFile(join(this.dir, f));
        metas.push({ name: f.replace(/\.vrm$/i, ""), size: buf.length });
      } catch {
        /* 跳过损坏文件 */
      }
    }
    metas.sort((a, b) => a.name.localeCompare(b.name));
    return metas;
  }

  async has(name: string): Promise<boolean> {
    try {
      await readFile(this.file(name));
      return true;
    } catch {
      return false;
    }
  }

  async read(name: string): Promise<Buffer> {
    return readFile(this.file(name));
  }

  async remove(name: string): Promise<void> {
    try {
      await unlink(this.file(name));
    } catch {
      /* 不存在即视作已删 */
    }
  }
}
