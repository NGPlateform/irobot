//! iRobot Edge Runtime（TurtleBot 4 / ROS 2 Jazzy）核心安全逻辑。
//!
//! 本 crate 只含**语言无关、可离线验证**的快环安全逻辑：动作状态机、安全等级/前置条件、
//! Edge 准入守卫（幂等/租约/并发/deadline）+ Action Journal。这是架构里的 Edge 权威安全层。
//!
//! 尚未包含（需 ROS 2 Jazzy 环境 + colcon，留待 `ros2` feature）：
//! - rclrs 节点：把 `irobot_interfaces` 的 Action 桥接到 Nav2 `NavigateToPose` 与
//!   `irobot_create_msgs` 的对接/电量；
//! - RobotStatus 发布、Nav2 goal/feedback/cancel 映射、生命周期节点。
//!
//! 对应关系：本 crate 的不变量与 TS 侧 `apps/robot-sim/server/orchestrator.ts` 一致，
//! 即"云/边共用同一动作语义"（ADR-011），Edge 侧为权威二次守卫。

pub mod action_state;
pub mod edge_guard;
pub mod protocol;
pub mod safety;

pub use action_state::{apply_transition, ActionState, IllegalTransition};
pub use edge_guard::{ActionRequest, Admission, EdgeGuard, JournalEntry};
pub use safety::{
    check_preconditions, eval_precondition, Op, Precondition, SafetyClass, StateSnapshot, Value,
};
