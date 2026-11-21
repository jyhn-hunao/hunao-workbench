// 桌宠 Live2D 渲染（2026-11-20）
// 约定见 外壳\petlive2d\说明.md：Cubism 模型 + PixiJS + pixi-live2d-display（cubism4），
// 四态 idle / thinking / speaking / listening 从 /petlive2d/state 轮询（主进程判态，见 桌宠状态.js）。
// ⛔ 本页不直接读磁盘：模型清单一律走 模型/当前.json，文件由主进程静态路由同源提供。

const PIXI = window.PIXI;
const LIVE2D = PIXI && PIXI.live2d;
const STAGE = document.getElementById('stage');
const HINT = document.getElementById('hint');
const HINT_TEXT = document.getElementById('hint-text');
const BTN_RETRY = document.getElementById('btn-retry');
const BADGE = document.getElementById('badge');
const BADGE_TEXT = document.getElementById('badge-text');
const MODEL_LABEL = document.getElementById('model-label');
const FALLBACK = document.getElementById('fallback');
const FB_IMG = document.getElementById('fallback-img');
const FB_SUB = document.getElementById('fb-sub');
const OFF = document.getElementById('off');
const BTN_RENDER_ON = document.getElementById('btn-render-on');
const BTN_SETTINGS = document.getElementById('btn-settings');
const PANEL = document.getElementById('settings-panel');
const SET_RENDER = document.getElementById('set-render');
const SET_RENDER_VAL = document.getElementById('set-render-val');
const SET_THEME = document.getElementById('set-theme');
const SET_THEME_VAL = document.getElementById('set-theme-val');
const MODEL_NOTE = document.getElementById('model-note');
const BTN_CLOSE = document.getElementById('btn-close');
const BTN_VIEW_RESET = document.getElementById('btn-view-reset');
const BTN_MODEL_RELOAD = document.getElementById('btn-model-reload');

const CONFIG_URL = './模型/当前.json';
const STATE_LABEL = { idle: '待机', thinking: '思考中', speaking: '说话中', listening: '听着呢' };

let cfgRender = true;
let cfgBright = true;
let cfg = null;
let model = null;
let puppet = null;
let puppetTextures = [];
let puppetGestureUntil = 0;
let loaded = false;
let curState = 'idle';
let pollTimer = 0;
let zoom = 1;
let panX = 0;
let panY = 0;
let faceTextures = null;
let faceNormal = null;
let faceKey = '';
let nextBlink = 0;
let blinkStart = -1;
let app = null;

// ---------- 渲染器 / 舞台 ----------
try {
  if (!PIXI || !LIVE2D || !LIVE2D.Live2DModel) throw new Error('Live2D 运行时没加载上（vendor 缺文件）');
  app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    resizeTo: window,
    powerPreference: 'low-power',
  });
} catch (e) {
  window.__petlive2d = { error: String((e && e.message) || e) };
  fail('WebGL / Live2D 起不来：' + String((e && e.message) || e));
  throw e;
}
STAGE.appendChild(app.view);
app.view.style.display = 'block';
app.view.style.touchAction = 'none';
app.view.style.cursor = 'grab';

const modelRoot = new PIXI.Container();
app.stage.addChild(modelRoot);

// ---------- 设置：渲染开关 / 背景（localStorage 持久化，默认开） ----------
function loadSettings() {
  try {
    cfgRender = localStorage.getItem('petlive2d_render') !== '0';
    cfgBright = localStorage.getItem('petlive2d_theme') !== 'dark';
  } catch (e) { /* 存储不可用：用默认 */ }
}
function saveSettings() {
  try {
    localStorage.setItem('petlive2d_render', cfgRender ? '1' : '0');
    localStorage.setItem('petlive2d_theme', cfgBright ? 'bright' : 'dark');
  } catch (e) { /* 忽略 */ }
}
function applyTheme(bright) {
  cfgBright = !!bright;
  document.body.dataset.theme = cfgBright ? 'bright' : 'dark';
}
loadSettings();
applyTheme(cfgBright);

function syncPanelUI() {
  SET_RENDER.checked = cfgRender;
  SET_RENDER_VAL.textContent = cfgRender ? '开' : '关';
  SET_THEME.checked = cfgBright;
  SET_THEME_VAL.textContent = cfgBright ? '开' : '关';
}
BTN_SETTINGS.addEventListener('click', function () {
  PANEL.hidden = !PANEL.hidden;
  if (!PANEL.hidden) syncPanelUI();
});
BTN_CLOSE.addEventListener('click', function () { PANEL.hidden = true; });
SET_RENDER.addEventListener('change', function () { applyRender(SET_RENDER.checked); });
SET_THEME.addEventListener('change', function () {
  applyTheme(SET_THEME.checked);
  syncPanelUI();
  saveSettings();
});
BTN_RENDER_ON.addEventListener('click', function () { applyRender(true); });
BTN_VIEW_RESET.addEventListener('click', function () { resetView(); });
BTN_MODEL_RELOAD.addEventListener('click', function () { loadModel(); });
BTN_RETRY.addEventListener('click', function () { loadModel(); });
syncPanelUI();

// ---------- 提示 / 兜底 ----------
function setHint(msg, retry) {
  HINT.hidden = false;
  HINT_TEXT.textContent = msg || '模型加载中…';
  BTN_RETRY.hidden = !retry;
}
function fail(msg) {
  setHint(msg || '加载失败', true);
}
function showFallback(reason) {
  loaded = false;
  if (!FB_IMG.getAttribute('src')) FB_IMG.src = './立绘.png';   // 只在真要兜底时才拉 1.6 MB 立绘
  FALLBACK.hidden = false;
  HINT.hidden = true;
  MODEL_LABEL.hidden = false;
  MODEL_LABEL.textContent = '立绘模式';
  FB_SUB.textContent = reason
    ? '未接入 Live2D 模型（' + reason + '）。把 Cubism 导出的模型放进 模型/正式/，再把 模型/当前.json 的 model 指向 *.model3.json。'
    : '当前显示立绘占位。把 Cubism 导出的模型放进 模型/正式/，再把 模型/当前.json 的 model 指向 *.model3.json。';
  if (cfg) MODEL_NOTE.textContent = '模型：未接入';
}
function hideFallback() {
  FALLBACK.hidden = true;
  MODEL_LABEL.hidden = true;
}

// ---------- 脸部贴图变体 / 四态 ----------
// 2026-11-21 实检：导出 moc3 里 27 个参数全是 0 keyform（7 张全画布静态 quad），
// ParamEye/Mouth/Breath 改了也不会产生形变。眨眼与口型改为切换同一图集的贴图变体：
// 只改 head 那一格的像素，其他格原样复制；模型整体呼吸/摇摆由 Pixi 容器补。
async function loadFaceTextures(c, base) {
  const specs = c && c.faceTextures;
  if (!specs) return null;
  const pairs = [['blink', 'blink'], ['talk', 'talk'], ['talk2', 'talk2'], ['blinkTalk', 'blinkTalk']]
    .filter(function (p) { return !!specs[p[1]]; });
  const loaded = await Promise.all(pairs.map(function (p) {
    const url = new URL(String(specs[p[1]]), base);
    url.searchParams.set('t', String(Date.now()));   // 换图集后避免浏览器缓存旧 1024 贴图
    return PIXI.Texture.fromURL(url.href).then(function (tex) { return [p[0], tex]; })
      .catch(function (e) {
        console.warn('[petlive2d] 脸部贴图没加载上：' + specs[p[1]], e);
        return null;
      });
  }));
  const out = {};
  loaded.forEach(function (x) { if (x) out[x[0]] = x[1]; });
  return Object.keys(out).length ? out : null;
}

function updateFace(t) {
  if (!model || !loaded || !faceTextures || !faceNormal) return;

  // 1. 眨眼：和旧实现同样的节奏，只是从改参数换成换整张图集
  if (cfg && cfg.autoBlink === true) {
    if (!nextBlink) nextBlink = t + 2 + Math.random() * 2;
    if (blinkStart < 0 && t >= nextBlink) {
      blinkStart = t;
      nextBlink = t + 2.5 + Math.random() * 3;
    }
    if (blinkStart >= 0 && (t - blinkStart) / 0.18 >= 1) blinkStart = -1;
  }
  const blinking = blinkStart >= 0;

  // 2. 说话：嘴的开合用正弦推，超过阈值换张嘴图；分两档让口型不是只开一次
  let talk = false;
  let wide = false;
  if (curState === 'speaking') {
    const mouth = 0.5 + 0.5 * Math.sin(t * 9.5);
    talk = mouth > 0.32;
    wide = mouth > 0.78;
  }

  let key = 'normal';
  if (blinking) key = talk ? 'blinkTalk' : 'blink';
  else if (talk) key = wide ? 'talk2' : 'talk';
  if (key === faceKey) return;
  const tex = key === 'normal' ? faceNormal : (faceTextures[key] || faceTextures.talk);
  if (!tex) return;
  model.textures[0] = tex;
  faceKey = key;
}

function animateModelBody(t) {
  if (!model || !loaded) return;
  const base = Number(model.__baseScale) || Number(model.scale && model.scale.x) || 1;
  // 3. 待机呼吸 / 四态摆幅：绕底部支点转一点，高度轻微呼吸
  const tilt = curState === 'thinking' ? 0.030 : curState === 'listening' ? -0.012 : 0;
  const nod = curState === 'speaking' ? 0.010 * Math.sin(t * 6.2) : 0;
  model.rotation = tilt + nod + 0.016 * Math.sin(t * 0.58);
  model.scale.y = base * (1 + 0.007 * Math.sin(t * 1.25));
}

// 在动作算完之后、网格更新之前换脸部贴图并补整体呼吸
function applyStateParams() {
  if (!model || !loaded) return;
  const t = performance.now() / 1000;
  updateFace(t);
  animateModelBody(t);
}

function applyState(state, force) {
  const s = STATE_LABEL[state] ? state : 'idle';
  const prev = curState;
  curState = s;
  BADGE.className = 'st-' + s;
  BADGE_TEXT.textContent = STATE_LABEL[s];
  if (!force && prev === s) return;
  if (!loaded || !cfg) return;
  if (!model) return;   // 分层骨骼只靠 animatePuppet 读 curState，不需要动作组
  const mg = cfg.motions && cfg.motions[s];
  const group = Array.isArray(mg) ? mg[0] : mg;
  if (group) {
    try { model.motion(group); } catch (e) { /* 动作组不存在：只靠参数叠加 */ }
  }
  const ex = cfg.expressions && cfg.expressions[s];
  if (ex) {
    try { model.expression(ex); } catch (e) { /* 表情不存在：忽略 */ }
  }
}

// ---------- 分层骨骼（不依赖 Cubism 导出） ----------
async function loadPuppet(c, base) {
  const layers = Array.isArray(c.layers) ? c.layers : [];
  if (!layers.length) throw new Error('分层模型缺少 layers');
  const cw = Number(c.canvas && c.canvas[0]) || 1254;
  const ch = Number(c.canvas && c.canvas[1]) || 1881;
  const textures = await Promise.all(layers.map(function (l) {
    const url = new URL(String(l.src), base).href;
    if (!PIXI.Texture.fromURL) throw new Error('PixiJS 版本不支持 Texture.fromURL');
    return PIXI.Texture.fromURL(url);
  }));
  const container = new PIXI.Container();
  const parts = {};
  layers.forEach(function (l, i) {
    const sp = new PIXI.Sprite(textures[i]);
    const px = Number(l.pivot && l.pivot[0]) || cw / 2;
    const py = Number(l.pivot && l.pivot[1]) || ch;
    sp.anchor.set(px / cw, py / ch);
    sp.position.set(px, py);
    // 演出层默认隐藏，避免首帧闪一下
    if (l.name === 'faceClosed' || l.name === 'mouthClosed') sp.alpha = 0;
    container.addChild(sp);
    parts[l.name] = sp;
  });
  container.canvasW = cw;
  container.canvasH = ch;
  container.parts = parts;
  puppet = container;
  puppetTextures = textures;
  modelRoot.addChild(container);
  loaded = true;
  app.ticker.add(animatePuppet);
  HINT.hidden = true;
  MODEL_LABEL.hidden = false;
  MODEL_LABEL.textContent = c.label || '分层骨骼';
  MODEL_NOTE.textContent = '模型：' + (c.label || '分层骨骼');
  window.__petlive2d = {
    config: c,
    mode: 'layered',
    setState: function (s) { applyState(s, true); },
    get state() { return curState; },
    get parts() { return puppet ? Object.keys(puppet.parts) : []; },
    blinkNow: function () { blinkStart = performance.now() / 1000; nextBlink = 0; },
  };
  layoutModel();
  applyState(curState, true);
}

function deg(v) { return v * Math.PI / 180; }

function animatePuppet() {
  if (!puppet || !puppet.parts) return;
  const t = performance.now() / 1000;
  const p = puppet.parts;
  const s = curState;
  const gesture = t < puppetGestureUntil;
  const breathe = Math.sin(t * 1.15) * 0.6;
  const armAmp = gesture ? 8 : (s === 'speaking' ? 6 : s === 'thinking' ? 4 : 1.5);
  const legAmp = gesture ? 5 : (s === 'listening' ? 1.5 : 1);

  if (p.head) {
    p.head.rotation = deg(1.2 * Math.sin(t * 0.85)
      + (s === 'thinking' ? -5 : 0)
      + (s === 'listening' ? 4 : 0)
      + (gesture ? 2.5 : 0));
  }
  // 5. 演出层跟随头部旋转：眨眼整脸层 / 闭嘴层与头同轴，避免转头时错位
  if (p.faceClosed && p.head) p.faceClosed.rotation = p.head.rotation;
  if (p.mouthClosed && p.head) p.mouthClosed.rotation = p.head.rotation;
  // 6. 眨眼：自动节奏只切“闭眼整脸层”透明度，原画默认层始终不变
  if (cfg && cfg.autoBlink === true) {
    if (!nextBlink) nextBlink = t + 2 + Math.random() * 2;
    if (blinkStart < 0 && t >= nextBlink) {
      blinkStart = t;
      nextBlink = t + 2.5 + Math.random() * 3;
    }
    if (blinkStart >= 0 && (t - blinkStart) / 0.18 >= 1) blinkStart = -1;
  }
  if (p.faceClosed) p.faceClosed.alpha = blinkStart >= 0 ? 1 : 0;
  // 7. 说话：默认张嘴，说话时用“闭嘴层”做开合，不动眼睛和头
  let mouthClosed = 0;
  if (s === 'speaking') {
    const mouth = 0.5 + 0.5 * Math.sin(t * 9.5);
    mouthClosed = mouth > 0.55 ? 1 : 0;
  }
  if (p.mouthClosed) p.mouthClosed.alpha = mouthClosed;
  if (p.body) {
    p.body.rotation = deg(0.8 * Math.sin(t * 1.05) + (s === 'speaking' ? 0.8 : 0));
    p.body.y = (p.body.__baseY || (p.body.__baseY = p.body.y)) - breathe;
  }
  if (p.tail) {
    p.tail.rotation = deg(3.2 * Math.sin(t * 1.35) + (gesture ? 5 : 0));
  }
  if (p.armL) {
    p.armL.rotation = deg(0.8 + armAmp * Math.sin(t * 3.1)
      + (s === 'thinking' ? 2 : 0) + (gesture ? 2 : 0));
  }
  if (p.armR) {
    p.armR.rotation = deg(-0.8 - armAmp * Math.sin(t * 3.1 + 0.6)
      - (s === 'thinking' ? 2 : 0) - (gesture ? 2 : 0));
  }
  if (p.legL) {
    p.legL.rotation = deg(legAmp * Math.sin(t * 2.0 + 0.4));
  }
  if (p.legR) {
    p.legR.rotation = deg(-legAmp * Math.sin(t * 2.0));
  }
}

// ---------- 模型加载 ----------
function destroyModel() {
  if (puppet) {
    try { app.ticker.remove(animatePuppet); } catch (e) { /* 忽略 */ }
    try { modelRoot.removeChild(puppet); } catch (e) { /* 忽略 */ }
    try { puppet.destroy({ children: true }); } catch (e) { /* 忽略 */ }
    puppet = null;
    puppetTextures.forEach(function (t) { try { t.destroy(true); } catch (e) { /* 忽略 */ } });
    puppetTextures = [];
  }
  loaded = false;
  if (model) {
    try { model.internalModel.off('beforeModelUpdate', applyStateParams); } catch (e) { /* 忽略 */ }
    try { if (faceNormal && model.textures) model.textures[0] = faceNormal; } catch (e) { /* 忽略 */ }
    try { modelRoot.removeChild(model); } catch (e) { /* 忽略 */ }
    try { model.destroy({ children: true, texture: true, baseTexture: true }); } catch (e) { /* 忽略 */ }
    model = null;
  }
  if (faceTextures) {
    Object.keys(faceTextures).forEach(function (k) {
      try { faceTextures[k].destroy(true); } catch (e) { /* 忽略 */ }
    });
  }
  faceTextures = null;
  faceNormal = null;
  faceKey = '';
  blinkStart = -1;
  nextBlink = 0;
  loaded = false;
}

async function loadModel() {
  setHint('模型加载中…', false);
  hideFallback();
  destroyModel();
  cfg = null;
  try {
    // 1. 读模型清单：模型/当前.json（缺失 = 还没接入模型，走立绘兜底）
    const r = await fetch(CONFIG_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('读不到 模型/当前.json（HTTP ' + r.status + '）');
    const c = await r.json();
    if (!c) throw new Error('模型/当前.json 为空');
    if (c.type !== 'layered' && !c.model) throw new Error('模型/当前.json 缺少 model 字段');
    cfg = c;
    const base = new URL(CONFIG_URL, location.href);
    app.ticker.maxFPS = Number(c.fps) > 0 ? Number(c.fps) : 30;

    // 0. 分层骨骼：七张透明 PNG 在运行时按支点旋转，不依赖 Cubism 导出
    if (c.type === 'layered') {
      await loadPuppet(c, base);
      return;
    }

    const url = new URL(String(c.model), base).href;
    window.__petlive2d = {
      config: c,
      url: url,
      setState: function (s) { applyState(s, true); },
      get state() { return curState; },
      get faceKey() { return faceKey; },
      get loaded() { return loaded; },
      get faceTextures() { return faceTextures ? Object.keys(faceTextures) : []; },
      get textureSize() {
        try { return model && model.textures && model.textures[0] ? [model.textures[0].width, model.textures[0].height] : null; }
        catch (e) { return null; }
      },
      stopPoll: function () { stopPoll(); },
      blinkNow: function () { blinkStart = performance.now() / 1000; nextBlink = 0; },
    };

    // 2. 加载 Cubism 模型（贴图/动作/物理都在 model3.json 里相对引用）
    const m = await LIVE2D.Live2DModel.from(url, { autoInteract: false, autoUpdate: true });
    model = m;
    model.anchor.set(0.5, 1);
    modelRoot.addChild(model);
    faceNormal = (m.textures && m.textures[0]) ? m.textures[0] : null;
    model.internalModel.on('beforeModelUpdate', applyStateParams);
    faceTextures = await loadFaceTextures(c, base);
    loaded = true;

    // 3. 展示与首帧
    HINT.hidden = true;
    MODEL_LABEL.hidden = false;
    MODEL_LABEL.textContent = c.label || 'Live2D 模型';
    MODEL_NOTE.textContent = '模型：' + (c.label || c.model);
    layoutModel();
    applyState(curState, true);
  } catch (e) {
    console.error('[petlive2d] 模型加载失败', e);
    showFallback(String((e && e.message) || e));
  }
}

// ---------- 布局 / 视角 ----------
function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function layoutModel() {
  if (puppet) {
    const w = app.screen.width;
    const h = app.screen.height;
    const ratio = Number(cfg && cfg.heightRatio) || 0.92;
    const base = Math.min(
      (h * ratio) / Math.max(1, puppet.canvasH),
      (w * 0.98) / Math.max(1, puppet.canvasW)
    );
    puppet.scale.set(base * zoom);
    puppet.x = w / 2 - puppet.canvasW * base * zoom / 2 + panX;
    puppet.y = h - puppet.canvasH * base * zoom + panY;
    return;
  }
  if (!model) return;
  const w = app.screen.width;
  const h = app.screen.height;
  const ratio = Number(cfg && cfg.heightRatio) || 0.92;
  // 用内部画布原始高度算缩放：model.height 会带当前 scale，拖一次缩一次会越缩越小
  const mh = Number(model.internalModel && model.internalModel.originalHeight) || model.height || 1;
  const mw = Number(model.internalModel && model.internalModel.originalWidth) || model.width || 1;
  const base = Math.min(
    (h * ratio) / Math.max(1, mh),
    (w * 0.98) / Math.max(1, mw)
  );
  model.__baseScale = base * zoom;
  model.scale.set(model.__baseScale);
  model.x = w / 2 + panX;
  model.y = h + panY;
}
function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  layoutModel();
}

// 拖动平移、滚轮缩放、单击触发动作；拖动中不做视线跟随
let dragging = false;
let last = null;
let moved = 0;
const DOM = app.view;
DOM.addEventListener('pointerdown', function (e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  dragging = true;
  last = { x: e.clientX, y: e.clientY };
  moved = 0;
  try { DOM.setPointerCapture(e.pointerId); } catch (e) { /* 捕获失败不挡操作 */ }
  DOM.style.cursor = 'grabbing';
  e.preventDefault();
});
DOM.addEventListener('pointermove', function (e) {
  if (dragging && last) {
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    moved += Math.abs(dx) + Math.abs(dy);
    panX = clampNum(panX + dx, -app.screen.width * 0.7, app.screen.width * 0.7);
    panY = clampNum(panY + dy, -app.screen.height * 0.9, app.screen.height * 0.35);
    layoutModel();
    return;
  }
  if (model) {
    try { model.focus(e.clientX, e.clientY); } catch (e) { /* 模型不支持视线：忽略 */ }
  }
});
function endPointer() {
  if (!dragging) return;
  dragging = false;
  last = null;
  DOM.style.cursor = 'grab';
  if (moved < 5) {
    if (puppet) {
      puppetGestureUntil = performance.now() / 1000 + 1.2;
    } else if (model && cfg && cfg.tapMotion) {
      try { model.motion(cfg.tapMotion); } catch (e) { /* 忽略 */ }
    }
  }
}
DOM.addEventListener('pointerup', endPointer);
DOM.addEventListener('pointercancel', endPointer);
DOM.addEventListener('wheel', function (e) {
  e.preventDefault();
  zoom = clampNum(zoom * Math.exp(-e.deltaY * 0.0012), 0.5, 2.5);
  layoutModel();
}, { passive: false });
window.addEventListener('resize', function () { layoutModel(); });

// ---------- 四态轮询（主进程 /petlive2d/state） ----------
function stopPoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
}
async function pollState() {
  pollTimer = 0;
  if (!cfgRender) return;
  try {
    const r = await fetch('/petlive2d/state', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.state) applyState(j.state, false);
  } catch (e) { /* 壳没起 / 网络抖动：保持当前态，下一轮再试 */ }
  if (cfgRender) pollTimer = setTimeout(pollState, 800);
}
function startPoll() {
  if (!pollTimer) pollTimer = setTimeout(pollState, 0);
}

// ---------- 渲染开关 ----------
function syncStage() {
  if (!cfgRender) {
    STAGE.style.display = 'none';
    BADGE.style.display = 'none';
    MODEL_LABEL.style.display = 'none';
    FALLBACK.style.display = 'none';
    OFF.classList.add('on');
    return;
  }
  STAGE.style.display = '';
  BADGE.style.display = '';
  MODEL_LABEL.style.display = '';
  FALLBACK.style.display = '';
  OFF.classList.remove('on');
}
function applyRender(on) {
  cfgRender = !!on;
  saveSettings();
  syncPanelUI();
  syncStage();
  if (cfgRender) {
    if (!document.hidden) app.ticker.start();
    startPoll();
    applyState(curState, true);
    if (!loaded && !model) loadModel();
  } else {
    stopPoll();
    app.ticker.stop();
    try { app.renderer.clear(); } catch (e) { /* 忽略 */ }
  }
}
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { stopPoll(); app.ticker.stop(); }
  else if (cfgRender) { app.ticker.start(); startPoll(); }
});

// ---------- 启动 ----------
syncStage();
if (cfgRender && !document.hidden) {
  app.ticker.start();
  startPoll();
  loadModel();
} else {
  app.ticker.stop();
}
window.__appRan = 'petlive2d';
