import type { ActionEvent } from "@irobot/action-protocol";
import { SimRobot, type Telemetry } from "./sim-robot.js";
import { type Proposal } from "./orchestrator.js";
import { parseIntent, type NluResult } from "./nlu.js";
import { CAPABILITIES } from "./capabilities.js";
import { claudeCliAvailable, type AgentWorldContext } from "./agent-claude.js";
import { ResidentAgent } from "./agent-resident.js";
import { ApiAgent, apiKeyAvailable } from "./agent-api.js";
import { MemoryLedgerStore, type LedgerStore, type LedgerEntry } from "./ledger-store.js";
import type { EdgeClient } from "./edge-client.js";
import { Fleet } from "./fleet.js";
import type { WorldMapData } from "./world-map.js";
import type { MapStore, MapMeta } from "./map-store.js";

interface Agent {
  ask(text: string, ctx: AgentWorldContext): Promise<NluResult | null>;
  stop(): void;
}

export type SseMessage =
  | { kind: "hello"; telemetry: Telemetry; robots: Array<{ deviceId: string; telemetry: Telemetry }>; activeDevice: string; capabilities: string[]; agent: string }
  | { kind: "telemetry"; deviceId: string; data: Telemetry }
  | { kind: "transcript"; role: "user" | "agent"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "status"; busy: boolean; label?: string }
  | { kind: "active"; deviceId: string }
  | { kind: "action"; event: ActionEvent; capabilityId: string; deviceId: string }
  | { kind: "map"; map: WorldMapData; coverage: number };

type Subscriber = (msg: SseMessage) => void;

const CN_NUM: Record<string, string> = { 一: "1", 二: "2", 三: "3", 四: "4" };

/** 从文本中解析目标机器人（"二号机器人 前进" / "切换到机器人2"）。 */
function parseDevice(text: string): { deviceId?: string; rest: string; isSwitch: boolean } {
  const m = text.match(/([一二三四1234])号机器人|机器人\s*([一二三四1234])|robot\s*([1234])/i);
  if (!m) return { rest: text, isSwitch: false };
  const raw = m[1] ?? m[2] ?? m[3] ?? "";
  const n = CN_NUM[raw] ?? raw;
  const isSwitch = /切换|选择|激活|控制/.test(text) && text.replace(m[0], "").replace(/[切换到选择激活控制\s，,。]/g, "") === "";
  const rest = text.replace(m[0], "").replace(/^[，,。\s让把使]*(切换到?|选择|激活|控制)?[，,。\s]*/, "").trim();
  return { deviceId: `robot-${n}`, rest, isSwitch };
}

/**
 * 会话：单用户，管理一个 Fleet（默认 1 台，IROBOT_FLEET=N 开多台）。把语音文本经
 * NLU → 目标设备的 Orchestrator → SimRobot 串起来，广播遥测/动作/口播（按 deviceId 区分）。
 */
export class Session {
  readonly robot: SimRobot; // 主设备（robot-1），兼容既有调用
  private readonly fleet: Fleet;
  private readonly store: LedgerStore;
  private activeDevice: string;
  private readonly subscribers = new Set<Subscriber>();
  private readonly history: Array<{ role: "user" | "agent"; text: string }> = [];
  private agent: Agent | null = null;
  private agentName = "规则式 NLU";
  private mapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: LedgerStore = new MemoryLedgerStore(),
    edge?: EdgeClient,
    private readonly mapStore?: MapStore,
  ) {
    this.store = store;
    const count = Math.max(1, Math.min(4, Number(process.env.IROBOT_FLEET ?? 1)));
    this.fleet = new Fleet(count, (deviceId, t) => this.broadcast({ kind: "telemetry", deviceId, data: t }), store, edge);
    this.robot = this.fleet.primary().robot;
    this.activeDevice = this.fleet.primary().deviceId;
  }

  async start(): Promise<void> {
    this.fleet.start();
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
    if (this.fleet.all().length > 1) console.log(`  舰队：${this.fleet.deviceIds().join(", ")}`);
    console.log(`  Agent: ${this.agentName}`);
    // 建图节流广播：占据栅格有变化时每 ~500ms 推一次。
    this.mapTimer = setInterval(() => {
      if (this.fleet.worldMap.dirty) {
        this.fleet.worldMap.dirty = false;
        this.broadcast(this.mapMessage());
      }
    }, 500);
    if (this.mapTimer && "unref" in this.mapTimer) (this.mapTimer as { unref: () => void }).unref();
  }
  stop(): void {
    this.fleet.stop();
    this.agent?.stop();
    if (this.mapTimer) { clearInterval(this.mapTimer); this.mapTimer = null; }
  }

  // ---- 三维地图：生成 / 建图（占据）/ 保存 / 加载 / 清除 ----
  private mapMessage(): SseMessage {
    return { kind: "map", map: this.fleet.worldMap.serialize(), coverage: this.fleet.worldMap.coverage() };
  }
  /** 程序化生成障碍环境并重置建图。 */
  generateMap(seed?: number): void {
    this.fleet.worldMap.generate(seed ?? (Date.now() & 0x7fffffff));
    this.broadcast(this.mapMessage());
    this.say("已生成新的障碍环境，开始探索建图。");
  }
  /** 清除已建占据栅格（保留障碍环境）。 */
  clearMap(): void {
    this.fleet.worldMap.clearOccupancy();
    this.broadcast(this.mapMessage());
    this.say("已清除建图。");
  }
  async saveMap(name: string): Promise<string | null> {
    if (!this.mapStore) return null;
    const saved = await this.mapStore.save(name, this.fleet.worldMap.serialize());
    this.say(`地图已保存为「${saved}」。`);
    return saved;
  }
  async loadMap(name: string): Promise<boolean> {
    if (!this.mapStore) return false;
    const data = await this.mapStore.load(name);
    this.fleet.worldMap.load(data);
    this.broadcast(this.mapMessage());
    this.say(`已加载地图「${name}」。`);
    return true;
  }
  async listMaps(): Promise<MapMeta[]> {
    return this.mapStore ? this.mapStore.list() : [];
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn({
      kind: "hello",
      telemetry: this.robot.telemetry(),
      robots: this.fleet.all().map((m) => ({ deviceId: m.deviceId, telemetry: m.robot.telemetry() })),
      activeDevice: this.activeDevice,
      capabilities: [...CAPABILITIES.keys()],
      agent: this.agentName,
    });
    fn(this.mapMessage()); // 晚订阅者立即拿到当前地图
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

  /** 物理急停通道：作用于全舰队（安全）。 */
  estop(on: boolean): void {
    for (const m of this.fleet.all()) m.robot.setEstop(on);
    this.broadcast({ kind: "reply", text: on ? "已急停（全部）。" : "已解除急停。" });
  }

  cancel(): void {
    const ok = this.fleet.get(this.activeDevice)!.orchestrator.cancelActive();
    if (!ok) this.broadcast({ kind: "reply", text: "当前没有正在执行的动作。" });
  }

  /** 北向入口：按 envelope.deviceId 路由到对应设备的 Orchestrator。 */
  async executeExternalEnvelope(
    envelope: unknown,
    onEvent: (ev: ActionEvent) => void,
  ): Promise<ActionEvent> {
    const obj = (envelope ?? {}) as { capabilityId?: string; deviceId?: string };
    const deviceId = obj.deviceId && this.fleet.get(obj.deviceId) ? obj.deviceId : this.fleet.primary().deviceId;
    const capabilityId = obj.capabilityId || "external";
    this.broadcast({ kind: "transcript", role: "user", text: `（OpenClaw 插件动作：${capabilityId} → ${deviceId}）` });
    return this.fleet.get(deviceId)!.orchestrator.executeEnvelope(envelope, (ev) => {
      onEvent(ev);
      this.broadcast({ kind: "action", event: ev, capabilityId, deviceId });
      if (ev.state === "PENDING_APPROVAL") this.say("外部指令为高风险动作，请在界面确认。");
    });
  }

  /** 全链路审计查询（G1）；舰队共享一个 store（条目带 deviceId）。 */
  ledger(): readonly LedgerEntry[] {
    return this.store.all();
  }

  /** 界面审批决策：在各设备的 Orchestrator 中查找该命令。 */
  approve(commandId: string, approved: boolean): void {
    const ok = this.fleet.all().some((m) => m.orchestrator.resolveApproval(commandId, approved));
    if (!ok) this.broadcast({ kind: "reply", text: "没有待审批的动作，可能已超时。" });
  }

  private worldContext(deviceId: string): AgentWorldContext {
    const t = this.fleet.get(deviceId)!.robot.telemetry();
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

    // 设备寻址：解析目标机器人前缀（仅多机时）。
    if (this.fleet.all().length > 1) {
      const { deviceId, rest, isSwitch } = parseDevice(text);
      if (deviceId && this.fleet.get(deviceId)) {
        this.activeDevice = deviceId;
        this.broadcast({ kind: "active", deviceId });
        if (isSwitch || !rest) {
          this.say(`已切换到${deviceId}。`);
          return;
        }
        text = rest; // 用剩余部分做意图解析
      }
    }
    const device = this.activeDevice;
    const member = this.fleet.get(device)!;

    let intent: NluResult | null = null;
    if (this.agent) {
      this.broadcast({ kind: "status", busy: true, label: "思考中…" });
      intent = await this.agent.ask(text, this.worldContext(device));
      this.broadcast({ kind: "status", busy: false });
    }
    if (!intent) intent = parseIntent(text);

    if (intent.kind === "control") {
      if (intent.control === "estop") for (const m of this.fleet.all()) m.robot.setEstop(true);
      else if (intent.control === "clear_estop") for (const m of this.fleet.all()) m.robot.setEstop(false);
      else if (intent.control === "cancel") member.orchestrator.cancelActive();
      this.say(intent.reply);
      return;
    }
    if (intent.kind === "smalltalk") {
      this.say(intent.reply);
      return;
    }

    this.say(intent.reply);
    const proposal = intent.proposal!;
    const finalEvent = await member.orchestrator.propose(proposal, (ev) => {
      this.broadcast({ kind: "action", event: ev, capabilityId: proposal.capabilityId, deviceId: device });
      if (ev.state === "PENDING_APPROVAL") {
        this.say("这是高风险动作，需要你在界面上确认。请点击批准或拒绝。");
      }
    });
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
        case "robot.navigation.enter_restricted_zone":
          return "审批通过，已进入危险区。";
        case "robot.arm.move_to_pose": {
          const poseLabel: Record<string, string> = { stow: "已收起机械臂", reach: "机械臂已伸出", grasp: "机械臂已抓取", lift: "机械臂已抬起" };
          return poseLabel[String(proposal.arguments.pose)] ?? "机械臂动作完成。";
        }
        default:
          return "动作完成。";
      }
    }
    if (ev.state === "CANCELLED") return "已取消当前动作。";
    if (ev.state === "EXPIRED") return `${p.reason ?? "已过期"}。`;
    if (ev.state === "REJECTED") return `无法执行：${p.reason ?? "被策略拒绝"}。`;
    if (ev.state === "FAILED") {
      if (p.reason === "estop") return "已因急停停止。";
      if (p.reason === "device_busy") return "我正在执行其他动作，请先说取消。";
      return `动作失败：${p.reason ?? "未知原因"}。`;
    }
    return "";
  }
}
