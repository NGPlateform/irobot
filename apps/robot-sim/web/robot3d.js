// 控制台：一条 SSE 连接驱动四种视图 —— 2D 地图 / 3D 探索 / 数字人脸部 / 数字人全身。
// 顶部按钮随时切换；语音/文本/审批/急停等控制全视图共享，复用后端同一动作链路。
const $ = (id) => document.getElementById(id);
const scene = window.IRobotScene.createRobotScene($("scene3d"));
const map2d = window.IRobotMap2D.createMap($("map2d"));
const avatar = window.IRobotDigitalHuman
  ? window.IRobotDigitalHuman.createAvatar($("dh-face"))
  : { update() {}, setListening() {}, setThinking() {}, startSpeaking() {}, stopSpeaking() {}, setView() {} };

// 三个渲染器统一驱动
const R = {
  update(dev, t) { map2d.update(dev, t); scene.update(dev, t); },
  setState(dev, s) { map2d.setState(dev, s); scene.setState(dev, s); },
  setActive(dev) { map2d.setActive(dev); scene.setActive(dev); },
};

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

// —— 视图：2d / 3d / face / body ——
const VIEWS = ["2d", "3d", "face", "body"];
const VIEW_BTN = { "2d": "view-2d", "3d": "view-3d", face: "view-face", body: "view-body" };
let view = "face";
function applyView(v) {
  if (!VIEWS.includes(v)) v = "face";
  view = v;
  $("stage-2d").classList.toggle("hidden", v !== "2d");
  $("stage-explore").classList.toggle("hidden", v !== "3d");
  $("stage-dh").classList.toggle("hidden", v !== "face" && v !== "body");
  $("shared-ro").classList.toggle("hidden", v !== "2d" && v !== "3d");
  for (const k of VIEWS) $(VIEW_BTN[k]).classList.toggle("active", k === v);
  if (v === "face" || v === "body") avatar.setView(v);
  try { localStorage.setItem("irobot-view", v); } catch {}
  renderActive();
}
for (const k of VIEWS) $(VIEW_BTN[k]).onclick = () => applyView(k);

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
  const box = $("dev-switch");
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
    for (const r of robots) { teleByDevice[r.deviceId] = r.telemetry; R.update(r.deviceId, r.telemetry); }
    R.setActive(activeDevice);
    telemetry = teleByDevice[activeDevice];
    avatar.update(telemetry, null);
    buildDeviceSwitcher();
    // 默认视图：手动选择优先；否则单机→脸部、多机→3D 探索。
    let saved = null;
    try { saved = localStorage.getItem("irobot-view"); } catch {}
    applyView(VIEWS.includes(saved) ? saved : (deviceIds.length > 1 ? "3d" : "face"));
  } else if (msg.kind === "status") {
    $("thinking").classList.toggle("hidden", !msg.busy);
    avatar.setThinking(!!msg.busy);
  } else if (msg.kind === "telemetry") {
    teleByDevice[msg.deviceId] = msg.data;
    R.update(msg.deviceId, msg.data);
    if (msg.deviceId === activeDevice) { telemetry = msg.data; avatar.update(msg.data, null); renderActive(); }
  } else if (msg.kind === "active") {
    activeDevice = msg.deviceId;
    R.setActive(activeDevice);
    telemetry = teleByDevice[activeDevice];
    avatar.update(telemetry, null);
    buildDeviceSwitcher();
    renderActive();
  } else if (msg.kind === "transcript") { addMsg(msg.role, msg.text); }
  else if (msg.kind === "reply") { speak(msg.text); avatarSpeak(msg.text); }
  else if (msg.kind === "action") { onAction(msg.event, msg.deviceId); }
};

function onAction(ev, deviceId) {
  R.setState(deviceId, ev.state);
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
      R.setState(deviceId, "IDLE");
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

// 快捷动作 / 机械臂按钮：统一走 /converse（复用 NLU→Orchestrator→安全链路）。
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
