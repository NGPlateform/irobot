import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Session } from "./session.js";
import { synthesize } from "./tts.js";
import { AvatarStore, sanitizeName } from "./avatar-store.js";

const WEB_DIR = new URL("../web/", import.meta.url);

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/3d": "robot3d.html",
  "/robot3d.html": "robot3d.html",
  "/robot3d.js": "robot3d.js",
  "/scene3d.bundle.js": "scene3d.bundle.js",
  "/digital-human.js": "digital-human.js",
  "/map2d.js": "map2d.js",
  "/human-vrm.bundle.js": "human-vrm.bundle.js",
  "/models/avatar.vrm": "models/avatar.vrm",
};
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  vrm: "application/octet-stream",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 读二进制请求体（上传 .vrm 用；不转 utf8 以免毁坏二进制），超限抛错。 */
async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const MAX_AVATAR_BYTES = 30 * 1024 * 1024; // 30MB 上限
const isGlb = (buf: Buffer): boolean => buf.length > 12 && buf.toString("latin1", 0, 4) === "glTF";

async function serveStatic(res: ServerResponse, file: string): Promise<void> {
  try {
    const buf = await readFile(fileURLToPath(new URL(file, WEB_DIR)));
    const ext = file.split(".").pop() ?? "html";
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

export function createSimServer(session: Session, avatarStore?: AvatarStore) {
  return createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url in STATIC) {
      return serveStatic(res, STATIC[url]!);
    }

    if (method === "GET" && url === "/ledger") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(session.ledger(), null, 2));
      return;
    }

    if (method === "GET" && url === "/edge-journal") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(session.ledger().filter((e) => e.source === "edge"), null, 2));
      return;
    }

    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (msg: unknown) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
      const unsub = session.subscribe(send);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    // 北向 Command Orchestrator 契约：OpenClaw 插件 POST 一个 Action Envelope，
    // 服务端流式回 NDJSON ActionEvent（与 gateway-adapter/orchestrator-client 对齐）。
    if (method === "POST" && url === "/v1/actions") {
      const body = await readBody(req);
      let envelope: unknown;
      try {
        envelope = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad json"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      try {
        await session.executeExternalEnvelope(envelope, (ev) =>
          res.write(JSON.stringify(ev) + "\n"),
        );
      } catch (err) {
        res.write(JSON.stringify({ kind: "diagnostic", error: String(err) }) + "\n");
      }
      res.end();
      return;
    }

    if (method === "POST" && url === "/converse") {
      const body = await readBody(req);
      const text = String(JSON.parse(body || "{}").text ?? "").slice(0, 500);
      if (text.trim()) void session.converse(text);
      res.writeHead(202).end("{}");
      return;
    }

    if (method === "POST" && url === "/cancel") {
      session.cancel();
      res.writeHead(202).end("{}");
      return;
    }

    if (method === "POST" && url === "/approve") {
      const body = await readBody(req);
      const parsed = JSON.parse(body || "{}");
      const commandId = String(parsed.commandId ?? "");
      const approved = Boolean(parsed.approved);
      if (commandId) session.approve(commandId, approved);
      res.writeHead(202).end("{}");
      return;
    }

    if (method === "POST" && url === "/estop") {
      const body = await readBody(req);
      const on = Boolean(JSON.parse(body || "{}").on);
      session.estop(on);
      res.writeHead(202).end("{}");
      return;
    }

    // 三维地图：生成 / 建图 / 保存 / 加载 / 列表 / 清除
    if (method === "POST" && url === "/map/generate") {
      const body = await readBody(req);
      const seed = Number(JSON.parse(body || "{}").seed);
      session.generateMap(Number.isFinite(seed) && seed > 0 ? seed : undefined);
      res.writeHead(202).end("{}");
      return;
    }
    if (method === "POST" && url === "/map/clear") {
      session.clearMap();
      res.writeHead(202).end("{}");
      return;
    }
    if (method === "POST" && url === "/map/save") {
      const name = String(JSON.parse((await readBody(req)) || "{}").name ?? "").slice(0, 60);
      const saved = await session.saveMap(name);
      res.writeHead(saved ? 200 : 501, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: saved }));
      return;
    }
    if (method === "POST" && url === "/map/load") {
      const name = String(JSON.parse((await readBody(req)) || "{}").name ?? "");
      try {
        const ok = await session.loadMap(name);
        res.writeHead(ok ? 202 : 404).end("{}");
      } catch {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      }
      return;
    }
    if (method === "GET" && url === "/map/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await session.listMaps()));
      return;
    }

    // 中文神经语音合成（edge-tts，零密钥）：GET /tts?voice=<id>&text=<...> → MP3。
    if (method === "GET" && (url === "/tts" || url.startsWith("/tts?"))) {
      const u = new URL(url, "http://localhost");
      const text = (u.searchParams.get("text") ?? "").slice(0, 500);
      const voice = u.searchParams.get("voice");
      if (!text.trim()) {
        res.writeHead(400, { "content-type": "text/plain" }).end("no text");
        return;
      }
      try {
        const mp3 = await synthesize(text, voice);
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
          "content-length": String(mp3.length),
        });
        res.end(mp3);
      } catch {
        res.writeHead(502, { "content-type": "text/plain" }).end("tts failed"); // 客户端回退 Web Speech
      }
      return;
    }

    // 自定义 VRM 头像：列表 / 取模型 / 上传 / 删除（内置 Seed-san 走静态 /models/avatar.vrm）
    if (method === "GET" && url === "/avatars") {
      const builtin = { id: "builtin", label: "内置 · Seed-san", url: "/models/avatar.vrm", builtin: true };
      const custom = avatarStore
        ? (await avatarStore.list()).map((m) => ({ id: m.name, label: m.name, url: `/avatars/${encodeURIComponent(m.name)}.vrm`, builtin: false }))
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([builtin, ...custom]));
      return;
    }
    if (method === "GET" && url.startsWith("/avatars/")) {
      const name = sanitizeName(decodeURIComponent(url.slice("/avatars/".length)));
      if (!avatarStore || !(await avatarStore.has(name))) { res.writeHead(404).end("not found"); return; }
      const buf = await avatarStore.read(name);
      res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": String(buf.length) });
      res.end(buf);
      return;
    }
    if (method === "POST" && url.startsWith("/avatars/upload")) {
      if (!avatarStore) { res.writeHead(501).end("{}"); return; }
      const name = sanitizeName(decodeURIComponent(new URL(url, "http://localhost").searchParams.get("name") ?? ""));
      let buf: Buffer;
      try {
        buf = await readBinaryBody(req, MAX_AVATAR_BYTES);
      } catch {
        res.writeHead(413, { "content-type": "application/json" }).end('{"error":"文件过大（上限 30MB）"}');
        return;
      }
      if (!isGlb(buf)) { res.writeHead(400, { "content-type": "application/json" }).end('{"error":"不是有效的 VRM/glb 文件"}'); return; }
      try {
        const saved = await avatarStore.save(name, buf);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: saved, url: `/avatars/${encodeURIComponent(saved)}.vrm` }));
      } catch {
        res.writeHead(500, { "content-type": "application/json" }).end('{"error":"保存失败"}');
      }
      return;
    }
    if (method === "POST" && url === "/avatars/delete") {
      if (!avatarStore) { res.writeHead(501).end("{}"); return; }
      const name = sanitizeName(String(JSON.parse((await readBody(req)) || "{}").name ?? ""));
      await avatarStore.remove(name);
      res.writeHead(202).end("{}");
      return;
    }

    res.writeHead(404).end("not found");
  });
}
