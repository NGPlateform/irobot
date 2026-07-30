# 权威设备状态快照（架构 §7 数据分类：设备状态只能来自设备/数字孪生）。
# Edge Runtime 周期发布；数字孪生据此更新，Agent 只读带版本的快照。

builtin_interfaces/Time stamp
geometry_msgs/Pose pose
float32 battery_percent
bool is_charging
bool estop_engaged            # 来自 Create 3 硬件安全层，独立于上位机
bool localization_healthy
uint32 state_version          # 单调递增，动作携带 expected_state_version 做一致性校验
