import * as THREE from "three";

const W = 9.5;
const H = 8;
const w2v = (x, y) => new THREE.Vector3(x, 0, y);

function makeLabel(text, color = "#8fb6bd") {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = color; ctx.font = "bold 40px system-ui"; ctx.textAlign = "center";
  ctx.fillText(text, 128, 46);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(0.9, 0.22, 1);
  return spr;
}

/** 近似 TurtleBot 4：Create 3 圆base + 传感器塔 + 顶部激光雷达 + 前置相机 + 机械臂。 */
function buildTurtleBot4(bodyColor) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.09, 40),
    new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.1, roughness: 0.7 }),
  );
  base.position.y = 0.055; base.castShadow = true; g.add(base);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.172, 0.172, 0.012, 40), new THREE.MeshStandardMaterial({ color: 0x1a1d22 }));
  ring.position.y = 0.106; g.add(ring);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.05), new THREE.MeshStandardMaterial({ color: 0x4fc4d1 }));
  nose.position.set(0.15, 0.11, 0); g.add(nose);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3038 });
  for (const dx of [-0.09, 0.09]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 12), poleMat);
    pole.position.set(dx, 0.19, -0.02); g.add(pole);
  }
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 40), new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }));
  plate.position.y = 0.28; g.add(plate);
  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 24), new THREE.MeshStandardMaterial({ color: 0x111317 }));
  lidar.position.y = 0.315; g.add(lidar);
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.03, 0.03), new THREE.MeshStandardMaterial({ color: 0x33373f }));
  cam.position.set(0.1, 0.24, 0); g.add(cam);
  // 机械臂
  const armPivot = new THREE.Group();
  armPivot.position.set(0.15, 0.24, 0); g.add(armPivot);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.028, 0.028), new THREE.MeshStandardMaterial({ color: 0x3a4551 }));
  boom.position.x = 0.13; armPivot.add(boom);
  const gripper = new THREE.Group(); gripper.position.x = 0.27; armPivot.add(gripper);
  const fingerMat = new THREE.MeshStandardMaterial({ color: 0x4fc4d1 });
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.016), fingerMat);
  const f2 = f1.clone(); gripper.add(f1); gripper.add(f2);
  armPivot.rotation.z = Math.PI / 2;
  // 进度环 + 激活高亮环
  const ringPad = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.26, 48), new THREE.MeshBasicMaterial({ color: 0x4fc4d1, side: THREE.DoubleSide, transparent: true }));
  ringPad.rotation.x = -Math.PI / 2; ringPad.position.y = 0.005; ringPad.visible = false; g.add(ringPad);
  const activeRing = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.32, 48), new THREE.MeshBasicMaterial({ color: 0xeea94e, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
  activeRing.rotation.x = -Math.PI / 2; activeRing.position.y = 0.004; activeRing.visible = false; g.add(activeRing);
  g.userData = { arm: { pivot: armPivot, f1, f2 }, progress: ringPad, activeRing, base, baseColor: bodyColor };
  return g;
}

const BODY_COLORS = [0xf2f2f2, 0xd9e8ff, 0xffe4c4, 0xd8ffd8];

export function createRobotScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e141d);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const camTarget = new THREE.Vector3(W / 2, 0, H / 2);
  const orbit = { radius: 12, theta: 0, phi: 0.95 };
  function applyCamera() {
    const r = orbit.radius;
    camera.position.set(
      camTarget.x + r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
      camTarget.y + r * Math.cos(orbit.phi),
      camTarget.z + r * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    );
    camera.lookAt(camTarget);
  }
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", (e) => { dragging = false; canvas.releasePointerCapture?.(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    orbit.theta -= (e.clientX - lastX) * 0.006;
    orbit.phi = Math.min(1.45, Math.max(0.15, orbit.phi - (e.clientY - lastY) * 0.005));
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); orbit.radius = Math.min(24, Math.max(4, orbit.radius + e.deltaY * 0.01)); }, { passive: false });

  scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x20262e, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1); dir.position.set(6, 12, 4); scene.add(dir);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ color: 0x151b24, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(W / 2, 0, H / 2); scene.add(floor);
  const grid = new THREE.GridHelper(Math.max(W, H), Math.max(W, H), 0x2a3542, 0x1f2731);
  grid.position.set(W / 2, 0.002, H / 2); scene.add(grid);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x28323d });
  for (const [x, z, sx, sz] of [[W / 2, 0, W, 0.05], [W / 2, H, W, 0.05], [0, H / 2, 0.05, H], [W, H / 2, 0.05, H]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.25, sz), wallMat);
    wall.position.set(x, 0.125, z); scene.add(wall);
  }

  const dynamic = new THREE.Group(); scene.add(dynamic);
  let staticsBuilt = false;
  let dangerAABB = null;
  function buildStatics(t) {
    const dock = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 32), new THREE.MeshStandardMaterial({ color: 0x2f8a5b, emissive: 0x123a24 }));
    const dp = w2v(t.dock.x, t.dock.y); dock.position.set(dp.x, 0.011, dp.z); dynamic.add(dock);
    for (const [name, s] of Object.entries(t.stations)) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 16), new THREE.MeshStandardMaterial({ color: 0x1c8a99, emissive: 0x08343a }));
      const p = w2v(s.x, s.y); post.position.set(p.x, 0.2, p.z); dynamic.add(post);
      const lb = makeLabel(name, "#8fb6bd"); lb.position.set(p.x, 0.62, p.z); dynamic.add(lb);
    }
    if (t.restrictedZone) {
      const rz = t.restrictedZone;
      const box = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 2), new THREE.MeshStandardMaterial({ color: 0xe5645b, transparent: true, opacity: 0.18 }));
      const p = w2v(rz.x, rz.y); box.position.set(p.x, 0.25, p.z); dynamic.add(box);
      const lb = makeLabel("⚠ " + rz.label, "#e5645b"); lb.position.set(p.x, 0.7, p.z); dynamic.add(lb);
      dangerAABB = [rz.x - 1, rz.y - 1, rz.x + 1, rz.y + 1];
    }
    staticsBuilt = true;
  }

  // 激光雷达（跟随激活机器人）
  const RAYS = 120;
  const lidarPos = new Float32Array(RAYS * 3);
  const lidarGeom = new THREE.BufferGeometry();
  lidarGeom.setAttribute("position", new THREE.BufferAttribute(lidarPos, 3));
  const lidar = new THREE.Points(lidarGeom, new THREE.PointsMaterial({ color: 0x6fe3c8, size: 0.07, transparent: true, opacity: 0.85 }));
  scene.add(lidar);
  const rayToWall = (px, pz, dx, dz) => {
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (W - px) / dx);
    if (dx < -1e-6) t = Math.min(t, -px / dx);
    if (dz > 1e-6) t = Math.min(t, (H - pz) / dz);
    if (dz < -1e-6) t = Math.min(t, -pz / dz);
    return t;
  };
  function rayToAABB(px, pz, dx, dz, minx, minz, maxx, maxz) {
    let tmin = -Infinity, tmax = Infinity;
    const slab = (p, d, lo, hi) => {
      if (Math.abs(d) < 1e-9) return p >= lo && p <= hi;
      let t1 = (lo - p) / d, t2 = (hi - p) / d; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); return true;
    };
    if (!slab(px, dx, minx, maxx) || !slab(pz, dz, minz, maxz)) return Infinity;
    if (tmax < Math.max(tmin, 0)) return Infinity;
    return tmin > 0 ? tmin : Infinity;
  }
  function updateLidar(px, pz) {
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      let t = rayToWall(px, pz, dx, dz);
      if (dangerAABB) t = Math.min(t, rayToAABB(px, pz, dx, dz, dangerAABB[0], dangerAABB[1], dangerAABB[2], dangerAABB[3]));
      const j = i * 3; lidarPos[j] = px + dx * t; lidarPos[j + 1] = 0.12; lidarPos[j + 2] = pz + dz * t;
    }
    lidarGeom.attributes.position.needsUpdate = true; lidarGeom.computeBoundingSphere();
  }

  const robots = new Map(); // deviceId → { group, trail..., state }
  let activeDevice = null;
  let colorIdx = 0;
  function ensureRobot(deviceId) {
    let r = robots.get(deviceId);
    if (r) return r;
    const group = buildTurtleBot4(BODY_COLORS[colorIdx++ % BODY_COLORS.length]);
    scene.add(group);
    const lb = makeLabel(deviceId, "#a4b1be"); lb.position.y = 0.5; group.add(lb);
    const MAXT = 200;
    const tpos = new Float32Array(MAXT * 3);
    const tgeom = new THREE.BufferGeometry();
    tgeom.setAttribute("position", new THREE.BufferAttribute(tpos, 3)); tgeom.setDrawRange(0, 0);
    const trail = new THREE.Line(tgeom, new THREE.LineBasicMaterial({ color: 0x4fc4d1, transparent: true, opacity: 0.5 }));
    scene.add(trail);
    r = { group, tpos, tgeom, tcount: 0, last: null, state: "IDLE", progress: 0 };
    robots.set(deviceId, r);
    return r;
  }
  function pushTrail(r, v) {
    if (r.last && r.last.distanceTo(v) <= 0.05) return;
    r.last = v.clone();
    if (r.tcount >= 200) { r.tpos.copyWithin(0, 3); r.tcount = 199; }
    const i = r.tcount * 3; r.tpos[i] = v.x; r.tpos[i + 1] = 0.02; r.tpos[i + 2] = v.z; r.tcount++;
    r.tgeom.setDrawRange(0, r.tcount); r.tgeom.attributes.position.needsUpdate = true; r.tgeom.computeBoundingSphere();
  }

  function update(deviceId, t) {
    if (!staticsBuilt) buildStatics(t);
    const r = ensureRobot(deviceId);
    const p = w2v(t.pose.x, t.pose.y);
    r.group.position.set(p.x, 0, p.z);
    r.group.rotation.y = -t.pose.heading;
    r.group.userData.base.material.color.set(t.estop ? 0xe5645b : (r.group.userData.baseColor ?? 0xf2f2f2));
    if (t.arm) {
      const { pivot, f1, f2 } = r.group.userData.arm;
      pivot.rotation.z = (Math.PI / 2) * (1 - t.arm.extension);
      const sep = 0.05 - 0.038 * t.arm.gripper; f1.position.z = sep; f2.position.z = -sep;
    }
    pushTrail(r, p);
    r.group.userData.progress.visible = r.state === "EXECUTING";
    if (deviceId === activeDevice || activeDevice === null) updateLidar(p.x, p.z);
  }
  function setState(deviceId, state) {
    const r = robots.get(deviceId); if (r && state) r.state = state;
  }
  function setActive(deviceId) {
    activeDevice = deviceId;
    for (const [id, r] of robots) r.group.userData.activeRing.visible = id === deviceId;
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix();
    }
  }
  function loop() { resize(); applyCamera(); renderer.render(scene, camera); requestAnimationFrame(loop); }
  applyCamera(); loop();

  return { update, setState, setActive };
}

window.IRobotScene = { createRobotScene };
