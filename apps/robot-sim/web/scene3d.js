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
  camera.position.set(W / 2, 9.5, H + 4.5);
  camera.lookAt(camTarget);

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

  let angle = 0;
  function loop() {
    resize();
    // 轻微环绕，突出 3D
    angle += 0.0008;
    const r = H + 4.5;
    camera.position.x = W / 2 + Math.sin(angle) * 1.2;
    camera.position.z = H / 2 + r;
    camera.lookAt(camTarget);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  return { update, setState };
}

// 供非模块脚本使用
window.IRobotScene = { createRobotScene };
