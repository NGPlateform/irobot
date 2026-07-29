/**
 * OpenClaw 插件入口（参考实现 / 发布目标）。
 *
 * 这是"不 fork 接入"的落点：作为**外部插件**发布，用户通过
 * `openclaw plugins install clawhub:irobot/gateway-adapter` 安装，无需改动 OpenClaw 核心。
 *
 * 注意：本文件依赖 `openclaw`（peerDependency）与 `typebox`，仅在安装了 OpenClaw 的
 * 发布/构建环境编译。仓库内的契约测试不导入本文件，只测纯桥接逻辑（propose-action-bridge）。
 *
 * 使用的 OpenClaw 缝（均来自 src/plugin-sdk/tool-plugin.ts，已 Spike 验证）：
 *   - definePluginEntry + api.registerTool         → 注册 Agent 工具，核心不变
 *   - ToolPluginExecutionContext.onUpdate          → 流式进度回传
 *   - ToolPluginExecutionContext.signal(AbortSignal)→ turn interruption → cancel/abort
 *   - 插件 config（configSchema）                   → 注入外部 Orchestrator 端点
 *   - api（OpenClawPluginApi）                      → 解析会话/设备绑定
 */
// @ts-nocheck — reference entry; types resolve only where `openclaw` is installed.
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  executeProposeAction,
  type GatewayAdapterConfig,
  type MissionBinding,
  type ProposeActionParams,
} from "./propose-action-bridge.js";

export default definePluginEntry({
  id: "irobot-gateway-adapter",
  name: "iRobot Gateway Adapter",
  description: "将 Agent 的设备动作提案桥接到外部 Command Orchestrator。",
  register(api) {
    const config = (api.pluginConfig ?? {}) as GatewayAdapterConfig;

    api.registerTool(
      {
        name: "propose_action",
        description:
          "向机器人提交一个声明式动作提案（唯一的设备写入口）。返回执行进度与终态。",
        parameters: Type.Object({
          capabilityId: Type.String(),
          capabilityVersion: Type.String(),
          arguments: Type.Record(Type.String(), Type.Unknown()),
          safetyClass: Type.Union([
            Type.Literal("S0_OBSERVE"),
            Type.Literal("S1_REVERSIBLE"),
            Type.Literal("S2_GUARDED"),
            Type.Literal("S3_HAZARDOUS"),
            Type.Literal("S4_FORBIDDEN"),
          ]),
        }),
        async execute(toolCallId, params, signal, onUpdate) {
          // 真实实现中 binding 由 api 从当前会话/设备目录/租约服务解析。
          const binding: MissionBinding = api.runtime.resolveMissionBinding();
          return executeProposeAction(
            params as ProposeActionParams,
            config,
            binding,
            { toolCallId, signal, onUpdate },
          );
        },
      },
      { optional: true },
    );
  },
});
