import { describe, it, expect } from "vitest";
import { VOICES, resolveVoice } from "./tts.js";

describe("TTS 音色白名单与回落（不联网）", () => {
  it("VOICES 含男女各二，id 唯一", () => {
    expect(VOICES.filter((v) => v.gender === "female").length).toBeGreaterThanOrEqual(2);
    expect(VOICES.filter((v) => v.gender === "male").length).toBeGreaterThanOrEqual(2);
    expect(new Set(VOICES.map((v) => v.id)).size).toBe(VOICES.length);
  });

  it("resolveVoice：合法保留、非法/空回落默认女声·晓晓", () => {
    expect(resolveVoice("zh-CN-YunxiNeural")).toBe("zh-CN-YunxiNeural");
    expect(resolveVoice("evil; drop table")).toBe("zh-CN-XiaoxiaoNeural");
    expect(resolveVoice(undefined)).toBe("zh-CN-XiaoxiaoNeural");
    expect(resolveVoice("")).toBe("zh-CN-XiaoxiaoNeural");
  });
});
