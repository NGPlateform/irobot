/**
 * OpenClaw 插件入口（真实运行版）。作为外部/旁加载插件注册 propose_action 工具，
 * 把模型的动作提案桥接到外部 Command Orchestrator（robot-sim 的 /v1/actions）。
 *
 * 依赖 `openclaw`（peer，宿主提供）与 `typebox`（宿主提供）。打包时把本仓库的
 * @irobot/* 与 zod 内联，openclaw/typebox 标记 external。
 */
// @ts-nocheck — 对宿主 openclaw 类型的校验只在装了 openclaw 的环境成立；运行逻辑正确。
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  executeProposeAction,
  type GatewayAdapterConfig,
  type MissionBinding,
  type ProposeActionParams,
} from "./propose-action-bridge.js";

const SAFETY = [
  "S0_OBSERVE", "S1_REVERSIBLE", "S2_GUARDED", "S3_HAZARDOUS", "S4_FORBIDDEN",
];

let turn = 0;

/**
 * 本地结构化类型：显式标注默认导出，避免 tsc 在 `declaration` 下需要命名 openclaw 内部
 * 类型（TS2742「inferred type ... cannot be named」不可移植）。宿主按运行时形状加载入口。
 */
type PluginEntryExport = {
  id: string;
  name: string;
  description: string;
  register(api: any): void;
};

const pluginEntry: PluginEntryExport = definePluginEntry({
  id: "irobot-gateway-adapter",
  name: "iRobot Gateway Adapter",
  description: "把 Agent 的设备动作提案桥接到外部 Command Orchestrator。",
  register(api) {
    const config = (api.pluginConfig ?? {}) as GatewayAdapterConfig;

    api.registerTool(
      {
        name: "propose_action",
        description:
          "向机器人提交一个声明式动作提案（唯一的设备写入口）。capabilityId 例如 " +
          "robot.navigation.navigate_relative(参数 distanceM 米，后退为负) / " +
          "robot.navigation.navigate_to_station(参数 station 中文站名) / " +
          "robot.navigation.return_to_dock / robot.navigation.enter_restricted_zone(S3 需审批) / " +
          "robot.telemetry.query_battery / robot.telemetry.query_pose。",
        parameters: Type.Object({
          capabilityId: Type.String(),
          capabilityVersion: Type.Optional(Type.String()),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          safetyClass: Type.Union(SAFETY.map((s) => Type.Literal(s))),
        }),
        async execute(toolCallId, params, signal, onUpdate) {
          const active = (api.activeModel ?? {}) as { provider?: string; modelId?: string };
          const binding: MissionBinding = {
            sessionId: "openclaw",
            deviceId: "sim-robot-001",
            leaseEpoch: 1,
            expectedStateVersion: 0,
            traceId: `oc-${(++turn).toString(36)}`,
            actor: { type: "user", id: api.requesterSenderId ?? "openclaw-user" },
            modelSnapshot: {
              provider: active.provider ?? "openclaw",
              model: active.modelId ?? "unknown",
              promptHash: "sha256:openclaw",
              toolCatalogVersion: "oc",
              policyVersion: "1",
            },
            proposalTimeoutMs: 60000,
          };
          const p = params as ProposeActionParams;
          return executeProposeAction(
            { ...p, capabilityVersion: p.capabilityVersion ?? "1.0.0", arguments: p.arguments ?? {} },
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

export default pluginEntry;
