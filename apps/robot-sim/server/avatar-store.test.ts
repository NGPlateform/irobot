import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AvatarStore, sanitizeName } from "./avatar-store.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "irobot-avatars-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("AvatarStore（上传/列表/删除/名称清洗）", () => {
  it("sanitizeName 防目录穿越、去 .vrm 后缀", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeName("我的头像.vrm")).toBe("我的头像");
    expect(sanitizeName("a/b\\c.VRM")).toBe("abc");
    expect(sanitizeName("")).toBe("avatar");
  });

  it("save → list → read → remove 往返", async () => {
    const store = new AvatarStore(dir);
    const bytes = Buffer.from("glTF\x02\x00\x00\x00dummy");
    const name = await store.save("勇者A.vrm", bytes);
    expect(name).toBe("勇者A");
    const list = await store.list();
    expect(list.map((m) => m.name)).toContain("勇者A");
    expect(await store.has("勇者A")).toBe(true);
    expect((await store.read("勇者A")).equals(bytes)).toBe(true);
    await store.remove("勇者A");
    expect(await store.has("勇者A")).toBe(false);
  });

  it("目录被运行时删除后 save 仍能恢复（不崩）", async () => {
    const store = new AvatarStore(dir);
    rmSync(dir, { recursive: true, force: true }); // 模拟目录被删
    const name = await store.save("恢复", Buffer.from("glTF\x02\x00\x00\x00x"));
    expect(name).toBe("恢复");
    expect(await store.has("恢复")).toBe(true);
  });
});
