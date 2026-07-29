# ADR-010: MVP 双语言栈 — 慢环 TypeScript，快环 Rust

- 状态：Accepted
- 日期：2026-07-30
- 决策人：技术负责人
- 相关评审人：平台 + Edge + 机器人

## 背景

架构设计 §13 的初版技术选型允许 Command Orchestrator 在 TypeScript/Go/Rust 中任选团队主语言。对 6～8 人的核心团队，若慢环内部再引入第三种语言（Agent 用 TS、Orchestrator 用 Go/Rust、Edge 用 Rust/C++），集成成本、构建链、招聘和跨语言契约测试都会被摊薄，且没有对应的性能收益证据。

## 决策

MVP 阶段刻意压到两种语言：

- 慢环（Agent Runtime + Command Orchestrator）统一 TypeScript，共享 `platform/packages/*` 协议包、类型和测试基座。
- 快环（Edge Runtime + Safety Supervisor）统一 Rust（备选 C++），不引入 GC 停顿。

## 后果

- 正面：慢环共享一套类型和协议契约，减少序列化边界和契约漂移；小团队心智负担和构建链复杂度显著下降。
- 负面 / 代价：Orchestrator 放弃了 Go/Rust 在高并发下的潜在吞吐优势。
- 缓解：接口已通过协议包隔离，规模化阶段若 Orchestrator 出现吞吐或延迟瓶颈，可单独用 Go/Rust 重写，成本可控。
- 安全影响：无。快环仍为独立进程/固件，语言选择不改变安全边界。

## 备选方案

- Orchestrator 直接用 Rust：与 Edge 统一语言，但慢环失去与 Agent 的类型共享，且团队需在慢环也承担 Rust 开发速度成本，MVP 阶段得不偿失。
- 全栈 TypeScript（含 Edge）：Edge 实时路径不接受 GC 停顿，否决。
