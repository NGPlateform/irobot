// 本地 OpenAI-兼容 mock（Responses API SSE），无凭据演示用。
// 首次请求返回 propose_action 工具调用；收到工具结果后返回最终文本，避免死循环。
// 真实使用时用带 ANTHROPIC_API_KEY / OPENAI_API_KEY 的 provider 替换即可，链路不变。
import { createServer } from "node:http";

const portArg = process.argv.indexOf("--port");
const PORT = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.MOCK_PORT || 8810);
const log = (...a) => console.error("[mock]", ...a);

// 可通过 env 定制演示动作
const CAP = process.env.MOCK_CAPABILITY || "robot.navigation.navigate_relative";
const ARGS = JSON.stringify({
  capabilityId: CAP,
  arguments: JSON.parse(process.env.MOCK_ARGS || '{"distanceM":2}'),
  safetyClass: process.env.MOCK_SAFETY || "S2_GUARDED",
});

const sse = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  return (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };
};

function toolCall(res) {
  const send = sse(res);
  const fc = { type: "function_call", id: "fc_1", call_id: "call_1", name: "propose_action", arguments: ARGS, status: "completed" };
  const resp = (status, output) => ({ id: "resp_1", object: "response", status, output, model: "mock", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  send("response.created", { response: resp("in_progress", []) });
  send("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "propose_action", arguments: "" } });
  send("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: ARGS });
  send("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: ARGS });
  send("response.output_item.done", { output_index: 0, item: fc });
  send("response.completed", { response: resp("completed", [fc]) });
  res.write("data: [DONE]\n\n");
  res.end();
}

function finalText(res) {
  const send = sse(res);
  const txt = process.env.MOCK_FINAL_TEXT || "好的，已让机器人执行完毕。";
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: txt }] };
  const resp = (status, output) => ({ id: "resp_2", object: "response", status, output, model: "mock", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  send("response.created", { response: resp("in_progress", []) });
  send("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } });
  send("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: txt });
  send("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: txt });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: resp("completed", [item]) });
  res.write("data: [DONE]\n\n");
  res.end();
}

createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(b || "{}"); } catch {}
    const raw = JSON.stringify(body);
    const afterTool = raw.includes("function_call_output") || raw.includes("call_1");
    log(req.method, req.url, "afterTool=" + afterTool, "tools=" + (body.tools || []).length);
    if (req.url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"object":"list","data":[{"id":"gpt-5.6-sol","object":"model"}]}');
      return;
    }
    if (req.url.includes("/responses")) return afterTool ? finalText(res) : toolCall(res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"index":0,"message":{"role":"assistant","content":"好的"},"finish_reason":"stop"}]}');
  });
}).listen(PORT, "127.0.0.1", () => log("listening on", PORT, "capability=" + CAP));
