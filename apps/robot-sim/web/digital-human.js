// 数字人头像：Canvas 2D 拟人机器人脸。随遥测/动作状态变表情，随 TTS 口型同步，
// 随麦克风聆听脉冲、status busy 思考动画。零依赖、免打包（classic script，暴露全局）。
(function () {
  "use strict";

  // 复用 styles.css 的设计令牌配色。
  var C = {
    flow: "#4fc4d1", signal: "#eea94e", danger: "#e5645b", ok: "#4cc186",
    ink: "#e6edf3", faint: "#6d7c8a", bg: "#0e141d", line: "#24303d",
    face: "#1b2632", pupil: "#0b0f14",
  };

  /**
   * 纯函数：把当前状态映射为表情描述符。无副作用、无 DOM，便于推理与复用。
   * s = { estop, battery, state, listening, thinking, speaking, flash }
   * 返回 { ring, label, brow, mouth, eye:[dx,dy], pulse }
   *   brow: neutral | worried | angry | happy
   *   mouth: smile | flat | frown | open（open 由口型包络驱动）
   */
  function computeExpression(s) {
    s = s || {};
    if (s.estop) return { ring: C.danger, label: "急停", brow: "angry", mouth: "flat", eye: [0, 0], pulse: true };
    if (s.flash === "sad") return { ring: C.danger, label: "出错了", brow: "worried", mouth: "frown", eye: [0, 0.12], pulse: false };
    if (s.flash === "happy") return { ring: C.ok, label: "完成", brow: "happy", mouth: "smile", eye: [0, -0.06], pulse: false };
    if (s.thinking) return { ring: C.signal, label: "思考中", brow: "neutral", mouth: "flat", eye: [0.14, -0.38], pulse: true };
    if (s.speaking) return { ring: C.flow, label: "说话中", brow: "neutral", mouth: "open", eye: [0, 0], pulse: false };
    if (s.listening) return { ring: C.flow, label: "聆听中", brow: "happy", mouth: "smile", eye: [0, 0], pulse: true };
    if (s.state === "EXECUTING") return { ring: C.flow, label: "执行中", brow: "neutral", mouth: "flat", eye: [0, 0.1], pulse: false };
    if (typeof s.battery === "number" && s.battery < 15) return { ring: C.signal, label: "电量低", brow: "worried", mouth: "frown", eye: [0, 0], pulse: false };
    return { ring: C.flow, label: "待命", brow: "neutral", mouth: "smile", eye: [0, 0], pulse: false };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function createAvatar(canvas) {
    var ctx = canvas.getContext("2d");
    // 可变输入状态
    var st = { estop: false, battery: 100, state: "IDLE", listening: false, thinking: false, speaking: false, flash: null };
    var flashUntil = 0;
    var mouthOpen = 0;        // 0..1，口型开合（对说话平滑）
    var eye = { x: 0, y: 0 }; // 当前眼球方向（对目标平滑）
    var raf = 0;

    function now() { return (typeof performance !== "undefined" ? performance.now() : 0); }

    function setFlash(kind) { st.flash = kind; flashUntil = now() + 1200; }

    function update(telemetry, state) {
      if (telemetry) { st.estop = !!telemetry.estop; st.battery = telemetry.battery; }
      if (state) {
        st.state = state;
        if (state === "SUCCEEDED") setFlash("happy");
        else if (state === "FAILED" || state === "REJECTED" || state === "EXPIRED") setFlash("sad");
      }
    }
    function setListening(b) { st.listening = !!b; }
    function setThinking(b) { st.thinking = !!b; }
    function startSpeaking() { st.speaking = true; }
    function stopSpeaking() { st.speaking = false; }

    function currentFlags(t) {
      var flash = t < flashUntil ? st.flash : null;
      return {
        estop: st.estop, battery: st.battery, state: st.state,
        listening: st.listening, thinking: st.thinking, speaking: st.speaking, flash: flash,
      };
    }

    function resize() {
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth || 320, h = canvas.clientHeight || 300;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    function drawBrow(cx, y, type, side) {
      // side: -1 左眼, +1 右眼。inner 端朝向中线。
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      var len = 26, inner = cx - side * (len / 2), outer = cx + side * (len / 2);
      var dyIn = 0, dyOut = 0;
      if (type === "worried") { dyIn = -6; dyOut = 3; }
      else if (type === "angry") { dyIn = 6; dyOut = -3; }
      else if (type === "happy") { dyIn = -4; dyOut = -4; }
      ctx.beginPath();
      ctx.moveTo(inner, y + dyIn);
      ctx.lineTo(outer, y + dyOut);
      ctx.stroke();
    }

    function drawEye(cx, cy, rw, rh, closed, dir) {
      // 眼白（屏幕）
      ctx.fillStyle = C.face;
      roundRect(ctx, cx - rw, cy - rh, rw * 2, rh * 2, Math.min(rw, rh) * 0.7);
      ctx.fill();
      if (closed) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(cx - rw * 0.7, cy); ctx.lineTo(cx + rw * 0.7, cy); ctx.stroke();
        return;
      }
      // 瞳孔（随 dir 偏移，营造"看向"）
      var px = cx + dir.x * rw * 0.55, py = cy + dir.y * rh * 0.6;
      var pr = Math.min(rw, rh) * 0.55;
      ctx.fillStyle = C.flow;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.pupil;
      ctx.beginPath(); ctx.arc(px, py, pr * 0.5, 0, Math.PI * 2); ctx.fill();
      // 高光
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.beginPath(); ctx.arc(px - pr * 0.3, py - pr * 0.3, pr * 0.22, 0, Math.PI * 2); ctx.fill();
    }

    function drawMouth(cx, cy, kind, open) {
      ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
      var w = 44;
      if (kind === "open") {
        var h = 6 + open * 26;
        ctx.fillStyle = "#2a1a1e";
        roundRect(ctx, cx - w * 0.42, cy - h / 2, w * 0.84, h, Math.min(10, h / 2));
        ctx.fill();
        ctx.stroke();
        return;
      }
      ctx.beginPath();
      if (kind === "smile") { ctx.moveTo(cx - w / 2, cy - 4); ctx.quadraticCurveTo(cx, cy + 14, cx + w / 2, cy - 4); }
      else if (kind === "frown") { ctx.moveTo(cx - w / 2, cy + 8); ctx.quadraticCurveTo(cx, cy - 10, cx + w / 2, cy + 8); }
      else { ctx.moveTo(cx - w / 2, cy + 2); ctx.lineTo(cx + w / 2, cy + 2); } // flat
      ctx.stroke();
    }

    function frame() {
      var t = now();
      var dim = resize();
      var w = dim.w, h = dim.h;
      var exp = computeExpression(currentFlags(t));

      // 口型包络：说话时开合，否则回落。
      var target = st.speaking ? (0.28 + 0.72 * Math.abs(Math.sin(t / 95) + 0.35 * Math.sin(t / 47))) : 0;
      if (target > 1) target = 1;
      mouthOpen += (target - mouthOpen) * 0.35;

      // 眼球方向平滑
      eye.x += (exp.eye[0] - eye.x) * 0.15;
      eye.y += (exp.eye[1] - eye.y) * 0.15;

      // 背景
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      var cx = w / 2;
      var breathe = Math.sin(t / 1400) * 3;
      var cy = h / 2 + breathe;
      var headW = Math.min(w * 0.62, 260);
      var headH = headW * 1.02;

      // 状态光环
      var pad = 16;
      var alpha = exp.pulse ? 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(t / 300)) : 0.85;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = exp.ring;
      ctx.lineWidth = 4;
      ctx.shadowColor = exp.ring; ctx.shadowBlur = exp.pulse ? 22 : 12;
      roundRect(ctx, cx - headW / 2 - pad, cy - headH / 2 - pad, headW + pad * 2, headH + pad * 2, 34);
      ctx.stroke();
      ctx.restore();

      // 天线
      ctx.strokeStyle = C.faint; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(cx, cy - headH / 2 - pad); ctx.lineTo(cx, cy - headH / 2 - pad - 16); ctx.stroke();
      ctx.fillStyle = exp.ring;
      ctx.beginPath(); ctx.arc(cx, cy - headH / 2 - pad - 20, 5, 0, Math.PI * 2); ctx.fill();

      // 头
      ctx.fillStyle = C.line;
      roundRect(ctx, cx - headW / 2, cy - headH / 2, headW, headH, 30);
      ctx.fill();
      ctx.fillStyle = "#141d27";
      roundRect(ctx, cx - headW / 2 + 6, cy - headH / 2 + 6, headW - 12, headH - 12, 24);
      ctx.fill();

      // 眨眼：约每 3.6s 眨一次，闭合 130ms。
      var closed = (t % 3600) < 130;
      var eyeY = cy - headH * 0.06;
      var eyeDX = headW * 0.2, eyeRW = headW * 0.13, eyeRH = eyeRW * (closed ? 0.2 : 0.95);

      drawBrow(cx - eyeDX, eyeY - eyeRH - 12, exp.brow, -1);
      drawBrow(cx + eyeDX, eyeY - eyeRH - 12, exp.brow, 1);
      drawEye(cx - eyeDX, eyeY, eyeRW, eyeRH, closed, eye);
      drawEye(cx + eyeDX, eyeY, eyeRW, eyeRH, closed, eye);
      drawMouth(cx, cy + headH * 0.24, exp.mouth, mouthOpen);

      // 状态文案
      ctx.fillStyle = exp.ring;
      ctx.font = "600 15px var(--sans), system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(exp.label, cx, cy + headH / 2 + pad + 22);

      raf = window.requestAnimationFrame(frame);
    }

    raf = window.requestAnimationFrame(frame);

    return {
      update: update,
      setListening: setListening,
      setThinking: setThinking,
      startSpeaking: startSpeaking,
      stopSpeaking: stopSpeaking,
      destroy: function () { if (raf) window.cancelAnimationFrame(raf); },
    };
  }

  window.IRobotDigitalHuman = { createAvatar: createAvatar, computeExpression: computeExpression };
})();
