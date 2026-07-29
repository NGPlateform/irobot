import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Session } from "./session.js";

const WEB_DIR = new URL("../web/", import.meta.url);

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

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

export function createSimServer(session: Session) {
  return createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url in STATIC) {
      return serveStatic(res, STATIC[url]!);
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

    res.writeHead(404).end("not found");
  });
}
