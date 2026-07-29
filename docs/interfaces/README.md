# 接口冻结状态

接口按开发计划 §7 的顺序冻结。冻结不代表不可扩展，但要求：新字段默认可选；枚举扩展必须有未知值处理；删除或改变语义必须提升主版本；Gateway 与 Edge 至少支持一个兼容窗口。

| # | 接口 | 版本 | 状态 | 实现位置 |
| --- | --- | --- | --- | --- |
| 1 | Capability Manifest | v0.1 | ✅ 已冻结 | `platform/packages/capability-schema` |
| 2 | Action Envelope | v0.1 | ✅ 已冻结 | `platform/packages/action-protocol` |
| 3 | Action Event 与状态机 | v0.1 | ✅ 已冻结 | `platform/packages/action-protocol` |
| 4 | Orchestrator API | v0.1 | 🚧 待定义（Phase 1） | `platform/services/command-orchestrator` |
| 5 | Edge Transport | v0.1 | 🚧 待定义（Phase 1） | `edge/runtime` |
| 6 | ROS 2 Action 接口 | v0.1 | 🚧 待定义（Phase 1） | `edge/ros2_ws/src/irobot_interfaces` |
| 7 | Approval API | v0.1 | ⬜ 未开始（Phase 3） | `platform/services/gateway-adapter` |
| 8 | Device State / Digital Twin API | v0.1 | ⬜ 未开始（Phase 1） | `platform/services/device-registry` |
| 9 | Trajectory Schema | v0.1 | ⬜ 未开始（Phase 5） | `learning/trajectory` |

## 已冻结契约的不变量（有测试保护）

- **安全等级**：S4_FORBIDDEN 永远拒绝且 Agent 不可提案；S2/S3 强制 Edge 侧二次校验。
- **Capability Manifest**：strict（拒绝未知字段防漂移）；kind=query 必须 S0_OBSERVE；capabilityId / 版本格式受约束。
- **Action Envelope**：strict；缺 idempotencyKey / leaseEpoch 一律拒绝（恰好一次效果与 fencing 的前提）；模型快照必须完整。
- **动作状态机**：五个终态不可变；跳过 VALIDATING 直达 EXECUTING/ACCEPTED 非法（不能绕过 Orchestrator）。

golden fixtures：`action-protocol/fixtures/`、`capability-schema/manifests/`。运行 `pnpm -r test` 校验。
