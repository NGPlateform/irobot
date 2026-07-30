// 控制台：一条 SSE 连接驱动两种视图 —— 多机器人 3D 探索 / 单机器人数字人。
// 语音/文本/审批/急停等控制两模式共享，全部复用后端同一动作链路。
const $ = (id) => document.getElementById(id);
const scene = window.IRobotScene.createRobotScene($("scene3d"));
const avatar = window.IRobotDigitalHuman
  ? window.IRobotDigitalHuman.createAvatar($("dh-face"))
  : { update() {}, setListening() {}, setThinking() {}, startSpeaking() {}, stopSpeaking() {} };

let telemetry = null;
let currentState = "IDLE";
let activeDevice = null;
let deviceIds = [];
const teleByDevice = {};

const STATE_LABEL = {
  IDLE: "待命", EXECUTING: "执行中", SUCCEEDED: "完成", REJECTED: "已拒绝",
  FAILED: "失败", CANCELLED: "已取消", ACCEPTED: "已接受", VALIDATING: "校验中",
  PROPOSED: "提案", PENDING_APPROVAL: "待审批", EXPIRED: "已过期",
};

// —— 显示模式：数字人 / 3D 探索 ——
let mode = "dh";
function applyMode(m) {
  mode = m;
  $("stage-dh").classList.toggle("hidden", m !== "dh");
  $("stage-explore").classList.toggle("hidden", m !== "explore");
  $("mode-dh").classList.toggle("active", m === "dh");
  $("mode-explore").classList.toggle("active", m === "explore");
  try { localStorage.setItem("irobot-view-mode", m); } catch {}
  // 切换后立即用缓存重绘目标视图。
  if (telemetry) { updateReadouts(); updateDhHud(telemetry); }
}
$("mode-dh").onclick = () => applyMode("dh");
$("mode-explore").onclick = () => applyMode("explore");

function updateReadouts() {
  if (!telemetry) return;
  $("ro-state").textContent = telemetry.estop ? "急停" : (STATE_LABEL[currentState] ?? currentState);
  $("ro-battery").textContent = telemetry.battery + "%" + (telemetry.charging ? " ⚡" : "");
  $("ro-battery").style.color = telemetry.battery < 15 ? "#e5645b" : telemetry.battery < 35 ? "#eea94e" : "#e6edf3";
  $("ro-pose").textContent = `${telemetry.pose.x.toFixed(1)}, ${telemetry.pose.y.toFixed(1)}`;
  $("ro-sv").textContent = telemetry.stateVersion;
  $("estop-banner").classList.toggle("hidden", !telemetry.estop);
}

function updateDhHud(t) {
  if (!t) return;
  $("dh-state").textContent = t.estop ? "急停" : (STATE_LABEL[currentState] ?? currentState);
  const bat = $("dh-battery");
  bat.textContent = t.battery + "%" + (t.charging ? " ⚡" : "");
  bat.style.color = t.battery < 15 ? "#e5645b" : t.battery < 35 ? "#eea94e" : "#e6edf3";
  $("dh-pose").textContent = `${t.pose.x.toFixed(1)}, ${t.pose.y.toFixed(1)}`;
  $("dh-heading").textContent = `${Math.round((((t.pose.heading * 180) / Math.PI) % 360 + 360) % 360)}°`;
  const loc = $("dh-loc");
  loc.textContent = t.localizationHealthy ? "正常" : "异常";
  loc.style.color = t.localizationHealthy ? "#e6edf3" : "#e5645b";
  $("dh-sv").textContent = t.stateVersion;
  if (t.arm) {
    $("dh-arm-ext").style.width = Math.round(t.arm.extension * 100) + "%";
    $("dh-arm-grip").style.width = Math.round(t.arm.gripper * 100) + "%";
  }
}

function buildDeviceSwitcher() {
  const box = $("dh-switch");
  if (deviceIds.length <= 1) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = "";
  for (const id of deviceIds) {
    const b = document.createElement("button");
    b.textContent = id;
    b.className = id === activeDevice ? "active" : "";
    b.onclick = () => converse("切换到机器人" + id.replace("robot-", ""));
    box.appendChild(b);
  }
}

// 活动设备的遥测/动作 → 同步刷新两视图（都保持热，切换即时）。
function renderActive() {
  updateReadouts();
  updateDhHud(telemetry);
  $("dh-device").textContent = activeDevice ?? "–";
}

const es = new EventSource("/events");
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.kind === "hello") {
    $("agent-badge").textContent = "Agent: " + msg.agent;
    activeDevice = msg.activeDevice;
    const robots = msg.robots || [{ deviceId: msg.activeDevice, telemetry: msg.telemetry }];
    deviceIds = robots.map((r) => r.deviceId);
    for (const r of robots) { teleByDevice[r.deviceId] = r.telemetry; scene.update(r.deviceId, r.telemetry); }
    scene.setActive(activeDevice);
    telemetry = teleByDevice[activeDevice];
    avatar.update(telemetry, null);
    buildDeviceSwitcher();
    // 默认模式：手动选择优先；否则单机→数字人、多机→3D 探索。
    let saved = null;
    try { saved = localStorage.getItem("irobot-view-mode"); } catch {}
    applyMode(saved === "dh" || saved === "explore" ? saved : (deviceIds.length > 1 ? "explore" : "dh"));
    renderActive();
  } else if (msg.kind === "status") {
    $("thinking").classList.toggle("hidden", !msg.busy);
    avatar.setThinking(!!msg.busy);
  } else if (msg.kind === "telemetry") {
    teleByDevice[msg.deviceId] = msg.data;
    scene.update(msg.deviceId, msg.data);
    if (msg.deviceId === activeDevice) { telemetry = msg.data; avatar.update(msg.data, null); renderActive(); }
  } else if (msg.kind === "active") {
    activeDevice = msg.deviceId;
    scene.setActive(activeDevice);
    telemetry = teleByDevice[activeDevice];
    avatar.update(telemetry, null);
    buildDeviceSwitcher();
    renderActive();
  } else if (msg.kind === "transcript") { addMsg(msg.role, msg.text); }
  else if (msg.kind === "reply") { speak(msg.text); avatarSpeak(msg.text); }
  else if (msg.kind === "action") { onAction(msg.event, msg.deviceId); }
};

function onAction(ev, deviceId) {
  scene.setState(deviceId, ev.state);
  if (deviceId === activeDevice && ev.state) {
    currentState = ev.state;
    avatar.update(null, ev.state);
    renderActive();
  }
  if (ev.state === "PENDING_APPROVAL") showApproval(ev, deviceId);
  if (["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "EXPIRED"].includes(ev.state) && ev.commandId === pendingApprovalId) hideApproval();
  const dev = deviceId && deviceId !== activeDevice ? `[${deviceId}] ` : "";
  const label = ev.kind === "feedback"
    ? `feedback <span class="pr">${Math.round((ev.progress ?? 0) * 100)}%</span>`
    : `<span class="st">${ev.state ?? ev.kind}</span>`;
  const reason = ev.payload && ev.payload.reason ? ` · ${ev.payload.reason}` : "";
  const row = document.createElement("div");
  row.className = "evt s-" + (ev.state ?? "");
  row.innerHTML = `<span>${dev}${label}${reason}</span><span>#${ev.seq}</span>`;
  const box = $("actions"); box.appendChild(row); box.scrollTop = box.scrollHeight;
  if (["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "EXPIRED"].includes(ev.state)) {
    setTimeout(() => {
      if (deviceId === activeDevice && currentState === ev.state) { currentState = "IDLE"; avatar.update(null, "IDLE"); renderActive(); }
      scene.setState(deviceId, "IDLE");
    }, 400);
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

// 数字人模式快捷动作 / 机械臂按钮：统一走 /converse（复用 NLU→Orchestrator→安全链路）。
document.querySelectorAll("[data-cmd]").forEach((b) => { b.onclick = () => converse(b.getAttribute("data-cmd")); });

// 审批
let pendingApprovalId = null;
function showApproval(ev, deviceId) {
  pendingApprovalId = ev.commandId;
  const p = ev.payload || {};
  const exp = p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString() : "—";
  $("approval").innerHTML = `
    <div class="ap-card">
      <div class="ap-h">⚠ 需要人工审批（S3 高风险动作）</div>
      <div class="ap-b">
        <div><span>设备</span><b>${deviceId || activeDevice || "sim-robot-001"}</b></div>
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

// TTS（音频）
let zhVoice = null;
function pickVoice() { const vs = speechSynthesis.getVoices(); zhVoice = vs.find((v) => /zh|Chinese/i.test(v.lang + v.name)) ?? null; }
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = "zh-CN"; if (zhVoice) u.voice = zhVoice;
  u.onstart = () => avatar.startSpeaking();
  u.onend = () => avatar.stopSpeaking();
  u.onerror = () => avatar.stopSpeaking();
  speechSynthesis.speak(u);
}
// 口型（视觉）：独立于 TTS 可用性，按文本长度估算时长，保证数字人一定"开口"。
let speakTimer = null;
function avatarSpeak(text) {
  avatar.startSpeaking();
  if (speakTimer) clearTimeout(speakTimer);
  const ms = Math.min(6000, 700 + (text ? text.length : 0) * 130);
  speakTimer = setTimeout(() => avatar.stopSpeaking(), ms);
}

// STT（语音输入）
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
if (SR) {
  recog = new SR(); recog.lang = "zh-CN"; recog.interimResults = false; recog.maxAlternatives = 1;
  recog.onresult = (e) => converse(e.results[0][0].transcript);
  recog.onend = () => { listening = false; $("mic").classList.remove("listening"); $("mic-label").textContent = "按住说话"; avatar.setListening(false); };
  recog.onerror = () => { $("voice-note").textContent = "语音识别出错，可改用输入框。"; avatar.setListening(false); };
  $("mic").onclick = () => {
    if (listening) { recog.stop(); return; }
    try { recog.start(); listening = true; $("mic").classList.add("listening"); $("mic-label").textContent = "聆听中…点按结束"; avatar.setListening(true); } catch {}
  };
} else {
  $("mic").disabled = true; $("mic-label").textContent = "此浏览器不支持语音";
  $("voice-note").textContent = "请用 Chrome / Edge 使用语音，或直接用下方输入框。";
}
