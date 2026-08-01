import * as THREE from "three";

const W = 9.5;
const H = 8;
const w2v = (x, y) => new THREE.Vector3(x, 0, y);

// ---- 手写可种子 2D value-noise + fBm（零外部依赖，用于程序化地形）----
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, seed) {
  let val = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) { val += amp * valueNoise(x * freq, y * freq, seed + o * 97); freq *= 2; amp *= 0.5; }
  return val;
}

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
  const armPivot = new THREE.Group();
  armPivot.position.set(0.15, 0.24, 0); g.add(armPivot);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.028, 0.028), new THREE.MeshStandardMaterial({ color: 0x3a4551 }));
  boom.position.x = 0.13; armPivot.add(boom);
  const gripper = new THREE.Group(); gripper.position.x = 0.27; armPivot.add(gripper);
  const fingerMat = new THREE.MeshStandardMaterial({ color: 0x4fc4d1 });
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.016), fingerMat);
  const f2 = f1.clone(); gripper.add(f1); gripper.add(f2);
  armPivot.rotation.z = Math.PI / 2;
  const ringPad = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.26, 48), new THREE.MeshBasicMaterial({ color: 0x4fc4d1, side: THREE.DoubleSide, transparent: true }));
  ringPad.rotation.x = -Math.PI / 2; ringPad.position.y = 0.005; ringPad.visible = false; g.add(ringPad);
  const activeRing = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.32, 48), new THREE.MeshBasicMaterial({ color: 0xeea94e, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
  activeRing.rotation.x = -Math.PI / 2; activeRing.position.y = 0.004; activeRing.visible = false; g.add(activeRing);
  g.userData = { arm: { pivot: armPivot, f1, f2 }, progress: ringPad, activeRing, base, baseColor: bodyColor };
  return g;
}

const BODY_COLORS = [0xf2f2f2, 0xd9e8ff, 0xffe4c4, 0xd8ffd8];

// ---- 低多边形树/岩/动物 ----
const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, flatShading: true, roughness: 1 });
const LEAF_MATS = [0x3f7a3a, 0x4f8f45, 0x5a7d38].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 1 }));
const ROCK_MAT = new THREE.MeshStandardMaterial({ color: 0x8a8f96, flatShading: true, roughness: 1 });
function makeTree(scale, tint) {
  const g = new THREE.Group();
  const leaf = LEAF_MATS[tint % LEAF_MATS.length];
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * scale, 0.08 * scale, 0.42 * scale, 6), TRUNK_MAT);
  trunk.position.y = 0.21 * scale; g.add(trunk);
  const c1 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3 * scale, 0), leaf);
  c1.position.y = 0.5 * scale; c1.rotation.y = tint; g.add(c1);
  const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.24 * scale, 0.42 * scale, 6), leaf);
  c2.position.y = 0.78 * scale; g.add(c2);
  return g;
}
function makeRock(scale) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28 * scale, 0), ROCK_MAT);
  m.rotation.set(Math.random(), Math.random(), Math.random());
  m.scale.y = 0.7;
  return m;
}
const A_BODY = new THREE.MeshStandardMaterial({ color: 0xb5794a, flatShading: true, roughness: 1 });
const A_WHITE = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, flatShading: true, roughness: 1 });
const A_BIRD = new THREE.MeshStandardMaterial({ color: 0x4a6fb5, flatShading: true, roughness: 1 });
function makeAnimal(kind) {
  const g = new THREE.Group();
  if (kind === 0) { // 鹿
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.3), A_BODY); body.position.y = 0.22; g.add(body);
    for (const [x, z] of [[-0.05, 0.11], [0.05, 0.11], [-0.05, -0.11], [0.05, -0.11]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 5), A_BODY); leg.position.set(x, 0.11, z); g.add(leg);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.11), A_BODY); head.position.set(0, 0.32, 0.18); g.add(head);
  } else if (kind === 1) { // 兔
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), A_WHITE); body.position.y = 0.1; body.scale.set(1, 0.9, 1.2); g.add(body);
    for (const x of [-0.03, 0.03]) { const ear = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.03), A_WHITE); ear.position.set(x, 0.22, -0.04); g.add(ear); }
  } else { // 鸟
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 5), A_BIRD); body.rotation.x = Math.PI / 2; body.position.y = 0; g.add(body);
    for (const s of [-1, 1]) { const wing = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.01, 0.06), A_BIRD); wing.position.set(s * 0.08, 0, 0); g.add(wing); }
  }
  return g;
}

export function createRobotScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const SKY = 0x9fc6e0;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 12, 30);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const camTarget = new THREE.Vector3(W / 2, 0.4, H / 2);
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

  scene.add(new THREE.HemisphereLight(0xdff0ff, 0x3a5a34, 1.05));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.15); sun.position.set(6, 12, 4); scene.add(sun);

  // ---- 程序化地形（高度图）+ 河流状态 ----
  let terrainSeed = 1, riverPts = [], riverW = 0.8;
  function distToRiverLocal(x, y) {
    let best = Infinity;
    for (let i = 0; i + 1 < riverPts.length; i++) {
      const a = riverPts[i], b = riverPts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1e-9;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
    return best;
  }
  /** 世界坐标 → 地形高度（含河谷刻蚀）。robot/树/动物据此贴地。 */
  function terrainHeight(x, y) {
    const base = (fbm(x * 0.32 + 5, y * 0.32 + 5, terrainSeed) - 0.5) * 0.9 + 0.3;
    if (riverPts.length >= 2) {
      const carve = Math.max(0, 1 - distToRiverLocal(x, y) / (riverW * 1.9));
      return base * (1 - carve) - 0.2 * carve;
    }
    return base;
  }

  const terrainGroup = new THREE.Group(); scene.add(terrainGroup);
  const envGroup = new THREE.Group(); scene.add(envGroup);      // 树/岩
  const riverGroup = new THREE.Group(); scene.add(riverGroup);  // 河流水面
  const dynamic = new THREE.Group(); scene.add(dynamic);        // 站点/坞/危险区
  const mapGroup = new THREE.Group(); scene.add(mapGroup);      // 占据叠加
  let riverGeo = null, riverBaseY = null;
  let mapObstacles = [];
  let staticsBuilt = false, dangerAABB = null, lastT = null;
  let envSig = "";

  function clearGroup(g) {
    for (const c of g.children) {
      c.traverse?.((o) => { o.geometry?.dispose?.(); });
      c.geometry?.dispose?.();
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) if (m && m !== TRUNK_MAT && !LEAF_MATS.includes(m) && m !== ROCK_MAT && m !== A_BODY && m !== A_WHITE && m !== A_BIRD) m.dispose?.();
    }
    g.clear();
  }

  function buildTerrain() {
    clearGroup(terrainGroup);
    const geo = new THREE.PlaneGeometry(W + 2, H + 2, 52, 44);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const cols = [];
    const grass = new THREE.Color(0x4f7a37), dirt = new THREE.Color(0x796a44), rock = new THREE.Color(0x8a8f96), sand = new THREE.Color(0xccb987);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + W / 2, z = pos.getZ(i) + H / 2;
      const hgt = terrainHeight(x, z);
      pos.setY(i, hgt);
      let col = hgt < 0.0 ? sand : hgt < 0.28 ? grass : hgt < 0.52 ? dirt : rock;
      cols.push(col.r, col.g, col.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
    mesh.position.set(W / 2, 0, H / 2);
    terrainGroup.add(mesh);
  }

  function buildEnv() {
    clearGroup(envGroup);
    let ti = 0;
    for (const o of mapObstacles) {
      const s = Math.max(0.7, (o.w + o.h) / 2);
      const g = o.kind === "rock" ? makeRock(s) : makeTree(s * 0.9, ti++);
      g.position.set(o.x, terrainHeight(o.x, o.y), o.y);
      if (o.kind !== "rock") g.rotation.y = hash2(Math.round(o.x * 10), Math.round(o.y * 10), terrainSeed) * 6.28;
      envGroup.add(g);
    }
  }

  function buildRiver() {
    clearGroup(riverGroup); riverGeo = null; riverBaseY = null;
    if (riverPts.length < 2) return;
    const verts = [], idx = [], half = riverW / 2;
    for (let i = 0; i < riverPts.length; i++) {
      const p = riverPts[i];
      const a = riverPts[Math.max(0, i - 1)], b = riverPts[Math.min(riverPts.length - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = -dy, ny = dx, y = -0.04;
      verts.push(p.x + nx * half, y, p.y + ny * half, p.x - nx * half, y, p.y - ny * half);
    }
    for (let i = 0; i + 1 < riverPts.length; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3f86c4, transparent: true, opacity: 0.8, metalness: 0.3, roughness: 0.25, side: THREE.DoubleSide }));
    riverGroup.add(water);
    riverGeo = geo; riverBaseY = Array.from(geo.attributes.position.array).filter((_, k) => k % 3 === 1);
  }

  function blockedLocal(x, y) {
    if (x < 0.4 || y < 0.4 || x > W - 0.4 || y > H - 0.4) return true;
    for (const o of mapObstacles) if (Math.abs(x - o.x) <= o.w / 2 + 0.25 && Math.abs(y - o.y) <= o.h / 2 + 0.25) return true;
    if (riverPts.length >= 2 && distToRiverLocal(x, y) <= riverW / 2 + 0.3) return true;
    return false;
  }
  function randLand() {
    for (let k = 0; k < 50; k++) { const x = 0.8 + Math.random() * (W - 1.6), y = 0.8 + Math.random() * (H - 1.6); if (!blockedLocal(x, y)) return { x, y }; }
    return { x: W / 2, y: H / 2 };
  }
  const animals = [];
  function buildAnimals() {
    for (const a of animals) { scene.remove(a.group); clearGroup(a.group); }
    animals.length = 0;
    for (let i = 0; i < 5; i++) {
      const kind = i % 3, g = makeAnimal(kind); scene.add(g);
      const p = randLand();
      animals.push({ group: g, x: p.x, y: p.y, tx: p.x, ty: p.y, kind, phase: Math.random() * 6.28, speed: 0.35 + Math.random() * 0.45 });
    }
  }
  function updateAnimals(dt, time) {
    for (const a of animals) {
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      if (d < 0.15) { const p = randLand(); a.tx = p.x; a.ty = p.y; }
      else { const sp = a.speed * dt; a.x += (dx / d) * sp; a.y += (dy / d) * sp; a.group.rotation.y = Math.atan2(dx, dy); }
      const gh = terrainHeight(a.x, a.y);
      if (a.kind === 2) { a.group.position.set(a.x, gh + 0.7 + Math.sin(time * 3 + a.phase) * 0.1, a.y); a.group.children.forEach((c, k) => { if (k >= 1) c.rotation.z = Math.sin(time * 12 + a.phase) * 0.5 * (k === 1 ? 1 : -1); }); }
      else { a.group.position.set(a.x, gh + Math.abs(Math.sin(time * a.speed * 5 + a.phase)) * 0.05, a.y); }
    }
  }

  function setMap(map) {
    if (!map) return;
    mapObstacles = map.obstacles || [];
    // 环境（地形/树/河/动物）只在障碍/河/种子变化时重建，避免建图时每 500ms 重建。
    const sig = (map.terrainSeed || 0) + "|" + JSON.stringify(mapObstacles) + "|" + JSON.stringify(map.river || []);
    if (sig !== envSig) {
      envSig = sig;
      terrainSeed = (map.terrainSeed || 1) >>> 0;
      riverPts = map.river || [];
      riverW = map.riverWidth || 0.8;
      buildTerrain(); buildEnv(); buildRiver(); buildAnimals();
      staticsBuilt = false; // 站点/坞按新地形高度重建
    }
    // 占据叠加（已探区微亮瓦片，贴地形；occupied 由树/岩代表故略去）
    clearGroup(mapGroup);
    const res = map.resolution, cols = map.cols, occ = map.occupancy || [];
    let nFree = 0; for (const v of occ) if (v === 1) nFree++;
    if (nFree > 0) {
      const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(res * 0.95, res * 0.95), new THREE.MeshBasicMaterial({ color: 0x9fe0d0, transparent: true, opacity: 0.16, side: THREE.DoubleSide }), nFree);
      const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2); let k = 0;
      for (let i = 0; i < occ.length; i++) {
        if (occ[i] !== 1) continue;
        const cx = i % cols, cy = Math.floor(i / cols), wx = (cx + 0.5) * res, wy = (cy + 0.5) * res;
        const mm = rot.clone(); mm.setPosition(wx, terrainHeight(wx, wy) + 0.03, wy); inst.setMatrixAt(k++, mm);
      }
      inst.instanceMatrix.needsUpdate = true; mapGroup.add(inst);
    }
  }

  function buildStatics(t) {
    clearGroup(dynamic);
    const dh = terrainHeight(t.dock.x, t.dock.y);
    const dock = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 32), new THREE.MeshStandardMaterial({ color: 0x2f8a5b, emissive: 0x123a24 }));
    dock.position.set(t.dock.x, dh + 0.012, t.dock.y); dynamic.add(dock);
    for (const [name, s] of Object.entries(t.stations)) {
      const sh = terrainHeight(s.x, s.y);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 16), new THREE.MeshStandardMaterial({ color: 0x1c8a99, emissive: 0x08343a }));
      post.position.set(s.x, sh + 0.2, s.y); dynamic.add(post);
      const lb = makeLabel(name, "#e8f4f0"); lb.position.set(s.x, sh + 0.62, s.y); dynamic.add(lb);
    }
    if (t.restrictedZone) {
      const rz = t.restrictedZone, zh = terrainHeight(rz.x, rz.y);
      const box = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 2), new THREE.MeshStandardMaterial({ color: 0xe5645b, transparent: true, opacity: 0.18 }));
      box.position.set(rz.x, zh + 0.25, rz.y); dynamic.add(box);
      const lb = makeLabel("⚠ " + rz.label, "#ffd0cc"); lb.position.set(rz.x, zh + 0.7, rz.y); dynamic.add(lb);
      dangerAABB = [rz.x - 1, rz.y - 1, rz.x + 1, rz.y + 1];
    }
    staticsBuilt = true;
  }

  // 激光雷达（跟随激活机器人，贴地形高度）
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
    const y0 = terrainHeight(px, pz) + 0.15;
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      let t = rayToWall(px, pz, dx, dz);
      if (dangerAABB) t = Math.min(t, rayToAABB(px, pz, dx, dz, dangerAABB[0], dangerAABB[1], dangerAABB[2], dangerAABB[3]));
      for (const o of mapObstacles) t = Math.min(t, rayToAABB(px, pz, dx, dz, o.x - o.w / 2, o.y - o.h / 2, o.x + o.w / 2, o.y + o.h / 2));
      const j = i * 3; lidarPos[j] = px + dx * t; lidarPos[j + 1] = y0; lidarPos[j + 2] = pz + dz * t;
    }
    lidarGeom.attributes.position.needsUpdate = true; lidarGeom.computeBoundingSphere();
  }

  const robots = new Map();
  let activeDevice = null, colorIdx = 0;
  function ensureRobot(deviceId) {
    let r = robots.get(deviceId);
    if (r) return r;
    const group = buildTurtleBot4(BODY_COLORS[colorIdx++ % BODY_COLORS.length]);
    scene.add(group);
    const lb = makeLabel(deviceId, "#ffffff"); lb.position.y = 0.5; group.add(lb);
    const MAXT = 200;
    const tpos = new Float32Array(MAXT * 3);
    const tgeom = new THREE.BufferGeometry();
    tgeom.setAttribute("position", new THREE.BufferAttribute(tpos, 3)); tgeom.setDrawRange(0, 0);
    const trail = new THREE.Line(tgeom, new THREE.LineBasicMaterial({ color: 0x4fc4d1, transparent: true, opacity: 0.6 }));
    scene.add(trail);
    r = { group, tpos, tgeom, tcount: 0, last: null, state: "IDLE", progress: 0 };
    robots.set(deviceId, r);
    return r;
  }
  function pushTrail(r, x, y, z) {
    if (r.last && Math.hypot(r.last.x - x, r.last.z - z) <= 0.05) return;
    r.last = { x, z };
    if (r.tcount >= 200) { r.tpos.copyWithin(0, 3); r.tcount = 199; }
    const i = r.tcount * 3; r.tpos[i] = x; r.tpos[i + 1] = y + 0.04; r.tpos[i + 2] = z; r.tcount++;
    r.tgeom.setDrawRange(0, r.tcount); r.tgeom.attributes.position.needsUpdate = true; r.tgeom.computeBoundingSphere();
  }

  function update(deviceId, t) {
    if (!staticsBuilt) buildStatics(t);
    const r = ensureRobot(deviceId);
    const hy = terrainHeight(t.pose.x, t.pose.y);
    r.group.position.set(t.pose.x, hy, t.pose.y);
    r.group.rotation.y = -t.pose.heading;
    r.group.userData.base.material.color.set(t.estop ? 0xe5645b : (r.group.userData.baseColor ?? 0xf2f2f2));
    if (t.arm) {
      const { pivot, f1, f2 } = r.group.userData.arm;
      pivot.rotation.z = (Math.PI / 2) * (1 - t.arm.extension);
      const sep = 0.05 - 0.038 * t.arm.gripper; f1.position.z = sep; f2.position.z = -sep;
    }
    pushTrail(r, t.pose.x, hy, t.pose.y);
    r.group.userData.progress.visible = r.state === "EXECUTING";
    if (deviceId === activeDevice || activeDevice === null) updateLidar(t.pose.x, t.pose.y);
    lastT = t;
  }
  function setState(deviceId, state) { const r = robots.get(deviceId); if (r && state) r.state = state; }
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
  const clock = new THREE.Clock();
  function loop() {
    const dt = Math.min(0.05, clock.getDelta()), time = clock.elapsedTime;
    resize(); applyCamera();
    // 河流波纹
    if (riverGeo && riverBaseY) {
      const p = riverGeo.attributes.position;
      for (let i = 0; i < riverBaseY.length; i++) p.setY(i, riverBaseY[i] + Math.sin(time * 2 + i * 0.6) * 0.02);
      p.needsUpdate = true;
    }
    updateAnimals(dt, time);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  applyCamera(); loop();

  return { update, setState, setActive, setMap };
}

window.IRobotScene = { createRobotScene };
