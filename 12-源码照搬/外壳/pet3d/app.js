// 桌宠 3D 渲染（2026-11-18）
// 约定见 外壳\pet3d\说明.md：GLB 骨骼动画 + three.js + toon 渲染 + 描边，
// 四态 idle / thinking / speaking / listening 从 /pet3d/state 轮询（主进程判态，见 桌宠状态.js）。
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const STAGE = document.getElementById('stage');
const HINT = document.getElementById('hint');
const BADGE = document.getElementById('badge');
const BADGE_TEXT = document.getElementById('badge-text');

const STATE_LABEL = {
  idle: '待机', thinking: '思考中', speaking: '说话中', listening: '听着呢',
};
// 各态叠加参数：timeScale + head/chest 的目标偏移（弧度）
const STATE_FX = {
  idle:      { timeScale: 1.0,  headX: 0,     headZ: 0,    chestX: 0 },
  thinking:  { timeScale: 0.55, headX: 0,     headZ: 0.09, chestX: 0 },
  speaking:  { timeScale: 1.30, headX: 0.03,  headZ: 0.13, chestX: 0 },
  listening: { timeScale: 1.0,  headX: 0,     headZ: 0,    chestX: -0.07 },
};

// ---------- 渲染器 / 场景 ----------
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
} catch (e) {
  fail('WebGL 起不来：' + String((e && e.message) || e));
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
STAGE.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 相机：模型高约 0.95m，原点在脚底；正面朝 +Z（Blender 导出口径 NEGATIVE_Z）
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 20);
camera.position.set(0, 0.16, 2.55);
camera.lookAt(0, 0.34, 0);

// 灯光：半球底光 + toon 主光 + 后缘光
scene.add(new THREE.HemisphereLight(0x8fa3d9, 0x232a38, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(-1.4, 2.6, 1.6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9db8ff, 1.1);
rim.position.set(0.6, 1.6, -2.4);
scene.add(rim);

// toon 渐变带（3 阶）：MeshToonMaterial 用
function makeGradientMap() {
  const data = new Uint8Array([95, 150, 255, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const GRADIENT = makeGradientMap();

// ---------- 模型加载 ----------
let model = null;
let mixer = null;
let action = null;
let headBone = null;
let chestBone = null;
let outline = null;
let loaded = false;
let failTimer = null;

function fail(msg) {
  HINT.textContent = msg || '模型加载失败';
  HINT.style.display = '';
}

const loader = new GLTFLoader();
loader.load(
  './模型/body.glb',
  function (gltf) {
    model = gltf.scene;
    scene.add(model);
    // 材质 → toon（拿 GLB 里 base/normal 贴图直接喂 toon 材质）
    model.traverse(function (o) {
      if (!o.isSkinnedMesh) return;
      const old = o.material;
      o.material = new THREE.MeshToonMaterial({
        color: 0xffffff,
        map: (old && old.map) || null,
        normalMap: (old && old.normalMap) || null,
        gradientMap: GRADIENT,
      });
      o.castShadow = false;
      // 描边：倒置外壳（同骨架、共享几何体，克隆后放大 + BackSide 深色）
      outline = o.clone();
      outline.material = new THREE.MeshBasicMaterial({
        color: 0x10151d, side: THREE.BackSide,
      });
      outline.scale.setScalar(1.028);
      (o.parent || model).add(outline);
    });
    // 动画：idle NLA clip（0~4s 无缝循环）
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      action = mixer.clipAction(gltf.animations[0]);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }
    headBone = model.getObjectByName('BONE_head');
    chestBone = model.getObjectByName('BONE_chest');
    loaded = true;
    HINT.style.display = 'none';
    // 先把身体摆到正视角（模型可能在原点偏移，微调相机目标到躯干中心）
    camera.lookAt(0, 0.34, 0);
  },
  undefined,
  function (err) {
    // 页面在壳没起 / GLB 没就位时加载失败：给一次自动重试，别把错误页钉死
    fail('模型没读到：' + String((err && err.message) || err));
    if (failTimer) clearTimeout(failTimer);
    failTimer = setTimeout(function () { location.reload(); }, 6000);
  },
);

// ---------- 四态轮询（主进程 /pet3d/state） ----------
let curState = 'idle';
let fx = { ...STATE_FX.idle };
let fxTarget = { ...STATE_FX.idle };

async function pollState() {
  try {
    const r = await fetch('/pet3d/state', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.state && j.state !== curState) {
      curState = j.state;
      fxTarget = { ...(STATE_FX[j.state] || STATE_FX.idle) };
      BADGE.className = 'st-' + curState;
      BADGE_TEXT.textContent = STATE_LABEL[curState] || curState;
    }
  } catch (e) { /* 壳没起 / 网络抖动：保持当前态，下一轮再试 */ }
  setTimeout(pollState, 800);
}
setTimeout(pollState, 300);

// ---------- 主循环 ----------
const clock = new THREE.Clock();
const TMP_A = new THREE.Vector3();

function lerp(a, b, t) { return a + (b - a) * t; }

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (mixer) mixer.update(dt);

  // 状态叠加参数缓动（状态切换时平滑过渡，不跳变）
  const k = Math.min(1, dt * 4);
  fx.timeScale = lerp(fx.timeScale, fxTarget.timeScale, k);
  fx.headX = lerp(fx.headX, fxTarget.headX, k);
  fx.headZ = lerp(fx.headZ, fxTarget.headZ, k);
  fx.chestX = lerp(fx.chestX, fxTarget.chestX, k);
  if (action) action.timeScale = fx.timeScale;

  // 叠加驱动：在 mixer 之后直接改骨骼节点局部旋转（下一帧 mixer 会重写，我们每帧再叠一次）
  const t = clock.elapsedTime;
  if (headBone && (Math.abs(fx.headX) > 0.001 || Math.abs(fx.headZ) > 0.001)) {
    headBone.rotation.x += fx.headX * Math.sin(t * 2.1);
    headBone.rotation.z += fx.headZ * Math.sin(t * 2.1 + 0.6);
  }
  if (chestBone && Math.abs(fx.chestX) > 0.001) {
    chestBone.rotation.x += fx.chestX * Math.sin(t * 1.6);
  }

  renderer.render(scene, camera);
}
tick();

// ---------- 尺寸自适应 ----------
window.addEventListener('resize', function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
