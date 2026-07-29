# 风险登记

活跃风险跟踪表。P=概率，I=影响。状态：Open / Mitigating / Closed。责任人在 Phase 0（第 1 周）指定。

来源：开发计划 §11（R01–R14）+ 架构评估补充（R15–R18）。

| ID | 风险 | P | I | 缓解措施 | 责任人 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | OpenClaw 扩展点不足 | 低 | 中高 | ✅ Spike 通过：外部 Tool 插件即可接入，见 spikes/openclaw-integration.md；完整 e2e 待 Phase 1 | TBD | Mitigating |
| R02 | 机器人驱动不完整 | 高 | 高 | 首期选 ROS 2 支持成熟的硬件；仿真先行 | TBD | Open |
| R03 | Agent 行为不稳定 | 高 | 中 | Schema、最大轮次、动作提案、确定性验证、固定 Mission 快照 | TBD | Mitigating |
| R04 | 网络重试导致重复动作 | 中 | 极高 | Inbox/Outbox、幂等处理器、终态不变 | TBD | Mitigating |
| R05 | Gateway 双主 | 中 | 极高 | 单设备所有者、租约、fencing token | TBD | Mitigating |
| R06 | Prompt Injection | 高 | 高 | 信任标记、Schema、最小权限、Agent 无设备密钥 | TBD | Open |
| R07 | SQLite 进入实时路径 | 低 | 高 | 架构测试和线程边界检查 | TBD | Open |
| R08 | 安全逻辑散落插件 | 中 | 高 | 策略集中在 Orchestrator/Edge，插件只做适配 | TBD | Open |
| R09 | 在线学习造成行为漂移 | 中 | 极高 | Phase 5 前禁用；离线评测、审批、签名 | TBD | Open |
| R10 | 多 Agent 争抢设备 | 中 | 高 | concurrencyKey、Mission Supervisor、单写者 | TBD | Mitigating |
| R11 | 研究代码许可风险 | 中 | 高 | Claude Code 仅 clean-room 借鉴；建立第三方代码清单 | TBD | Mitigating |
| R12 | 现场人工接管不足 | 中 | 极高 | 产品需求阶段定义本地接管和硬件急停 | TBD | Open |
| R13 | 原始音视频成本过高 | 中 | 中 | 边缘预处理、事件摘要、短期对象引用 | TBD | Open |
| R14 | 过早微服务化 | 中 | 中 | MVP 模块化单体，按负载和故障域再拆分 | TBD | Open |
| R15 | 工期乐观（HIL/安全评审溢出） | 高 | 中 | 22～30 周视为下限；G0 末按硬件成熟度重估 | TBD | Open |
| R16 | 多语言栈集成成本 | 中 | 中 | ADR-010：MVP 压到双语言（TS 慢环 / Rust 快环） | TBD | Closed |
| R17 | OpenClaw 接入为最大未知 | 低 | 高 | ✅ Spike 通过：流式/取消/审批/配置四缝均由 plugin-sdk 提供，源码级验证 | TBD | Mitigating |
| R18 | 边缘算力约束下 Agent 无法运行 | 中 | 中 | ADR-011：上下文压缩为硬约束，云/边共用动作协议 | TBD | Mitigating |

## 极高影响风险优先级

R04、R05、R09、R12 为极高影响（I=极高），须在对应阶段门禁前具备自动化属性测试（开发计划 §8.2）：
一个 commandId 最多一个物理动作实例；旧 leaseEpoch 永不覆盖新 epoch；候选技能不能直接进入生产目录；本地接管与硬件急停不依赖 Gateway。
