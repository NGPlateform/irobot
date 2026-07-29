import { describe, it, expect } from "vitest";
import { parseClaudeEnvelope } from "./agent-claude.js";

const envelope = (structured: unknown, isError = false) =>
  JSON.stringify({ is_error: isError, result: JSON.stringify(structured), structured_output: structured });

describe("parseClaudeEnvelope：CLI 输出 → NluResult", () => {
  it("proposal 映射为动作提案", () => {
    const r = parseClaudeEnvelope(
      envelope({
        kind: "proposal",
        capabilityId: "robot.navigation.navigate_relative",
        arguments: { distanceM: 2 },
        say: "好的，前进2米",
      }),
    );
    expect(r?.kind).toBe("proposal");
    expect(r?.proposal?.capabilityId).toBe("robot.navigation.navigate_relative");
    expect(r?.proposal?.arguments.distanceM).toBe(2);
    expect(r?.reply).toBe("好的，前进2米");
  });

  it("control 映射为控制意图", () => {
    const r = parseClaudeEnvelope(envelope({ kind: "control", control: "estop", say: "已急停" }));
    expect(r?.kind).toBe("control");
    expect(r?.control).toBe("estop");
  });

  it("smalltalk 映射为闲聊", () => {
    const r = parseClaudeEnvelope(envelope({ kind: "smalltalk", say: "我可以帮你导航" }));
    expect(r?.kind).toBe("smalltalk");
    expect(r?.reply).toBe("我可以帮你导航");
  });

  it("回退：无 structured_output 时解析 result 文本", () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: JSON.stringify({ kind: "smalltalk", say: "你好" }),
    });
    expect(parseClaudeEnvelope(stdout)?.reply).toBe("你好");
  });

  it("fail-closed：is_error / 非法 JSON / 缺字段 → null", () => {
    expect(parseClaudeEnvelope(envelope({ kind: "smalltalk", say: "x" }, true))).toBeNull();
    expect(parseClaudeEnvelope("not json")).toBeNull();
    expect(parseClaudeEnvelope(JSON.stringify({ structured_output: { kind: "proposal" } }))).toBeNull();
  });
});
