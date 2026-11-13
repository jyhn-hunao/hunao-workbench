#!/usr/bin/env node
// 人格记忆.mjs —— 「胡闹的大肥鱼」的记忆写入 / 召回 / 归档（2026-11-13）
//
// 为什么有它：人格层原先只在 AGENTS.md 写「该记的事写 记忆\ / 对话\ / _待办.md」，但没有可执行工具 ⇒
//   实际运行时记忆靠模型临时发挥，容易漏、容易重复、容易写成没索引的孤儿文件。这里给三件事一条固定路径：
//     · 记忆\<日期>-<标题>.md   长期的事（他是谁 / 偏好 / 答应过什么 / 判断错了的坑），带前置元数据，进 记忆\_索引.md
//     · 对话\<日期>-<来源>-<标题>.md  聊过什么（谁来找我、说了什么、我怎么回），进 对话\_索引.md
//     · _待办.md                答应没办的事，一行一条，同文不重复
//   隐私：这三个都在 12-源码照搬\.gitignore 里（本机不入库，与项目记忆分开）。
//
// 用法：
//   node 工具\人格记忆.mjs 写 --类 记忆 --标题 "用户偏好直接写代码交付" --要点 "不喜欢反复开浏览器验收|要求交付时就给代码"
//   node 工具\人格记忆.mjs 写 --类 对话 --来源 QQ --标题 "和他在 QQ 上聊了桌宠设置" --正文 _临时\对话草稿.md
//   node 工具\人格记忆.mjs 写 --类 待办 --标题 "把 QQ 的主动钟接到人格设置"
//   node 工具\人格记忆.mjs 读 --词 "桌宠" --条 5
//   node 工具\人格记忆.mjs 归档 --天 180 [--dry]
//   node 工具\人格记忆.mjs 体检
//
// 退出码：0 成功 / 2 参数或前置不成立 / 3 需要人确认（设置里开了「写前确认」）/ 4 写失败或自检没过
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pet = require('../外壳/桌宠设置.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(pet.DSH_HOME, '场景记忆', '胡闹的大肥鱼');
const DIR_LONG = path.join(MEM, '记忆');
const DIR_TALK = path.join(MEM, '对话');
const TODO = path.join(MEM, '_待办.md');
const IDX_LONG = path.join(DIR_LONG, '_索引.md');
const IDX_TALK = path.join(DIR_TALK, '_索引.md');
const CHECK = path.join(ROOT, '工具', '场景记忆.mjs');

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const has = (k) => argv.includes(k);
const say = (s) => console.log(s);

function today() { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function slug(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, ' ').trim().replace(/\s+/g, '-').slice(0, 40) || '未命名';
}
function ensureDirs() {
  fs.mkdirSync(DIR_LONG, { recursive: true });
  fs.mkdirSync(DIR_TALK, { recursive: true });
  if (!fs.existsSync(IDX_LONG)) fs.writeFileSync(IDX_LONG, '# 记忆索引\n\n> 一行一条：日期 · 标题 · 文件。只追加。\n\n', 'utf8');
  if (!fs.existsSync(IDX_TALK)) fs.writeFileSync(IDX_TALK, '# 对话索引\n\n> 一行一条：日期 · 来源 · 标题 · 文件。只追加。\n\n', 'utf8');
  if (!fs.existsSync(TODO)) fs.writeFileSync(TODO, '# 待办\n\n> 一行一条：`- [ ] 事情（登记日期）`。办完改成 `- [x]` 并写明结果。\n\n', 'utf8');
}
function addIndex(file, line) {
  const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (t.includes(line)) return false;
  fs.writeFileSync(file, t.replace(/\s*$/, '\n') + line + '\n', 'utf8');
  return true;
}

// 3.5 近期摘要：把「最近 10 条记忆索引 + 未办待办 5 条」压成一份 ≤2 KB 的小文件。
//     为什么有它：开场注入只带 §〇（人格卡），不读这份就等于「有记忆但想不起来」；
//     每轮读它成本很小，需要细节再用 读 --词 顺着看原文。
const RECENT = path.join(MEM, '_近期.md');
function rebuildRecent() {
  if (!fs.existsSync(IDX_LONG)) return;
  const lines = fs.readFileSync(IDX_LONG, 'utf8').split('\n').filter((x) => x.startsWith('- ')).slice(-10);
  const todo = fs.existsSync(TODO) ? fs.readFileSync(TODO, 'utf8').split('\n').filter((x) => /^- \[ \]/.test(x.trim())).slice(-5) : [];
  const talkIdx = fs.existsSync(IDX_TALK) ? fs.readFileSync(IDX_TALK, 'utf8').split('\n').filter((x) => x.startsWith('- ')).slice(-5) : [];
  const txt = [
    '# 近期记忆（工具自动生成，别手改）',
    '',
    '> 开场先读这份；要细节就 `node 12-源码照搬\\工具\\桌宠.mjs 记 读 --词 "…"` 顺着文件看原文。',
    '',
    '## 长期的事（最近 10 条）',
    lines.length ? lines.join('\n') : '（还没记）',
    '',
    '## 聊过什么（最近 5 条）',
    talkIdx.length ? talkIdx.join('\n') : '（还没记）',
    '',
    '## 答应没办',
    todo.length ? todo.join('\n') : '（没有未办）',
    ''
  ].join('\n');
  fs.writeFileSync(RECENT, txt, 'utf8');
}
function checkScene() {
  const r = spawnSync(process.execPath || 'node', [CHECK, 'check', '--场景', '胡闹的大肥鱼'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const out = String((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: r.status === 0, out };
}

// 1. 写：记忆 / 对话 / 待办
function cmdWrite() {
  const kind = String(val('--类', '记忆'));
  const title = String(val('--标题', '')).trim();
  const sys = pet.getSettings().memory || {};
  if (!title) { say('✗ 缺 --标题 "<一句话标题>"'); return 2; }
  if (kind === '待办') {
    ensureDirs();
    const line = '- [ ] ' + title + '（' + today() + '）';
    const t = fs.readFileSync(TODO, 'utf8');
    if (t.includes(title)) { say('✓ 待办里已有这条，不重复登记：' + title); return 0; }
    fs.writeFileSync(TODO, t.replace(/\s*$/, '\n') + line + '\n', 'utf8');
    rebuildRecent();
    say('✓ 已登记待办：' + title);
    return 0;
  }
  if (kind !== '记忆' && kind !== '对话') { say('✗ --类 只认 记忆 / 对话 / 待办'); return 2; }

  // 开关与确认：设置里关掉就不写；开了「写前确认」必须人点头
  const allowed = kind === '记忆' ? (sys.writeLongTerm !== false) : (sys.writeDialog !== false);
  if (!allowed) { say('✗ 设置里关掉了「' + (kind === '记忆' ? '写长期记忆' : '写对话流水') + '」⇒ 不写（要写请在人格面板 ⚙ 设置 里打开）'); return 2; }
  if (sys.confirmBeforeWrite && !has('--确认')) {
    say('⚠ 设置里开了「写之前先问我」⇒ 这条等你确认。确认后加 --确认 再跑：');
    say('  node 12-源码照搬\\工具\\人格记忆.mjs 写 --类 ' + kind + ' --标题 "' + title + '" --确认');
    return 3;
  }

  ensureDirs();
  const date = today();
  const source = String(val('--来源', '工作台')).trim();
  const dir = kind === '记忆' ? DIR_LONG : DIR_TALK;
  const name = (kind === '记忆' ? date + '-' : date + '-' + slug(source) + '-') + slug(title) + '.md';
  const file = path.join(dir, name);
  if (fs.existsSync(file)) { say('✓ 同标题已有同一天的条目，不覆盖：' + path.relative(MEM, file)); return 0; }

  let body = '';
  const src = String(val('--正文', ''));
  if (src) {
    const p = path.isAbsolute(src) ? src : path.resolve(process.cwd(), src);
    if (!fs.existsSync(p)) { say('✗ --正文 指向的文件不存在：' + p); return 2; }
    body = fs.readFileSync(p, 'utf8').trim();
  } else {
    const pts = String(val('--要点', '')).split(/[|｜]/).map((x) => x.trim()).filter(Boolean);
    if (!pts.length) { say('✗ 缺内容：给 --要点 "a|b" 或 --正文 <md路径>'); return 2; }
    body = pts.map((x) => '- ' + x).join('\n');
  }

  // 2. 落盘：前置元数据 + 正文；日期/类/来源写进 frontmatter，索引只加一行指针
  const fm = [
    '---',
    'title: ' + title,
    'date: ' + date,
    'kind: ' + (kind === '记忆' ? 'memory' : 'talk'),
    'source: ' + source,
    '---',
    '',
    '# ' + title,
    '',
    body,
    ''
  ].join('\n');
  fs.writeFileSync(file, fm, 'utf8');
  const rel = path.relative(MEM, file).replace(/\\/g, '\\');
  addIndex(kind === '记忆' ? IDX_LONG : IDX_TALK,
    '- ' + date + ' · ' + (kind === '记忆' ? title : source + ' · ' + title) + ' · `' + rel + '`');
  rebuildRecent();
  say('✓ 已写入 ' + path.relative(ROOT, file));

  // 3. 写完当场复核：场景记忆闸门（卡指纹 / 证据 / 索引）必须过
  const c = checkScene();
  (c.out ? c.out.split('\n') : []).forEach((l) => l && say('  ' + l));
  return c.ok ? 0 : 4;
}

// 4. 读：按词召回（记忆 → 对话 → 待办 → 索引），带文件与行号，便于顺着看原文
function cmdRead() {
  const q = String(val('--词', '')).trim();
  const lim = Math.max(1, Number(val('--条', 5)) || 5);
  if (!q) { say('✗ 缺 --词 "<关键词>"'); return 2; }
  ensureDirs();
  const hits = [];
  const files = [];
  [DIR_LONG, DIR_TALK].forEach((d) => fs.readdirSync(d).filter((f) => f.endsWith('.md') && !f.startsWith('_')).forEach((f) => files.push(path.join(d, f))));
  [TODO, IDX_LONG, IDX_TALK, path.join(MEM, '_场景索引.md')].forEach((f) => { if (fs.existsSync(f)) files.push(f); });
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    if (!t.includes(q)) continue;
    const line = t.split('\n').find((x) => x.includes(q)) || '';
    hits.push('- ' + path.relative(MEM, f).replace(/\\/g, '\\') + ' :: ' + line.trim().slice(0, 120));
    if (hits.length >= lim) break;
  }
  say('召回「' + q + '」' + (hits.length ? '：' : '（没找到）'));
  hits.forEach((x) => say(x));
  if (!hits.length) say('  ⇒ 要么确实没记过，要么换个词；也可以直接读 场景记忆\\胡闹的大肥鱼\\场景私有记忆.md 的 §〇');
  return 0;
}

// 5. 归档：把超过 N 天的记忆条目搬进 记忆\归档\YYYY\（对话流水不动，人工决定）
function cmdArchive() {
  const days = Number(val('--天', 180)) || 180;
  const dry = has('--dry');
  ensureDirs();
  const cut = Date.now() - days * 24 * 3600 * 1000;
  const moved = [];
  for (const f of fs.readdirSync(DIR_LONG)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const full = path.join(DIR_LONG, f);
    const st = fs.statSync(full);
    if (st.mtimeMs >= cut) continue;
    const year = String(new Date(st.mtimeMs).getFullYear());
    const dst = path.join(DIR_LONG, '归档', year, f);
    moved.push({ f, dst });
    if (dry) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(full, dst);
  }
  say((dry ? '（--dry）会归档 ' : '已归档 ') + moved.length + ' 条（>' + days + ' 天）');
  moved.slice(0, 10).forEach((m) => say('  · ' + m.f));
  if (!dry && moved.length) say('  ⚠ 索引里的指针还指向旧位置：需要保留就用相对路径 `记忆\\归档\\年\\文件`，删掉索引行也行');
  return 0;
}

// 6. 体检：目录/索引/待办在不在、有多少条、最旧/最新、有没有孤儿文件（不在索引里的）
function cmdDoctor() {
  ensureDirs();
  rebuildRecent();
  const long = fs.readdirSync(DIR_LONG).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  const talk = fs.readdirSync(DIR_TALK).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  const idxL = fs.readFileSync(IDX_LONG, 'utf8');
  const idxT = fs.readFileSync(IDX_TALK, 'utf8');
  const orphanL = long.filter((f) => !idxL.includes(f));
  const orphanT = talk.filter((f) => !idxT.includes(f));
  const todo = fs.readFileSync(TODO, 'utf8').split('\n').filter((x) => /^- \[ \]/.test(x.trim()));
  say('记忆：' + long.length + ' 条（索引缺 ' + orphanL.length + '）');
  say('对话：' + talk.length + ' 条（索引缺 ' + orphanT.length + '）');
  say('待办：' + todo.length + ' 条未办');
  orphanL.concat(orphanT).slice(0, 8).forEach((f) => say('  ⚠ 索引里没有：' + f));
  const c = checkScene();
  (c.out ? c.out.split('\n') : []).forEach((l) => l && say('  ' + l));
  return c.ok && !orphanL.length && !orphanT.length ? 0 : 4;
}

const table = { 写: cmdWrite, 读: cmdRead, 归档: cmdArchive, 体检: cmdDoctor };
if (!table[cmd]) {
  say('用法：node 工具\\人格记忆.mjs <写|读|归档|体检> [参数]');
  process.exit(2);
}
process.exit(table[cmd]());
