'use strict';
// QQ能力.js —— QQ 个人号的媒体能力层（2026-11-19）
//
// 为什么单独一层：
//   · dsh-onebot-channel 负责收发、图片、经典表情、收藏表情，但不带语音转写/语音发送；
//   · 工作台 QQ 群旁听需要把语音变成正文，否则群里发语音等于只看到「[语音]」；
//   · 千问表情包在微信侧已经有生成链路，QQ 侧复用同一套概念图和 Key，不另造人格。
//
// 这层只做「能复用、能自检」的东西：
//   · 语音转写：OneBot record → SILK/WAV → DeepSeek ASR（Key 复用微信通道配置）；
//   · 表情包：概念图 + 千问生成 → 本地图库，发送时按情绪挑图；
//   · 语音合成：Windows SAPI 生成 WAV，交给 OneBot 发送 record 段（不依赖外部 TTS 服务）。
//
// 配置落盘：外壳\data\QQ能力.json（本机配置，gitignored；不回显任何 Key）。
// 日志：外壳\data\QQ能力\通道.log

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn, spawnSync, execFile } = require('child_process');
// 情绪联动：语音概率也按当前心情收；缺失时退回原概率，不阻断发送。
let socialReply = null;
try { socialReply = require('./社交回复'); } catch (e) { /* 没有回复策略层，语音保持原行为 */ }

const SHELL = __dirname;
const ROOT = path.dirname(SHELL);
const DATA_DIR = path.join(SHELL, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'QQ能力.json');
const WORK_DIR = path.join(DATA_DIR, 'QQ能力');
const VOICE_DIR = path.join(WORK_DIR, 'voice');
const TMP_DIR = path.join(WORK_DIR, 'tmp');
const LOG_FILE = path.join(WORK_DIR, '通道.log');
const STICKER_ROOT = path.join(SHELL, 'pet3d', '表情包');
const QQ_STICKER_DIR = path.join(STICKER_ROOT, 'QQ千问');
const CONCEPT_REF = path.join(SHELL, 'pet3d', '概念', '07-气氛图.png');
const WECHAT_CONFIG = path.join(DATA_DIR, '微信通道.json');
const DEFAULT_ASR = 'https://api.deepseek.com/v1/tools/asr';
const DEFAULT_BREEZE_BASE = 'https://api.breeze.blue';
const DEFAULT_BREEZE_MODEL = 'breeze-tts-2';
const DEFAULT_BREEZE_LANGUAGE = 'zh';
const DEFAULT_BREEZE_INSTRUCTION = '用饭团的语气，自然、亲近、稍微俏皮，句尾轻快。';

const DEFAULTS = {
  enabled: true,
  voice: true,
  voiceListen: true,
  voiceReply: true,
  voiceReplyGroups: false,
  voiceReplyChance: 0,
  // 普通 @ / 私聊的直接语音：默认关，打开后才按各自概率决定；
  // 群随机接话仍走 voiceReplyGroups + voiceReplyChance，两套互不干扰。
  voiceReplyMentions: false,
  voiceReplyMentionsChance: 1,
  voiceReplyPrivate: false,
  voiceReplyPrivateChance: 1,
  stickers: true,
  stickerChance: 0.3,
  stickerMaxPerReply: 1,
  stickerDynamic: true,
  voiceMaxChars: 80,
  ttsProvider: 'sapi',
  ttsVoice: 'Microsoft Huihui Desktop',
  breezeBaseUrl: DEFAULT_BREEZE_BASE,
  breezeApiKey: '',
  breezeVoiceId: '',
  breezeVoiceName: '',
  breezeModel: DEFAULT_BREEZE_MODEL,
  breezeLanguage: DEFAULT_BREEZE_LANGUAGE,
  breezeInstructions: DEFAULT_BREEZE_INSTRUCTION,
  breezeFallback: true
};

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { fs.writeFileSync(file, text, 'utf8'); }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* 调用方报错 */ }
}

function safeLabel(value) {
  const s = String(value || '').replace(/[\\/:*?"<>|\[\]\r\n\x00-\x1f]/g, '').replace(/\s+/g, '').slice(0, 12);
  return s === '.' || s === '..' ? '' : s;
}

function normalizeConfig(raw) {
  const x = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  x.enabled = x.enabled !== false;
  x.voice = x.voice !== false;
  x.voiceListen = x.voiceListen !== false;
  x.voiceReply = x.voiceReply !== false;
  x.voiceReplyGroups = x.voiceReplyGroups === true;
  x.voiceReplyChance = clamp(x.voiceReplyChance, 0, 1);
  x.voiceReplyMentions = x.voiceReplyMentions === true;
  x.voiceReplyMentionsChance = clamp(x.voiceReplyMentionsChance, 0, 1);
  x.voiceReplyPrivate = x.voiceReplyPrivate === true;
  x.voiceReplyPrivateChance = clamp(x.voiceReplyPrivateChance, 0, 1);
  x.stickers = x.stickers !== false;
  x.stickerChance = clamp(x.stickerChance, 0, 1);
  x.stickerMaxPerReply = clamp(Math.round(Number(x.stickerMaxPerReply) || 1), 1, 2);
  x.stickerDynamic = x.stickerDynamic !== false;
  x.voiceMaxChars = clamp(Math.round(Number(x.voiceMaxChars) || 80), 10, 180);
  x.ttsVoice = String(x.ttsVoice || DEFAULTS.ttsVoice).slice(0, 120);
  x.ttsProvider = x.ttsProvider === 'breeze' ? 'breeze' : 'sapi';
  x.breezeBaseUrl = String(x.breezeBaseUrl || DEFAULT_BREEZE_BASE).trim().replace(/\/+$/, '').slice(0, 200);
  x.breezeApiKey = String(x.breezeApiKey || '').trim().slice(0, 300);
  x.breezeVoiceId = String(x.breezeVoiceId || '').trim().slice(0, 80);
  x.breezeVoiceName = String(x.breezeVoiceName || '').trim().slice(0, 80);
  x.breezeModel = String(x.breezeModel || DEFAULT_BREEZE_MODEL).trim().slice(0, 80);
  x.breezeLanguage = String(x.breezeLanguage || DEFAULT_BREEZE_LANGUAGE).trim().slice(0, 16);
  x.breezeInstructions = String(x.breezeInstructions || DEFAULT_BREEZE_INSTRUCTION).trim().slice(0, 300);
  x.breezeFallback = x.breezeFallback !== false;
  return x;
}

function nowText() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function fileMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((f) => f && f.isFile() && /\.(?:png|jpg|jpeg|gif|webp)$/i.test(f.name))
      .map((f) => path.join(dir, f.name));
  } catch (e) { return []; }
}

function createService(options) {
  const opt = options || {};
  const dshHome = String(opt.dshHome || process.env.DSH_HOME || '');
  const log = typeof opt.log === 'function' ? opt.log : function () {};
  let config = normalizeConfig(readJson(CONFIG_FILE));
  let sapiCache = { checkedAt: 0, available: false, voices: [] };
  let breezeLast = { at: 0, ok: false, provider: 'breeze', ms: 0, bytes: 0, error: '' };
  let directVoiceLast = { at: 0, ok: false, chatType: '', chatId: '', provider: '', bytes: 0, error: '' };
  const generating = new Map();

  function appendLog(line) {
    const text = '[' + nowText() + '] ' + String(line || '').slice(0, 1000);
    try { ensureDir(WORK_DIR); fs.appendFileSync(LOG_FILE, text + '\r\n', 'utf8'); } catch (e) { /* 日志不影响主流程 */ }
    try { log('[qq-media] ' + text); } catch (e) { /* 外部日志失败不影响 */ }
  }

  function readQqConfig() {
    const candidates = [
      path.join(os.homedir(), '.dsh', 'qq-bridge.config.json'),
      path.join(dshHome, 'qq-bridge.config.json')
    ];
    for (const file of candidates) {
      const j = readJson(file);
      if (j && typeof j === 'object') return j;
    }
    return {};
  }

  function readWechatConfig() {
    return readJson(WECHAT_CONFIG) || {};
  }

  // 鲸鲸 home 由微信通道配置给出；只读它的 qwen-image.json 和 config.json，不读桌面端宿主目录。
  function whaleHome() {
    const wc = readWechatConfig();
    const explicit = String(process.env.WHALE_HOME || wc.whaleHome || '').trim();
    if (explicit) return explicit;
    const fallback = path.join('D:\\', 'whale-girl');
    return fs.existsSync(fallback) ? fallback : '';
  }

  function qwenConfig() {
    const home = whaleHome();
    const candidates = [
      home ? path.join(home, 'data', 'qwen-image.json') : '',
      path.join(DATA_DIR, 'qwen-image.json')
    ].filter(Boolean);
    for (const file of candidates) {
      const j = readJson(file);
      if (j && String(j.apiKey || '').trim()) return j;
    }
    return {};
  }

  // 语音识别 Key 只复用同源配置：鲸鲸 voice.apiKey → 鲸鲸聊天 Key → 环境变量。
  // 不把微信 Key 写进 QQ 配置，也不在状态里回显。
  function asrConfig() {
    const home = whaleHome();
    const cfgFile = home ? path.join(home, 'config.json') : '';
    const cfg = cfgFile ? (readJson(cfgFile) || {}) : {};
    const voice = cfg.voice && typeof cfg.voice === 'object' ? cfg.voice : {};
    const deepseek = cfg.deepseek && typeof cfg.deepseek === 'object' ? cfg.deepseek : {};
    const baseUrl = String(voice.baseUrl || DEFAULT_ASR).trim();
    const key = String(process.env.DEEPSEEK_API_KEY || voice.apiKey || deepseek.apiKey || '').trim();
    return { baseUrl: baseUrl, key: key, provider: String(voice.provider || 'deepseek') };
  }

  function findPython() {
    const wc = readWechatConfig();
    const candidates = [
      String(wc.whalePython || '').trim(),
      path.join(whaleHome(), 'runtime', 'python', 'python.exe'),
      'python'
    ].filter(Boolean);
    for (const p of candidates) {
      if (p === 'python') return p;
      if (fs.existsSync(p)) return p;
    }
    return '';
  }

  function sapiInfo(force) {
    const now = Date.now();
    if (!force && sapiCache.checkedAt && now - sapiCache.checkedAt < 10 * 60 * 1000) return sapiCache;
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '@($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) -join "`n";',
      '$s.Dispose()'
    ].join(' ');
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 8000, windowsHide: true
      });
      const voices = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      sapiCache = { checkedAt: now, available: (r.status === 0) && voices.length > 0, voices: voices };
    } catch (e) {
      sapiCache = { checkedAt: now, available: false, voices: [] };
    }
    return sapiCache;
  }

  function stickerCategories() {
    const out = [];
    try {
      for (const ent of fs.readdirSync(STICKER_ROOT, { withFileTypes: true })) {
        if (!ent || !ent.isDirectory()) continue;
        const dir = path.join(STICKER_ROOT, ent.name);
        const count = listFiles(dir).length;
        if (count > 0) out.push({ name: ent.name, count: count, dir: dir });
      }
    } catch (e) { /* 图库不存在按空处理 */ }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  function normalizeStickerName(value) {
    return String(value || '').replace(/[\s\[\]【】「」『』]/g, '').slice(0, 20);
  }

  // 表情包解析顺序：分类名 → 文件名包含情绪 → 动态生成。
  // 只在 pet3d\表情包 下找，拒绝模型给任意路径。
  function pickSticker(label) {
    const want = normalizeStickerName(label);
    if (!want) return null;
    const cats = stickerCategories();
    const exact = cats.find((c) => normalizeStickerName(c.name) === want);
    if (exact) {
      const files = listFiles(exact.dir);
      if (files.length) return files[0];
    }
    for (const cat of cats) {
      const files = listFiles(cat.dir);
      const hit = files.find((f) => path.basename(f).includes(want));
      if (hit) return hit;
    }
    return null;
  }

  function stickerFileFor(label) {
    const file = pickSticker(label);
    return file ? { ok: true, file: file, label: normalizeStickerName(label) } : null;
  }

  function execNode(args, env, timeout) {
    return new Promise((resolve) => {
      const useElectron = !process.env.QQ_NODE_BIN && /electron/i.test(path.basename(process.execPath || ''));
      const bin = String(process.env.QQ_NODE_BIN || '').trim() || process.execPath || 'node';
      const childEnv = Object.assign({}, process.env, env || {});
      if (useElectron) childEnv.ELECTRON_RUN_AS_NODE = '1';
      execFile(bin, args, {
        cwd: ROOT, env: childEnv, timeout: timeout || 260000, maxBuffer: 8 * 1024 * 1024, windowsHide: true
      }, (error, stdout, stderr) => {
        resolve({ error: error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  async function generateSticker(label, situation) {
    const emotion = safeLabel(label);
    if (!emotion) return { ok: false, error: '表情名不能为空（2–6 个汉字最合适）' };
    if (generating.has(emotion)) return generating.get(emotion);
    const p = (async function () {
      const qwen = qwenConfig();
      const apiKey = String(qwen.apiKey || '').trim();
      if (!apiKey) return { ok: false, error: '千问 Key 未配置：先在微信通道功能页保存，QQ 复用同一份配置' };
      const tool = path.join(ROOT, '工具', '表情包生成.mjs');
      if (!fs.existsSync(tool)) return { ok: false, error: '生成工具缺失：' + tool };
      if (!fs.existsSync(CONCEPT_REF)) return { ok: false, error: '概念图缺失：' + CONCEPT_REF };
      ensureDir(QQ_STICKER_DIR);
      const fileName = '动态-' + emotion + '-' + Date.now() + '.png';
      const args = [
        tool, '--model', String(qwen.model || 'qwen-image-2.1-pro'),
        '--ref', CONCEPT_REF, '--out', QQ_STICKER_DIR,
        '--emotion', emotion, '--situation', String(situation || '').replace(/[\r\n]+/g, ' ').slice(0, 600),
        '--filename', fileName
      ];
      const env = { QWEN_API_KEY: apiKey, QWEN_IMAGE_ENDPOINT: String(qwen.baseUrl || '') };
      const run = await execNode(args, env, 260000);
      if (run.error) {
        return { ok: false, error: '千问生成失败：' + (run.stderr.trim() || run.error.message || String(run.error)) };
      }
      let generated = null;
      try { generated = JSON.parse(run.stdout.trim()); } catch (e) { /* 下面报可读错误 */ }
      const file = generated && generated.ok === true && Array.isArray(generated.files) && generated.files[0]
        ? String(generated.files[0].path || '') : '';
      if (!file || !fs.existsSync(file)) {
        return { ok: false, error: '千问生成没有返回可用图片：' + run.stdout.slice(0, 300) };
      }
      appendLog('表情生成 ' + emotion + ' → ' + path.basename(file));
      return { ok: true, file: file, label: emotion, generated: true, model: String(qwen.model || '') };
    })().finally(function () { generating.delete(emotion); });
    generating.set(emotion, p);
    return p;
  }

  async function ensureSticker(label, situation) {
    const found = stickerFileFor(label);
    if (found) return found;
    if (!config.stickerDynamic) return null;
    const made = await generateSticker(label, situation);
    return made && made.ok && made.file ? { ok: true, file: made.file, label: made.label, generated: true } : null;
  }

  function recordSegmentOf(message) {
    const segs = Array.isArray(message) ? message : (message && message.type ? [message] : []);
    return segs.find((seg) => seg && seg.type === 'record') || null;
  }

  async function callOneBot(payload, timeoutMs) {
    const qq = readQqConfig();
    const url = String(qq.onebotHttp || '').trim();
    if (!url) throw new Error('QQ 协议端地址为空（qq-bridge.config.json onebotHttp）');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(qq.token || '') },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(3000, Number(timeoutMs) || 15000))
    });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* 按原文报错 */ }
    if (!r.ok) throw new Error('OneBot HTTP ' + r.status + '：' + raw.slice(0, 120));
    if (!j || Number(j.retcode) !== 0) throw new Error('OneBot retcode ' + (j && j.retcode) + '：' + raw.slice(0, 120));
    return j;
  }

  async function downloadRecord(segment) {
    const data = (segment && segment.data) || {};
    const raw = String(data.url || data.file || data.path || '').trim();
    ensureDir(TMP_DIR);
    let ext = '.silk';
    let source = raw;
    if (source.startsWith('base64://')) {
      const body = Buffer.from(source.slice('base64://'.length), 'base64');
      const file = path.join(TMP_DIR, 'record-' + crypto.randomBytes(4).toString('hex') + ext);
      fs.writeFileSync(file, body);
      return file;
    }
    if (source.startsWith('file://')) {
      try { source = decodeURIComponent(new URL(source).pathname); } catch (e) { source = source.slice(7); }
    }
    if (/^https?:/i.test(source)) {
      const u = new URL(source);
      const pathExt = path.extname(u.pathname || '');
      if (pathExt) ext = pathExt;
      const r = await fetch(source, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('下载语音 HTTP ' + r.status);
      const body = Buffer.from(await r.arrayBuffer());
      const file = path.join(TMP_DIR, 'record-' + crypto.randomBytes(4).toString('hex') + ext);
      fs.writeFileSync(file, body);
      return file;
    }
    // SnowLuma 有时只给相对文件名；先按本机路径试，找不到再用 get_record。
    if (fs.existsSync(source)) return source;
    try {
      const result = await callOneBot({ action: 'get_record', params: { file: String(data.file || raw || ''), file_id: String(data.file_id || '') } });
      const got = String((result.data && (result.data.file || result.data.path)) || '');
      if (got && fs.existsSync(got)) return got;
      if (result.data && result.data.base64) {
        const file = path.join(TMP_DIR, 'record-' + crypto.randomBytes(4).toString('hex') + ext);
        fs.writeFileSync(file, Buffer.from(result.data.base64, 'base64'));
        return file;
      }
    } catch (e) { /* 落到下面的可读错误 */ }
    throw new Error('拿不到语音文件（OneBot 没有给 url，get_record 也没有落盘）');
  }

  function writeSilkDecoder() {
    const file = path.join(WORK_DIR, 'decode-silk.py');
    if (fs.existsSync(file)) return file;
    ensureDir(WORK_DIR);
    const code = [
      'import io, sys, wave',
      'import pysilk',
      'src, dst, rate = sys.argv[1], sys.argv[2], int(sys.argv[3] or 24000)',
      'pcm = io.BytesIO()',
      'with open(src, "rb") as f:',
      '    pysilk.decode(f, pcm, rate)',
      'with wave.open(dst, "wb") as w:',
      '    w.setnchannels(1)',
      '    w.setsampwidth(2)',
      '    w.setframerate(rate)',
      '    w.writeframes(pcm.getvalue())'
    ].join('\n');
    fs.writeFileSync(file, code + '\n', 'utf8');
    return file;
    }

  async function toWav(src) {
    const ext = path.extname(src).toLowerCase();
    if (ext === '.wav') return src;
    if (ext !== '.silk' && ext !== '.slk') throw new Error('暂不支持直接识别 ' + (ext || '未知') + ' 语音（当前支持 SILK/WAV）');
    const py = findPython();
    if (!py) throw new Error('缺少 Python 运行时，无法解 SILK');
    const decoder = writeSilkDecoder();
    const out = path.join(TMP_DIR, 'wav-' + crypto.randomBytes(4).toString('hex') + '.wav');
    const r = await new Promise((resolve) => {
      const child = spawn(py, [decoder, src, out, '24000'], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (buf) => { err += String(buf || ''); });
      child.on('error', (e) => resolve({ code: -1, err: String((e && e.message) || e) }));
      child.on('close', (code) => resolve({ code: code, err: err }));
    });
    if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 100) {
      throw new Error('SILK 解码失败：' + r.err.slice(0, 180));
    }
    return out;
  }

  async function transcribeWav(wav) {
    const asr = asrConfig();
    if (!asr.key) throw new Error('语音识别 Key 未配置（先让微信通道的语音识别可用，QQ 复用同一份）');
    if (!/api\.deepseek\.com\/v1\/tools\/asr/i.test(asr.baseUrl)) {
      throw new Error('QQ 语音转写目前只接了 DeepSeek ASR；当前地址不是 DeepSeek ASR');
    }
    const body = fs.readFileSync(wav);
    const boundary = '----qq' + crypto.randomBytes(8).toString('hex');
    const head = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="voice.wav"\r\n' +
      'Content-Type: audio/wav\r\n\r\n', 'utf8'
    );
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
    const multipart = Buffer.concat([head, body, tail]);
    const r = await fetch(asr.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + asr.key,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(multipart.length)
      },
      body: multipart,
      signal: AbortSignal.timeout(90000)
    });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* 下面报状态 */ }
    if (!r.ok) throw new Error('ASR HTTP ' + r.status + '：' + raw.slice(0, 180));
    const text = String((j && (j.text || (j.data && j.data.text))) || '').trim();
    return text;
  }

  async function transcribeMessage(message) {
    const seg = recordSegmentOf(message);
    if (!seg) return { ok: false, error: '没有语音段' };
    const temp = [];
    try {
      const src = await downloadRecord(seg);
      if (path.dirname(src).startsWith(TMP_DIR)) temp.push(src);
      const wav = await toWav(src);
      if (wav !== src && path.dirname(wav).startsWith(TMP_DIR)) temp.push(wav);
      const text = await transcribeWav(wav);
      if (!text) return { ok: false, error: '语音识别返回空文本' };
      appendLog('语音转写成功，' + text.length + ' 字');
      return { ok: true, text: text, ms: 0 };
    } catch (e) {
      const msg = String((e && e.message) || e);
      appendLog('语音转写失败：' + msg);
      return { ok: false, error: msg };
    } finally {
      for (const file of temp) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* 临时文件清理失败不影响结果 */ }
      }
    }
  }

  function writeSapiScript() {
    const file = path.join(WORK_DIR, 'speak.ps1');
    ensureDir(WORK_DIR);
    const code = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      // QQ 的 record 段通常要 SILK；先固定成 16 kHz / 16 bit / 单声道，
      // 后面的 pysilk 才能直接编码，不用再靠 ffmpeg 重采样（本机没有 ffmpeg）。
      '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
      'if ($env:QQ_TTS_VOICE) { try { $s.SelectVoice($env:QQ_TTS_VOICE) } catch {} }',
      '$text = [IO.File]::ReadAllText($env:QQ_TTS_TEXT, [Text.Encoding]::UTF8)',
      '$s.SetOutputToWaveFile($env:QQ_TTS_OUT, $fmt)',
      '$s.Speak($text)',
      '$s.Dispose()'
    ].join('\r\n');
    fs.writeFileSync(file, code + '\r\n', 'utf8');
    return file;
  }

  function writeSilkScript() {
    const file = path.join(WORK_DIR, 'to-silk.py');
    ensureDir(WORK_DIR);
    const code = [
      'import sys, wave, io, pysilk',
      'w = wave.open(sys.argv[1], "rb")',
      'rate = w.getframerate()',
      'if rate not in (8000, 12000, 16000, 24000): sys.exit("unsupported sample rate " + str(rate))',
      'if w.getsampwidth() != 2 or w.getnchannels() != 1: sys.exit("expect 16-bit mono wav")',
      'pcm = w.readframes(w.getnframes())',
      'out = io.BytesIO()',
      'pysilk.encode(io.BytesIO(pcm), out, rate, 24000, tencent=True)',
      'open(sys.argv[2], "wb").write(out.getvalue())',
      ''
    ].join('\r\n');
    fs.writeFileSync(file, code + '\r\n', 'utf8');
    return file;
  }

  // OneBot 的 record 段对 SILK 的兼容性最好；TTS 先固定 16 kHz 单声道，
  // 这里只做 pysilk 编码，不引入 ffmpeg。编码失败就退回 WAV，由协议端决定能不能发。
  async function toSilk(wavFile, silkFile) {
    const py = findPython();
    if (!py || !fs.existsSync(py)) return { ok: false, error: '没有可用的 Whale Python（无法生成 SILK）' };
    const script = writeSilkScript();
    const r = await new Promise((resolve) => {
      const child = spawn(py, [script, wavFile, silkFile], { windowsHide: true });
      let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* 已退出 */ } resolve({ code: -1, err: 'SILK 编码超时' }); }, 20000);
      child.stderr.on('data', (buf) => { err += String(buf || ''); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String((e && e.message) || e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code, err: err }); });
    });
    if (r.code !== 0 || !fs.existsSync(silkFile) || fs.statSync(silkFile).size < 100) {
      return { ok: false, error: 'SILK 编码失败：' + String(r.err || ('退出码 ' + r.code)).slice(0, 160) };
    }
    return { ok: true, file: silkFile, bytes: fs.statSync(silkFile).size };
  }

  // BreezeBlue 只做 TTS：Key 和音色都落本机 QQ能力.json，界面只回显末尾四位。
  function maskKey(value) {
    const key = String(value || '').trim();
    if (!key) return '';
    return key.length <= 4 ? '••••' : '••••' + key.slice(-4);
  }

  function breezeStatus() {
    return {
      configured: !!(config.breezeApiKey && config.breezeVoiceId),
      keyConfigured: !!config.breezeApiKey,
      keyMasked: maskKey(config.breezeApiKey),
      voiceId: config.breezeVoiceId,
      voiceName: config.breezeVoiceName,
      model: config.breezeModel,
      language: config.breezeLanguage,
      instructions: config.breezeInstructions,
      fallback: config.breezeFallback,
      baseUrl: config.breezeBaseUrl,
      last: Object.assign({}, breezeLast)
    };
  }

  // 只发一个 JSON、收一段二进制音频；不引入 SDK，避免把 Key 交给第三方包。
  function postJsonBinary(url, key, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let target;
      try { target = new URL(url); } catch (e) { reject(new Error('Breeze 地址无效')); return; }
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = https.request({
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'content-type': 'application/json',
          'content-length': payload.length
        }
      }, function (res) {
        const chunks = [];
        res.on('data', function (chunk) { chunks.push(chunk); });
        res.on('end', function () {
          resolve({ status: Number(res.statusCode) || 0, body: Buffer.concat(chunks) });
        });
      });
      req.setTimeout(timeoutMs, function () { req.destroy(new Error('Breeze 合成超时')); });
      req.on('error', reject);
      req.end(payload);
    });
  }

  function breezeErrorText(status, buf) {
    let detail = '';
    try {
      const j = JSON.parse(buf.toString('utf8'));
      detail = [j.code, j.detail].filter(Boolean).join(' · ');
    } catch (e) {
      detail = buf.toString('utf8').slice(0, 180);
    }
    return 'Breeze ' + status + (detail ? '：' + detail : '');
  }

  // 输出固定 wav_24000：24 kHz / 16-bit / 单声道，正好对上现有 pysilk 编码脚本。
  async function synthesizeBreeze(text, wavFile) {
    const started = Date.now();
    if (!config.breezeApiKey) throw new Error('Breeze API Key 未配置');
    if (!config.breezeVoiceId) throw new Error('Breeze 音色 ID 未配置');
    const body = {
      text: text,
      language_code: config.breezeLanguage,
      model_id: config.breezeModel
    };
    if (config.breezeInstructions) body.instructions = config.breezeInstructions;
    const url = config.breezeBaseUrl + '/v1/text-to-speech/' + encodeURIComponent(config.breezeVoiceId) + '?output_format=wav_24000';
    try {
      const r = await postJsonBinary(url, config.breezeApiKey, body, 45000);
      if (r.status !== 200) throw new Error(breezeErrorText(r.status, r.body));
      if (r.body.length < 100) throw new Error('Breeze 返回空音频');
      if (r.body.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('Breeze 返回的不是 WAV');
      fs.writeFileSync(wavFile, r.body);
      breezeLast = {
        at: Date.now(), ok: true, provider: 'breeze', ms: Date.now() - started,
        bytes: r.body.length, chars: text.length, error: ''
      };
      return { ok: true, bytes: r.body.length, ms: Date.now() - started };
    } catch (e) {
      const msg = String((e && e.message) || e);
      breezeLast = {
        at: Date.now(), ok: false, provider: 'breeze', ms: Date.now() - started,
        bytes: 0, chars: text.length, error: msg.slice(0, 180)
      };
      throw e;
    }
  }

  async function synthesizeVoice(text) {
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, config.voiceMaxChars);
    if (!body) return { ok: false, error: '语音正文为空' };
    if (!config.voiceReply) return { ok: false, error: '语音回复开关关闭' };
    ensureDir(VOICE_DIR);
    ensureDir(TMP_DIR);
    const id = crypto.randomBytes(5).toString('hex');
    const textFile = path.join(TMP_DIR, 'tts-' + id + '.txt');
    const wavFile = path.join(VOICE_DIR, 'tts-' + id + '.wav');
    let provider = config.ttsProvider;
    let voice = config.breezeVoiceName || config.breezeVoiceId;
    let breezeError = '';

    // 1. 先走界面选中的 provider；Breeze 失败且允许回退时才落到 SAPI。
    if (provider === 'breeze') {
      try {
        await synthesizeBreeze(body, wavFile);
      } catch (e) {
        breezeError = String((e && e.message) || e).slice(0, 180);
        appendLog('Breeze 合成失败，' + (config.breezeFallback ? '回退 SAPI' : '不发送语音') + '：' + breezeError);
        if (!config.breezeFallback) return { ok: false, error: breezeError, provider: 'breeze' };
        provider = 'sapi';
      }
    }

    // 2. SAPI 路径保持原样：16 kHz WAV，后面交给 pysilk。
    if (provider === 'sapi') {
      fs.writeFileSync(textFile, body, 'utf8');
      const ps = writeSapiScript();
      const sapi = sapiInfo(true);
      if (!sapi.available) {
        try { fs.unlinkSync(textFile); } catch (e) { /* 清理失败不影响 */ }
        return { ok: false, error: 'Windows 语音合成不可用（没有可用的 SAPI 中文语音）', provider: 'sapi' };
      }
      voice = sapi.voices.indexOf(config.ttsVoice) >= 0
        ? config.ttsVoice
        : (sapi.voices.find((v) => /Huihui|Yaoyao|Kangkang/i.test(v)) || sapi.voices[0]);
      const r = await new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps], {
          env: Object.assign({}, process.env, { QQ_TTS_TEXT: textFile, QQ_TTS_OUT: wavFile, QQ_TTS_VOICE: voice }),
          windowsHide: true
        });
        let err = '';
        const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* 已退出 */ } resolve({ code: -1, err: 'TTS 超时' }); }, 30000);
        child.stderr.on('data', (buf) => { err += String(buf || ''); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String((e && e.message) || e) }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code, err: err }); });
      });
      try { fs.unlinkSync(textFile); } catch (e) { /* 清理失败不影响 */ }
      if (r.code !== 0 || !fs.existsSync(wavFile) || fs.statSync(wavFile).size < 100) {
        return { ok: false, error: '语音合成失败：' + (r.err || ('退出码 ' + r.code)), provider: 'sapi' };
      }
    }

    const wavBytes = fs.statSync(wavFile).size;
    const silkFile = path.join(VOICE_DIR, 'tts-' + id + '.silk');
    const silk = await toSilk(wavFile, silkFile);
    appendLog('语音合成[' + provider + '] ' + body.length + ' 字 → ' + path.basename(silk.ok ? silkFile : wavFile)
      + (silk.ok ? ' · SILK' : ' · WAV（' + String(silk.error || '').slice(0, 80) + '）'));
    return {
      ok: true,
      file: silk.ok ? silkFile : wavFile,
      wav: wavFile,
      silk: !!silk.ok,
      bytes: silk.ok ? silk.bytes : wavBytes,
      voice: voice,
      provider: provider,
      breezeError: breezeError,
      silkError: silk.ok ? '' : String(silk.error || '')
    };
  }

  // 直接语音判定：只决定「这条正文发完后要不要补语音」，不碰群随机接话。
  // ctx: { chatType: 'group'|'private', chatId, text, hasAt }
  function shouldVoiceDirect(ctx) {
    if (!config.voiceReply || !ctx || !String(ctx.text || '').trim()) return false;
    let plan = null;
    try {
      plan = socialReply && typeof socialReply.moodPlanFor === 'function' ? socialReply.moodPlanFor({}) : null;
    } catch (e) { plan = null; }
    if (plan && plan.voiceAllowed === false) return false;
    const factor = plan ? Math.max(0, Number(plan.voiceFactor) || 0) : 1;
    if (ctx.chatType === 'group') {
      if (!config.voiceReplyMentions || !ctx.hasAt) return false;
      return Math.random() < Math.min(1, config.voiceReplyMentionsChance * factor);
    }
    if (ctx.chatType === 'private') {
      if (!config.voiceReplyPrivate) return false;
      return Math.random() < Math.min(1, config.voiceReplyPrivateChance * factor);
    }
    return false;
  }

  function noteDirectVoice(ok, info) {
    const p = info && typeof info === 'object' ? info : {};
    let plan = null;
    try { plan = socialReply && typeof socialReply.moodPlanFor === 'function' ? socialReply.moodPlanFor({}) : null; } catch (e) { plan = null; }
    directVoiceLast = {
      at: Date.now(),
      ok: !!ok,
      chatType: String(p.chatType || ''),
      chatId: String(p.chatId || ''),
      provider: String(p.provider || ''),
      bytes: Number(p.bytes) || 0,
      error: String(p.error || ''),
      mood: plan && plan.visible ? plan.label : '',
      voiceFactor: plan ? plan.voiceFactor : 1
    };
  }

  function status() {
    const cats = stickerCategories();
    const asr = asrConfig();
    const qwen = qwenConfig();
    const sapi = sapiInfo(false);
    const breeze = breezeStatus();
    const publicConfig = Object.assign({}, config, {
      breezeApiKey: '',
      voiceReplyChancePct: Math.round(config.voiceReplyChance * 1000) / 10,
      voiceReplyMentionsChancePct: Math.round(config.voiceReplyMentionsChance * 1000) / 10,
      voiceReplyPrivateChancePct: Math.round(config.voiceReplyPrivateChance * 1000) / 10,
      stickerChancePct: Math.round(config.stickerChance * 1000) / 10
    });
    return {
      ok: true,
      config: publicConfig,
      asr: { configured: !!asr.key, provider: asr.provider, deepseek: /api\.deepseek\.com/i.test(asr.baseUrl) },
      qwen: { configured: !!String(qwen.apiKey || '').trim(), model: String(qwen.model || '') },
      stickers: { dir: STICKER_ROOT, categories: cats, total: cats.reduce((n, c) => n + c.count, 0), qqDir: QQ_STICKER_DIR },
      tts: {
        provider: config.ttsProvider,
        available: config.ttsProvider === 'breeze' ? breeze.configured : !!sapi.available,
        voices: sapi.voices.slice(0, 20),
        selected: config.ttsVoice,
        silk: !!findPython(),
        sapi: { available: !!sapi.available, voices: sapi.voices.slice(0, 20), selected: config.ttsVoice },
        breeze: breeze
      },
      directVoice: {
        mentions: config.voiceReplyMentions,
        private: config.voiceReplyPrivate,
        mentionChancePct: Math.round(config.voiceReplyMentionsChance * 1000) / 10,
        privateChancePct: Math.round(config.voiceReplyPrivateChance * 1000) / 10,
        last: directVoiceLast
      },
      configFile: CONFIG_FILE,
      logFile: LOG_FILE
    };
  }

  function settingsGet() {
    return status();
  }

  function settingsSave(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = Object.assign({}, config);
    for (const key of ['enabled', 'voice', 'voiceListen', 'voiceReply', 'voiceReplyGroups', 'voiceReplyMentions', 'voiceReplyPrivate', 'stickers', 'stickerDynamic']) {
      if (Object.prototype.hasOwnProperty.call(p, key)) next[key] = p[key] !== false;
    }
    if (Object.prototype.hasOwnProperty.call(p, 'voiceReplyChancePct')) next.voiceReplyChance = clamp(Number(p.voiceReplyChancePct) / 100, 0, 1);
    else if (Object.prototype.hasOwnProperty.call(p, 'voiceReplyChance')) next.voiceReplyChance = clamp(Number(p.voiceReplyChance), 0, 1);
    if (Object.prototype.hasOwnProperty.call(p, 'voiceReplyMentionsChancePct')) next.voiceReplyMentionsChance = clamp(Number(p.voiceReplyMentionsChancePct) / 100, 0, 1);
    if (Object.prototype.hasOwnProperty.call(p, 'voiceReplyPrivateChancePct')) next.voiceReplyPrivateChance = clamp(Number(p.voiceReplyPrivateChancePct) / 100, 0, 1);
    if (Object.prototype.hasOwnProperty.call(p, 'stickerChancePct')) next.stickerChance = clamp(Number(p.stickerChancePct) / 100, 0, 1);
    else if (Object.prototype.hasOwnProperty.call(p, 'stickerChance')) next.stickerChance = clamp(Number(p.stickerChance), 0, 1);
    if (Object.prototype.hasOwnProperty.call(p, 'stickerMaxPerReply')) next.stickerMaxPerReply = clamp(Math.round(Number(p.stickerMaxPerReply) || 1), 1, 2);
    if (Object.prototype.hasOwnProperty.call(p, 'voiceMaxChars')) next.voiceMaxChars = clamp(Math.round(Number(p.voiceMaxChars) || 80), 10, 180);
    if (Object.prototype.hasOwnProperty.call(p, 'ttsVoice')) next.ttsVoice = String(p.ttsVoice || '').trim().slice(0, 120) || DEFAULTS.ttsVoice;
    if (Object.prototype.hasOwnProperty.call(p, 'ttsProvider')) next.ttsProvider = p.ttsProvider === 'breeze' ? 'breeze' : 'sapi';
    if (Object.prototype.hasOwnProperty.call(p, 'breezeApiKey')) {
      const key = String(p.breezeApiKey || '').trim();
      if (key) next.breezeApiKey = key.slice(0, 300);
    }
    if (p.breezeApiKeyClear === true) next.breezeApiKey = '';
    if (Object.prototype.hasOwnProperty.call(p, 'breezeVoiceId')) next.breezeVoiceId = String(p.breezeVoiceId || '').trim().slice(0, 80);
    if (Object.prototype.hasOwnProperty.call(p, 'breezeVoiceName')) next.breezeVoiceName = String(p.breezeVoiceName || '').trim().slice(0, 80);
    if (Object.prototype.hasOwnProperty.call(p, 'breezeModel')) next.breezeModel = String(p.breezeModel || '').trim().slice(0, 80) || DEFAULT_BREEZE_MODEL;
    if (Object.prototype.hasOwnProperty.call(p, 'breezeLanguage')) next.breezeLanguage = String(p.breezeLanguage || '').trim().slice(0, 16) || DEFAULT_BREEZE_LANGUAGE;
    if (Object.prototype.hasOwnProperty.call(p, 'breezeInstructions')) next.breezeInstructions = String(p.breezeInstructions || '').trim().slice(0, 300);
    if (Object.prototype.hasOwnProperty.call(p, 'breezeBaseUrl')) next.breezeBaseUrl = String(p.breezeBaseUrl || '').trim() || DEFAULT_BREEZE_BASE;
    if (Object.prototype.hasOwnProperty.call(p, 'breezeFallback')) next.breezeFallback = p.breezeFallback !== false;
    config = normalizeConfig(next);
    writeAtomic(CONFIG_FILE, config);
    return settingsGet();
  }

  function cleanupVoice() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
      ensureDir(VOICE_DIR);
      for (const ent of fs.readdirSync(VOICE_DIR, { withFileTypes: true })) {
        if (!ent || !ent.isFile()) continue;
        const file = path.join(VOICE_DIR, ent.name);
        if (fileMtime(file) && fileMtime(file) < cutoff) fs.unlinkSync(file);
      }
    } catch (e) { /* 清理失败不影响主流程 */ }
  }

  return {
    status: status,
    settingsGet: settingsGet,
    settingsSave: settingsSave,
    categories: stickerCategories,
    transcribeMessage: transcribeMessage,
    pickSticker: stickerFileFor,
    ensureSticker: ensureSticker,
    generateSticker: generateSticker,
    synthesizeVoice: synthesizeVoice,
    shouldVoiceDirect: shouldVoiceDirect,
    noteDirectVoice: noteDirectVoice,
    // 只给主进程内部用的同步接口；不经过 preload 暴露，完整 Key 不下发渲染层。
    breezeConfig: function () {
      return {
        provider: config.ttsProvider,
        apiKey: config.breezeApiKey,
        baseUrl: config.breezeBaseUrl,
        model: config.breezeModel,
        voiceId: config.breezeVoiceId,
        voiceName: config.breezeVoiceName,
        language: config.breezeLanguage,
        instructions: config.breezeInstructions
      };
    },
    cleanupVoice: cleanupVoice,
    configFile: CONFIG_FILE,
    logFile: LOG_FILE
  };
}

module.exports = { createService: createService, DEFAULTS: DEFAULTS };
