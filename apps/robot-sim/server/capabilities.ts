import {
  parseCapabilityManifest,
  type CapabilityManifest,
} from "@irobot/capability-schema";

/**
 * 仿真机器人的能力清单。全部经 capability-schema 校验，证明 demo 与冻结契约一致，
 * 而非另起一套。低速移动机器人，首个场景（开发计划 §3.3）。
 */
const RAW: unknown[] = [
  {
    capabilityId: "robot.telemetry.query_battery",
    version: "1.0.0",
    kind: "query",
    description: "查询当前电量百分比",
    safetyClass: "S0_OBSERVE",
    concurrencyKey: "telemetry",
    interruptMode: "cancel",
    defaultTimeoutMs: 5000,
    offlinePolicy: "local_autonomy_only",
    inputSchema: { type: "object", properties: {} },
    resultSchema: {
      type: "object",
      required: ["percent"],
      properties: { percent: { type: "number" } },
    },
  },
  {
    capabilityId: "robot.telemetry.query_pose",
    version: "1.0.0",
    kind: "query",
    description: "查询当前位置与朝向",
    safetyClass: "S0_OBSERVE",
    concurrencyKey: "telemetry",
    interruptMode: "cancel",
    defaultTimeoutMs: 5000,
    offlinePolicy: "local_autonomy_only",
    inputSchema: { type: "object", properties: {} },
    resultSchema: { type: "object", required: ["x", "y"], properties: {} },
  },
  {
    capabilityId: "robot.navigation.navigate_relative",
    version: "1.0.0",
    kind: "action",
    description: "在本地坐标系内沿当前朝向移动指定距离",
    safetyClass: "S2_GUARDED",
    concurrencyKey: "base_motion",
    interruptMode: "abort",
    defaultTimeoutMs: 60000,
    offlinePolicy: "execute_with_valid_lease",
    inputSchema: {
      type: "object",
      required: ["distanceM"],
      properties: {
        distanceM: { type: "number", minimum: -3, maximum: 3 },
        maxSpeedMps: { type: "number", minimum: 0.05, maximum: 0.6 },
      },
    },
    preconditions: [
      { path: "safety.estop", op: "==", value: false },
      { path: "localization.healthy", op: "==", value: true },
      { path: "battery.percent", op: ">=", value: 10 },
    ],
    resultSchema: {
      type: "object",
      required: ["distanceTravelledM"],
      properties: {},
    },
  },
  {
    capabilityId: "robot.navigation.navigate_to_point",
    version: "1.0.0",
    kind: "action",
    description: "导航到地图内任意坐标（自主探索/绕障，A* 避开障碍与河流）",
    safetyClass: "S2_GUARDED",
    concurrencyKey: "base_motion",
    interruptMode: "abort",
    defaultTimeoutMs: 90000,
    offlinePolicy: "execute_with_valid_lease",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: { type: "number", minimum: 0, maximum: 9.5 },
        y: { type: "number", minimum: 0, maximum: 8 },
      },
    },
    preconditions: [
      { path: "safety.estop", op: "==", value: false },
      { path: "localization.healthy", op: "==", value: true },
      { path: "battery.percent", op: ">=", value: 10 },
    ],
    resultSchema: { type: "object", required: ["distanceTravelledM"], properties: {} },
  },
  {
    capabilityId: "robot.navigation.navigate_to_station",
    version: "1.0.0",
    kind: "action",
    description: "导航到预定义站点",
    safetyClass: "S2_GUARDED",
    concurrencyKey: "base_motion",
    interruptMode: "abort",
    defaultTimeoutMs: 90000,
    offlinePolicy: "execute_with_valid_lease",
    inputSchema: {
      type: "object",
      required: ["station"],
      properties: { station: { type: "string" } },
    },
    preconditions: [
      { path: "safety.estop", op: "==", value: false },
      { path: "localization.healthy", op: "==", value: true },
      { path: "battery.percent", op: ">=", value: 10 },
    ],
    resultSchema: { type: "object", required: ["station"], properties: {} },
  },
  {
    capabilityId: "robot.navigation.enter_restricted_zone",
    version: "1.0.0",
    kind: "action",
    description: "进入受限/危险区域（高风险，需人工审批）",
    safetyClass: "S3_HAZARDOUS",
    concurrencyKey: "base_motion",
    interruptMode: "abort",
    defaultTimeoutMs: 90000,
    offlinePolicy: "stop_on_disconnect",
    inputSchema: { type: "object", properties: {} },
    preconditions: [
      { path: "safety.estop", op: "==", value: false },
      { path: "localization.healthy", op: "==", value: true },
    ],
    resultSchema: { type: "object", properties: {} },
  },
  {
    capabilityId: "robot.arm.move_to_pose",
    version: "1.0.0",
    kind: "action",
    description: "机械臂移动到预定义位姿（stow/reach/grasp/lift）",
    safetyClass: "S2_GUARDED",
    concurrencyKey: "arm",
    interruptMode: "abort",
    defaultTimeoutMs: 15000,
    offlinePolicy: "stop_on_disconnect",
    inputSchema: {
      type: "object",
      required: ["pose"],
      properties: { pose: { type: "string", enum: ["stow", "reach", "grasp", "lift"] } },
    },
    preconditions: [{ path: "safety.estop", op: "==", value: false }],
    resultSchema: { type: "object", required: ["pose"], properties: {} },
  },
  {
    capabilityId: "robot.navigation.return_to_dock",
    version: "1.0.0",
    kind: "action",
    description: "返回充电站",
    safetyClass: "S2_GUARDED",
    concurrencyKey: "base_motion",
    interruptMode: "abort",
    defaultTimeoutMs: 120000,
    offlinePolicy: "execute_with_valid_lease",
    inputSchema: { type: "object", properties: {} },
    preconditions: [{ path: "safety.estop", op: "==", value: false }],
    resultSchema: { type: "object", properties: {} },
  },
];

export const CAPABILITIES: ReadonlyMap<string, CapabilityManifest> = new Map(
  RAW.map((r) => {
    const m = parseCapabilityManifest(r);
    return [m.capabilityId, m] as const;
  }),
);

export function getCapability(id: string): CapabilityManifest | undefined {
  return CAPABILITIES.get(id);
}
