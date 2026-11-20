#!/usr/bin/env node
// 自动维护.mjs —— 六件后台活的「开关 / 阈值 / 上次 / 下次 / 结果」唯一读写口（2026-11-20）
//
// 为什么要有它：自动换会话、记忆整理、巡检、退出清缓存、孤儿 staging、崩溃回滚原来
//   默认开着、只能改 JSON 或看日志。用户在界面上既关不掉，也看不到「上次跑没跑、下次什么时候」。
//
// 用法：
//   node 工具\自动维护.mjs status [--json]        看全部状态（只读）
//   node 工具\自动维护.mjs set --rotate on|off --threshold 88 --turns 20 --idle 10 --cooldown 30
//   node 工具\自动维护.mjs set --tidy on|off --inspect on|off --cache on|off --staging on|off --rollback on|off
//   node 工具\自动维护.mjs set --tidy-days 7 --inspect-hours 12 --cache-mb 800
//   node 工具\自动维护.mjs run --tidy | --inspect   手动跑一次（读/写由被调脚本自己决定）
//
// 真源（两个本机 JSON，不入库）：
//   外壳\data\自动换会话.json   { enabled, threshold, minTurns, idleMin, cooldownMin }
//   外壳\data\自动维护.json     { tidy, inspect, cacheClean, stagingClean, rollback }
// 外壳启动时读它们；改完下一次 tick / 下一次定时检查生效（不用重启整壳）。
//
// ⛔ JSON 坏了：外壳按「全部关闭 + toast」处理；本脚本也拒绝把坏文件当成默认值悄悄写回去。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { port, WORKBENCH_ROOT } from './环境.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(WORKBENCH_ROOT, '外壳');
const DATA = path.join(SHELL, 'data');
const ROTATE_FILE = path.join(DATA, '自动换会话.json');
const MAINT_FILE = path.join(DATA, '自动维护.json');
const TIDY_FILE = path.join(DATA, '记忆整理.json');
const INSPECT_FILE = path.join(DATA, '巡检.json');
const CACHE_HINT_FILE = path.join(DATA, 'cache-hint.json');
const GUARD_FILE = path.join(DATA, 'start-guard.json');
const STAGING_FILE = path.join(DATA, 'staging-clean.json');
const MAINT_LOG = path.join(DATA, '自动维护.log');
const ROTATE_LOG = path.join(DATA, '换会话日志.jsonl');

const ROTATE_DEF = { enabled: true, threshold: 88, minTurns: 20, idleMin: 10, cooldownMin: 30 };
const MAINT_DEF = {
  tidy: { enabled: true, everyDays: 7 },
  inspect: { enabled: true, everyHours: 12 },
  cacheClean: { enabled: true, thresholdMb: 800 },
  stagingClean: { enabled: true },
  rollback: { enabled: true },
};

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null; };
const num = (v, d, min, max) => {
  const n = Number(v);
  return (Number.isFinite(n) && n >= min && n <= max) ? n : d;
};
const onoff = (v, d) => {
  const s = String(v || '').toLowerCase();
  if (s === 'on' || s === 'true' || s === '1' || s === '开') return true;
  if (s === 'off' || s === 'false' || s === '0' || s === 'no' || s === '关') return false;
  return d;
};
const objOn = (v, d) => {
  if (v === false) return false;
  if (v && typeof v === 'object' && v.enabled !== undefined) return onoff(v.enabled, d);
  return d;
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function readStrict(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(file + ' 解析失败：' + ((e && e.message) || e)); }
}

function jsonState(file) {
  if (!fs.existsSync(file)) return { ok: true, exists: false };
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return { ok: true, exists: true }; }
  catch (e) { return { ok: false, exists: true, error: String((e && e.message) || e) }; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readRotate(strict) {
  const raw = strict ? readStrict(ROTATE_FILE, {}) : readJson(ROTATE_FILE, {});
  return {
    enabled: objOn(raw, true),
    threshold: num(raw && raw.threshold, ROTATE_DEF.threshold, 50, 100),
    minTurns: num(raw && raw.minTurns, ROTATE_DEF.minTurns, 1, 200),
    idleMin: num(raw && raw.idleMin, ROTATE_DEF.idleMin, 1, 1440),
    cooldownMin: num(raw && raw.cooldownMin, ROTATE_DEF.cooldownMin, 1, 1440),
  };
}

function readMaint(strict) {
  const raw = strict ? readStrict(MAINT_FILE, {}) : readJson(MAINT_FILE, {});
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    tidy: {
      enabled: objOn(obj.tidy, true),
      everyDays: num(obj.tidy && obj.tidy.everyDays, MAINT_DEF.tidy.everyDays, 1, 30),
    },
    inspect: {
      enabled: objOn(obj.inspect, true),
      everyHours: num(obj.inspect && obj.inspect.everyHours, MAINT_DEF.inspect.everyHours, 1, 168),
    },
    cacheClean: {
      enabled: objOn(obj.cacheClean, true),
      thresholdMb: num(obj.cacheClean && obj.cacheClean.thresholdMb, MAINT_DEF.cacheClean.thresholdMb, 100, 10000),
    },
    stagingClean: { enabled: objOn(obj.stagingClean, true) },
    rollback: { enabled: objOn(obj.rollback, true) },
  };
}

function localText(ms) {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function isoText(s) {
  const ms = Date.parse(String(s || ''));
  return Number.isFinite(ms) ? localText(ms) : '—';
}

function lastAutoRotate() {
  try {
    const lines = fs.readFileSync(ROTATE_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-80);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (String(j.ev || '').startsWith('auto-')) {
          return { ts: j.ts || '', ev: j.ev || '', panel: j.panel || '', scene: j.scene || '' };
        }
      } catch { /* 单行坏不影响下一条 */ }
    }
  } catch { /* 没有日志 = 没触发过 */ }
  return null;
}

function lastOf(file) {
  const j = readJson(file, null);
  return j && typeof j === 'object' ? j : null;
}

// 退出后清缓存由分离进程执行，结果只落 data\自动维护.log；
// 这里把最后一条「自动清缓存」捞出来，避免状态行只能看到阈值、看不到实际删了多少。
function lastCacheRun() {
  try {
    const lines = fs.readFileSync(MAINT_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-200);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\[([^\]]+)\]\s*自动清缓存：删\s*(\d+)\s*个目录，释放约\s*([0-9.]+)\s*MB（失败\s*(\d+)）/);
      if (m) {
        return { at: m[1], deleted: Number(m[2]), mb: Number(m[3]), failed: Number(m[4]) };
      }
    }
  } catch { /* 没有日志 = 还没跑过 */ }
  return null;
}

function probe(p) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已断 */ }
      resolve(v);
    };
    const sock = net.connect({ host: '127.0.0.1', port: p });
    sock.setTimeout(800);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function serviceState() {
  const names = [['dsh', 'dsh'], ['site', 'site'], ['preview', 'preview'], ['webAi', 'webAi']];
  const out = {};
  await Promise.all(names.map(async ([key, name]) => {
    let p = 0;
    try { p = port(name); } catch { p = 0; }
    out[key] = { port: p, listening: p ? await probe(p) : false };
  }));
  return out;
}

async function snapshot() {
  const rotate = readRotate();
  const maint = readMaint();
  const rotateState = jsonState(ROTATE_FILE);
  const maintState = jsonState(MAINT_FILE);
  const tidy = lastOf(TIDY_FILE);
  const inspect = lastOf(INSPECT_FILE);
  const hint = lastOf(CACHE_HINT_FILE);
  const guard = lastOf(GUARD_FILE);
  const staging = lastOf(STAGING_FILE);
  const tidyAt = tidy && tidy.at ? Date.parse(String(tidy.at)) : 0;
  const inspectAt = inspect && inspect.at ? Date.parse(String(inspect.at)) : 0;
  const inspectFails = (inspect && Array.isArray(inspect.items) ? inspect.items : [])
    .filter((x) => x && x.ok === false)
    .map((x) => String(x.name || '')).filter(Boolean).slice(0, 8);
  if (!rotateState.ok) rotate.enabled = false;
  if (!maintState.ok) {
    maint.tidy.enabled = false; maint.inspect.enabled = false;
    maint.cacheClean.enabled = false; maint.stagingClean.enabled = false; maint.rollback.enabled = false;
  }
  return {
    at: Date.now(),
    rotate: Object.assign({}, rotate, { last: lastAutoRotate(), checkEveryMin: 5 }),
    rotateBad: rotateState.ok ? null : rotateState.error,
    maintBad: maintState.ok ? null : maintState.error,
    tidy: Object.assign({}, maint.tidy, {
      lastAt: tidyAt || null,
      nextAt: tidyAt ? tidyAt + maint.tidy.everyDays * 86400000 : null,
      last: tidy ? { at: tidy.at || '', scenes: tidy.scenes || 0, moved: tidy.moved || 0 } : null,
    }),
    inspect: Object.assign({}, maint.inspect, {
      lastAt: inspectAt || null,
      nextAt: inspectAt ? inspectAt + maint.inspect.everyHours * 3600000 : null,
      last: inspect ? { at: inspect.at || '', total: inspect.total || 0, fails: inspect.fails || 0, failNames: inspectFails } : null,
    }),
    cacheClean: Object.assign({}, maint.cacheClean, {
      recordedMb: hint && typeof hint.mb === 'number' ? hint.mb : null,
      hintAt: hint && typeof hint.at === 'number' ? hint.at : null,
      lastRun: lastCacheRun(),
    }),
    stagingClean: Object.assign({}, maint.stagingClean, {
      last: staging ? {
        at: staging.at || '',
        cleaned: Number(staging.cleaned || 0),
        failed: Number(staging.failed || 0),
        kept: staging.kept || '',
        skipped: staging.skipped || '',
      } : null,
    }),
    rollback: Object.assign({}, maint.rollback, {
      lastGuard: guard ? { clean: guard.clean, at: guard.at || null, autoRolledBack: guard.autoRolledBack || null } : null,
    }),
    services: await serviceState(),
    paths: { rotate: ROTATE_FILE, maint: MAINT_FILE },
  };
}

function human(s) {
  const yn = (b) => (b ? '开' : '关');
  if (s.rotateBad) console.log('⚠ 自动换会话.json 解析失败：' + s.rotateBad + ' ⇒ 外壳会按「关闭」处理');
  if (s.maintBad) console.log('⚠ 自动维护.json 解析失败：' + s.maintBad + ' ⇒ 外壳会按「全部关闭」处理');
  console.log('自动换会话：' + yn(s.rotate.enabled) + ' · ' + s.rotate.threshold + '% / ≥' + s.rotate.minTurns + ' 轮 / 空闲 ' + s.rotate.idleMin + ' 分 / 冷却 ' + s.rotate.cooldownMin + ' 分 · 每 ' + s.rotate.checkEveryMin + ' 分钟检查一次');
  console.log('  上次自动触发：' + (s.rotate.last ? isoText(s.rotate.last.ts) + ' · ' + s.rotate.last.ev + (s.rotate.last.scene ? ' · ' + s.rotate.last.scene : '') : '还没有'));
  console.log('自动记忆整理：' + yn(s.tidy.enabled) + ' · 每 ' + s.tidy.everyDays + ' 天 · 上次 ' + localText(s.tidy.lastAt) + ' · 下次 ' + localText(s.tidy.nextAt));
  if (s.tidy.last) console.log('  上次结果：' + s.tidy.last.scenes + ' 个场景，搬 ' + s.tidy.last.moved + ' 篇进 归档\\');
  console.log('自动巡检：' + yn(s.inspect.enabled) + ' · 每 ' + s.inspect.everyHours + ' 小时 · 上次 ' + localText(s.inspect.lastAt) + ' · 下次 ' + localText(s.inspect.nextAt));
  if (s.inspect.last) {
    console.log('  上次结果：' + s.inspect.last.total + ' 项，失败 ' + s.inspect.last.fails + ' 项');
    if (s.inspect.last.failNames && s.inspect.last.failNames.length) console.log('  失败项：' + s.inspect.last.failNames.join(' / '));
  }
  console.log('退出清缓存：' + yn(s.cacheClean.enabled) + ' · 阈值 ' + s.cacheClean.thresholdMb + ' MB · 开机记录 ' + (s.cacheClean.recordedMb == null ? '—' : s.cacheClean.recordedMb + ' MB') + (s.cacheClean.recordedMb != null && s.cacheClean.recordedMb < s.cacheClean.thresholdMb ? '（不到阈值，不清）' : ''));
  if (s.cacheClean.lastRun) {
    console.log('  最近一次：' + isoText(s.cacheClean.lastRun.at) + ' · 删 ' + s.cacheClean.lastRun.deleted + ' 个目录，释放约 ' + s.cacheClean.lastRun.mb + ' MB' + (s.cacheClean.lastRun.failed ? '（失败 ' + s.cacheClean.lastRun.failed + '）' : ''));
  } else {
    console.log('  最近一次：还没有记录（退壳后才写）');
  }
  console.log('孤儿 staging 清理：' + yn(s.stagingClean.enabled) + '（下次启动生效）');
  if (s.stagingClean.last) {
    const x = s.stagingClean.last;
    console.log('  上次清理：' + isoText(x.at) + ' · 清 ' + x.cleaned + ' 个' + (x.failed ? '（失败 ' + x.failed + '）' : '') + (x.skipped ? ' · ' + x.skipped : ''));
  } else {
    console.log('  上次清理：还没有记录（下次启动写）');
  }
  console.log('崩溃自动回滚：' + yn(s.rollback.enabled) + '（只回启动配置，不碰源码）');
  if (s.rollback.lastGuard) console.log('  上次 guard：clean=' + String(s.rollback.lastGuard.clean) + ' · ' + localText(s.rollback.lastGuard.at) + (s.rollback.lastGuard.autoRolledBack ? ' · 已自动回滚 ' + (s.rollback.lastGuard.autoRolledBack.ok ? '成功' : '失败') : '') + '（运行中 clean=false 正常，正常退出才写 true）');
  const sv = s.services;
  console.log('本地服务：dsh ' + sv.dsh.port + ' ' + (sv.dsh.listening ? '✓ 在听' : '✗ 未听') + ' / site ' + sv.site.port + ' ' + (sv.site.listening ? '✓ 在听' : '✗ 未听') + ' / preview ' + sv.preview.port + ' ' + (sv.preview.listening ? '✓ 在听' : '✗ 未听（按需启动，未听不代表坏）') + ' / webAi ' + sv.webAi.port + ' ' + (sv.webAi.listening ? '✓ 在听' : '✗ 未听'));
  console.log('真源：' + s.paths.rotate + '  /  ' + s.paths.maint);
}

function applySet() {
  let rotate, maint;
  try {
    rotate = readRotate(true);
    maint = readMaint(true);
  } catch (e) {
    console.error('✗ ' + ((e && e.message) || e) + '\n  不改坏文件；先修好 JSON 或删掉它让外壳按默认重建。');
    process.exit(1);
  }
  let changedRotate = 0;
  let changedMaint = 0;

  if (val('--rotate') != null) { rotate.enabled = onoff(val('--rotate'), rotate.enabled); changedRotate++; }
  if (val('--threshold') != null) { rotate.threshold = num(val('--threshold'), rotate.threshold, 50, 100); changedRotate++; }
  if (val('--turns') != null) { rotate.minTurns = num(val('--turns'), rotate.minTurns, 1, 200); changedRotate++; }
  if (val('--idle') != null) { rotate.idleMin = num(val('--idle'), rotate.idleMin, 1, 1440); changedRotate++; }
  if (val('--cooldown') != null) { rotate.cooldownMin = num(val('--cooldown'), rotate.cooldownMin, 1, 1440); changedRotate++; }

  const toggles = [['tidy', 'tidy'], ['inspect', 'inspect'], ['cache', 'cacheClean'], ['staging', 'stagingClean'], ['rollback', 'rollback']];
  for (const [flag, key] of toggles) {
    if (val('--' + flag) != null) { maint[key].enabled = onoff(val('--' + flag), maint[key].enabled); changedMaint++; }
  }
  if (val('--tidy-days') != null) { maint.tidy.everyDays = num(val('--tidy-days'), maint.tidy.everyDays, 1, 30); changedMaint++; }
  if (val('--inspect-hours') != null) { maint.inspect.everyHours = num(val('--inspect-hours'), maint.inspect.everyHours, 1, 168); changedMaint++; }
  if (val('--cache-mb') != null) { maint.cacheClean.thresholdMb = num(val('--cache-mb'), maint.cacheClean.thresholdMb, 100, 10000); changedMaint++; }

  if (!changedRotate && !changedMaint) { console.error('✗ 没有要改的项：至少给一个 --rotate / --tidy / --inspect / --cache / --staging / --rollback / --threshold / --turns / --idle / --cooldown / --tidy-days / --inspect-hours / --cache-mb'); process.exit(2); }
  if (changedRotate) writeJson(ROTATE_FILE, rotate);
  if (changedMaint) writeJson(MAINT_FILE, maint);
  console.log('✓ 已写入：' + (changedRotate ? ROTATE_FILE : '') + (changedRotate && changedMaint ? '  /  ' : '') + (changedMaint ? MAINT_FILE : ''));
  console.log('✓ 生效：下一次 5 分钟 tick / 下一次定时检查；staging 与回滚在下次启动生效。');
}

function runOnce() {
  let tool = '';
  if (has('--tidy')) tool = path.join(WORKBENCH_ROOT, '工具', '自动记忆整理.mjs');
  else if (has('--inspect')) tool = path.join(WORKBENCH_ROOT, '工具', '自动巡检.mjs');
  if (!tool) { console.error('✗ run 只认 --tidy / --inspect'); process.exit(2); }
  if (!fs.existsSync(tool)) { console.error('✗ 脚本不在：' + tool); process.exit(2); }
  const r = spawnSync(process.execPath, [tool], {
    cwd: WORKBENCH_ROOT, encoding: 'utf8', windowsHide: true, timeout: 540000,
    env: process.env,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) { console.error('✗ 起不来：' + r.error.message); process.exit(2); }
  process.exit(Number.isFinite(r.status) ? r.status : 1);
}

const cmd = String(argv[0] || '').toLowerCase();
if (cmd === 'run') {
  runOnce();
} else if (cmd === 'set') {
  applySet();
} else if (cmd === 'status' || !cmd || cmd === '--json') {
  snapshot().then((s) => {
    if (has('--json')) console.log(JSON.stringify(s, null, 0));
    else human(s);
  }).catch((e) => {
    console.error('✗ 状态读取失败：' + ((e && e.message) || e));
    process.exit(1);
  });
} else {
  console.error('用法：node 工具\\自动维护.mjs status [--json] | set ... | run --tidy|--inspect');
  process.exit(2);
}
