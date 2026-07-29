// iRobot 仿真控制台前端：SSE 遥测/事件订阅 + Canvas 地图 + Web Speech 语音。
const WORLD_W = 9.5;
const WORLD_H = 8;

const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

let telemetry = null;
let currentState = "IDLE";
let progress = 0;
const trail = [];

// ---------- Canvas 渲染 ----------
function w2p(x, y) {
  const pad = 34;
  const cw = canvas.width, ch = canvas.height;
  return [
    pad + (x / WORLD_W) * (cw - 2 * pad),
    ch - pad - (y / WORLD_H) * (ch - 2 * pad),
  ];
}

function draw() {
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // 网格
  ctx.strokeStyle = "#1a2330";
  ctx.lineWidth = 1;
  for (let x = 0; x <= WORLD_W; x++) {
    const [px] = w2p(x, 0);
    const [, py0] = w2p(0, 0);
    const [, py1] = w2p(0, WORLD_H);
    ctx.beginPath(); ctx.moveTo(px, py0); ctx.lineTo(px, py1); ctx.stroke();
  }
  for (let y = 0; y <= WORLD_H; y++) {
    const [px0] = w2p(0, y);
    const [px1] = w2p(WORLD_W, y);
    const [, py] = w2p(0, y);
    ctx.beginPath(); ctx.moveTo(px0, py); ctx.lineTo(px1, py); ctx.stroke();
  }
  // 房间边框
  const [bx0, by0] = w2p(0, 0);
  const [bx1, by1] = w2p(WORLD_W, WORLD_H);
  ctx.strokeStyle = "#31404f"; ctx.lineWidth = 2;
  ctx.strokeRect(bx1 < bx0 ? bx1 : bx0, by1 < by0 ? by1 : by0, Math.abs(bx1 - bx0), Math.abs(by1 - by0));

  if (!telemetry) return;

  // 充电坞
  const [dx, dy] = w2p(telemetry.dock.x, telemetry.dock.y);
  ctx.fillStyle = telemetry.charging ? "#4cc186" : "#2f5d47";
  ctx.fillRect(dx - 12, dy - 12, 24, 24);
  ctx.fillStyle = "#0b0f14"; ctx.font = "14px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("⚡", dx, dy);

  // 站点
  for (const [name, s] of Object.entries(telemetry.stations)) {
    const [sx, sy] = w2p(s.x, s.y);
    ctx.fillStyle = "#1c8a99"; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill();
    ctx.fillStyle = "#8fb6bd"; ctx.font = "11px system-ui"; ctx.textAlign = "center";
    ctx.fillText(name, sx, sy - 12);
  }

  // 轨迹
  if (trail.length > 1) {
    ctx.strokeStyle = "rgba(79,196,209,.35)"; ctx.lineWidth = 2; ctx.beginPath();
    trail.forEach(([tx, ty], i) => {
      const [px, py] = w2p(tx, ty);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }

  // 机器人
  const [rx, ry] = w2p(telemetry.pose.x, telemetry.pose.y);
  const r = 15;
  // 进度环
  if (currentState === "EXECUTING") {
    ctx.strokeStyle = "#4fc4d1"; ctx.lineWidth = 3; ctx.beginPath();
    ctx.arc(rx, ry, r + 7, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = telemetry.estop ? "#e5645b" : "#4fc4d1";
  ctx.beginPath(); ctx.arc(rx, ry, r, 0, 7); ctx.fill();
  // 朝向
  ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(rx, ry);
  ctx.lineTo(rx + Math.cos(-telemetry.pose.heading) * r * 1.4, ry + Math.sin(-telemetry.pose.heading) * r * 1.4);
  ctx.stroke();
}

// ---------- 读数 ----------
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

// ---------- SSE ----------
const es = new EventSource("/events");
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.kind === "hello") { telemetry = msg.telemetry; $("agent-badge").textContent = "Agent: " + msg.agent; }
  else if (msg.kind === "status") { $("thinking").classList.toggle("hidden", !msg.busy); }
  else if (msg.kind === "telemetry") {
    telemetry = msg.data;
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(last[0] - telemetry.pose.x, last[1] - telemetry.pose.y) > 0.05) {
      trail.push([telemetry.pose.x, telemetry.pose.y]);
      if (trail.length > 200) trail.shift();
    }
  } else if (msg.kind === "transcript") { addMsg(msg.role, msg.text); }
  else if (msg.kind === "reply") { speak(msg.text); }
  else if (msg.kind === "action") { onAction(msg.event); }
  updateReadouts();
};

function onAction(ev) {
  if (ev.state) currentState = ev.state;
  if (ev.kind === "feedback" && typeof ev.progress === "number") progress = ev.progress;
  if (ev.state === "EXECUTING") progress = 0;

  const label = ev.kind === "feedback"
    ? `feedback <span class="pr">${Math.round((ev.progress ?? 0) * 100)}%</span>`
    : `<span class="st">${ev.state ?? ev.kind}</span>`;
  const reason = ev.payload && ev.payload.reason ? ` · ${ev.payload.reason}` : "";
  const row = document.createElement("div");
  row.className = "evt s-" + (ev.state ?? "");
  row.innerHTML = `<span>${label}${reason}</span><span>#${ev.seq}</span>`;
  const box = $("actions"); box.appendChild(row); box.scrollTop = box.scrollHeight;
  if (["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "EXPIRED"].includes(ev.state)) {
    setTimeout(() => { if (currentState === ev.state) currentState = "IDLE"; }, 400);
  }
}

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  el.textContent = text;
  const box = $("transcript"); box.appendChild(el); box.scrollTop = box.scrollHeight;
}

// ---------- 命令发送 ----------
async function post(path, body) {
  await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}
function converse(text) { if (text.trim()) post("/converse", { text }); }

$("send").onclick = () => { converse($("text-in").value); $("text-in").value = ""; };
$("text-in").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };
$("cancel").onclick = () => post("/cancel");
$("estop").onclick = () => post("/estop", { on: true });
$("clear-estop").onclick = () => post("/estop", { on: false });

// ---------- TTS ----------
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find((v) => /zh|Chinese/i.test(v.lang + v.name)) ?? null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  if (zhVoice) u.voice = zhVoice;
  speechSynthesis.speak(u);
}

// ---------- STT ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
if (SR) {
  recog = new SR();
  recog.lang = "zh-CN";
  recog.interimResults = false;
  recog.maxAlternatives = 1;
  recog.onresult = (e) => { converse(e.results[0][0].transcript); };
  recog.onend = () => { listening = false; $("mic").classList.remove("listening"); $("mic-label").textContent = "按住说话"; };
  recog.onerror = () => { $("voice-note").textContent = "语音识别出错，可改用输入框。"; };
  $("mic").onclick = () => {
    if (listening) { recog.stop(); return; }
    try { recog.start(); listening = true; $("mic").classList.add("listening"); $("mic-label").textContent = "聆听中…点按结束"; }
    catch { /* already started */ }
  };
} else {
  $("mic").disabled = true;
  $("mic-label").textContent = "此浏览器不支持语音";
  $("voice-note").textContent = "请用 Chrome / Edge 使用语音，或直接用下方输入框。";
}

// ---------- 渲染循环 ----------
function loop() { draw(); requestAnimationFrame(loop); }
loop();
