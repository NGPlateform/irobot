# 智能设备与机器人对话执行系统开发计划

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Draft / 待项目立项确认 |
| 版本 | 0.1 |
| 日期 | 2026-07-30 |
| 依赖文档 | [架构设计](./architecture-design.md) |
| 计划方式 | 阶段门禁、风险优先、仿真优先 |

## 2. 计划摘要

推荐以 6～8 人核心团队、22～30 周完成“可监督单机器人试点”为参考基线。该时间不包含行业认证、量产硬件设计或大规模车队部署。

> 工期定性：22～30 周应视为“一切顺利”的下限估计。HIL 调试、危害分析和安全评审历来最易溢出，G2→G4 段风险最高。必须在 Phase 0 结束时（G0）根据实际硬件成熟度、驱动完整度和团队规模重新校准，不把此区间当作承诺。

计划遵循以下顺序：

```text
架构与风险预研
  → 仿真端到端闭环
  → 单机器人边缘安全
  → 多渠道和多模态
  → 可靠性与试点
  → 记忆与离线学习
```

核心版本不以“Agent 能调用工具”为完成标准，而以以下结果为完成标准：

- 同一命令重试不会产生重复物理效果。
- 旧租约、过期命令和状态不匹配命令全部拒绝。
- Gateway/网络故障后机器人进入预定义行为。
- cancel、abort、emergency stop 三种语义可验证区分。
- 每次动作可从用户请求追踪到 ROS Goal 和最终结果。
- LLM、记忆和插件无法绕过 Command Orchestrator 与 Edge Safety Supervisor。

## 3. 计划假设

### 3.1 资源假设

参考团队：

| 角色 | 建议人数 | 主要职责 |
| --- | ---: | --- |
| 技术负责人/架构师 | 1 | 架构、协议、安全边界、ADR、跨团队集成 |
| Gateway/平台工程师 | 1～2 | OpenClaw 集成、身份、会话、设备目录、审计 |
| Agent 工程师 | 1 | Agent Loop、Tool Contract、模型适配、上下文 |
| 机器人/Edge 工程师 | 2 | Edge Runtime、ROS 2、动作服务器、控制器集成 |
| 测试与安全工程师 | 1 | 仿真、HIL、故障注入、威胁和危害分析 |
| SRE/基础设施工程师 | 0.5～1 | CI/CD、观测、发布、密钥和部署 |
| 产品/交互设计 | 0.5～1 | 场景、确认流程、人工接管、语音交互 |

若团队少于 5 人，应缩减为单一文本渠道、单一机器人和 3～5 个能力，不应并行开发语音、视觉、车队和学习系统。

### 3.2 产品假设

启动前需要明确：

- 首个机器人或设备型号。
- 首个演示场景。
- 是否具备 ROS 2 驱动或仿真模型。
- 硬件急停、限位和看门狗条件。
- 部署网络环境。
- 是否需要离线对话。
- 是否涉及门锁、高温、机械臂或公共空间等高风险能力。

### 3.3 推荐首个场景

建议首个垂直场景采用低速移动机器人：

1. 查询电量和位置。
2. 移动到预定义站点。
3. 相对移动有限距离。
4. 取消导航。
5. 返回充电点。

不建议首期选择：

- 自由空间高速移动。
- 与人直接接触的机械臂操作。
- 门锁、炉灶等高风险智能家居。
- 在线自动生成新的控制技能。

## 4. 工作流与代码组织

### 4.1 建议目标仓库结构

当前工作区中的 OpenClaw、Hermes 和 Claude Code 作为研究基线保留。新系统使用独立目录，避免将产品代码混入研究仓库。

```text
irobot/
  docs/
  platform/
    packages/
      action-protocol/
      capability-schema/
      policy-contract/
    services/
      gateway-adapter/
      agent-runtime/
      command-orchestrator/
      device-registry/
  edge/
    runtime/
    safety-supervisor/
    ros2_ws/
      src/
        irobot_action_bridge/
        irobot_simulator/
        irobot_interfaces/
  adapters/
    home-assistant/
    matter/
  learning/
    trajectory/
    evaluation/
    skill-candidates/
  tests/
    contract/
    simulation/
    fault-injection/
    security/
```

MVP 可以在一个 Monorepo 内完成。逻辑模块边界不等于立即拆成独立部署服务。

### 4.2 开发分支与发布

- 主干开发或短生命周期分支。
- 协议 Schema 变更必须经过兼容性测试。
- Edge、Gateway、Policy、Capability Manifest 分别版本化。
- 生产动作 Manifest、策略和技能必须生成哈希并签名。
- 不允许通过运行时修改文件绕过正式发布流程。

## 5. 分阶段计划

### 5.1 Phase 0：架构与风险预研

参考周期：2～3 周。

目标：消除决定整体路线的高风险不确定性。

工作项：

- 选择首个机器人、仿真器和演示场景。
- 完成系统上下文、数据流和信任边界图。
- 完成首版 Hazard Analysis 和威胁模型。
- 定义 S0～S4 安全等级。
- 定义 Capability Manifest、Action Envelope 和状态机。
- 验证 OpenClaw 插件/Node 扩展能力。
- 验证 Command Orchestrator 作为外部服务接入 OpenClaw。
- 验证 ROS 2 Action 的 goal、feedback、cancel、result。
- 验证 Gateway 断开后的 Edge 行为。
- 决定 Edge Runtime 使用 C++ 或 Rust。
- 建立 ADR、协议版本和代码规范。

技术 Spike：

| Spike | 要回答的问题 | 成功标准 |
| --- | --- | --- |
| OpenClaw 接入 | 能否不 fork 或只做窄 patch 接入外部动作系统 | 完成文本消息到外部 Orchestrator 的流式闭环 |
| ROS 2 Action | 是否能稳定映射平台 Action 状态 | goal/feedback/cancel/result 全链路通过 |
| Edge 持久化 | SQLite WAL 是否满足动作日志需求 | 断电重启后命令不重复执行 |
| 租约与 fencing | 网络分区时能否阻止旧控制者 | 旧 epoch 命令 100% 拒绝 |
| 模型结构化输出 | 模型能否稳定生成受限动作提案 | Schema 无效时确定性拒绝，不触发设备 |

阶段交付：

- 架构设计 v1。
- 协议 Schema v0.1。
- Threat Model v0.1。
- Hazard Register v0.1。
- OpenClaw/ROS 2 两个可运行 Spike。
- 关键 ADR。

退出门槛 G0：

- 首个场景和硬件明确。
- 所有 S2/S3 能力有责任人和初始安全条件。
- OpenClaw 集成路线确定为插件、外部服务或窄 fork。
- ROS 2 Action 和 Edge 进程边界通过评审。
- 不存在必须让 LLM 直接访问低层执行器的需求。

### 5.2 Phase 1：仿真端到端垂直切片

参考周期：4～5 周。

目标：在不连接真实执行器的情况下完成最小闭环。

范围：

- 单文本渠道。
- 单用户。
- 单仿真机器人。
- 3～5 个高层能力。
- 单 Gateway、单 Agent、单 Edge Runtime。
- SQLite 持久化。

工作项：

#### 协议与领域

- 实现 Capability Manifest Schema。
- 实现 Action Envelope Schema。
- 实现动作状态机和终态不变约束。
- 实现命令 ID、幂等键、期限和状态版本。
- 建立协议 golden fixtures 和兼容性测试。

#### Command Orchestrator

- 动作提案 API。
- Schema、身份和基础策略校验。
- Action Ledger。
- Outbox。
- 幂等响应缓存。
- cancel、abort 请求。
- 审计事件。

#### Agent Runtime

- Tool Contract。
- 只读查询工具。
- `propose_action` 唯一写入口。
- 只读并发、写操作串行。
- turn interruption。
- 最大轮次和预算限制。
- Prompt/Tool Catalog 快照。

#### Edge 与仿真

- Edge command client。
- Action Inbox/Journal。
- Safety Supervisor 骨架。
- ROS 2 仿真 Action Server。
- 进度、结果和错误上报。
- 断线策略。

#### 观测

- Trace ID 全链路传递。
- 命令状态指标。
- 结构化安全拒绝事件。
- 基础调试面板或 CLI。

阶段演示：

```text
用户：“移动到一号站点”
  → Agent 生成动作提案
  → Orchestrator 验证
  → Edge 接收
  → ROS 2 仿真导航
  → 返回进度
  → 用户中途取消
  → 动作进入 CANCELLED
  → 全链路审计可查询
```

退出门槛 G1：

- 所有动作只通过 Orchestrator。
- 重复提交相同幂等键不会产生第二个 ROS Goal。
- 无效 Schema、过期命令和前置条件失败不会到达 Edge 执行。
- cancel 和 abort 在仿真中可重复验证。
- Gateway 重启后能从 Action Ledger 恢复状态。
- 关键模块单元测试和契约测试通过。

### 5.3 Phase 2：单机器人 Edge 与硬件安全

参考周期：6～8 周。

目标：将仿真闭环迁移到真实低风险机器人。

工作项：

#### Edge Runtime

- 设备身份和安全连接。
- Capability Manifest 本地校验。
- 租约和 `leaseEpoch`。
- `expectedStateVersion`。
- 动作资源锁和 `concurrencyKey`。
- 本地 Action Journal 恢复。
- 连接丢失策略。
- 本地操作员优先级和人工接管。

#### Safety Supervisor

- 急停状态读取。
- 速度、区域、电量和定位健康前置条件。
- 看门狗。
- cancel、abort 和 local stop。
- 安全事件持久化。
- 每项能力的确定性 policy handler。

#### ROS 2

- 自定义 `.action`、`.msg` 和 `.srv`。
- Lifecycle Node。
- 仿真与真实驱动保持相同接口。
- Goal ID 与 Command ID 关联。
- Action Server 的抢占和取消。
- 故障码标准化。

#### 硬件在环

- 断网。
- Gateway 崩溃。
- Edge 重启。
- 重复命令。
- 乱序结果。
- 旧租约。
- 状态版本变化。
- 急停触发。
- 传感器异常。
- 电量不足。

真实硬件测试顺序：

1. 执行器断电状态下验证协议。
2. 架空轮或测试台验证。
3. 有围栏、低速、空载验证。
4. 受控环境人工监督验证。
5. 才允许进入有限真实场景。

退出门槛 G2：

- 急停和本地安全保护不依赖 Gateway。
- 旧租约、过期命令和重复命令在 HIL 中 100% 阻断。
- 网络断开后的行为符合每项能力的 `offlinePolicy`。
- Edge 重启后不会重复执行已完成动作。
- 所有 S2 能力具备明确前置条件和故障处理。
- 测试场地完成安全评审。

### 5.4 Phase 3：多渠道、多模态与交互完善

参考周期：4～6 周。

目标：在保持执行边界不变的前提下增强用户体验。

工作项：

- Web/App/IM 渠道。
- 流式 ASR 和 TTS。
- 本地或边缘唤醒词。
- 语音 barge-in。
- 图片和摄像头快照。
- 感知结果摘要，不将持续视频直接输入 LLM。
- 审批 UI。
- 动作进度、取消和人工接管 UI。
- 多语言交互。
- 无障碍和网络弱连接体验。

> **沙箱内已实现（进行中）**：`apps/robot-sim` 的数字人操作台落地了本阶段交互完善的可视化部分——
> 单机器人「数字人模式」提供**脸部会说话头像**与**拟人机器人全身**两种视图切换，随遥测/动作
> 变表情、随 TTS 口型同步、随麦克风聆听脉冲、随思考态动画；全身视图另反映底盘行走、机械臂映射
> 与说话手势。配合实时遥测 HUD、快捷动作按钮、机械臂可视控制，以及对应「审批 UI」（351）与
> 「动作进度/取消/人工接管 UI」（352）的 S3 审批卡片与动作事件流。执行边界不变：所有指令仍走
> `/converse → NLU → Orchestrator → 安全校验`。另有多机器人「3D 探索模式」（舰队/激光雷达）。
> 控制台现共 **5 种可即时切换的显示模式**：2D 俯视地图、3D 探索（three.js）、数字人脸部、数字人全身
> （均自绘 Canvas），以及第 5 种 **VRM 3D 数字人引擎**（@pixiv/three-vrm，VRM 1.0 人形，表情/口型
> 由同一 SSE 驱动，内置模型完全离线）。语音输入支持常开 / 手工（按住空格）两模式。

语音中断语义：

- 用户插话先停止 TTS。
- Agent turn interruption 终止生成。
- 若识别到“停止任务”，提交 cancel/abort。
- 若识别到紧急停止，应同时提供本地高优先级通道；语音本身不能是唯一急停方式。

退出门槛 G3：

- 新渠道无法绕过统一身份和动作策略。
- TTS/ASR 中断不会造成命令状态丢失。
- 视觉和外部文本按不可信输入处理。
- Approval 清楚显示设备、动作、参数、风险和有效期。
- 用户可随时查询当前动作及其控制者。

### 5.5 Phase 4：可靠性、安全加固与受监督试点

参考周期：6～8 周。

目标：达到有限用户、有限环境的受监督试点条件。

工作项：

#### 可靠性

- Gateway 重启恢复。
- Edge 状态对账。
- 数据库迁移。
- 配置原子更新。
- 灰度发布和回滚。
- 设备软件版本目录。
- 备份恢复演练。

#### 安全

- 完整威胁模型复审。
- Prompt Injection 测试集。
- 权限提升和越权测试。
- Secret 泄漏扫描。
- 插件签名和来源验证。
- SBOM 和依赖漏洞扫描。
- 设备证书轮换。

#### 测试

- 长时间运行测试。
- 网络抖动和分区。
- 消息重复、丢失和乱序。
- 数据库锁、磁盘满和进程崩溃。
- 模型超时、空响应和回退。
- 操作员争抢控制权。
- 多任务资源冲突。

#### 试点运营

- 值班和事件响应。
- 用户与设备权限管理。
- 安全事件告警。
- 审计导出。
- 现场人工接管手册。
- 故障停用和设备隔离流程。

退出门槛 G4：

- 发布阻断故障注入用例全部通过。
- 安全事件、命令和设备状态具备完整审计。
- 完成备份恢复和证书轮换演练。
- 完成受监督试点 Runbook。
- 业务负责人、安全负责人和机器人负责人共同批准。

### 5.6 Phase 5：记忆与离线技能学习

参考周期：6 周起，非核心版本阻塞项。

目标：在不改变安全边界的前提下提升个性化和任务成功率。

工作项：

- 会话记忆与设备状态分库。
- FTS5 会话检索。
- 任务轨迹 Schema。
- 成功/失败轨迹回放。
- 候选技能生成。
- 仿真评测。
- 安全属性测试。
- 人工审批和签名。
- 技能版本灰度。
- 线上效果和回滚。

退出门槛 G5：

- 学习服务无设备写权限。
- 候选技能不能直接进入生产目录。
- 每个生产技能具有来源、版本、评测、审批、哈希和回滚版本。
- 技能升级不会改变 Capability Manifest 的安全等级。
- 学习数据删除和隐私策略明确。

## 6. Epic 列表

| Epic | 内容 | 首次交付阶段 | 主要依赖 |
| --- | --- | --- | --- |
| E01 Action Protocol | Manifest、Envelope、事件、状态机 | Phase 1 | ADR、首个场景 |
| E02 Command Orchestrator | 验证、Ledger、Outbox、审批 | Phase 1 | E01 |
| E03 Agent Runtime | Tool Contract、规划、压缩、中断 | Phase 1 | E01、E02 |
| E04 Edge Runtime | Inbox、Journal、租约、断线策略 | Phase 1～2 | E01 |
| E05 ROS 2 Integration | Action、Lifecycle、仿真、驱动 | Phase 1～2 | 目标硬件 |
| E06 Safety Supervisor | 前置条件、仲裁、看门狗、急停状态 | Phase 2 | 危害分析 |
| E07 Gateway Integration | 渠道、身份、节点、设备目录 | Phase 0～3 | OpenClaw Spike |
| E08 Observability | Trace、指标、审计、告警 | Phase 1～4 | 全部核心模块 |
| E09 Multimodal | ASR、TTS、视觉摘要 | Phase 3 | Agent/Gateway |
| E10 Security | PKI、Secret、插件、威胁测试 | Phase 0～4 | 平台与 Edge |
| E11 Fleet Reliability | HA、持久消息、设备所有权 | Phase 4 | 单机器人稳定 |
| E12 Memory/Learning | 记忆、轨迹、技能评测和发布 | Phase 5 | 核心闭环稳定 |

## 7. 关键接口交付顺序

接口应按以下顺序冻结：

1. Capability Manifest v0.1。
2. Action Envelope v0.1。
3. Action Event 和状态机 v0.1。
4. Orchestrator API v0.1。
5. Edge Transport v0.1。
6. ROS 2 Action 接口 v0.1。
7. Approval API v0.1。
8. Device State/Digital Twin API v0.1。
9. Trajectory Schema v0.1。

协议冻结并不意味着未来不能扩展。要求：

- 新字段默认可选。
- 枚举扩展必须有未知值处理。
- 删除和改变语义必须提升主版本。
- Gateway 和 Edge 至少支持一个兼容窗口。
- Manifest 与命令明确携带版本。

## 8. 测试计划

### 8.1 测试层次

| 层次 | 重点 |
| --- | --- |
| 单元测试 | Schema、状态机、策略、幂等、租约、状态版本 |
| 契约测试 | Gateway、Orchestrator、Edge、ROS 接口兼容 |
| 集成测试 | 数据库、Outbox/Inbox、重启恢复 |
| 仿真测试 | 正常任务、取消、超时、资源冲突 |
| 故障注入 | 丢包、重复、乱序、分区、进程崩溃、磁盘异常 |
| HIL | 真实控制器、传感器、急停和看门狗 |
| 安全测试 | 越权、Prompt Injection、旧凭据、插件逃逸 |
| 长稳测试 | 内存、句柄、数据库增长、连接重建 |
| 用户测试 | 澄清、审批、进度、取消、接管 |

### 8.2 必须自动化的属性

- 一个 `commandId` 最多产生一个物理动作实例。
- 终态不可改变。
- 较旧 `leaseEpoch` 永远不能覆盖较新 epoch。
- Deadline 之后不能开始新动作。
- S4 能力无论任何用户或模型输出均被拒绝。
- 同一 `concurrencyKey` 不允许两个写动作同时执行。
- Agent 不可直接访问 Edge Transport。
- 记忆内容不能修改 Policy 或 Capability Manifest。
- Gateway/Edge 重启不会丢失已接受动作的审计记录。

### 8.3 模型评测

建立固定场景集：

- 正常明确指令。
- 参数缺失，需要澄清。
- 互相矛盾的指令。
- 用户要求绕过安全限制。
- 外部文档中的 Prompt Injection。
- 状态已变化的旧计划。
- 多步骤任务中途取消。
- 模型超时或返回无效 JSON。
- 模型回退。

模型成功率不能代替安全校验。任何模型输出在进入设备链路前仍执行相同确定性检查。

## 9. CI/CD 与发布门禁

每次提交：

- 格式化、静态分析和单元测试。
- Schema 和协议兼容性测试。
- 状态机属性测试。
- Secret 扫描。
- 依赖漏洞扫描。

每次候选发布：

- 仿真回归。
- 故障注入回归。
- 升级/回滚测试。
- 数据库迁移测试。
- Manifest/Policy 签名验证。
- SBOM 生成。

Edge 发布额外要求：

- HIL 测试。
- 目标硬件资源测试。
- 断电恢复。
- 看门狗和急停验证。
- 旧版本兼容窗口验证。

生产发布：

- 分阶段灰度。
- 每阶段定义自动停止条件。
- Edge 保留上一个已知安全版本。
- Gateway 和模型故障不得阻止本地安全控制。

## 10. Definition of Done

一个设备能力只有满足以下条件才算完成：

- Capability Manifest 已版本化。
- 输入、输出和错误 Schema 完整。
- 安全等级已评审。
- 前置条件由确定性代码实现。
- 正常、取消、超时、断网、重复和旧租约测试齐全。
- Action Ledger 和审计事件完整。
- ROS Goal 与 Command ID 可关联。
- 用户可查询进度和终态。
- 文档和运维手册已更新。
- 不存在绕过 Orchestrator 或 Safety Supervisor 的调用路径。

## 11. 风险登记

| 风险 | 概率 | 影响 | 缓解措施 |
| --- | --- | --- | --- |
| OpenClaw 扩展点不足 | 中 | 中高 | Phase 0 Spike；优先外部服务，必要时仅维护窄 patch |
| 机器人驱动不完整 | 高 | 高 | 首期优先选择 ROS 2 支持成熟的硬件；仿真先行 |
| Agent 行为不稳定 | 高 | 中 | Schema、最大轮次、动作提案、确定性验证、固定 Mission 快照 |
| 网络重试导致重复动作 | 中 | 极高 | Inbox/Outbox、幂等处理器、终态不变 |
| Gateway 双主 | 中 | 极高 | 单设备所有者、租约、fencing token |
| Prompt Injection | 高 | 高 | 信任标记、Schema、最小权限、Agent 无设备密钥 |
| SQLite 进入实时路径 | 低 | 高 | 架构测试和线程边界检查 |
| 安全逻辑散落插件 | 中 | 高 | 所有策略集中在 Orchestrator/Edge，插件只做适配 |
| 在线学习造成行为漂移 | 中 | 极高 | Phase 5 前禁用；离线评测、审批、签名 |
| 多 Agent 争抢设备 | 中 | 高 | `concurrencyKey`、Mission Supervisor、单写者 |
| 研究代码许可风险 | 中 | 高 | Claude 仅 clean-room 借鉴；建立第三方代码清单 |
| 现场人工接管不足 | 中 | 极高 | 产品需求阶段定义本地接管和硬件急停 |
| 原始音视频成本过高 | 中 | 中 | 边缘预处理、事件摘要、短期对象引用 |
| 过早微服务化 | 中 | 中 | MVP 模块化单体，按负载和故障域再拆分 |

## 12. 项目治理

### 12.1 决策机制

以下变更必须写 ADR：

- 动作协议语义变化。
- 安全等级变化。
- 新的设备写入口。
- 新的离线策略。
- Gateway/Edge 信任边界变化。
- 新的插件权限。
- 在线学习或自动技能发布。
- 实时控制路径依赖变化。

### 12.2 评审要求

| 变更 | 必要评审人 |
| --- | --- |
| Agent Prompt/Tool | Agent + 平台 |
| Action Protocol | 平台 + Edge + 机器人 |
| S2/S3 Capability | 机器人 + 安全 + 产品 |
| Edge/控制器 | 机器人 + 安全 |
| 身份和密钥 | 安全 + 平台 |
| 学习技能上线 | Agent + 机器人 + 安全 |

### 12.3 周期性活动

- 每周风险和阻塞评审。
- 每两周端到端演示。
- 每个阶段进行门禁评审。
- 每月故障注入演练。
- 试点期每周复盘安全拒绝和人工接管事件。

## 13. 前 30 天行动清单

### 第 1 周

- 确定首个机器人和场景。
- 指定技术负责人、机器人负责人和安全负责人。
- 建立目标产品代码目录。
- 创建 ADR 模板、风险登记和接口规范目录。
- 建立 ROS 2 仿真基线。

### 第 2 周

- 完成 OpenClaw 外部 Orchestrator Spike（**硬门槛**：本项目最大技术不确定性。若插件/Node 扩展点无法在不 fork 的前提下接入外部 Orchestrator，必须在本周内暴露，并据此重估 Phase 1 范围与 OpenClaw 集成路线，不得拖到 Phase 1）。
- 定义 Capability Manifest 和 Action Envelope 草案。
- 定义首批 3～5 个能力。
- 完成首版威胁模型和危害分析。

### 第 3 周

- 完成 ROS 2 Action 映射。
- 完成 Edge Inbox/Journal 原型。
- 验证幂等、重复命令和断电恢复。
- 决定 Edge 语言和传输协议。

### 第 4 周

- 完成文本指令到仿真机器人的垂直切片。
- 验证取消、过期、旧租约和前置条件拒绝。
- 建立基础 Trace 和 Action Ledger 查询。
- 召开 G0 评审并冻结 Phase 1 范围。

## 14. 里程碑总览

| 里程碑 | 参考时间 | 可演示结果 |
| --- | --- | --- |
| G0 架构路线确定 | 第 2～3 周 | OpenClaw + Orchestrator + ROS 2 技术闭环 |
| G1 仿真 MVP | 第 6～8 周 | 文本对话控制仿真机器人，可取消、可审计 |
| G2 单机器人硬件闭环 | 第 12～16 周 | 低速受控硬件、安全监督、断网恢复 |
| G3 多渠道体验 | 第 16～22 周 | 语音/App/IM、审批和人工接管 |
| G4 受监督试点 | 第 22～30 周 | 完成安全加固和试点 Runbook |
| G5 记忆与学习 | G4 之后 | 离线技能生成、评测、审批和灰度 |

时间估算需在 Phase 0 根据硬件成熟度、团队规模和安全要求重新校准。

