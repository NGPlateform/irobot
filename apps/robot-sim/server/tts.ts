// 中文神经语音合成：微软 edge-tts（Read Aloud 端点），零 API 密钥、免费，服务端合成 MP3。
// 客户端播放，比浏览器 Web Speech 自然得多；断网/端点不可达时前端回退 Web Speech。
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export interface VoiceInfo {
  id: string;
  label: string;
  gender: "female" | "male";
}

/** 可选音色白名单（男/女各二）。 */
export const VOICES: VoiceInfo[] = [
  { id: "zh-CN-XiaoxiaoNeural", label: "女声·晓晓", gender: "female" },
  { id: "zh-CN-XiaoyiNeural", label: "女声·晓伊", gender: "female" },
  { id: "zh-CN-YunxiNeural", label: "男声·云希", gender: "male" },
  { id: "zh-CN-YunyangNeural", label: "男声·云扬", gender: "male" },
];

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const ALLOWED = new Set(VOICES.map((v) => v.id));

/** 非法/空 voice 回落默认音色。 */
export function resolveVoice(voice?: string | null): string {
  return voice && ALLOWED.has(voice) ? voice : DEFAULT_VOICE;
}

/**
 * 合成一段中文语音，返回 MP3 Buffer。
 * 每次请求新建 MsEdgeTTS（避免复用陈旧 WebSocket 的可靠性问题）+ 超时兜底：
 * 超时/失败抛错，服务器据此返回 502，客户端回退 Web Speech。
 */
export async function synthesize(text: string, voice?: string | null, timeoutMs = 8000): Promise<Buffer> {
  const v = resolveVoice(voice);
  const tts = new MsEdgeTTS();
  const work = (async (): Promise<Buffer> => {
    await tts.setMetadata(v, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks: Buffer[] = [];
    for await (const c of audioStream as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    return Buffer.concat(chunks);
  })();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("tts timeout")), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
