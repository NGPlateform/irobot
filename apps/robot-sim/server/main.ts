import { Session } from "./session.js";
import { createSimServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8899);

const session = new Session();
session.start();

const server = createSimServer(session);
server.listen(PORT, () => {
  console.log(`\n  🤖 iRobot 仿真控制台已启动`);
  console.log(`     打开 http://localhost:${PORT}\n`);
  console.log(`  语音需在 Chrome/Edge 中使用（Web Speech API）。也可用输入框打字。`);
});

const shutdown = () => {
  session.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
