# ADR-012: 首个目标硬件 TurtleBot 4，ROS 2 Jazzy

- 状态：Accepted
- 日期：2026-07-30
- 决策人：产品 + 机器人负责人
- 相关评审人：机器人 + Edge + 安全

## 背景

开发计划 §17 的首要待决策项：首个目标硬件与 ROS 2 发行版决定了 `edge/ros2_ws` 能否动工、
Edge Runtime 对接哪套驱动、以及安全参数（速度上限、急停链路）的具体来源。

## 决策

- **首个硬件：TurtleBot 4**（iRobot Create 3 底盘 + RPLIDAR + OAK-D 相机 + 树莓派 4）。
- **ROS 2 发行版：Jazzy Jalisco**（Ubuntu 24.04 LTS，与 TB4 官方镜像一致）。
- 导航走 **Nav2**（`nav2_msgs/action/NavigateToPose`）；对接/脱离对接、危险区、电量走
  **`irobot_create_msgs`**（Create 3 原生）。急停/危险检测由 Create 3 固件承担（不依赖上位机）。

## 后果

- 正面：TB4 是 ROS 2 支持最成熟、社区最广的低速移动平台，仿真（Ignition/Gazebo + Nav2）
  与实机接口一致，满足计划"仿真先行、同接口迁移"。急停/碰撞由 Create 3 固件保证，天然满足
  安全不变量 §4.1#3（硬件保护不依赖 LLM/网关/网络）。
- 代价 / 约束：TB4 最大线速度约 0.31 m/s、角速度约 1.9 rad/s——Capability Manifest 的
  `maxSpeedMps` 上限须收敛到该范围；导航语义绑定 Nav2，站点即预设 pose。
- 安全影响：正向。Create 3 的硬件急停/悬崖/碰撞传感是独立安全层，Edge Safety Supervisor 在其上叠加。

## 备选方案

- 自研底盘 / 其它平台（Jackal、Go2 等）：驱动成熟度或成本不占优，首期不选。
- ROS 2 Humble（Ubuntu 22.04）：更老的 LTS，但 TB4 新镜像与 Create 3 固件已对齐 Jazzy，选新不选旧。

## 关联

- Edge 语言见 [[0010-two-language-stack]]（Rust）。
- 该决策解除开发计划 §17 的首要阻塞，Phase 1→2 的 `irobot_interfaces` 与 Rust Edge 骨架据此展开。
