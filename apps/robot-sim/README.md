# robot-sim — 浏览器仿真机器人 + 语音对话

无硬件时的端到端演示。它**复用已冻结的协议包**（`action-protocol` / `capability-schema` /
`policy-contract`），把"语音 → 意图 → 动作提案 → 仿真 Edge 执行 → 流式 ActionEvent →
浏览器渲染"完整走一遍双环，而不是抛弃式 mock。

## 运行

```bash
pnpm install
pnpm --filter @irobot/robot-sim dev
# 打开 http://localhost:8899
```

语音识别（STT）与合成（TTS）用浏览器原生 **Web Speech API**，**零外部 API、零密钥**。
语音需在 **Chrome / Edge** 中使用；任何浏览器都可用输入框打字。

## 认知层：本机 claude CLI 常驻 Agent

若本机装有 `claude` CLI，服务启动时拉起一个**常驻 Agent 进程**（页面右上角标识
`Agent: claude 常驻 (haiku)`）；否则回退到规则式 NLU。二者产出**完全同形**的声明式提案，
下游 Orchestrator / 状态机 / 安全校验不变——这正是"LLM 只提议、确定性层处置"。

**为什么常驻**：进程用 `--input-format stream-json --output-format stream-json` 长驻，
多轮对话由进程原生保持，prompt 缓存跨轮复用（首轮建 ~31k token 缓存，之后 cache_read
命中）。实测每轮延迟从冷启的约 11s 降到热缓存的约 7s，且成本大幅下降。多轮指代原生
生效，例如先“往前走一米”、再“再往前挪半米”会被正确理解为 0.5 米。

常驻进程串行处理（一次一轮）；单轮超时（默认 30s）或进程崩溃会自动重启并对当轮返回
null，由 Session 回退规则式 NLU（fail-closed，不阻塞对话）。

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
- `电量还有多少` / `我在哪`（查询，S0，同步返回）
- `取消`（取消当前动作 → CANCEL_REQUESTED → CANCELLED）
- `急停`（急停；页面 E-STOP 按钮是独立高优先通道）

画面左侧是机器人地图（位置、朝向、轨迹、站点、充电坞、执行进度环），右侧是对话、
动作事件流和实时读数。

## 架构对应

| 演示组件 | 架构角色 | 说明 |
| --- | --- | --- |
| `agent-resident.ts` | 认知慢环（常驻 LLM Agent） | 长驻 claude 进程，stream-json 双向流，缓存跨轮复用 |
| `agent-claude.ts` | Agent 共享逻辑 | system prompt、输出 schema、结构化输出映射（也供一次性调用） |
| `nlu.ts` | 认知慢环（回退） | 规则式中文意图，CLI 不可用/超时时兜底；与 LLM 输出同形 |
| `orchestrator.ts` | Command Orchestrator | 提案校验、确定性前置条件、安全等级处置、状态机守卫 |
| `sim-robot.ts` | Edge Runtime + 设备物理 | 权威状态源；执行动作、流式 feedback、急停/取消即时生效 |
| `capabilities.ts` | Capability Manifest | 经 capability-schema 校验，与冻结契约一致 |

**边界（与真实系统的差异）**：NLU 是规则式而非 LLM；Orchestrator/Edge/物理合并在一个
进程内（真实系统三者分离，Edge 独立部署）；无 ROS 2、无硬件安全监督器。这些在 Phase 1/2
按计划替换，协议契约不变。
