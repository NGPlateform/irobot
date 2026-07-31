// 极简 TLS 终结反向代理：https://:TLS_PORT → http://UPSTREAM_HOST:UPSTREAM_PORT。
// 用于给无鉴权的 robot-sim 加 HTTPS，让远程浏览器进入安全上下文（麦克风/SpeechRecognition 可用）。
// 零依赖；流式转发（SSE /events 不缓冲）。证书/密钥由环境变量指向（自签即可）。
//
//   TLS_CERT=… TLS_KEY=… TLS_PORT=8443 UPSTREAM_PORT=8899 node scripts/tls-proxy.mjs
import { createServer } from "node:https";
import { request } from "node:http";
import { readFileSync } from "node:fs";

const TLS_PORT = Number(process.env.TLS_PORT ?? 8443);
const UP_HOST = process.env.UPSTREAM_HOST ?? "127.0.0.1";
const UP_PORT = Number(process.env.UPSTREAM_PORT ?? 8899);

if (!process.env.TLS_CERT || !process.env.TLS_KEY) {
  console.error("需要 TLS_CERT 与 TLS_KEY 环境变量指向证书/密钥文件");
  process.exit(1);
}
const tls = { key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) };

const server = createServer(tls, (creq, cres) => {
  const preq = request(
    {
      host: UP_HOST,
      port: UP_PORT,
      method: creq.method,
      path: creq.url,
      headers: { ...creq.headers, host: `${UP_HOST}:${UP_PORT}` },
    },
    (pres) => {
      cres.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(cres); // 流式：SSE 逐块转发，不缓冲
    },
  );
  preq.on("error", (e) => {
    if (!cres.headersSent) cres.writeHead(502, { "content-type": "text/plain" });
    cres.end("proxy upstream error: " + e.message);
  });
  creq.pipe(preq);
});

server.on("clientError", (_e, sock) => sock.destroy());
server.listen(TLS_PORT, () => {
  console.log(`  🔒 TLS 反代 https://0.0.0.0:${TLS_PORT} → http://${UP_HOST}:${UP_PORT}`);
});

const bye = () => server.close(() => process.exit(0));
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
