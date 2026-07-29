# irobot — 智能设备与机器人对话执行系统

将自然语言转化为**可验证、可审计、可取消**的设备动作。核心架构为「慢速认知环 + 快速确定性控制环」双环分离：LLM 只提出目标或候选动作，物理执行由独立的命令编排与边缘安全监督层负责。

- 架构设计：[docs/architecture-design.md](docs/architecture-design.md)
- 开发计划：[docs/development-plan.md](docs/development-plan.md)
- 架构决策：[docs/adr/](docs/adr/) · 风险登记：[docs/risk-register.md](docs/risk-register.md)
- 接口冻结状态：[docs/interfaces/README.md](docs/interfaces/README.md)

## 安全不变量（不可绕过）

1. LLM 只能提出目标或候选动作，不能直接控制执行器。
2. 所有写操作必须经过 Command Orchestrator 和 Edge Safety Supervisor。
3. 硬件急停、碰撞保护和看门狗不依赖 LLM、Gateway 或互联网。
4. 身份、状态、策略或租约不明确时 fail-closed。
5. 同一控制域同一时刻只有一个命令所有者；重试不产生重复物理动作。

完整清单见架构设计 §4.1。

## 仓库结构

```text
platform/
  packages/          # 冻结的协议契约（TypeScript + zod）
    policy-contract/     # S0–S4 安全等级、前置条件
    capability-schema/   # Capability Manifest v0.1
    action-protocol/     # Action Envelope / Event / 状态机 v0.1
  services/          # 慢环服务（TypeScript）
    gateway-adapter/ agent-runtime/ command-orchestrator/ device-registry/
edge/                # 快环（Rust 优先）
  runtime/ safety-supervisor/
  ros2_ws/src/       # irobot_action_bridge / irobot_simulator / irobot_interfaces
adapters/            # home-assistant / matter（写操作仍经统一策略层）
learning/            # 旁路：轨迹 / 评测 / 技能候选（不进物理关键路径）
tests/               # contract / simulation / fault-injection / security
docs/                # 架构、计划、ADR、接口、风险
```

研究基线仓库 `claude-code/`、`hermes-agent/`、`openclaw/` 仅作设计参考，不纳入产品代码历史（见 `.gitignore`）。

## 开发

```bash
pnpm install
pnpm rebuild esbuild   # 首次：批准 vitest 的 esbuild 构建
pnpm -r test           # 运行全部契约测试
```

要求 Node ≥ 22、pnpm 10。快环与 ROS 2 部分见 `edge/`。

## 当前状态：Phase 0（架构与风险预研）

已冻结首批契约并附 golden fixture 与不变量测试：
Capability Manifest v0.1、Action Envelope v0.1、动作状态机 v0.1（含终态不可变约束）。

G0 退出门槛见 [docs/development-plan.md §5.1](docs/development-plan.md)。下一步硬门槛：**OpenClaw 外部 Orchestrator 接入 Spike**（第 2 周内验证）。
