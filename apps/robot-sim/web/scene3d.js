import * as THREE from "three";

// 世界尺寸（米），与后端 sim 一致。three 坐标：x=worldX, z=worldY, y=up。
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

/** 组一个近似 TurtleBot 4：Create 3 圆base + 传感器塔 + 顶部激光雷达 + 前置相机。 */
function buildTurtleBot4() {
  const g = new THREE.Group();
  // Create 3 底盘
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.09, 40),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, metalness: 0.1, roughness: 0.7 }),
  );
  base.position.y = 0.055; base.castShadow = true;
  g.add(base);
  // 顶部黑环
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(0.172, 0.172, 0.012, 40),
    new THREE.MeshStandardMaterial({ color: 0x1a1d22 }),
  );
  ring.position.y = 0.106; g.add(ring);
  // 朝向标记（前方一小块）
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.02, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x4fc4d1 }),
  );
  nose.position.set(0.15, 0.11, 0); g.add(nose);
  // 传感器塔（两根立柱 + 顶板）
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3038 });
  for (const dx of [-0.09, 0.09]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 12), poleMat);
    pole.position.set(dx, 0.19, -0.02); g.add(pole);
  }
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 0.02, 40),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8 }),
  );
  plate.position.y = 0.28; g.add(plate);
  // 激光雷达（顶部黑色转筒）
  const lidar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: 0x111317 }),
  );
  lidar.position.y = 0.315; g.add(lidar);
  // OAK-D 相机（前置小盒）
  const cam = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.03, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x33373f }),
  );
  cam.position.set(0.1, 0.24, 0); g.add(cam);
  // 执行进度环（默认隐藏）
  const ringPad = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.26, 48),
    new THREE.MeshBasicMaterial({ color: 0x4fc4d1, side: THREE.DoubleSide, transparent: true }),
  );
  ringPad.rotation.x = -Math.PI / 2; ringPad.position.y = 0.005; ringPad.visible = false;
  g.add(ringPad);
  g.userData.progress = ringPad;
  return g;
}

export function createRobotScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e141d);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const camTarget = new THREE.Vector3(W / 2, 0, H / 2);
  // 轨道相机（球坐标）：鼠标拖拽转动，滚轮缩放。
  const orbit = { radius: 12, theta: 0, phi: 0.95 }; // theta 方位角，phi 仰角
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
  applyCamera();

  scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x20262e, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(6, 12, 4); dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.left = -8; dir.shadow.camera.right = 8;
  dir.shadow.camera.top = 8; dir.shadow.camera.bottom = -8;
  scene.add(dir);

  // 地面
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ color: 0x151b24, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2; floor.position.set(W / 2, 0, H / 2); floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(Math.max(W, H), Math.max(W, H), 0x2a3542, 0x1f2731);
  grid.position.set(W / 2, 0.002, H / 2); scene.add(grid);
  // 墙框
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x28323d });
  const wallH = 0.25;
  const walls = [
    [W / 2, 0, [W, 0.05]], [W / 2, H, [W, 0.05]],
    [0, H / 2, [0.05, H]], [W, H / 2, [0.05, H]],
  ];
  for (const [x, z, [sx, sz]] of walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, wallH, sz), wallMat);
    wall.position.set(x, wallH / 2, z); scene.add(wall);
  }

  const dynamic = new THREE.Group();
  scene.add(dynamic);
  const robot = buildTurtleBot4();
  scene.add(robot);

  // 激光雷达点云：从机器人向四周打射线，命中房间墙/危险区。
  const RAYS = 120;
  const lidarPos = new Float32Array(RAYS * 3);
  const lidarGeom = new THREE.BufferGeometry();
  lidarGeom.setAttribute("position", new THREE.BufferAttribute(lidarPos, 3));
  const lidar = new THREE.Points(
    lidarGeom,
    new THREE.PointsMaterial({ color: 0x6fe3c8, size: 0.07, sizeAttenuation: true, transparent: true, opacity: 0.85 }),
  );
  scene.add(lidar);
  function rayToWall(px, pz, dx, dz) {
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (W - px) / dx);
    if (dx < -1e-6) t = Math.min(t, -px / dx);
    if (dz > 1e-6) t = Math.min(t, (H - pz) / dz);
    if (dz < -1e-6) t = Math.min(t, -pz / dz);
    return t;
  }
  function rayToAABB(px, pz, dx, dz, minx, minz, maxx, maxz) {
    let tmin = -Infinity, tmax = Infinity;
    const slab = (p, d, lo, hi) => {
      if (Math.abs(d) < 1e-9) return p >= lo && p <= hi;
      let t1 = (lo - p) / d, t2 = (hi - p) / d;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      return true;
    };
    if (!slab(px, dx, minx, maxx) || !slab(pz, dz, minz, maxz)) return Infinity;
    if (tmax < Math.max(tmin, 0)) return Infinity;
    return tmin > 0 ? tmin : Infinity;
  }
  let dangerAABB = null;
  function updateLidar(px, pz) {
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      let t = rayToWall(px, pz, dx, dz);
      if (dangerAABB) t = Math.min(t, rayToAABB(px, pz, dx, dz, dangerAABB[0], dangerAABB[1], dangerAABB[2], dangerAABB[3]));
      const j = i * 3;
      lidarPos[j] = px + dx * t; lidarPos[j + 1] = 0.12; lidarPos[j + 2] = pz + dz * t;
    }
    lidarGeom.attributes.position.needsUpdate = true;
    lidarGeom.computeBoundingSphere();
  }

  let world = null;
  const built = { stations: false };

  function buildStatics(t) {
    // 充电坞
    const dock = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.02, 32),
      new THREE.MeshStandardMaterial({ color: 0x2f8a5b, emissive: 0x123a24 }),
    );
    const dp = w2v(t.dock.x, t.dock.y); dock.position.set(dp.x, 0.011, dp.z);
    dynamic.add(dock);
    const dl = makeLabel("⚡ dock", "#4cc186"); dl.position.set(dp.x, 0.5, dp.z); dynamic.add(dl);
    // 站点
    for (const [name, s] of Object.entries(t.stations)) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.4, 16),
        new THREE.MeshStandardMaterial({ color: 0x1c8a99, emissive: 0x08343a }),
      );
      const p = w2v(s.x, s.y); post.position.set(p.x, 0.2, p.z); dynamic.add(post);
      const lb = makeLabel(name, "#8fb6bd"); lb.position.set(p.x, 0.62, p.z); dynamic.add(lb);
    }
    // 危险区
    if (t.restrictedZone) {
      const rz = t.restrictedZone;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(2, 0.5, 2),
        new THREE.MeshStandardMaterial({ color: 0xe5645b, transparent: true, opacity: 0.18 }),
      );
      const p = w2v(rz.x, rz.y); box.position.set(p.x, 0.25, p.z); dynamic.add(box);
      const lb = makeLabel("⚠ " + rz.label, "#e5645b"); lb.position.set(p.x, 0.7, p.z); dynamic.add(lb);
      dangerAABB = [rz.x - 1, rz.y - 1, rz.x + 1, rz.y + 1]; // minx,minz,maxx,maxz（雷达会命中）
    }
    built.stations = true;
  }

  // 轨迹（预分配固定缓冲 + drawRange，避免每帧重建几何体的告警）
  const MAX_TRAIL = 300;
  const trailPos = new Float32Array(MAX_TRAIL * 3);
  const trailGeom = new THREE.BufferGeometry();
  trailGeom.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeom.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({ color: 0x4fc4d1, transparent: true, opacity: 0.5 });
  const trail = new THREE.Line(trailGeom, trailMat);
  scene.add(trail);
  let trailCount = 0;
  let lastTrail = null;
  function pushTrail(v) {
    if (lastTrail && lastTrail.distanceTo(v) <= 0.05) return;
    lastTrail = v.clone();
    if (trailCount >= MAX_TRAIL) {
      trailPos.copyWithin(0, 3); // 左移一个点
      trailCount = MAX_TRAIL - 1;
    }
    const i = trailCount * 3;
    trailPos[i] = v.x; trailPos[i + 1] = 0.02; trailPos[i + 2] = v.z;
    trailCount++;
    trailGeom.setDrawRange(0, trailCount);
    trailGeom.attributes.position.needsUpdate = true;
    trailGeom.computeBoundingSphere();
  }

  let progress = 0, executing = false;

  function update(t) {
    world = t;
    if (!built.stations) buildStatics(t);
    const p = w2v(t.pose.x, t.pose.y);
    robot.position.set(p.x, 0, p.z);
    // 后端 heading：绕世界 x（atan2(dy,dx)）；three 里绕 y 轴，z=worldY 需取负。
    robot.rotation.y = -t.pose.heading;
    pushTrail(p);
    updateLidar(p.x, p.z);
    const ring = robot.userData.progress;
    ring.visible = executing;
    if (executing) {
      ring.scale.setScalar(0.9 + 0.1 * Math.sin(performance.now() / 200));
    }
  }

  function setState(state, prog) {
    executing = state === "EXECUTING";
    if (typeof prog === "number") progress = prog;
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix();
    }
  }

  function loop() {
    resize();
    applyCamera();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  return { update, setState };
}

// 供非模块脚本使用
window.IRobotScene = { createRobotScene };
