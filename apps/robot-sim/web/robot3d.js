// 控制台：一条 SSE 连接驱动四种视图 —— 2D 地图 / 3D 探索 / 数字人脸部 / 数字人全身。
// 顶部按钮随时切换；语音/文本/审批/急停等控制全视图共享，复用后端同一动作链路。
const $ = (id) => document.getElementById(id);
const scene = window.IRobotScene.createRobotScene($("scene3d"));
const map2d = window.IRobotMap2D.createMap($("map2d"));
const avatar = window.IRobotDigitalHuman
  ? window.IRobotDigitalHuman.createAvatar($("dh-face"))
  : { update() {}, setListening() {}, setThinking() {}, startSpeaking() {}, stopSpeaking() {}, setView() {} };
let avatarUrl = "/models/avatar.vrm";
try { const a = localStorage.getItem("irobot-avatar-url"); if (a) avatarUrl = a; } catch {}
const human = window.IRobotHuman
  ? window.IRobotHuman.createHuman($("vrm-stage"), avatarUrl)
  : { update() {}, setListening() {}, setThinking() {}, startSpeaking() {}, stopSpeaking() {}, resize() {}, setAvatar() {} };
// 说话/思考/聆听同时驱动 Canvas 数字人（脸部/全身）与 VRM 数字人。
const talkers = {
  update: (t, s) => { avatar.update(t, s); human.update(t, s); },
  setListening: (b) => { avatar.setListening(b); human.setListening(b); },
  setThinking: (b) => { avatar.setThinking(b); human.setThinking(b); },
  startSpeaking: () => { avatar.startSpeaking(); human.startSpeaking(); },
  stopSpeaking: () => { avatar.stopSpeaking(); human.stopSpeaking(); },
};

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
const VIEWS = ["2d", "3d", "face", "body", "human"];
const VIEW_BTN = { "2d": "view-2d", "3d": "view-3d", face: "view-face", body: "view-body", human: "view-human" };
let view = "face";
function applyView(v) {
  if (!VIEWS.includes(v)) v = "face";
  view = v;
  $("stage-2d").classList.toggle("hidden", v !== "2d");
  $("stage-explore").classList.toggle("hidden", v !== "3d");
  $("stage-dh").classList.toggle("hidden", v !== "face" && v !== "body");
  $("stage-human").classList.toggle("hidden", v !== "human");
  $("shared-ro").classList.toggle("hidden", v !== "2d" && v !== "3d");
  for (const k of VIEWS) $(VIEW_BTN[k]).classList.toggle("active", k === v);
  if (v === "face" || v === "body") avatar.setView(v);
  if (v === "human") human.resize(); // 容器由隐藏变可见，需重置渲染尺寸
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
  const vd = $("vrm-device"); if (vd) vd.textContent = activeDevice ?? "–";
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
    talkers.update(telemetry, null);
    buildDeviceSwitcher();
    // 默认视图：手动选择优先；否则单机→脸部、多机→3D 探索。
    let saved = null;
    try { saved = localStorage.getItem("irobot-view"); } catch {}
    applyView(VIEWS.includes(saved) ? saved : (deviceIds.length > 1 ? "3d" : "face"));
  } else if (msg.kind === "status") {
    $("thinking").classList.toggle("hidden", !msg.busy);
    talkers.setThinking(!!msg.busy);
  } else if (msg.kind === "telemetry") {
    teleByDevice[msg.deviceId] = msg.data;
    R.update(msg.deviceId, msg.data);
    if (msg.deviceId === activeDevice) { telemetry = msg.data; talkers.update(msg.data, null); renderActive(); }
  } else if (msg.kind === "active") {
    activeDevice = msg.deviceId;
    R.setActive(activeDevice);
    telemetry = teleByDevice[activeDevice];
    talkers.update(telemetry, null);
    buildDeviceSwitcher();
    renderActive();
  } else if (msg.kind === "transcript") { addMsg(msg.role, msg.text); }
  else if (msg.kind === "reply") { speak(msg.text); }
  else if (msg.kind === "action") { onAction(msg.event, msg.deviceId); }
  else if (msg.kind === "map") {
    scene.setMap(msg.map); map2d.setMap(msg.map);
    $("map-cov").textContent = "建图 " + Math.round((msg.coverage || 0) * 100) + "%";
  }
  else if (msg.kind === "explore") {
    exploring = !!msg.on;
    const b = $("explore-btn");
    b.textContent = exploring ? "⏹ 停止探索" : "🧭 自动探索";
    b.classList.toggle("active", exploring);
    if (typeof msg.coverage === "number") $("map-cov").textContent = "建图 " + Math.round(msg.coverage * 100) + "%";
  }
};
let exploring = false;
$("explore-btn").onclick = () => post("/explore", { on: !exploring });

// —— 三维地图控制 ——
async function refreshMapList() {
  try {
    const list = await (await fetch("/map/list")).json();
    const sel = $("map-load-sel");
    sel.innerHTML = '<option value="">加载已存地图…</option>' +
      list.map((m) => `<option value="${m.name}">${m.name}（障碍${m.obstacles}·${Math.round(m.coverage * 100)}%）</option>`).join("");
  } catch {}
}
$("map-gen").onclick = () => post("/map/generate", {});
$("map-clear").onclick = () => post("/map/clear", {});
$("map-save").onclick = async () => {
  const name = prompt("地图名称", "map-" + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, ""));
  if (name) { await post("/map/save", { name }); refreshMapList(); }
};
$("map-load-sel").onchange = (e) => { if (e.target.value) post("/map/load", { name: e.target.value }); };
refreshMapList();

// —— VRM 自定义头像：列表 / 切换 / 上传 / 删除 ——
const avatarSel = $("avatar-sel");
let avatarList = [{ id: "builtin", label: "内置 · Seed-san", url: "/models/avatar.vrm", builtin: true }];
function currentAvatarBuiltin() { const it = avatarList.find((a) => a.url === avatarUrl); return it ? it.builtin : true; }
async function refreshAvatars() {
  try { avatarList = await (await fetch("/avatars")).json(); } catch {}
  if (!avatarList.some((a) => a.url === avatarUrl)) {
    avatarUrl = "/models/avatar.vrm";
    try { localStorage.setItem("irobot-avatar-url", avatarUrl); } catch {}
    human.setAvatar(avatarUrl);
  }
  if (avatarSel) {
    avatarSel.innerHTML = avatarList.map((a) => `<option value="${a.url}">${a.label}</option>`).join("");
    avatarSel.value = avatarUrl;
  }
  const del = $("avatar-del"); if (del) del.disabled = currentAvatarBuiltin();
}
if (avatarSel) {
  avatarSel.onchange = () => {
    avatarUrl = avatarSel.value;
    try { localStorage.setItem("irobot-avatar-url", avatarUrl); } catch {}
    human.setAvatar(avatarUrl);
    $("avatar-del").disabled = currentAvatarBuiltin();
  };
}
$("avatar-upload").onclick = () => $("avatar-file").click();
$("avatar-file").onchange = async () => {
  const f = $("avatar-file").files && $("avatar-file").files[0];
  if (!f) return;
  const name = (f.name.replace(/\.vrm$/i, "").replace(/[^0-9a-zA-Z一-龥_-]/g, "").slice(0, 40)) || "avatar";
  try {
    const r = await fetch("/avatars/upload?name=" + encodeURIComponent(name), { method: "POST", body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { addMsg("agent", "头像上传失败：" + (j.error || r.status)); }
    else {
      await refreshAvatars();
      avatarUrl = j.url; if (avatarSel) avatarSel.value = j.url;
      try { localStorage.setItem("irobot-avatar-url", avatarUrl); } catch {}
      human.setAvatar(avatarUrl);
      $("avatar-del").disabled = currentAvatarBuiltin();
    }
  } catch { addMsg("agent", "头像上传出错。"); }
  $("avatar-file").value = "";
};
$("avatar-del").onclick = async () => {
  if (currentAvatarBuiltin()) return;
  const it = avatarList.find((a) => a.url === avatarUrl);
  if (!it) return;
  await post("/avatars/delete", { name: it.id });
  avatarUrl = "/models/avatar.vrm";
  try { localStorage.setItem("irobot-avatar-url", avatarUrl); } catch {}
  human.setAvatar(avatarUrl);
  await refreshAvatars();
};
refreshAvatars();

function onAction(ev, deviceId) {
  R.setState(deviceId, ev.state);
  if (deviceId === activeDevice && ev.state) {
    currentState = ev.state;
    talkers.update(null, ev.state);
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
      if (deviceId === activeDevice && currentState === ev.state) { currentState = "IDLE"; talkers.update(null, "IDLE"); renderActive(); }
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

// TTS：优先用 edge-tts 中文神经语音（服务端合成 /tts，自然）；失败回退浏览器 Web Speech。
let ttsVoice = "zh-CN-XiaoxiaoNeural";
try { const v = localStorage.getItem("irobot-tts-voice"); if (v) ttsVoice = v; } catch {}
const voiceSel = $("tts-voice");
if (voiceSel) {
  voiceSel.value = ttsVoice;
  voiceSel.onchange = () => { ttsVoice = voiceSel.value; try { localStorage.setItem("irobot-tts-voice", ttsVoice); } catch {} speak("你好，我是机器人助手。"); };
}

// Web Speech 兜底
let zhVoice = null;
function pickVoice() { const vs = speechSynthesis.getVoices(); zhVoice = vs.find((v) => /zh|Chinese/i.test(v.lang + v.name)) ?? null; }
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function webSpeak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = "zh-CN"; if (zhVoice) u.voice = zhVoice;
  u.onstart = () => talkers.startSpeaking();
  u.onend = () => talkers.stopSpeaking();
  u.onerror = () => talkers.stopSpeaking();
  try { speechSynthesis.cancel(); } catch {}
  speechSynthesis.speak(u);
}

// edge-tts 音频播放；口型由音频 play/ended 驱动（时长准），另有计时器兜底。
const ttsAudio = new Audio();
let lastSpokenText = "";
let speakTimer = null;
function stopSpeakTimer() { if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; } }
ttsAudio.onplay = () => { stopSpeakTimer(); talkers.startSpeaking(); };
ttsAudio.onended = () => talkers.stopSpeaking();
ttsAudio.onerror = () => { stopSpeakTimer(); talkers.stopSpeaking(); webSpeak(lastSpokenText); };
function speak(text) {
  if (!text || !text.trim()) return;
  lastSpokenText = text;
  try { ttsAudio.pause(); } catch {}
  // 视觉兜底：先让数字人开口，音频事件到达/结束时接管；音频始终不来则计时器收尾。
  talkers.startSpeaking(); stopSpeakTimer();
  speakTimer = setTimeout(() => talkers.stopSpeaking(), Math.min(9000, 800 + text.length * 140));
  ttsAudio.src = "/tts?voice=" + encodeURIComponent(ttsVoice) + "&text=" + encodeURIComponent(text);
  ttsAudio.play().catch(() => { stopSpeakTimer(); webSpeak(text); });
}

// —— STT（语音输入）：两种模式 ——
//   手工(hold)：点麦克风单次识别；按住【空格】push-to-talk（松开即发）。
//   常开(open)：持续聆听、说完自动发送，onend 自动重启保持常开。
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let voiceMode = "hold";   // "hold" | "open"
let listening = false;    // 识别是否正在进行
let wantOpen = false;     // 常开是否已开启（onend 据此自动重启）
let pushToTalk = false;   // 是否处于按住空格状态
try { const v = localStorage.getItem("irobot-voice-mode"); if (v === "hold" || v === "open") voiceMode = v; } catch {}

function micIdleLabel() {
  return voiceMode === "open"
    ? (wantOpen ? "常开聆听中（点击关闭）" : "常开：点击开启")
    : "点麦克风，或按住空格说话";
}
function paintMic() {
  const el = $("mic");
  el.classList.toggle("listening", listening);
  el.classList.toggle("armed", voiceMode === "open" && wantOpen && !listening);
  $("mic-label").textContent = listening
    ? (pushToTalk ? "聆听中…松开空格结束" : (voiceMode === "open" ? "常开聆听中…（点击关闭）" : "聆听中…点按结束"))
    : micIdleLabel();
  talkers.setListening(listening);
}
function startRecog(continuous) {
  if (!recog || listening) return;
  recog.continuous = !!continuous;
  listening = true; // 乐观置位；onend 会纠正
  try { recog.start(); } catch { listening = false; }
  paintMic();
}
function stopRecog() { if (recog && listening) { try { recog.stop(); } catch {} } }

if (SR) {
  recog = new SR(); recog.lang = "zh-CN"; recog.interimResults = false; recog.maxAlternatives = 1;
  recog.onstart = () => { listening = true; paintMic(); };
  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) { const tx = e.results[i][0].transcript; if (tx.trim()) converse(tx); }
    }
  };
  recog.onerror = (e) => {
    if (e && e.error && e.error !== "no-speech" && e.error !== "aborted")
      $("voice-note").textContent = "语音识别出错，可改用输入框。";
  };
  recog.onend = () => {
    listening = false;
    if (voiceMode === "open" && wantOpen) setTimeout(() => startRecog(true), 150); // 常开：自动重启
    else pushToTalk = false;
    paintMic();
  };

  // 麦克风按钮：常开→开/关常开会话；手工→单次识别开/关。
  $("mic").onclick = () => {
    if (voiceMode === "open") {
      if (wantOpen) { wantOpen = false; stopRecog(); } else { wantOpen = true; startRecog(true); }
    } else {
      if (listening) stopRecog(); else startRecog(false);
    }
    paintMic();
  };

  // 手工模式：按住空格 push-to-talk（焦点不在输入框、非重复按键）。
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat || voiceMode !== "hold") return;
    const el = document.activeElement;
    if (el && (el.id === "text-in" || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    e.preventDefault();
    if (!listening) { pushToTalk = true; startRecog(false); }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && pushToTalk) { e.preventDefault(); stopRecog(); }
  });

  // 模式切换（切到常开即开启——此为用户手势）。
  function setVoiceMode(m) {
    voiceMode = m;
    try { localStorage.setItem("irobot-voice-mode", m); } catch {}
    $("vm-hold").classList.toggle("active", m === "hold");
    $("vm-open").classList.toggle("active", m === "open");
    if (m === "open") { wantOpen = true; startRecog(true); }
    else { wantOpen = false; pushToTalk = false; stopRecog(); }
    paintMic();
  }
  $("vm-hold").onclick = () => setVoiceMode("hold");
  $("vm-open").onclick = () => setVoiceMode("open");

  // 初始：设定模式与按钮态；不在加载时自动开麦（需用户手势）。
  $("vm-hold").classList.toggle("active", voiceMode === "hold");
  $("vm-open").classList.toggle("active", voiceMode === "open");
  paintMic();
} else {
  $("mic").disabled = true; $("mic-label").textContent = "此浏览器不支持语音";
  $("vm-hold").disabled = true; $("vm-open").disabled = true;
  $("voice-note").textContent = "请用 Chrome / Edge 使用语音，或直接用下方输入框。";
}
