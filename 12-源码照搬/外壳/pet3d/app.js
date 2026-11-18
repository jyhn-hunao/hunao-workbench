// 桌宠 3D 渲染（2026-11-18）
// 约定见 外壳\pet3d\说明.md：GLB 骨骼动画 + three.js + toon 渲染 + 描边，
// 四态 idle / thinking / speaking / listening 从 /pet3d/state 轮询（主进程判态，见 桌宠状态.js）。
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

window.__appRan = 'start';   // 诊断标记：模块执行入口
window.__pet3d = { get scene() { return scene; }, get renderer() { return renderer; }, get model() { return model; } };

const STAGE = document.getElementById('stage');
const HINT = document.getElementById('hint');
const BADGE = document.getElementById('badge');
const BADGE_TEXT = document.getElementById('badge-text');
const VIEW_HINT = document.getElementById('view-hint');
let cfgRender = true;   // 3D 渲染总开关（提前声明：WebGL 起不来时 fail() 也要能判断；loadSettings 覆盖为已存值）

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
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
} catch (e) {
  fail('WebGL 起不来：' + String((e && e.message) || e));
  throw e;
}
renderer.setClearColor(0x000000, 0);   // 背景透明，交给 HTML 的浅色渐变
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
STAGE.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 相机：模型高约 0.95m，原点在脚底；正面朝 +Z（模型导出口径 NEGATIVE_Z）
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 20);

// ---------- 视角控制：拖动旋转 / 滚轮缩放 / 双指捏合（2026-11-18） ----------
// 相机绕 target 转：theta 是水平角，phi 是从 +Y 起的极角；限制角度与距离，避免翻到模型底下或缩进模型里。
const VIEW_TARGET = new THREE.Vector3(0, 0.34, 0);
const VIEW_HOME = new THREE.Vector3(0, 0.16, 2.55);
const VIEW_HOME_RADIUS = VIEW_HOME.distanceTo(VIEW_TARGET);
const VIEW_HOME_PHI = Math.acos((VIEW_HOME.y - VIEW_TARGET.y) / VIEW_HOME_RADIUS);
const VIEW_HOME_THETA = Math.atan2(VIEW_HOME.x - VIEW_TARGET.x, VIEW_HOME.z - VIEW_TARGET.z);
const VIEW = {
  target: VIEW_TARGET.clone(),
  radius: VIEW_HOME_RADIUS,
  theta: VIEW_HOME_THETA,
  phi: VIEW_HOME_PHI,
  minRadius: 0.9,
  maxRadius: 4.2,
  minPhi: 0.30,
  maxPhi: 1.72,
};
function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function updateCamera() {
  // 拉远时自动抬高视线，保证相机不钻到地面以下（模型脚底 y=0）
  const phiFloor = Math.acos(clampNum((0.02 - VIEW.target.y) / VIEW.radius, -1, 1));
  VIEW.phi = clampNum(VIEW.phi, VIEW.minPhi, Math.min(VIEW.maxPhi, phiFloor));
  const sp = Math.sin(VIEW.phi);
  camera.position.set(
    VIEW.target.x + VIEW.radius * sp * Math.sin(VIEW.theta),
    VIEW.target.y + VIEW.radius * Math.cos(VIEW.phi),
    VIEW.target.z + VIEW.radius * sp * Math.cos(VIEW.theta),
  );
  camera.lookAt(VIEW.target);
}
function resetView() {
  VIEW.radius = VIEW_HOME_RADIUS;
  VIEW.theta = VIEW_HOME_THETA;
  VIEW.phi = VIEW_HOME_PHI;
  updateCamera();
}
updateCamera();

// 指针：单指/左键拖动旋转，双指捏合缩放；滚轮缩放。只在画布上生效，不挡设置浮层。
const DOM = renderer.domElement;
DOM.style.touchAction = 'none';
DOM.style.cursor = 'grab';
const pointers = new Map();
let lastPointer = null;
let pinchDist = 0;

function pointerPos(e) { return { x: e.clientX, y: e.clientY }; }
function pinchLength() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return 0;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

DOM.addEventListener('pointerdown', function (e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  pointers.set(e.pointerId, pointerPos(e));
  try { DOM.setPointerCapture(e.pointerId); } catch (_) { /* 捕获失败不挡操作 */ }
  if (pointers.size === 1) {
    lastPointer = pointerPos(e);
    DOM.style.cursor = 'grabbing';
  } else if (pointers.size === 2) {
    pinchDist = pinchLength();
    lastPointer = null;
  }
  e.preventDefault();
});

DOM.addEventListener('pointermove', function (e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, pointerPos(e));
  if (pointers.size === 1 && lastPointer) {
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = pointerPos(e);
    VIEW.theta -= dx * 0.0075;
    VIEW.phi = clampNum(VIEW.phi - dy * 0.0075, VIEW.minPhi, VIEW.maxPhi);
    updateCamera();
  } else if (pointers.size === 2) {
    const d = pinchLength();
    if (d > 0 && pinchDist > 0) {
      VIEW.radius = clampNum(VIEW.radius * (pinchDist / d), VIEW.minRadius, VIEW.maxRadius);
      updateCamera();
    }
    pinchDist = d;
  }
  e.preventDefault();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    lastPointer = null;
    pinchDist = 0;
    DOM.style.cursor = 'grab';
  } else if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    lastPointer = { x: p.x, y: p.y };
    pinchDist = 0;
  }
}
DOM.addEventListener('pointerup', endPointer);
DOM.addEventListener('pointercancel', endPointer);

DOM.addEventListener('wheel', function (e) {
  e.preventDefault();
  VIEW.radius = clampNum(VIEW.radius * Math.exp(e.deltaY * 0.0015), VIEW.minRadius, VIEW.maxRadius);
  updateCamera();
}, { passive: false });

// 灯光：半球底光 + toon 主光 + 后缘光；两套渲染风格（亮=2026-11-18 调亮 / 暗=调整前）
// 开关由页面「设置」浮层控制，localStorage 持久化（默认亮）
const hemi = new THREE.HemisphereLight(0x9db4e8, 0x3a4358, 1.35);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(-1.4, 2.6, 1.6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9db8ff, 1.0);
rim.position.set(0.6, 1.6, -2.4);
scene.add(rim);

const LIGHTING = {
  bright: { hemi: 1.35, key: 2.0, rim: 1.0 },
  dark:   { hemi: 0.9,  key: 1.15, rim: 0.7 },
};
let cfgBright = true;
function applyBright(bright) {
  cfgBright = bright;
  const L = LIGHTING[bright ? 'bright' : 'dark'];
  hemi.intensity = L.hemi;
  key.intensity = L.key;
  rim.intensity = L.rim;
  document.body.dataset.theme = bright ? 'bright' : 'dark';
}

// toon 渐变带（4 阶）：MeshToonMaterial 用；暗阶抬到 115，暗部不沉底
function makeGradientMap() {
  const data = new Uint8Array([115, 165, 215, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const GRADIENT = makeGradientMap();

// ---------- 设置：渲染开关 / 渲染风格 / 描边（localStorage 持久化，默认开） ----------
let cfgOutline = true;
let outline = null;   // 提前声明：设置面板要在模型加载前可交互
let viewHintShown = false;   // 只在第一次真正开画时提示一次，避免切回页面反复弹
let viewHintTimer = 0;
function showViewHint() {
  if (!cfgRender || viewHintShown) return;
  viewHintShown = true;
  VIEW_HINT.classList.add('on');
  if (viewHintTimer) clearTimeout(viewHintTimer);
  viewHintTimer = setTimeout(function () { VIEW_HINT.classList.remove('on'); }, 7000);
}
function loadSettings() {
  try {
    cfgRender = localStorage.getItem('pet3d_render') !== '0';
    cfgBright = localStorage.getItem('pet3d_theme') !== 'dark';
    cfgOutline = localStorage.getItem('pet3d_outline') !== '0';
  } catch (e) { /* 存储不可用：用默认 */ }
}
function saveSettings() {
  try {
    localStorage.setItem('pet3d_render', cfgRender ? '1' : '0');
    localStorage.setItem('pet3d_theme', cfgBright ? 'bright' : 'dark');
    localStorage.setItem('pet3d_outline', cfgOutline ? '1' : '0');
  } catch (e) { /* 忽略 */ }
}
loadSettings();
applyBright(cfgBright);

const BTN_SETTINGS = document.getElementById('btn-settings');
const PANEL = document.getElementById('settings-panel');
const SET_RENDER = document.getElementById('set-render');
const SET_RENDER_VAL = document.getElementById('set-render-val');
const SET_THEME = document.getElementById('set-theme');
const SET_THEME_VAL = document.getElementById('set-theme-val');
const SET_OUTLINE = document.getElementById('set-outline');
const SET_OUTLINE_VAL = document.getElementById('set-outline-val');
const OFF = document.getElementById('off');
const BTN_RENDER_ON = document.getElementById('btn-render-on');
const BTN_CLOSE = document.getElementById('btn-close');
const BTN_VIEW_RESET = document.getElementById('btn-view-reset');

function syncPanelUI() {
  SET_RENDER.checked = cfgRender;
  SET_RENDER_VAL.textContent = cfgRender ? '开' : '关';
  SET_THEME.checked = cfgBright;
  SET_THEME_VAL.textContent = cfgBright ? '开' : '关';
  SET_OUTLINE.checked = cfgOutline;
  SET_OUTLINE_VAL.textContent = cfgOutline ? '开' : '关';
  if (outline) outline.visible = cfgOutline;
}
BTN_SETTINGS.addEventListener('click', function () {
  PANEL.hidden = !PANEL.hidden;
  if (!PANEL.hidden) syncPanelUI();
});
SET_RENDER.addEventListener('change', function () { applyRender(SET_RENDER.checked); });
BTN_RENDER_ON.addEventListener('click', function () { applyRender(true); });
SET_THEME.addEventListener('change', function () {
  applyBright(SET_THEME.checked);
  syncPanelUI();
  saveSettings();
});
SET_OUTLINE.addEventListener('change', function () {
  cfgOutline = SET_OUTLINE.checked;
  syncPanelUI();
  saveSettings();
});
BTN_CLOSE.addEventListener('click', function () { PANEL.hidden = true; });
BTN_VIEW_RESET.addEventListener('click', function () { resetView(); });
syncPanelUI();   // 启动时把开关控件同步到已读配置

// ---------- 模型加载 ----------
let model = null;
let mixer = null;
let action = null;
let headBone = null;
let chestBone = null;
let loaded = false;
let failTimer = null;

function fail(msg) {
  HINT.textContent = msg || '模型加载失败';
  HINT.style.display = cfgRender ? '' : 'none';   // 渲染关着时别把错误字盖到关闭态上
}

const loader = new GLTFLoader();
window.__appRan = 'before-load';
loader.load(
  './模型/body.glb',
  function (gltf) {
    try {
    window.__appRan = 'onload';
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
      outline.visible = cfgOutline;   // 应用描边开关（模型加载完成后）
    });
    window.__appRan = 'materials-ok';
    // 动画：idle NLA clip（0~4s 无缝循环）
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      action = mixer.clipAction(gltf.animations[0]);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }
    window.__appRan = 'anim-ok';
    headBone = model.getObjectByName('BONE_head');
    chestBone = model.getObjectByName('BONE_chest');
    loaded = true;
    HINT.style.display = 'none';
    window.__appRan = 'loaded';
    // 先把身体摆到正视角（模型可能在原点偏移，微调相机目标到躯干中心）
    updateCamera();
    } catch (e) {
      window.__appRan = 'onload-error: ' + String((e && e.message) || e);
      fail('加载完处理出错：' + String((e && e.message) || e));
      throw e;
    }
  },
  undefined,
  function (e) {
    // 加载进度直接上屏：卡在哪个阶段一眼可见（诊断用，加载完就隐藏）
    const kb = Math.round((e.loaded || 0) / 1024);
    const total = Math.round((e.total || 0) / 1024);
    HINT.textContent = '加载模型 ' + kb + ' KB' + (total ? ' / ' + total + ' KB' : '');
  },
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
let pollTimer = 0;

async function pollState() {
  pollTimer = 0;
  if (!cfgRender) return;   // 渲染关着就不轮状态：页面不做任何后台活
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
  if (cfgRender) pollTimer = setTimeout(pollState, 800);
}

// ---------- 主循环（可整体开关：关掉后真停帧，不是把画面盖住） ----------
const clock = new THREE.Clock();

function lerp(a, b, t) { return a + (b - a) * t; }

let running = false;   // 当前是否在画帧
let rafId = 0;

function tick() {
  if (!running) return;
  rafId = requestAnimationFrame(tick);
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

// 真正开画：重置时钟基准（丢掉暂停期间的时间差，恢复后动画不跳帧）
function startRender() {
  if (running || !renderer) return;
  running = true;
  clock.getDelta();
  rafId = requestAnimationFrame(tick);
  if (!pollTimer) pollTimer = setTimeout(pollState, 0);
  showViewHint();   // 第一次开画时提示「拖动旋转 · 滚轮缩放」，7 秒后自己淡出
}

// 真正停画：取消下一帧、停状态轮询、清掉画布上的最后一帧
function stopRender() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
  if (renderer) renderer.clear();
}

// 关闭态：藏画布与徽标，整页留一个「开启 3D 渲染」入口（入口常驻，随时能还原）
function syncStage() {
  STAGE.style.display = cfgRender ? '' : 'none';
  BADGE.style.display = cfgRender ? '' : 'none';
  VIEW_HINT.style.display = cfgRender ? '' : 'none';
  OFF.classList.toggle('on', !cfgRender);
  if (!cfgRender) { HINT.style.display = 'none'; return; }
  HINT.style.display = loaded ? 'none' : '';
}

// 开关总入口：设置浮层里的 switch 与关闭态的大按钮都走这里
function applyRender(on) {
  cfgRender = !!on;
  saveSettings();
  syncPanelUI();
  syncStage();
  if (cfgRender) { if (!document.hidden) startRender(); }
  else stopRender();
}

// 页面被最小化 / 切走时停帧，回来按用户的选择恢复（不动开关本身）
document.addEventListener('visibilitychange', function () {
  if (document.hidden) stopRender();
  else if (cfgRender) startRender();
});

syncStage();
if (cfgRender) startRender();

// ---------- 尺寸自适应 ----------
window.addEventListener('resize', function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
