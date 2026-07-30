# 架构决策记录（ADR）

记录对系统结构、安全边界或接口有长期影响的决策。以下变更**必须**写 ADR（开发计划 §12.1）：动作协议语义、安全等级、新设备写入口、新离线策略、Gateway/Edge 信任边界、新插件权限、在线学习或自动技能发布、实时控制路径依赖。

模板见 [`0000-template.md`](0000-template.md)。文件名格式 `NNNN-kebab-title.md`。

## 索引

| ID | 决策 | 状态 | 记录 |
| --- | --- | --- | --- |
| ADR-001 | 认知慢环与确定性快环分离 | Accepted | 架构设计 §16 |
| ADR-002 | LLM 只生成声明式目标，不直接控制低层执行器 | Accepted | 架构设计 §16 |
| ADR-003 | OpenClaw 用于北向控制面，不作为最终机器人执行协议 | Accepted | 架构设计 §16 |
| ADR-004 | 新建 Action Envelope、Action Ledger、租约和 fencing | Accepted | 架构设计 §16 |
| ADR-005 | Edge Runtime 独立部署，SQLite 不进入实时线程 | Accepted | 架构设计 §16 |
| ADR-006 | 对话记忆与设备权威状态分离 | Accepted | 架构设计 §16 |
| ADR-007 | Claude Code 只做 clean-room 架构参考 | Accepted | 架构设计 §16 |
| ADR-008 | Hermes 学习仅在离线验证和审批后进入生产 | Accepted | 架构设计 §16 |
| ADR-009 | MVP 模块化单体，规模化后再引入持久消息总线 | Accepted | 架构设计 §16 |
| ADR-010 | MVP 双语言栈：慢环 TypeScript，快环 Rust | Accepted | [0010](0010-two-language-stack.md) |
| ADR-011 | 边缘上下文压缩为硬约束；云/边共用同一动作协议 | Accepted | [0011](0011-edge-context-compaction.md) |
| ADR-012 | 首个硬件 TurtleBot 4，ROS 2 Jazzy | Accepted | [0012](0012-first-hardware-turtlebot4-jazzy.md) |

ADR-001～009 的背景与后果详见架构设计 §16 及相关章节；此处只维护状态索引，避免重复。新决策一律新建独立文件。
