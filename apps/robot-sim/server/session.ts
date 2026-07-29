import type { ActionEvent } from "@irobot/action-protocol";
import { SimRobot, type Telemetry } from "./sim-robot.js";
import { Orchestrator, type Proposal } from "./orchestrator.js";
import { parseIntent, type NluResult } from "./nlu.js";
import { CAPABILITIES } from "./capabilities.js";
import { claudeCliAvailable, type AgentWorldContext } from "./agent-claude.js";
import { ResidentAgent } from "./agent-resident.js";
import { ApiAgent, apiKeyAvailable } from "./agent-api.js";

/** 认知慢环后端的统一接口。ApiAgent / ResidentAgent 都实现它。 */
interface Agent {
  ask(text: string, ctx: AgentWorldContext): Promise<NluResult | null>;
  stop(): void;
}

export type SseMessage =
  | { kind: "hello"; telemetry: Telemetry; capabilities: string[]; agent: string }
  | { kind: "telemetry"; data: Telemetry }
  | { kind: "transcript"; role: "user" | "agent"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "status"; busy: boolean; label?: string }
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
  private readonly history: Array<{ role: "user" | "agent"; text: string }> = [];
  private agent: Agent | null = null;
  private agentName = "规则式 NLU";

  constructor() {
    this.robot = new SimRobot((t) => this.broadcast({ kind: "telemetry", data: t }));
    this.orchestrator = new Orchestrator(this.robot);
  }

  async start(): Promise<void> {
    this.robot.start();
    // 后端优先级：显式 mode 优先；auto 时优先 API（近实时），否则常驻 CLI，否则规则式。
    const mode = process.env.IROBOT_AGENT ?? "auto";
    const model = process.env.IROBOT_API_MODEL ?? process.env.IROBOT_AGENT_MODEL ?? "haiku";
    if ((mode === "api" || mode === "auto") && apiKeyAvailable()) {
      this.agent = new ApiAgent();
      this.agentName = `API (${model})`;
    } else if ((mode === "claude" || mode === "auto") && (await claudeCliAvailable())) {
      const r = new ResidentAgent();
      r.warmup();
      this.agent = r;
      this.agentName = `claude 常驻 (${process.env.IROBOT_AGENT_MODEL ?? "haiku"})`;
    }
    if (!this.agent) this.agentName = "规则式 NLU";
    console.log(`  Agent: ${this.agentName}`);
  }
  stop(): void {
    this.robot.stop();
    this.agent?.stop();
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn({
      kind: "hello",
      telemetry: this.robot.telemetry(),
      capabilities: [...CAPABILITIES.keys()],
      agent: this.agentName,
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

  private worldContext(): AgentWorldContext {
    const t = this.robot.telemetry();
    return {
      battery: t.battery,
      pose: { x: t.pose.x, y: t.pose.y },
      estop: t.estop,
      charging: t.charging,
      stations: Object.keys(t.stations),
      history: this.history.slice(-6),
    };
  }

  /** 处理一句用户语音/文本。 */
  async converse(text: string): Promise<void> {
    this.broadcast({ kind: "transcript", role: "user", text });
    this.history.push({ role: "user", text });

    // 认知慢环：优先 LLM Agent，失败回退规则式 NLU（fail-closed，不阻塞）。
    let intent: NluResult | null = null;
    if (this.agent) {
      this.broadcast({ kind: "status", busy: true, label: "思考中…" });
      intent = await this.agent.ask(text, this.worldContext());
      this.broadcast({ kind: "status", busy: false });
    }
    if (!intent) intent = parseIntent(text);

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
    if (!text) return;
    this.history.push({ role: "agent", text });
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
