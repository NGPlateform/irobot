# robot-sim — 浏览器仿真机器人 + 语音对话

无硬件时的端到端演示。它**复用已冻结的协议包**（`action-protocol` / `capability-schema` /
`policy-contract`），把"语音 → 意图 → 动作提案 → 仿真 Edge 执行 → 流式 ActionEvent →
浏览器渲染"完整走一遍双环，而不是抛弃式 mock。

## 运行

```bash
pnpm install
pnpm --filter @irobot/robot-sim dev
# 打开 http://localhost:8899（3D 视图 /3d）

# 多机器人舰队（默认 1 台）：
IROBOT_FLEET=2 pnpm --filter @irobot/robot-sim dev
# 指令按设备寻址：“二号机器人去大厅”、“切换到机器人2”；不同控制域并行，同设备单写者。
```

语音识别（STT）与合成（TTS）用浏览器原生 **Web Speech API**，**零外部 API、零密钥**。
语音需在 **Chrome / Edge** 中使用；任何浏览器都可用输入框打字。

## 认知层：三档 Agent 后端

三种后端产出**完全同形**的声明式提案（NluResult），下游 Orchestrator / 状态机 / 安全校验
不变——这正是"LLM 只提议、确定性层处置"。页面右上角显示当前后端。

| 后端 | 触发 | 延迟 | 说明 |
| --- | --- | --- | --- |
| **API** 直连 | 有 `ANTHROPIC_API_KEY` | 近实时（亚秒~1s） | 直连 Messages API，强制 emit_decision 工具，system+工具 prompt 缓存 |
| **claude 常驻** | 有 `claude` CLI | 热缓存约 7s | 长驻 CLI 进程（stream-json），缓存跨轮复用 |
| **规则式 NLU** | 兜底 | 即时 | 关键词解析；上面两者不可用/失败时回退 |

**自动选择**（`IROBOT_AGENT=auto`，默认）：有 API key 用 API；否则有 CLI 用常驻；否则规则式。
可用 `IROBOT_AGENT=api|claude|rules` 强制。任一后端出错/超时都 fail-closed 回退规则式，
对话不中断。多轮指代原生生效（“往前走一米”后“再往前挪半米”→0.5 米）。

### 环境变量

- `IROBOT_AGENT`：`auto`(默认) / `api` / `claude` / `rules`。
- `ANTHROPIC_API_KEY`：启用 API 后端。`ANTHROPIC_BASE_URL` 可指向兼容端点。
- `IROBOT_API_MODEL`：API 后端完整模型 id（默认按别名解析到 `claude-haiku-4-5-20251001`）。
- `IROBOT_AGENT_MODEL`：`haiku`(默认) / `sonnet` / `opus` / `fable`，两后端共用别名。

LLM 让对话自然：“麻烦帮我到二号那边去一趟”“现在电池情况怎么样”这类口语化、无关键词的
说法，规则式接不住，LLM 能正确映射为提案。即便 LLM 幻觉出不存在的能力，也会被
Orchestrator `REJECTED`——安全边界不依赖模型。

环境变量：

- `IROBOT_AGENT=rules` 强制用规则式（不调 CLI）；`=auto`（默认）自动探测。
- `IROBOT_AGENT_MODEL=haiku|sonnet|opus`（默认 `haiku`，兼顾延迟与成本）。

代价：每轮一次 `claude -p` 无头调用，Haiku 约数秒延迟；调用会走 Claude Code 的
计费。CLI 不可用或超时（25s）自动回退规则式，demo 不中断。

## 能做什么

对着麦克风或输入框说：

- `前进两米` / `后退一米`（相对移动，S2）
- `去一号站点` / `到二号站点` / `去大厅`（导航到站点，S2）
- `返回充电` / `回充电`（返回充电坞，S2）
- `进入危险区`（**S3 高风险，触发人工审批**：地图上红色危险区，需在弹出的审批卡片点“批准执行”才会运动）
- `电量还有多少` / `我在哪`（查询，S0，同步返回）
- `取消`（取消当前动作 → CANCEL_REQUESTED → CANCELLED）
- `急停`（急停；页面 E-STOP 按钮是独立高优先通道）

## S3 人工审批门

风险等级为 `S3_HAZARDOUS` 的动作（如进入危险区）不会自动执行：Orchestrator 进入
`PENDING_APPROVAL` 并弹出审批卡片（设备、动作、参数、风险等级、有效期），必须人工点击
**批准执行** 才 `ACCEPTED → EXECUTING`；点 **拒绝** → `REJECTED`；30 秒（默认）无人处理 →
`EXPIRED`。审批走界面按钮这一显式通道，不接受语音单独批准（安全关键决策不能只靠语音）。
`IROBOT_APPROVAL_TIMEOUT_MS` 可调超时。

画面左侧是机器人地图（位置、朝向、轨迹、站点、充电坞、执行进度环），右侧是对话、
动作事件流和实时读数。

## 架构对应

| 演示组件 | 架构角色 | 说明 |
| --- | --- | --- |
| `agent-api.ts` | 认知慢环（API 后端） | 直连 Messages API，强制工具 + prompt 缓存，近实时 |
| `agent-resident.ts` | 认知慢环（常驻 CLI 后端） | 长驻 claude 进程，stream-json 双向流，缓存跨轮复用 |
| `agent-claude.ts` | Agent 共享逻辑 | system prompt、输出 schema、结构化输出映射、CLI 探测 |
| `nlu.ts` | 认知慢环（回退） | 规则式中文意图，LLM 不可用/超时时兜底；与 LLM 输出同形 |
| `orchestrator.ts` | Command Orchestrator | 提案校验、确定性前置条件、安全等级处置、状态机守卫 |
| `sim-robot.ts` | Edge Runtime + 设备物理 | 权威状态源；执行动作、流式 feedback、急停/取消即时生效 |
| `capabilities.ts` | Capability Manifest | 经 capability-schema 校验，与冻结契约一致 |

**边界（与真实系统的差异）**：NLU 是规则式而非 LLM；Orchestrator/Edge/物理合并在一个
进程内（真实系统三者分离，Edge 独立部署）；无 ROS 2、无硬件安全监督器。这些在 Phase 1/2
按计划替换，协议契约不变。
