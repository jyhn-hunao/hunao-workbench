#!/usr/bin/env node
// 近期记忆.mjs —— 给**每个场景**生成 `_近期.md`（2026-11-13 新增）
//
// 为什么有它：开场注入（`外壳\scripts\sessions.mjs` 的 memSeedBlock）会拼三段
//   「本面板交接 → 场景 §〇 → 近期记忆」。但 `_近期.md` 原来只有「胡闹的大肥鱼」有，
//   生成器（工具\人格记忆.mjs）把场景路径写死成人格场景 ⇒ 其余 6 个场景的「近期记忆」段永远是空的。
//   这里补上通用生成器：从 决策\ / 坑\ / _待办.md 里按时间窗口抽最近若干条，压成一份可直接注入的摘要。
//
// 与 人格记忆.mjs 的关系：人格场景（胡闹的大肥鱼）由 人格记忆.mjs 负责（它的 _近期.md 带 记忆\ 与 对话\ 两类），
//   本工具默认**拒绝**覆盖它，避免两套生成器互相打架（确需覆盖加 --force）。
//
// 用法：
//   node 工具\近期记忆.mjs 生成 --场景 程序开发                 写 <场景记忆>\程序开发\_近期.md
//   node 工具\近期记忆.mjs 生成 --场景 程序开发 --天 14 --条 8    改窗口与条数
//   node 工具\近期记忆.mjs 生成 --all                          除人格场景外全部重算
//   node 工具\近期记忆.mjs 生成 --场景 程序开发 --dry           只打印计划，不写盘
//
// 退出码：0 成功 / 2 参数或前置不成立（场景目录不存在、要覆盖人格场景却没 --force）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');       // 12-源码照搬
const DSH_HOME = process.env.DSH_HOME || process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');
const MEM_ROOT = path.join(DSH_HOME, '场景记忆');
const PERSONA_SCENE = '胡闹的大肥鱼';                                                  // 归 人格记忆.mjs 管

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const flag = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };

const say = (m) => console.log(m);
const now = () => new Date();

// 1. 解析单个记忆文件：frontmatter 的 title / date / tags + 正文「## 要点」的前两条
function parseEntry(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  raw = raw.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^(title|date|tags)\s*:\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2].replace(/^\[|\]$/g, '').trim();
    }
  }
  const body = fm ? raw.slice(fm[0].length) : raw;
  // 2. 要点：取「## 要点」小节里的 - 开头行
  const sec = /##\s*要点\s*\n([\s\S]*?)(?=\n##\s|\Z)/.exec(body);
  let points = [];
  if (sec) {
    points = sec[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^-\s+/, '').replace(/^-\s+/, '').trim());   // 连写两层 "- - xxx" 也剥干净
  }
  // 3. 没写「## 要点」的（早期拆分条目就是一行正文 / 几条 - 列表）：优先取列表项，都剥掉符号
  if (!points.length) {
    const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('>'));
    const bullets = lines.filter((l) => /^[-*]\s+/.test(l));
    points = (bullets.length ? bullets : lines).map((l) => l.replace(/^[-*]\s+/, '').trim());
  }
  const title = (meta.title || path.basename(file, '.md')).replace(/^[0-9-]+/, '').trim() || path.basename(file, '.md');
  const dateStr = meta.date || (() => { try { return new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 10); } catch { return ''; } })();
  return { file, title, date: String(dateStr).slice(0, 10), points: points.slice(0, 2) };
}

// 4. 收一个目录下的条目（递归，跳过 归档\）
function collect(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, depth) => {
    if (depth > 3) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) {
        if (it.name === '归档') continue;
        walk(p, depth + 1);
      } else if (it.name.endsWith('.md') && !it.name.startsWith('_')) {
        const e = parseEntry(p);
        if (e) out.push(e);
      }
    }
  };
  walk(dir, 0);
  return out;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// 5. 待办：_待办.md 里 - [ ] 开头的行
function readTodo(dir) {
  const f = path.join(dir, '_待办.md');
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n')
      .filter((l) => /^\s*-\s*\[\s*\]/.test(l)).map((l) => l.replace(/^\s*-\s*\[\s*\]\s*/, '').trim());
  } catch { return []; }
}

// 6. 生成一份：窗口内按日期倒序，每类最多 N 条，再压到字节预算内
//    预算为什么重要：开场注入三段共用 4 KB（sessions.mjs 的 SEED_MEM_LIMIT），
//    近期记忆一条 90 字上下，12+6 条就能吃掉全部预算，把 §〇 和交接挤没。默认 1.6 KB。
function build(sceneDir, scene, days, max, budget) {
  const cut = now().getTime() - days * 24 * 3600 * 1000;
  const inWindow = (e) => {
    const t = Date.parse(e.date + 'T00:00:00');
    return Number.isFinite(t) ? t >= cut : true;        // 日期解析不了的当"新"，别丢
  };
  const byDateDesc = (a, b) => String(b.date).localeCompare(String(a.date));

  const decisionsAll = collect(path.join(sceneDir, '决策'));
  const pitsAll = collect(path.join(sceneDir, '坑'));
  let decisions = decisionsAll.filter(inWindow).sort(byDateDesc).slice(0, max);
  let pits = pitsAll.filter(inWindow).sort(byDateDesc).slice(0, Math.max(3, Math.round(max / 2)));
  const todos = readTodo(sceneDir).slice(0, 6);

  // 本地时间（不加 Z），别让注入里的时间戳比真实时间差 8 小时
  const pad2 = (n) => String(n).padStart(2, '0');
  const stamp = (() => {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  })();
  const head = [
    '# 近期记忆（工具自动生成，别手改）',
    '',
    '> 由 `node 12-源码照搬\\工具\\近期记忆.mjs 生成 --场景 ' + scene + '` 生成；重算整份覆盖，要改内容请改对应条目文件。',
    '> 窗口：最近 ' + days + ' 天 · 每类最多 ' + max + ' 条 · 生成于 ' + stamp,
    '',
  ];

  const decLine = (e) => '- ' + e.date + ' · ' + clip(e.title, 46) + (e.points[0] ? ' —— ' + clip(e.points[0], 64) : '');
  const pitLine = (e) => '- ' + e.date + ' · ' + clip(e.title, 46) + (e.points[0] ? ' —— ' + clip(e.points[0], 64) : '');

  // 7. 预算裁剪：头 + 底账留位，剩下的按"决策优先、坑后补、待办最后"塞满即停
  const tail = [
    '',
    '## 底账',
    '- 本场景共 ' + (decisionsAll.length + pitsAll.length) + ' 条分条记忆（决策 ' + decisionsAll.length + ' / 坑 ' + pitsAll.length + '）',
    '- 更早的看 `场景私有记忆.md`（§〇 注入用）与 `_文件索引.md`（全量索引）',
    '',
  ].join('\n');
  const fixed = Buffer.byteLength(head.join('\n') + '\n' + tail, 'utf8');
  let left = budget - fixed;
  const L = [];
  const push = (s) => { const b = Buffer.byteLength(s, 'utf8') + 1; if (b > left) return false; left -= b; L.push(s); return true; };

  let decShown = 0, pitShown = 0, todoShown = 0;
  if (decisions.length) { L.push('## 定下来的事（决策）'); left -= 4; }
  for (const e of decisions) { if (!push(decLine(e))) break; decShown++; }
  if (pits.length && left > 60) { L.push(''); L.push('## 踩过的坑'); left -= 4; }
  for (const e of pits) { if (!push(pitLine(e))) break; pitShown++; }
  if (todos.length && left > 80) { L.push(''); L.push('## 答应没办'); left -= 4; }
  for (const t of todos) { if (!push('- [ ] ' + clip(t, 80))) break; todoShown++; }
  if (!decShown && !pitShown && !todoShown) L.push('（最近 ' + days + ' 天没有新记忆；要查全部看 `场景私有记忆.md` 与 `_文件索引.md`）');
  if ((decShown < decisions.length || pitShown < pits.length) && left > 40) {
    L.push(''); push('- （窗口内还有 ' + (decisions.length - decShown) + ' 条决策 / ' + (pits.length - pitShown) + ' 条坑，受预算所限未列）');
  }

  const text = head.join('\n') + '\n' + L.join('\n') + '\n' + tail;
  return {
    text,
    counts: { decisions: decShown, pits: pitShown, todos: todoShown, total: decisionsAll.length + pitsAll.length },
  };
}

// 7. 写盘（CRLF + UTF-8 无 BOM，跟本仓其他 md 一致）
function writeText(file, text) {
  const body = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(file, body, { encoding: 'utf8' });
}

// 7.5 场景清单只认 scenarios\*.json 的 name（真源）；停用场景（如「工作台定制」）不该有 _近期.md
function sceneNames() {
  const dir = path.join(ROOT, '外壳', 'scenarios');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return String(j.name || ''); } catch { return ''; } })
      .filter(Boolean);
  } catch { return []; }
}

function doGenerate(scene) {
  const dir = path.join(MEM_ROOT, scene);
  if (!fs.existsSync(dir)) { console.error('✗ 场景记忆目录不存在：' + dir); process.exit(2); }
  if (scene === PERSONA_SCENE && !flag('--force')) {
    console.error('✗ 「' + PERSONA_SCENE + '」的 _近期.md 归 工具\\人格记忆.mjs 管（它还要拼 记忆\\ 与 对话\\）；' +
      '确需用本工具覆盖请加 --force');
    process.exit(2);
  }
  const days = Number(val('--天', '30')) || 30;
  const max = Number(val('--条', '10')) || 10;
  const budget = Number(val('--字节', '1600')) || 1600;
  const r = build(dir, scene, days, max, budget);
  const out = path.join(dir, '_近期.md');
  if (flag('--dry')) {
    say('--dry：将写入 ' + out + '（决策 ' + r.counts.decisions + ' / 坑 ' + r.counts.pits + ' / 待办 ' + r.counts.todos + '，共 ' + Buffer.byteLength(r.text, 'utf8') + ' 字节）');
    return;
  }
  writeText(out, r.text);
  say('✓ ' + scene + ' → ' + out + '（决策 ' + r.counts.decisions + ' / 坑 ' + r.counts.pits + ' / 待办 ' + r.counts.todos + '，' + Buffer.byteLength(r.text, 'utf8') + ' 字节）');
}

if (cmd === '生成') {
  if (flag('--all')) {
    let n = 0;
    for (const s of sceneNames()) {
      if (s === PERSONA_SCENE) { say('· 跳过 ' + s + '（归 人格记忆.mjs）'); continue; }
      doGenerate(s); n++;
    }
    say('共处理 ' + n + ' 个场景');
  } else {
    const scene = val('--场景', '');
    if (!scene) { console.error('用法：node 工具\\近期记忆.mjs 生成 --场景 <目录名> ｜ --all'); process.exit(2); }
    doGenerate(scene);
  }
} else {
  console.error('用法：node 工具\\近期记忆.mjs 生成 --场景 <目录名> [--天 30] [--条 12] [--dry] ｜ 生成 --all');
  process.exit(2);
}
