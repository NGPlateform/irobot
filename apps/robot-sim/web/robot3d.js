// 3D 控制台：SSE 遥测 → 驱动 3D 场景；语音/文本控制、审批（复用后端同一动作链路）。
const $ = (id) => document.getElementById(id);
const scene = window.IRobotScene.createRobotScene($("scene3d"));

let telemetry = null;
let currentState = "IDLE";

const STATE_LABEL = {
  IDLE: "待命", EXECUTING: "执行中", SUCCEEDED: "完成", REJECTED: "已拒绝",
  FAILED: "失败", CANCELLED: "已取消", ACCEPTED: "已接受", VALIDATING: "校验中",
  PROPOSED: "提案", PENDING_APPROVAL: "待审批", EXPIRED: "已过期",
};
function updateReadouts() {
  if (!telemetry) return;
  $("ro-state").textContent = telemetry.estop ? "急停" : (STATE_LABEL[currentState] ?? currentState);
  $("ro-battery").textContent = telemetry.battery + "%" + (telemetry.charging ? " ⚡" : "");
  $("ro-battery").style.color = telemetry.battery < 15 ? "#e5645b" : telemetry.battery < 35 ? "#eea94e" : "#e6edf3";
  $("ro-pose").textContent = `${telemetry.pose.x.toFixed(1)}, ${telemetry.pose.y.toFixed(1)}`;
  $("ro-sv").textContent = telemetry.stateVersion;
  $("estop-banner").classList.toggle("hidden", !telemetry.estop);
}

const es = new EventSource("/events");
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.kind === "hello") { telemetry = msg.telemetry; $("agent-badge").textContent = "Agent: " + msg.agent; scene.update(telemetry); }
  else if (msg.kind === "status") { $("thinking").classList.toggle("hidden", !msg.busy); }
  else if (msg.kind === "telemetry") { telemetry = msg.data; scene.update(telemetry); }
  else if (msg.kind === "transcript") { addMsg(msg.role, msg.text); }
  else if (msg.kind === "reply") { speak(msg.text); }
  else if (msg.kind === "action") { onAction(msg.event); }
  updateReadouts();
};

function onAction(ev) {
  if (ev.state) currentState = ev.state;
  scene.setState(ev.state, ev.progress);
  if (ev.state === "PENDING_APPROVAL") showApproval(ev);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "EXPIRED"].includes(ev.state) && ev.commandId === pendingApprovalId) hideApproval();
  const label = ev.kind === "feedback"
    ? `feedback <span class="pr">${Math.round((ev.progress ?? 0) * 100)}%</span>`
    : `<span class="st">${ev.state ?? ev.kind}</span>`;
  const reason = ev.payload && ev.payload.reason ? ` · ${ev.payload.reason}` : "";
  const row = document.createElement("div");
  row.className = "evt s-" + (ev.state ?? "");
  row.innerHTML = `<span>${label}${reason}</span><span>#${ev.seq}</span>`;
  const box = $("actions"); box.appendChild(row); box.scrollTop = box.scrollHeight;
  if (["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "EXPIRED"].includes(ev.state)) {
    setTimeout(() => { if (currentState === ev.state) { currentState = "IDLE"; scene.setState("IDLE"); } }, 400);
  }
}

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role; el.textContent = text;
  const box = $("transcript"); box.appendChild(el); box.scrollTop = box.scrollHeight;
}

async function post(path, body) {
  await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}
function converse(text) { if (text.trim()) post("/converse", { text }); }
$("send").onclick = () => { converse($("text-in").value); $("text-in").value = ""; };
$("text-in").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };
$("cancel").onclick = () => post("/cancel");
$("estop").onclick = () => post("/estop", { on: true });
$("clear-estop").onclick = () => post("/estop", { on: false });

// 审批
let pendingApprovalId = null;
function showApproval(ev) {
  pendingApprovalId = ev.commandId;
  const p = ev.payload || {};
  const exp = p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString() : "—";
  $("approval").innerHTML = `
    <div class="ap-card">
      <div class="ap-h">⚠ 需要人工审批（S3 高风险动作）</div>
      <div class="ap-b">
        <div><span>设备</span><b>sim-robot-001</b></div>
        <div><span>动作</span><b>${p.capabilityId || ev.commandId}</b></div>
        <div><span>参数</span><b>${JSON.stringify(p.arguments || {})}</b></div>
        <div><span>风险等级</span><b class="risk">${p.safetyClass || "S3_HAZARDOUS"}</b></div>
        <div><span>有效期至</span><b>${exp}</b></div>
      </div>
      <div class="ap-actions">
        <button id="ap-deny" class="ctl danger">拒绝</button>
        <button id="ap-approve" class="ctl approve">批准执行</button>
      </div>
    </div>`;
  $("approval").classList.remove("hidden");
  $("ap-approve").onclick = () => decide(true);
  $("ap-deny").onclick = () => decide(false);
}
function decide(approved) { if (!pendingApprovalId) return; post("/approve", { commandId: pendingApprovalId, approved }); hideApproval(); }
function hideApproval() { pendingApprovalId = null; $("approval").classList.add("hidden"); $("approval").innerHTML = ""; }

// TTS
let zhVoice = null;
function pickVoice() { const vs = speechSynthesis.getVoices(); zhVoice = vs.find((v) => /zh|Chinese/i.test(v.lang + v.name)) ?? null; }
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) { if (!("speechSynthesis" in window)) return; const u = new SpeechSynthesisUtterance(text); u.lang = "zh-CN"; if (zhVoice) u.voice = zhVoice; speechSynthesis.speak(u); }

// STT
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
if (SR) {
  recog = new SR(); recog.lang = "zh-CN"; recog.interimResults = false; recog.maxAlternatives = 1;
  recog.onresult = (e) => converse(e.results[0][0].transcript);
  recog.onend = () => { listening = false; $("mic").classList.remove("listening"); $("mic-label").textContent = "按住说话"; };
  recog.onerror = () => { $("voice-note").textContent = "语音识别出错，可改用输入框。"; };
  $("mic").onclick = () => {
    if (listening) { recog.stop(); return; }
    try { recog.start(); listening = true; $("mic").classList.add("listening"); $("mic-label").textContent = "聆听中…点按结束"; } catch {}
  };
} else {
  $("mic").disabled = true; $("mic-label").textContent = "此浏览器不支持语音";
  $("voice-note").textContent = "请用 Chrome / Edge 使用语音，或直接用下方输入框。";
}
