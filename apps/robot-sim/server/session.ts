import type { ActionEvent } from "@irobot/action-protocol";
import { SimRobot, type Telemetry } from "./sim-robot.js";
import { Orchestrator, type Proposal } from "./orchestrator.js";
import { parseIntent } from "./nlu.js";
import { CAPABILITIES } from "./capabilities.js";

export type SseMessage =
  | { kind: "hello"; telemetry: Telemetry; capabilities: string[] }
  | { kind: "telemetry"; data: Telemetry }
  | { kind: "transcript"; role: "user" | "agent"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "action"; event: ActionEvent; capabilityId: string };

type Subscriber = (msg: SseMessage) => void;

/**
 * 会话：单用户、单仿真机器人。把语音文本经 NLU → Orchestrator → SimRobot 串起来，
 * 并把遥测、动作事件、口播回复广播给所有 SSE 订阅者（浏览器）。
 */
export class Session {
  readonly robot: SimRobot;
  private readonly orchestrator: Orchestrator;
  private readonly subscribers = new Set<Subscriber>();

  constructor() {
    this.robot = new SimRobot((t) => this.broadcast({ kind: "telemetry", data: t }));
    this.orchestrator = new Orchestrator(this.robot);
  }

  start(): void {
    this.robot.start();
  }
  stop(): void {
    this.robot.stop();
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn({
      kind: "hello",
      telemetry: this.robot.telemetry(),
      capabilities: [...CAPABILITIES.keys()],
    });
    return () => this.subscribers.delete(fn);
  }

  private broadcast(msg: SseMessage): void {
    for (const fn of this.subscribers) {
      try {
        fn(msg);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }

  /** 物理急停通道（UI 的 E-STOP 按钮 / 语音"急停"）。 */
  estop(on: boolean): void {
    this.robot.setEstop(on);
    this.broadcast({ kind: "reply", text: on ? "已急停。" : "已解除急停。" });
  }

  cancel(): void {
    const ok = this.orchestrator.cancelActive();
    if (!ok) this.broadcast({ kind: "reply", text: "当前没有正在执行的动作。" });
  }

  /** 处理一句用户语音/文本。 */
  async converse(text: string): Promise<void> {
    this.broadcast({ kind: "transcript", role: "user", text });
    const intent = parseIntent(text);

    if (intent.kind === "control") {
      if (intent.control === "estop") this.robot.setEstop(true);
      else if (intent.control === "clear_estop") this.robot.setEstop(false);
      else if (intent.control === "cancel") this.orchestrator.cancelActive();
      this.say(intent.reply);
      return;
    }

    if (intent.kind === "smalltalk") {
      this.say(intent.reply);
      return;
    }

    // proposal
    this.say(intent.reply);
    const proposal = intent.proposal!;
    const finalEvent = await this.orchestrator.propose(proposal, (ev) =>
      this.broadcast({
        kind: "action",
        event: ev,
        capabilityId: proposal.capabilityId,
      }),
    );
    this.say(this.completionSpeech(proposal, finalEvent));
  }

  private say(text: string): void {
    this.broadcast({ kind: "transcript", role: "agent", text });
    this.broadcast({ kind: "reply", text });
  }

  private completionSpeech(proposal: Proposal, ev: ActionEvent): string {
    const p = ev.payload as Record<string, unknown>;
    if (ev.state === "SUCCEEDED") {
      switch (proposal.capabilityId) {
        case "robot.telemetry.query_battery":
          return `当前电量 ${p.percent}%。`;
        case "robot.telemetry.query_pose":
          return `我在坐标 ${p.x}, ${p.y}。`;
        case "robot.navigation.navigate_relative":
          return `已完成移动，行进 ${p.distanceTravelledM} 米。`;
        case "robot.navigation.navigate_to_station":
          return `已到达${proposal.arguments.station}。`;
        case "robot.navigation.return_to_dock":
          return "已返回充电站，开始充电。";
        default:
          return "动作完成。";
      }
    }
    if (ev.state === "CANCELLED") return "已取消当前动作。";
    if (ev.state === "REJECTED") return `无法执行：${p.reason ?? "被策略拒绝"}。`;
    if (ev.state === "FAILED") {
      if (p.reason === "estop") return "已因急停停止。";
      if (p.reason === "device_busy") return "我正在执行其他动作，请先说取消。";
      return `动作失败：${p.reason ?? "未知原因"}。`;
    }
    return "";
  }
}
