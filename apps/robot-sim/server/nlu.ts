import type { Proposal } from "./orchestrator.js";

/**
 * 规则式中文意图解析。慢环的"认知"占位实现：把自然语言映射为声明式动作提案。
 * 刻意与真正的 LLM Agent 同形（都只产出提案，从不直接控制执行器），因此后续可整体
 * 替换为 Agent Runtime，而下游 Orchestrator/Edge 不变。零依赖、零密钥、可离线。
 */

export interface NluResult {
  kind: "proposal" | "control" | "smalltalk";
  proposal?: Proposal;
  control?: "cancel" | "estop" | "clear_estop";
  /** 立即口播的确认语。 */
  reply: string;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 解析距离（米），支持阿拉伯数字与常见中文数字；含小数与"点"。返回带符号数或 null。 */
export function parseDistance(text: string): number | null {
  const backward = /(后退|倒退|向后|往后|退)/.test(text);
  const sign = backward ? -1 : 1;

  const arabic = text.match(/(\d+(?:\.\d+)?)\s*米/);
  if (arabic) return sign * parseFloat(arabic[1]!);

  // 中文："两米""一米""一点五米""三点二米"
  const cn = text.match(/([零一二两三四五六七八九十]+)(?:点([零一二两三四五六七八九]+))?\s*米/);
  if (cn) {
    const whole = cnToNumber(cn[1]!);
    let frac = 0;
    if (cn[2]) {
      const digits = [...cn[2]].map((c) => CN_DIGITS[c] ?? 0);
      frac = parseFloat("0." + digits.join(""));
    }
    if (whole !== null) return sign * (whole + frac);
  }
  return null;
}

function cnToNumber(s: string): number | null {
  if (s.length === 1) return CN_DIGITS[s] ?? null;
  // 处理"十""十X""X十""X十Y"
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a === "" ? 1 : (CN_DIGITS[a!] ?? 0);
    const ones = b ? (CN_DIGITS[b] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return CN_DIGITS[s] ?? null;
}

const STATION_ALIASES: Array<[RegExp, string]> = [
  [/(一号站点|1号站点|一号|1号|站点一|站点1)/, "一号站点"],
  [/(二号站点|2号站点|二号|2号|站点二|站点2)/, "二号站点"],
  [/(大厅|门厅|前台)/, "大厅"],
];

export function parseIntent(raw: string): NluResult {
  const text = raw.trim();

  // 急停：语音仅作辅助，真正急停应走独立高优先通道（架构 §8.2）。
  if (/(急停|紧急停止|快停|马上停)/.test(text)) {
    return {
      kind: "control",
      control: "estop",
      reply: "已急停。请注意，正式系统的急停必须有独立硬件通道，语音不能是唯一方式。",
    };
  }
  if (/(解除急停|恢复运行|取消急停|解锁)/.test(text)) {
    return { kind: "control", control: "clear_estop", reply: "已解除急停。" };
  }
  // 取消/停止当前任务 → cancel（非急停）。
  if (/(取消|停下|停止|别动|停一下|等一下|停)/.test(text)) {
    return { kind: "control", control: "cancel", reply: "正在取消当前动作。" };
  }

  // 查询
  if (/(电量|电池|还有多少电|多少电)/.test(text)) {
    return {
      kind: "proposal",
      proposal: { capabilityId: "robot.telemetry.query_battery", arguments: {} },
      reply: "查询电量。",
    };
  }
  if (/(位置|在哪|坐标|哪里)/.test(text)) {
    return {
      kind: "proposal",
      proposal: { capabilityId: "robot.telemetry.query_pose", arguments: {} },
      reply: "查询位置。",
    };
  }

  // 进入受限/危险区（S3，将触发人工审批）
  if (/(危险区|受限区|禁区|危险区域|受限区域)/.test(text)) {
    return {
      kind: "proposal",
      proposal: { capabilityId: "robot.navigation.enter_restricted_zone", arguments: {} },
      reply: "好的，请求进入危险区。",
    };
  }

  // 返回充电
  if (/(回充电|返回充电|回坞|回桩|回家|去充电|充电)/.test(text)) {
    return {
      kind: "proposal",
      proposal: { capabilityId: "robot.navigation.return_to_dock", arguments: {} },
      reply: "好的，返回充电站。",
    };
  }

  // 导航到站点
  for (const [re, station] of STATION_ALIASES) {
    if (re.test(text) && /(去|到|前往|导航|走到|过去)/.test(text)) {
      return {
        kind: "proposal",
        proposal: {
          capabilityId: "robot.navigation.navigate_to_station",
          arguments: { station },
        },
        reply: `好的，前往${station}。`,
      };
    }
  }

  // 相对移动
  if (/(前进|后退|向前|向后|往前|往后|走|移动|退)/.test(text)) {
    const d = parseDistance(text);
    if (d !== null && d !== 0) {
      return {
        kind: "proposal",
        proposal: {
          capabilityId: "robot.navigation.navigate_relative",
          arguments: { distanceM: d },
        },
        reply: d > 0 ? `前进${d}米。` : `后退${Math.abs(d)}米。`,
      };
    }
    return {
      kind: "smalltalk",
      reply: "请告诉我移动多远，例如“前进两米”。",
    };
  }

  return {
    kind: "smalltalk",
    reply:
      "我可以：前进/后退几米、去一号或二号站点、去大厅、返回充电、查电量或位置。说“取消”停止，说“急停”紧急停止。",
  };
}
