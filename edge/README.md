# edge — 快环（TurtleBot 4 / ROS 2 Jazzy / Rust）

Edge Runtime 是架构里的**确定性快环 + 权威安全层**（ADR-010 Rust、ADR-012 TB4 + Jazzy）。
每台机器人本地一个 Edge Runtime，验证命令、跑安全监督、把领域动作桥接到 ROS 2 执行。

## 结构

```text
edge/
  runtime/           # Rust crate：语言无关的快环安全逻辑（零依赖，可离线 cargo test）
    src/action_state.rs  # 动作状态机（终态不可变）
    src/safety.rs        # 安全等级 S0–S4 + 确定性前置条件
    src/edge_guard.rs    # 准入守卫：幂等/租约fencing/并发互斥/deadline + Action Journal
  ros2_ws/src/
    irobot_interfaces/   # ROS 2 Jazzy 领域接口：.action + RobotStatus.msg
    irobot_action_bridge/  # (待做) rclrs 节点：irobot_interfaces ↔ Nav2 / irobot_create_msgs
    irobot_simulator/      # (待做) 仿真 Action Server（Ignition/Gazebo + Nav2）
  safety-supervisor/   # (待做) 独立安全监督进程/看门狗
```

## Rust Edge 核心（现已可编译可测）

```bash
cd edge/runtime && cargo test --offline    # 14 项测试
```

强制的 §8.2 安全不变量（与 TS 侧 `apps/robot-sim` orchestrator 一致，Edge 为权威二次守卫）：
终态不可变、S4 禁止、deadline 过期拒绝、租约 fencing、并发 concurrency_key 互斥、幂等去重、
前置条件 fail-closed。

## 与 TurtleBot 4 的映射

- 导航（NavigateRelative / NavigateToStation）→ Nav2 `NavigateToPose`。
- 返回充电（ReturnToDock）→ Nav2 到坞前 + `irobot_create_msgs/action/Dock`。
- 急停 / 悬崖 / 碰撞 → Create 3 固件硬件安全层（独立于上位机，安全不变量 §4.1#3）。
- 速度上限收敛到 TB4 平台（线速 ≤ ~0.31 m/s）。

## 待做（需 ROS 2 Jazzy 环境 + colcon）

`ros2` feature：rclrs 节点把 `irobot_interfaces` 桥接到 Nav2 与 Create 3，发布 RobotStatus，
映射 goal/feedback/cancel/result，生命周期节点。本沙箱无 ROS 2，故仅接口定义 + 纯 Rust 核心先行。
