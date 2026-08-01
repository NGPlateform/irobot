import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Session } from "./session.js";
import { createSimServer } from "./server.js";
import { SqliteLedgerStore, MemoryLedgerStore, type LedgerStore } from "./ledger-store.js";
import { EdgeClient } from "./edge-client.js";
import { MapStore } from "./map-store.js";
import { AvatarStore } from "./avatar-store.js";

const PORT = Number(process.env.PORT ?? 8899);

// 生产落盘：审计与幂等持久化，进程重启后仍可查、仍去重（§8.2）。
// IROBOT_LEDGER_DB=":memory:" 或 =off 可退回内存。
const dbPath = process.env.IROBOT_LEDGER_DB ?? "./state/orchestrator.sqlite";
let store: LedgerStore;
if (dbPath === "off" || dbPath === ":memory:") {
  store = dbPath === ":memory:" ? new SqliteLedgerStore(":memory:") : new MemoryLedgerStore();
} else {
  mkdirSync(dirname(dbPath), { recursive: true });
  store = new SqliteLedgerStore(dbPath);
  console.log(`  审计/幂等持久化 → ${dbPath}`);
}

// 可选：Rust Edge daemon 作为权威准入层（云/边进程分离）。
// IROBOT_EDGE_BIN 指向 edge-daemon 可执行文件（cargo build 产物）。
let edge: EdgeClient | undefined;
const edgeBin = process.env.IROBOT_EDGE_BIN;
if (edgeBin) {
  const ec = new EdgeClient(edgeBin);
  if (ec.start()) {
    edge = ec;
    console.log(`  Edge daemon（Rust 权威准入）→ ${edgeBin}`);
  } else {
    console.log(`  ⚠ Edge daemon 启动失败：${edgeBin}（回退：无 Edge 准入）`);
  }
}

// 三维地图存取：state/maps/*.json（Nav2 map_server 风格）。
const mapStore = new MapStore(process.env.IROBOT_MAP_DIR ?? "./state/maps");
console.log(`  地图存储 → ${process.env.IROBOT_MAP_DIR ?? "./state/maps"}`);

const session = new Session(store, edge, mapStore);
await session.start();

// 可选：启动即加载某张已存地图。
if (process.env.IROBOT_MAP) {
  try {
    await session.loadMap(process.env.IROBOT_MAP);
    console.log(`  已加载地图：${process.env.IROBOT_MAP}`);
  } catch {
    console.log(`  ⚠ 地图加载失败：${process.env.IROBOT_MAP}`);
  }
}

// 自定义 VRM 头像存储：state/avatars/*.vrm（上传，不入库）。
const avatarStore = new AvatarStore(process.env.IROBOT_AVATAR_DIR ?? "./state/avatars");
console.log(`  头像存储 → ${process.env.IROBOT_AVATAR_DIR ?? "./state/avatars"}`);

const server = createSimServer(session, avatarStore);
server.listen(PORT, () => {
  console.log(`\n  🤖 iRobot 仿真控制台已启动`);
  console.log(`     打开 http://localhost:${PORT}\n`);
  console.log(`  语音需在 Chrome/Edge 中使用（Web Speech API）。也可用输入框打字。`);
});

const shutdown = () => {
  session.stop();
  edge?.stop();
  store.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
