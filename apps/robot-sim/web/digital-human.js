// 数字人头像：Canvas 2D 拟人机器人。两种视图共享同一张"表情头"：
//   脸部（face）= 会说话的大头像；全身（body）= 拟人机器人立身（头+躯干+双臂+双腿）。
// 随遥测/动作状态变表情、随 TTS 口型同步、随麦克风聆听脉冲、status busy 思考动画；
// 全身另外反映：底盘行走、机械臂映射（右臂）、说话手势（左臂）。零依赖、免打包。
(function () {
  "use strict";

  // 复用 styles.css 的设计令牌配色。
  var C = {
    flow: "#4fc4d1", signal: "#eea94e", danger: "#e5645b", ok: "#4cc186",
    ink: "#e6edf3", faint: "#6d7c8a", bg: "#0e141d", line: "#24303d",
    face: "#1b2632", pupil: "#0b0f14", limb: "#3a4a5a",
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
    var st = {
      estop: false, battery: 100, state: "IDLE",
      listening: false, thinking: false, speaking: false, flash: null,
      arm: { extension: 0, gripper: 0, moving: false },
      pose: null, moving: false,
    };
    var view = "face";       // "face" | "body"
    var flashUntil = 0;
    var mouthOpen = 0;        // 0..1，口型开合（对说话平滑）
    var eye = { x: 0, y: 0 }; // 当前眼球方向（对目标平滑）
    var raf = 0;

    function now() { return (typeof performance !== "undefined" ? performance.now() : 0); }

    function setFlash(kind) { st.flash = kind; flashUntil = now() + 1200; }

    function update(telemetry, state) {
      if (telemetry) {
        st.estop = !!telemetry.estop;
        st.battery = telemetry.battery;
        if (telemetry.arm) st.arm = telemetry.arm;
        // 由 pose 增量判断底盘是否在移动（区分"行走"与"仅机械臂动"）。
        if (telemetry.pose) {
          if (st.pose) {
            var dx = telemetry.pose.x - st.pose.x, dy = telemetry.pose.y - st.pose.y;
            st.moving = Math.hypot(dx, dy) > 0.002;
          }
          st.pose = { x: telemetry.pose.x, y: telemetry.pose.y };
        }
      }
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
    function setView(v) { view = v === "body" ? "body" : "face"; }

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

    function drawBrow(cx, y, type, side, s) {
      // side: -1 左眼, +1 右眼。inner 端朝向中线。
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 4 * s;
      ctx.lineCap = "round";
      var len = 26 * s, inner = cx - side * (len / 2), outer = cx + side * (len / 2);
      var dyIn = 0, dyOut = 0;
      if (type === "worried") { dyIn = -6 * s; dyOut = 3 * s; }
      else if (type === "angry") { dyIn = 6 * s; dyOut = -3 * s; }
      else if (type === "happy") { dyIn = -4 * s; dyOut = -4 * s; }
      ctx.beginPath();
      ctx.moveTo(inner, y + dyIn);
      ctx.lineTo(outer, y + dyOut);
      ctx.stroke();
    }

    function drawEye(cx, cy, rw, rh, closed, dir, s) {
      ctx.fillStyle = C.face;
      roundRect(ctx, cx - rw, cy - rh, rw * 2, rh * 2, Math.min(rw, rh) * 0.7);
      ctx.fill();
      if (closed) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3 * s; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(cx - rw * 0.7, cy); ctx.lineTo(cx + rw * 0.7, cy); ctx.stroke();
        return;
      }
      var px = cx + dir.x * rw * 0.55, py = cy + dir.y * rh * 0.6;
      var pr = Math.min(rw, rh) * 0.55;
      ctx.fillStyle = C.flow;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.pupil;
      ctx.beginPath(); ctx.arc(px, py, pr * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.beginPath(); ctx.arc(px - pr * 0.3, py - pr * 0.3, pr * 0.22, 0, Math.PI * 2); ctx.fill();
    }

    function drawMouth(cx, cy, kind, open, s) {
      ctx.strokeStyle = C.ink; ctx.lineWidth = 4 * s; ctx.lineCap = "round"; ctx.lineJoin = "round";
      var w = 44 * s;
      if (kind === "open") {
        var hh = (6 + open * 26) * s;
        ctx.fillStyle = "#2a1a1e";
        roundRect(ctx, cx - w * 0.42, cy - hh / 2, w * 0.84, hh, Math.min(10 * s, hh / 2));
        ctx.fill();
        ctx.stroke();
        return;
      }
      ctx.beginPath();
      if (kind === "smile") { ctx.moveTo(cx - w / 2, cy - 4 * s); ctx.quadraticCurveTo(cx, cy + 14 * s, cx + w / 2, cy - 4 * s); }
      else if (kind === "frown") { ctx.moveTo(cx - w / 2, cy + 8 * s); ctx.quadraticCurveTo(cx, cy - 10 * s, cx + w / 2, cy + 8 * s); }
      else { ctx.moveTo(cx - w / 2, cy + 2 * s); ctx.lineTo(cx + w / 2, cy + 2 * s); }
      ctx.stroke();
    }

    /** 共享"表情头"：天线 + 头 + 眨眼眼睛 + 眉 + 嘴。按 headW 缩放，脸/身两视图复用。 */
    function drawHead(cx, cy, headW, exp, closed) {
      var s = headW / 260;
      var headH = headW * 1.02;
      var pad = 16 * s;

      // 天线
      ctx.strokeStyle = C.faint; ctx.lineWidth = 3 * s; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(cx, cy - headH / 2); ctx.lineTo(cx, cy - headH / 2 - 16 * s); ctx.stroke();
      ctx.fillStyle = exp.ring;
      ctx.beginPath(); ctx.arc(cx, cy - headH / 2 - 20 * s, 5 * s, 0, Math.PI * 2); ctx.fill();

      // 头
      ctx.fillStyle = C.line;
      roundRect(ctx, cx - headW / 2, cy - headH / 2, headW, headH, 30 * s);
      ctx.fill();
      ctx.fillStyle = "#141d27";
      roundRect(ctx, cx - headW / 2 + 6 * s, cy - headH / 2 + 6 * s, headW - 12 * s, headH - 12 * s, 24 * s);
      ctx.fill();

      var eyeY = cy - headH * 0.06;
      var eyeDX = headW * 0.2, eyeRW = headW * 0.13, eyeRH = eyeRW * (closed ? 0.2 : 0.95);
      drawBrow(cx - eyeDX, eyeY - eyeRH - 12 * s, exp.brow, -1, s);
      drawBrow(cx + eyeDX, eyeY - eyeRH - 12 * s, exp.brow, 1, s);
      drawEye(cx - eyeDX, eyeY, eyeRW, eyeRH, closed, eye, s);
      drawEye(cx + eyeDX, eyeY, eyeRW, eyeRH, closed, eye, s);
      drawMouth(cx, cy + headH * 0.24, exp.mouth, mouthOpen, s);
      void pad;
    }

    function label(cx, y, exp) {
      ctx.fillStyle = exp.ring;
      ctx.font = "600 15px var(--sans), system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(exp.label, cx, y);
    }

    // —— 脸部视图：状态光环 + 大头像 + 文案 ——
    function drawFace(w, h, exp, closed, t) {
      var cx = w / 2;
      var cy = h / 2 + Math.sin(t / 1400) * 3;
      var headW = Math.min(w * 0.62, 260);
      var headH = headW * 1.02;
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

      drawHead(cx, cy, headW, exp, closed);
      label(cx, cy + headH / 2 + pad + 22, exp);
    }

    function limb(ax, ay, bx, by, wdt) {
      ctx.strokeStyle = C.limb; ctx.lineWidth = wdt; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    function joint(x, y, r) { ctx.fillStyle = C.faint; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

    // —— 全身视图：拟人机器人立身，反映行走 / 机械臂 / 说话 / 表情 ——
    function drawBody(w, h, exp, closed, t) {
      var cx = w / 2;
      var walk = st.moving && !st.estop;
      var ph = t * 0.012;                                   // 步态相位
      var bob = walk ? Math.abs(Math.sin(ph)) * 5 : Math.sin(t / 1400) * 2;
      var lean = walk ? 5 : 0;

      var groundY = h * 0.90;
      var legLen = h * 0.20;
      var hipY = groundY - legLen - bob;
      var torsoH = Math.min(h * 0.26, 190);
      var torsoW = Math.min(w * 0.26, 150);
      var shoulderY = hipY - torsoH;
      var headW = Math.min(torsoW * 0.86, 120);
      var headCY = shoulderY - headW * 0.55 - bob;
      var lw = Math.max(7, torsoW * 0.11);                  // 肢体粗细

      // 地面阴影（随状态脉冲）
      ctx.save();
      ctx.globalAlpha = exp.pulse ? 0.28 + 0.18 * (0.5 + 0.5 * Math.sin(t / 300)) : 0.32;
      ctx.fillStyle = exp.ring;
      ctx.beginPath(); ctx.ellipse(cx, groundY + 6, torsoW * 0.62, 12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // 双腿（行走时前后摆动 + 抬脚）
      for (var i = -1; i <= 1; i += 2) {
        var lp = walk ? Math.sin(ph + (i > 0 ? Math.PI : 0)) : 0;
        var hipX = cx + i * torsoW * 0.24 + lean * 0.4;
        var footX = hipX + lp * legLen * 0.5;
        var lift = walk ? Math.max(0, Math.cos(ph + (i > 0 ? Math.PI : 0))) * 8 : 0;
        var footY = groundY - lift;
        var kneeX = (hipX + footX) / 2;
        var kneeY = hipY + legLen * 0.52;
        limb(hipX, hipY, kneeX, kneeY, lw);
        limb(kneeX, kneeY, footX, footY, lw);
        joint(kneeX, kneeY, lw * 0.5);
        ctx.fillStyle = C.faint;
        ctx.beginPath(); ctx.ellipse(footX + 4, footY, lw * 0.9, lw * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      }

      // 躯干 + 核心状态光
      var tx = cx - torsoW / 2 + lean * 0.5;
      ctx.fillStyle = st.estop ? "#3a2422" : C.line;
      roundRect(ctx, tx, shoulderY, torsoW, torsoH, torsoW * 0.28);
      ctx.fill();
      ctx.save();
      ctx.shadowColor = exp.ring; ctx.shadowBlur = exp.pulse ? 20 : 12;
      ctx.fillStyle = exp.ring;
      ctx.globalAlpha = exp.pulse ? 0.7 + 0.3 * Math.sin(t / 300) : 0.95;
      ctx.beginPath(); ctx.arc(cx + lean * 0.3, shoulderY + torsoH * 0.44, torsoW * 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      var armUpper = h * 0.12, armFore = h * 0.11;

      // 右臂 = 机械臂映射（抬升/前伸随 extension，手指开合随 gripper）
      (function () {
        var sx = cx + torsoW * 0.5 + lean * 0.3, sy = shoulderY + torsoH * 0.14;
        var ext = st.estop ? 0 : (st.arm ? st.arm.extension : 0);
        var th = ext * 2.0;                                 // 0 下垂 .. ~115°
        var ex = sx + Math.sin(th) * armUpper, ey = sy + Math.cos(th) * armUpper;
        var wx = ex + Math.sin(th + 0.35) * armFore, wy = ey + Math.cos(th + 0.35) * armFore;
        limb(sx, sy, ex, ey, lw); limb(ex, ey, wx, wy, lw * 0.9); joint(ex, ey, lw * 0.5);
        // 夹爪：两指，开合随 gripper（1 闭合、0 张开）
        var grip = st.arm ? st.arm.gripper : 0;
        var spread = (1 - grip) * 0.5 + 0.12;
        var fl = lw * 1.4, base = th + 0.35;
        limb(wx, wy, wx + Math.sin(base - spread) * fl, wy + Math.cos(base - spread) * fl, lw * 0.55);
        limb(wx, wy, wx + Math.sin(base + spread) * fl, wy + Math.cos(base + spread) * fl, lw * 0.55);
      })();

      // 左臂 = 说话手势（说话时手部小幅摆动，否则自然下垂）
      (function () {
        var sx = cx - torsoW * 0.5 + lean * 0.3, sy = shoulderY + torsoH * 0.14;
        var g = (!st.estop && st.speaking) ? (0.55 + Math.sin(t * 0.02) * 0.4) : 0.06;
        var ex = sx - Math.sin(g) * armUpper, ey = sy + Math.cos(g) * armUpper;
        var wx = ex - Math.sin(g + 0.3) * armFore, wy = ey + Math.cos(g + 0.3) * armFore;
        limb(sx, sy, ex, ey, lw); limb(ex, ey, wx, wy, lw * 0.9); joint(ex, ey, lw * 0.5);
        joint(wx, wy, lw * 0.55);
      })();

      // 头（复用共享表情头）
      drawHead(cx + lean * 0.2, headCY, headW, exp, closed);
      label(cx, h * 0.97, exp);
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

      var closed = (t % 3600) < 130;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      if (view === "body") drawBody(w, h, exp, closed, t);
      else drawFace(w, h, exp, closed, t);

      raf = window.requestAnimationFrame(frame);
    }

    raf = window.requestAnimationFrame(frame);

    return {
      update: update,
      setListening: setListening,
      setThinking: setThinking,
      startSpeaking: startSpeaking,
      stopSpeaking: stopSpeaking,
      setView: setView,
      destroy: function () { if (raf) window.cancelAnimationFrame(raf); },
    };
  }

  window.IRobotDigitalHuman = { createAvatar: createAvatar, computeExpression: computeExpression };
})();
