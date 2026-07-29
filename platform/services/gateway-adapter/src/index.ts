// 可测试的桥接表面。OpenClaw 插件入口（openclaw-plugin.ts）单独作为发布目标，
// 不从此处导出，以免把 openclaw peer 依赖带入库的可导入表面。
export * from "./orchestrator-client.js";
export * from "./propose-action-bridge.js";
