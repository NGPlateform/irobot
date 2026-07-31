// 多机器人 2D 俯视地图（Canvas 2D，零依赖、免打包）。API 与 3D 场景对齐：
//   createMap(canvas) → { update(deviceId,t), setState(deviceId,state), setActive(deviceId) }
// 每台机器人独立颜色/轨迹/朝向/执行环/机械臂指示；激活机器人琥珀高亮。
(function () {
  "use strict";
  var WORLD_W = 9.5, WORLD_H = 8;
  var COLORS = ["#4fc4d1", "#8fa0ff", "#f0b46a", "#7fd88a"];

  function createMap(canvas) {
    var ctx = canvas.getContext("2d");
    var robots = new Map(); // deviceId → {t,state,color,trail}
    var activeDevice = null;
    var colorIdx = 0;
    var mapData = null; // 三维地图：障碍 + 占据栅格
    function setMap(map) { mapData = map; }

    function ensure(deviceId) {
      var r = robots.get(deviceId);
      if (!r) {
        r = { t: null, state: "IDLE", color: COLORS[colorIdx++ % COLORS.length], trail: [] };
        robots.set(deviceId, r);
      }
      return r;
    }

    function update(deviceId, t) {
      var r = ensure(deviceId);
      r.t = t;
      var last = r.trail[r.trail.length - 1];
      if (!last || Math.hypot(last[0] - t.pose.x, last[1] - t.pose.y) > 0.05) {
        r.trail.push([t.pose.x, t.pose.y]);
        if (r.trail.length > 200) r.trail.shift();
      }
    }
    function setState(deviceId, state) { ensure(deviceId).state = state; }
    function setActive(deviceId) { activeDevice = deviceId; }

    function resize() {
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth || 640, h = canvas.clientHeight || 480;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    var PAD = 30;
    function w2p(x, y, w, h) {
      return [PAD + (x / WORLD_W) * (w - 2 * PAD), h - PAD - (y / WORLD_H) * (h - 2 * PAD)];
    }

    function drawWorld(w, h, t) {
      // 网格
      ctx.strokeStyle = "#18212d"; ctx.lineWidth = 1;
      for (var x = 0; x <= WORLD_W; x++) {
        var a = w2p(x, 0, w, h), b = w2p(x, WORLD_H, w, h);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      for (var y = 0; y <= WORLD_H; y++) {
        var c = w2p(0, y, w, h), d = w2p(WORLD_W, y, w, h);
        ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
      }
      var o = w2p(0, 0, w, h), e = w2p(WORLD_W, WORLD_H, w, h);
      ctx.strokeStyle = "#2c3a48"; ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(o[0], e[0]), Math.min(o[1], e[1]), Math.abs(e[0] - o[0]), Math.abs(e[1] - o[1]));
      // 占据栅格（free 暗青 / occupied 红）+ 障碍描边
      if (mapData) {
        var res = mapData.resolution, cols = mapData.cols, occ = mapData.occupancy || [];
        var cw = (res / WORLD_W) * (w - 2 * PAD) + 0.6, ch = (res / WORLD_H) * (h - 2 * PAD) + 0.6;
        for (var i = 0; i < occ.length; i++) {
          if (occ[i] === 0) continue;
          var gx = i % cols, gy = Math.floor(i / cols);
          var cp = w2p((gx + 0.5) * res, (gy + 0.5) * res, w, h);
          ctx.fillStyle = occ[i] === 2 ? "rgba(229,100,91,.6)" : "rgba(28,107,116,.28)";
          ctx.fillRect(cp[0] - cw / 2, cp[1] - ch / 2, cw, ch);
        }
        ctx.strokeStyle = "rgba(160,177,190,.55)"; ctx.lineWidth = 1.5;
        for (var oi = 0; oi < (mapData.obstacles || []).length; oi++) {
          var ob = mapData.obstacles[oi];
          var a = w2p(ob.x - ob.w / 2, ob.y + ob.h / 2, w, h), b = w2p(ob.x + ob.w / 2, ob.y - ob.h / 2, w, h);
          ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
        }
      }
      if (!t) return;
      // 危险区
      if (t.restrictedZone) {
        var rz = t.restrictedZone;
        var z0 = w2p(rz.x - 1, rz.y + 1, w, h), z1 = w2p(rz.x + 1, rz.y - 1, w, h);
        ctx.fillStyle = "rgba(229,100,91,.14)"; ctx.fillRect(z0[0], z0[1], z1[0] - z0[0], z1[1] - z0[1]);
        ctx.strokeStyle = "rgba(229,100,91,.7)"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
        ctx.strokeRect(z0[0], z0[1], z1[0] - z0[0], z1[1] - z0[1]); ctx.setLineDash([]);
        var lz = w2p(rz.x, rz.y, w, h);
        ctx.fillStyle = "#e5645b"; ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("⚠ " + rz.label, lz[0], lz[1]);
      }
      // 站点
      if (t.stations) {
        for (var name in t.stations) {
          var s = t.stations[name], sp = w2p(s.x, s.y, w, h);
          ctx.fillStyle = "#1c8a99"; ctx.beginPath(); ctx.arc(sp[0], sp[1], 6, 0, 7); ctx.fill();
          ctx.fillStyle = "#8fb6bd"; ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
          ctx.fillText(name, sp[0], sp[1] - 11);
        }
      }
    }

    function drawRobot(w, h, dev, r, active, t2) {
      var p = w2p(r.t.pose.x, r.t.pose.y, w, h);
      var rad = 14;
      // 轨迹
      if (r.trail.length > 1) {
        ctx.strokeStyle = active ? "rgba(238,169,78,.45)" : r.color + "55"; ctx.lineWidth = 2; ctx.beginPath();
        for (var i = 0; i < r.trail.length; i++) {
          var tp = w2p(r.trail[i][0], r.trail[i][1], w, h);
          i ? ctx.lineTo(tp[0], tp[1]) : ctx.moveTo(tp[0], tp[1]);
        }
        ctx.stroke();
      }
      // 充电坞（每台自己的）
      if (r.t.dock) {
        var dk = w2p(r.t.dock.x, r.t.dock.y, w, h);
        ctx.fillStyle = r.t.charging ? "#4cc186" : "#2f5d47";
        ctx.fillRect(dk[0] - 9, dk[1] - 9, 18, 18);
      }
      // 激活高亮
      if (active) {
        ctx.strokeStyle = "#eea94e"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p[0], p[1], rad + 11, 0, 7); ctx.stroke();
      }
      // 执行环
      if (r.state === "EXECUTING") {
        ctx.strokeStyle = r.color; ctx.lineWidth = 3; ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t2 / 300));
        ctx.beginPath(); ctx.arc(p[0], p[1], rad + 6, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      }
      // 机械臂指示（沿朝向伸出，长度∝extension；末端夹爪开合∝gripper）
      if (r.t.arm && r.t.arm.extension > 0.02) {
        var ang = -r.t.pose.heading;
        var ax = p[0] + Math.cos(ang) * rad, ay = p[1] + Math.sin(ang) * rad;
        var ex = ax + Math.cos(ang) * rad * r.t.arm.extension * 1.6;
        var ey = ay + Math.sin(ang) * rad * r.t.arm.extension * 1.6;
        ctx.strokeStyle = "#c9d4de"; ctx.lineWidth = 3; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
        var spread = (1 - r.t.arm.gripper) * 0.6 + 0.15, fl = 7;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + Math.cos(ang - spread) * fl, ey + Math.sin(ang - spread) * fl); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + Math.cos(ang + spread) * fl, ey + Math.sin(ang + spread) * fl); ctx.stroke();
      }
      // 机身
      ctx.fillStyle = r.t.estop ? "#e5645b" : r.color;
      ctx.beginPath(); ctx.arc(p[0], p[1], rad, 0, 7); ctx.fill();
      // 朝向
      ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[0] + Math.cos(-r.t.pose.heading) * rad * 1.4, p[1] + Math.sin(-r.t.pose.heading) * rad * 1.4);
      ctx.stroke();
      // 标签
      ctx.fillStyle = active ? "#eea94e" : "#8fb6bd"; ctx.font = (active ? "600 " : "") + "11px system-ui";
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.fillText(dev, p[0], p[1] + rad + 15);
    }

    function frame() {
      var t2 = (typeof performance !== "undefined" ? performance.now() : 0);
      var dim = resize(), w = dim.w, h = dim.h;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0e141d"; ctx.fillRect(0, 0, w, h);
      var act = activeDevice && robots.get(activeDevice);
      drawWorld(w, h, act && act.t ? act.t : null);
      // 先画非激活，激活最后画（在上层）
      robots.forEach(function (r, dev) { if (r.t && dev !== activeDevice) drawRobot(w, h, dev, r, false, t2); });
      if (act && act.t) drawRobot(w, h, activeDevice, act, true, t2);
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);

    return { update: update, setState: setState, setActive: setActive, setMap: setMap };
  }

  window.IRobotMap2D = { createMap: createMap };
})();
