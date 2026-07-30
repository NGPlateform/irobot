# Spike：OpenClaw 外部 Orchestrator 接入

- 状态：✅ 通过（G0 硬门槛）
- 日期：2026-07-30
- 关联风险：R01、R17（风险登记）
- 关联 ADR：ADR-003（OpenClaw 用于北向控制面，不作最终执行协议）

## 要回答的问题

能否**不 fork** OpenClaw、也不把机器人语义写进其核心，就让一个独立进程的
Command Orchestrator 接入，并完成"文本消息 → 外部 Orchestrator → 流式闭环"？

## 结论

**能，且不需要 fork。** OpenClaw 提供的**外部插件**机制 + **Agent 工具**扩展点，恰好
暴露了我们双环架构所需的全部原语：流式进度、取消信号、配置注入、审批门。机器人的
写入口以一个外部 Tool 插件（`propose_action`）形态接入，核心零改动。

## 源码证据（openclaw 基线仓库）

| 需求 | OpenClaw 提供 | 位置 |
| --- | --- | --- |
| 不进核心仓库、独立发布安装 | 外部插件 `openclaw plugins install clawhub:<pkg>` | `docs/plugins/building-plugins.md` |
| 注册 Agent 工具 | `definePluginEntry` + `api.registerTool({ name, parameters, execute })` | `src/plugin-sdk/plugin-entry.ts`、`tool-plugin.ts` |
| **流式进度回传** | `ToolPluginExecutionContext.onUpdate: AgentToolUpdateCallback` | `src/plugin-sdk/tool-plugin.ts:29`；`packages/agent-core/src/types.ts:491` |
| **取消传播**（turn interruption → cancel/abort） | `ToolPluginExecutionContext.signal: AbortSignal` | `src/plugin-sdk/tool-plugin.ts:25` |
| 注入 Orchestrator 端点/凭据 | 插件 `config`（`configSchema`） | `tool-plugin.ts:45`、`docs/plugins/building-plugins.md` |
| **审批门**（映射 S2/S3） | 插件权限请求 + approval runtime | `docs/plugins/plugin-permission-requests.md`；`src/plugin-sdk/approval-*-runtime.ts` |
| 默认关闭、显式启用 | `optional: true` 工具 + `tools.allow` 白名单 | `docs/plugins/building-plugins.md` |

关键契约（`src/plugin-sdk/tool-plugin.ts:21`）：

```ts
export type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;              // → cancel / abort
  toolCallId: string;                // → idempotencyKey 一半
  onUpdate?: AgentToolUpdateCallback; // → 流式 feedback
};
```

`AgentToolUpdateCallback = (partialResult) => void`，正是我们把 Action Event 的
`feedback`（进度）流式喂回 Agent 的通道。`signal` 让 Agent 的 turn interruption
自然映射为动作 `cancel`/`abort`（架构 §8.2），而急停仍走本地独立链路、与此无关。

## 最小验证代码（本仓库）

落点在 `platform/services/gateway-adapter/`：

- `src/orchestrator-client.ts` — 到外部 Orchestrator 的 HTTP 客户端，消费 NDJSON 事件流。
- `src/propose-action-bridge.ts` — OpenClaw 工具 `execute` 的纯逻辑：构造并校验
  Action Envelope（fail-closed）→ 提交 → `feedback` 映射 `onUpdate` → 终态回落工具结果；
  S4 在桥接层即拒。
- `src/openclaw-plugin.ts` — 真实 `definePluginEntry` 接线（发布目标，peer 依赖 openclaw）。
- `openclaw.plugin.json` — 插件清单（`contracts.tools`、`configSchema.orchestratorUrl`）。

测试 `src/propose-action-bridge.test.ts` 用一个 mock Orchestrator（node:http，流式 NDJSON）
证明了闭环，无需启动完整网关与模型：

```
✓ 流式闭环：收到进度并以 SUCCEEDED 收尾
✓ S4_FORBIDDEN 在桥接层即被拒，永不触达 Orchestrator
✓ AbortSignal 透传：turn interruption 取消进行中的提案
✓ 幂等键由 sessionId + toolCallId 稳定构成
```

复现：

```bash
pnpm install && pnpm rebuild esbuild
pnpm --filter @irobot/gateway-adapter test
```

## 边界与遗留（进入 Phase 1 前需补）

- 本 Spike 用 node:http mock 证明 OpenClaw 侧桥接逻辑；**完整 e2e**（真实 OpenClaw 网关 +
  模型 + `openclaw plugins install` 安装形态）属 Phase 1，须按 `npm-pack:` 安装形态复验。
- 采用外部插件而非窄 fork：确认 `api.runtime` 能否解析我们需要的会话/设备绑定
  （`resolveMissionBinding` 目前是占位），否则该绑定改由 Orchestrator 侧按 `deviceId` 解析。
- S2/S3 审批：本 Spike 只验证 seam 存在；审批 UI 与两阶段危险动作在 Phase 3（E07/E10）。
- 官方/受信插件信任链（catalog-backed official install）非 MVP 必需，暂不涉及。

## 对计划的影响

R01/R17 由"中/高未决"降为"已验证可行，走外部插件路线"。ADR-003 得到源码支撑。
建议将 OpenClaw 集成路线在 G0 正式定为**外部 Tool 插件**（而非 fork 或窄 patch）。

---

## 真连接进展（2026-07-30 更新）

在 Spike 之上又把"北向插件 ↔ 外部 Orchestrator"的**线级连接做成真实且可测**：

- **robot-sim 现在是真正的外部 Command Orchestrator**：`apps/robot-sim` 暴露
  `POST /v1/actions`，接收 Action Envelope，流式回 NDJSON ActionEvent，由真实
  Orchestrator + SimRobot 驱动（`server/server.ts` + `orchestrator.executeEnvelope`）。
- **端到端已测**：`server/openclaw-bridge.integration.test.ts` 让 OpenClaw 侧插件代码
  （`@irobot/gateway-adapter` 的 `executeProposeAction`/`submitProposal`）经**真实 HTTP**
  打到 robot-sim，机器人真的移动、流式回传、终态正确。
- **纵深防御已测**：Orchestrator 的 `safetyClass` 一律由本地 manifest 派生，忽略北向
  声明——谎报 S0 的导航仍按 S2 前置条件校验，急停下 REJECTED。
- **活体验证**：`curl -d @fixtures/navigate_relative.envelope.json .../v1/actions` 返回
  完整 PROPOSED→…→feedback 事件流。

### 已在本机真网关上跑通（2026-07-30）

最初判断本沙箱跑不了真网关；实际逐一攻克后**已在本机把完整闭环跑通**：

```
真 OpenClaw 网关(agent --local) → 模型(OpenAI Responses API)
  → propose_action 工具(本插件，已在真网关内 Status: loaded)
  → robot-sim /v1/actions(外部 Command Orchestrator) → 机器人移动
  → 工具结果回流 → 模型最终答复 "好的，已让机器人前进两米。"
```

证据：说“前进两米”后，机器人 pose.x 由 1 → 3（正好 navigate_relative 2 米），
agent turn exit=0，模型 Responses API 恰好两跳（先 function_call、再收到工具结果后出文本）。

为在本沙箱跑起来所做的环境处置（均为本地开发权宜，不进产品仓库）：

- Node 22.21.1 → **24.18.1**（nvm；满足 OpenClaw ≥24.15 引擎）。
- 手动补齐被网络抖动跳过的原生绑定：`@rolldown/binding-linux-x64-gnu`、`@esbuild/linux-x64`。
- pnpm `verifyDepsBeforeRun: false`（否则每次跑脚本都自动 install，撞上拉不下来的大二进制）。
- 用 pnpm overrides 把**用不到**的巨型二进制（onnxruntime / node-llama-cpp / copilot /
  claude-agent-sdk 二进制 / node-pty 等）指向空 stub，使 install 得以完整跑完。
- 插件用 esbuild 打成自包含 bundle（内联 @irobot/* 与 typebox，external openclaw），
  经 `openclaw plugins install <dir> --link` 旁加载；隔离 `OPENCLAW_STATE_DIR`，
  **不触碰操作员的 `~/.openclaw`**。
- 模型用本地 OpenAI-兼容 mock（Responses API SSE，返回 propose_action 工具调用）替代凭据；
  真实使用换成带 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 的 provider 即可，链路不变。

结论：`接真实 OpenClaw 网关` 已从"seam 证明"升级为**本机实跑贯通**。合规生产主机上把 mock 换成
真 provider、把 stub 的重扩展按需装回即可。

### 合规主机 runbook（完成真连接）

```bash
# 0) 主机需 Node ≥22.22.3、pnpm 11；准备一个模型 provider（API key 或自建 CLI backend 插件）

# 1) 构建并打包本插件
cd platform/services/gateway-adapter
pnpm build:plugin                 # 产出 dist/openclaw-plugin.js（需 openclaw 作为 peer 已装）
npm pack --pack-destination /tmp

# 2) 安装到 OpenClaw
openclaw plugins install npm-pack:/tmp/irobot-gateway-adapter-*.tgz --force
openclaw plugins inspect irobot-gateway-adapter --runtime --json

# 3) 配置外部 Orchestrator 端点（指向运行中的 robot-sim）
#    openclaw.json 中该插件 config：{ "orchestratorUrl": "http://<robot-sim-host>:8899" }

# 4) 允许工具并启动
#    tools.allow: ["propose_action"]
#    启动 robot-sim（外部 Orchestrator）：pnpm --filter @irobot/robot-sim dev
#    在任一渠道对 OpenClaw 说“前进两米”，模型将调用 propose_action → robot-sim → 机器人执行
```

keyless 选项：按 `docs/plugins/cli-backend-plugins.md` 写一个把本机 `claude` CLI 映射为
模型后端的 CLI backend 插件，即可无 API key 驱动 OpenClaw 的认知层。
