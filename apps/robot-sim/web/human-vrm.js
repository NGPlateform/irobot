// VRM 3D 数字人引擎（@pixiv/three-vrm）。作为控制台的第 5 种显示模式。
// 加载内置 VRM（/models/avatar.vrm），表情由机器人状态驱动、口型随说话开合、自动眨眼/注视/待机。
// 暴露 avatar 式接口，接到 robot3d.js 既有的 speaking/thinking/listening 驱动上。经 esbuild 打成 iife。
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const EMOTIONS = ["happy", "angry", "sad", "relaxed", "surprised", "neutral"];
const RING = { happy: "#4cc186", angry: "#e5645b", sad: "#eea94e", relaxed: "#4fc4d1", surprised: "#8fa0ff", neutral: "#4fc4d1" };

/** 状态 → VRM 情绪/文案/注视（与 digital-human 同一套优先级语义）。 */
function computeEmotion(s) {
  s = s || {};
  if (s.estop) return { expr: "angry", label: "急停", look: "center" };
  if (s.flash === "sad") return { expr: "sad", label: "出错了", look: "down" };
  if (s.flash === "happy") return { expr: "happy", label: "完成", look: "center" };
  if (s.thinking) return { expr: "neutral", label: "思考中", look: "up" };
  if (s.speaking) return { expr: "neutral", label: "说话中", look: "center" };
  if (s.listening) return { expr: "happy", label: "聆听中", look: "center" };
  if (s.state === "EXECUTING") return { expr: "relaxed", label: "执行中", look: "center" };
  if (typeof s.battery === "number" && s.battery < 15) return { expr: "sad", label: "电量低", look: "center" };
  return { expr: "neutral", label: "待命", look: "center" };
}

function createHuman(container) {
  container.style.position = "relative";

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  camera.position.set(0, 1.32, 0.95);

  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(0.5, 2, 2);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x4fc4d1, 0.5);
  rim.position.set(-1, 1, -1.5);
  scene.add(rim);

  // 状态文案叠层
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:absolute;left:0;right:0;bottom:12px;text-align:center;font:600 15px system-ui;" +
    "color:#4fc4d1;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.6)";
  badge.textContent = "加载数字人…";
  container.appendChild(badge);

  // 可变状态（与 digital-human 一致）
  const st = { estop: false, battery: 100, state: "IDLE", listening: false, thinking: false, speaking: false, flash: null };
  let flashUntil = 0, mouthOpen = 0, blinkGaze = 0;
  const clock = new THREE.Clock();
  let vrm = null, raf = 0, headBone = null, targetY = 1.3;

  function now() { return (typeof performance !== "undefined" ? performance.now() : 0); }
  function setFlash(k) { st.flash = k; flashUntil = now() + 1200; }
  function currentFlags(t) {
    return {
      estop: st.estop, battery: st.battery, state: st.state,
      listening: st.listening, thinking: st.thinking, speaking: st.speaking,
      flash: t < flashUntil ? st.flash : null,
    };
  }

  function resize() {
    const w = container.clientWidth || 480, h = container.clientHeight || 420;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.load(
    "/models/avatar.vrm",
    (gltf) => {
      vrm = gltf.userData.vrm;
      try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch {}
      try { VRMUtils.combineSkeletons(gltf.scene); } catch {}
      vrm.scene.traverse((o) => { o.frustumCulled = false; });
      scene.add(vrm.scene);
      // 把默认 T-pose 手臂放到自然下垂，任意画幅都是干净的人物肖像。
      const hb = vrm.humanoid;
      if (hb) {
        const lu = hb.getNormalizedBoneNode("leftUpperArm");
        const ru = hb.getNormalizedBoneNode("rightUpperArm");
        if (lu) lu.rotation.z = -1.2;
        if (ru) ru.rotation.z = 1.2;
        const ll = hb.getNormalizedBoneNode("leftLowerArm");
        const rl = hb.getNormalizedBoneNode("rightLowerArm");
        if (ll) ll.rotation.z = -0.2;
        if (rl) rl.rotation.z = 0.2;
      }
      // 取头骨用于构图与待机微动
      headBone = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode("head");
      if (headBone) {
        const p = new THREE.Vector3();
        headBone.getWorldPosition(p);
        targetY = p.y;
      }
      // 头肩特写：拉近相机、留头顶余量，裁掉默认 T-pose 手臂，突出"数字人"面部。
      camera.position.set(0, targetY + 0.04, 0.62);
      camera.lookAt(0, targetY - 0.02, 0);
      resize();
      badge.textContent = "待命";
    },
    undefined,
    (err) => {
      badge.style.color = "#e5645b";
      badge.textContent = "数字人模型加载失败";
      console.error("VRM load error", err);
    },
  );

  function frame() {
    const dt = clock.getDelta();
    const t = now();
    if (vrm) {
      const flags = currentFlags(t);
      const emo = computeEmotion(flags);
      const em = vrm.expressionManager;
      if (em) {
        for (const n of EMOTIONS) em.setValue(n, n === emo.expr ? 0.7 : 0);
        // 口型：说话时开合
        const target = flags.speaking ? (0.25 + 0.6 * Math.abs(Math.sin(t / 95) + 0.3 * Math.sin(t / 47))) : 0;
        mouthOpen += (Math.min(1, target) - mouthOpen) * 0.35;
        em.setValue("aa", mouthOpen);
        // 眨眼
        em.setValue("blink", (t % 3600) < 120 ? 1 : 0);
        // 注视
        em.setValue("lookUp", emo.look === "up" ? 0.5 : 0);
        em.setValue("lookDown", emo.look === "down" ? 0.4 : 0);
      }
      // 待机头部微动（呼吸/看向）
      if (headBone) {
        headBone.rotation.y = Math.sin(t / 2200) * 0.05;
        headBone.rotation.x = (emo.look === "up" ? -0.12 : emo.look === "down" ? 0.1 : 0) + Math.sin(t / 1800) * 0.02;
      }
      vrm.update(dt);
      if (badge.textContent !== emo.label) badge.textContent = emo.label;
      badge.style.color = RING[emo.expr] || "#4fc4d1";
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  window.addEventListener("resize", resize);
  resize();

  return {
    update(telemetry, state) {
      if (telemetry) {
        st.estop = !!telemetry.estop;
        st.battery = telemetry.battery;
      }
      if (state) {
        st.state = state;
        if (state === "SUCCEEDED") setFlash("happy");
        else if (state === "FAILED" || state === "REJECTED" || state === "EXPIRED") setFlash("sad");
      }
    },
    setListening(b) { st.listening = !!b; },
    setThinking(b) { st.thinking = !!b; },
    startSpeaking() { st.speaking = true; },
    stopSpeaking() { st.speaking = false; },
    setActive() { /* 单一数字人始终代表活动设备，无需切换 */ },
    resize,
    destroy() { if (raf) cancelAnimationFrame(raf); },
  };
}

window.IRobotHuman = { createHuman, computeEmotion };
