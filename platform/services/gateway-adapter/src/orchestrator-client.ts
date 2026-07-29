import { ActionEvent, isTerminal, type ActionEnvelope } from "@irobot/action-protocol";

/**
 * 外部 Command Orchestrator 的 HTTP 客户端。
 *
 * 这是 Spike 验证的核心：OpenClaw 侧的插件工具在 execute() 中调用此客户端，把动作提案
 * 发给独立进程的 Orchestrator，并把回流的 ActionEvent 流式转发给 Agent。协议刻意用
 * 最朴素的 "POST + NDJSON 响应流"，不引入额外依赖，证明缝可用即可。
 *
 * 契约：
 *   POST {baseUrl}/v1/actions   body = ActionEnvelope(JSON)
 *   响应 = NDJSON 流，每行一个 ActionEvent；以 kind=result 的事件收尾。
 */

export interface SubmitOptions {
  /** 取消信号，来自 OpenClaw 工具执行上下文（turn interruption → cancel/abort）。 */
  signal?: AbortSignal;
  /** 进度回调，映射到 OpenClaw 的 onUpdate 流式回传。 */
  onFeedback?: (event: ActionEvent) => void;
}

export interface SubmitResult {
  finalEvent: ActionEvent;
  events: ActionEvent[];
}

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

/**
 * 提交动作提案并消费流式事件。返回终态 result 事件；被 signal 取消时抛 AbortError。
 */
export async function submitProposal(
  baseUrl: string,
  envelope: ActionEnvelope,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new OrchestratorError(
      `orchestrator 返回 ${res.status} ${res.statusText}`,
    );
  }

  const events: ActionEvent[] = [];
  let finalEvent: ActionEvent | undefined;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // fail-closed：任何无法解析为 ActionEvent 的行都视为协议违约。
    const event = ActionEvent.parse(JSON.parse(trimmed));
    events.push(event);
    // 终态以 state 判定：SUCCEEDED/FAILED/CANCELLED 为 kind=result，但 REJECTED/EXPIRED
    // 是 kind=state_changed，同样是终态，必须据此收尾，否则流会挂到结束才报错。
    if (event.state && isTerminal(event.state)) {
      finalEvent = event;
    } else {
      opts.onFeedback?.(event);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  handleLine(buffer);

  if (!finalEvent) {
    throw new OrchestratorError("orchestrator 流结束但未返回 result 终态事件");
  }
  return { finalEvent, events };
}
