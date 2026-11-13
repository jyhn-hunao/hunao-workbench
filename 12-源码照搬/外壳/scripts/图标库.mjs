#!/usr/bin/env node
/**
 * 图标库.mjs —— 把 Lucide 线图标抓成本地静态 SVG，供工作台「场景标签」直接引用。
 *
 *   node scripts\图标库.mjs            # 抓取/补齐（已存在且版本标记对得上的跳过，可反复跑）
 *   node scripts\图标库.mjs --force    # 全部重抓
 *   node scripts\图标库.mjs --check    # 只核对，不联网：缺文件 / 版本标记过期 / 有野文件 ⇒ 退出码 1
 *
 * 为什么要图标库：场景越加越多，原来每个图标都是一段手写 SVG，而且得在 renderer.js 的 ICONS
 * 和 renderers.js 的 SCENARIO_ICONS 里各写一份；没登记的场次一律退回同一个 🧩
 * ⇒ 「胡闹的大肥鱼」和「社交」就这么顶上了同一枚图标。现在改成：
 *   ① 常规场景图标从 Lucide 图标库取（本脚本落地到 renderer\assets\icons\*.svg）；
 *   ② 场景 id → 图标名 只在 renderer\scene-icons.js 一张表里登记（单处权威）；
 *   ③ 手绘 SVG / 官方 logo 仍优先（renderers.js 的 SCENARIO_ICONS 那一份不动）。
 *
 * 许可：Lucide 是 ISC，可商用可再分发；每个落地文件头都留了来源与版本标记。
 * 依赖：只用 Node 内置模块（fetch 是 Node 18+ 自带），不引 npm 依赖（见本仓 AGENTS.md §4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'renderer', 'assets', 'icons');
const LIB = 'lucide-static';
const VER = '1.72.0';
const CDN = 'https://cdn.jsdelivr.net/npm/' + LIB + '@' + VER + '/icons/';
const MARK = '<!-- ' + LIB + ' ' + VER + ' · ISC 许可 · 由 scripts\\图标库.mjs 生成，勿手改 -->';

// 图标统一规格：24 的坐标系（Lucide 原样），显示 17×17，描边用工作台图标主色 #8fb4ff
const ROOT_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" '
  + 'fill="none" stroke="#8fb4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

// ── 要落地的图标清单（加一个场景图标 = 这里加一条 + scene-icons.js 的 MAP 登记）──
const SPEC = [
  { name: 'fish',            note: '胡闹的大肥鱼（人格本体 · 一条鱼）' },
  // 社交：圆气泡 + 三个点。2026-11-13 离屏渲染横评过 5 个候选（messages-square / message-square-more /
  // message-circle-more / message-square / users-round），16px 下这个"气球 + 点"最认得出，也不跟鱼的曲线混。
  { name: 'message-circle-more', note: '社交（多平台通道 + 合并消息流 · 气泡+三点）' },
  // 兜底池：没在 scene-icons.js 登记的新场景按顺序各领一个，保证两个场景不撞同一个
  { name: 'shapes',          note: '兜底 1（抽象图形）' },
  { name: 'layers',          note: '兜底 2（叠层）' },
  { name: 'box',             note: '兜底 3（盒子）' },
  { name: 'sparkles',        note: '兜底 4（星点）' },
  { name: 'circle-dot',      note: '兜底 5（圆点）' },
  { name: 'radar',           note: '兜底 6（雷达）' },
];

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const FORCE = args.includes('--force');

let fails = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fails++; console.log('  ✗ ' + m); };

// 1. 只留 <svg> 里的图元：注释 / class / 原根属性全部丢掉，统一按 ROOT_ATTRS 重写
function normalize(raw, name) {
  const body = String(raw)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>[\s\S]*$/i, '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\r\n');
  if (!body) throw new Error(name + '：Lucide 源文件里没解析到图元');
  return [MARK, '<svg ' + ROOT_ATTRS + '>', body, '</svg>', ''].join('\r\n');
}

// 2. 落地文件是否已经是对的（版本标记对得上 ⇒ 不重复下载）
function isFresh(p) {
  try {
    const t = fs.readFileSync(p, 'utf8');
    return t.startsWith(MARK) && /<svg /i.test(t);
  } catch (e) { return false; }
}

function readmeText() {
  return [
    '# 场景图标库（生成产物，别手改）',
    '',
    '本目录下的 `*.svg` 由 `12-源码照搬\\外壳\\scripts\\图标库.mjs` 从 Lucide 官方图标库抓取后写入，',
    '手改会在下次重跑时被覆盖。改图标请改脚本里的 `SPEC`，再加场景登记（见下）。',
    '',
    '- 来源：<https://lucide.dev> · npm 包 `' + LIB + '@' + VER + '`',
    '- 许可：ISC（可商用、可再分发）；每个文件头保留来源与版本标记',
    '- 规格：`viewBox="0 0 24 24"`、显示 17×17、描边 `#8fb4ff`（工作台图标主色）、`stroke-width="2"`',
    '',
    '## 加一个场景图标（四步）',
    '',
    '1. 到 <https://lucide.dev/icons> 挑图标，记下英文名（如 `fish`）；',
    '2. 在 `scripts\\图标库.mjs` 的 `SPEC` 里加一条（`name` = 图标名，`note` = 哪个场景用）；',
    '3. 跑 `node 12-源码照搬\\外壳\\scripts\\图标库.mjs`（只补这一个新文件，不重下已有的）；',
    '4. 在 `renderer\\scene-icons.js` 的 `MAP` 里登记 `\'<场景 id>\': \'<图标名>\'`，',
    '   然后 `node 12-源码照搬\\外壳\\scripts\\check-gui.mjs` 过一遍 —— 会检出「没登记 / 两个场景撞同一个图标 / 文件缺失」。',
    '',
    '## 当前清单',
    '',
    '| 文件 | 用在哪 |',
    '| --- | --- |',
  ].concat(SPEC.map((s) => '| `' + s.name + '.svg` | ' + s.note + ' |')).join('\n') + '\n';
}

async function fetchOne(name) {
  // ⚠ 别给 fetch 塞中文的 user-agent：NS 的 header 值只能是 ASCII（ByteString），中文会直接抛
  const res = await fetch(CDN + name + '.svg', { headers: { 'user-agent': 'luanyujia-workbench-iconlib' } });
  if (!res.ok) throw new Error(name + '：CDN 返回 HTTP ' + res.status);
  return normalize(await res.text(), name);
}

async function main() {
  console.log('== 图标库（' + LIB + ' ' + VER + ' · ISC）==');
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  if (CHECK) {
    // 只读核对：文件在、版本标记对、没有不在 SPEC 里的野文件
    for (const s of SPEC) {
      const p = path.join(OUT, s.name + '.svg');
      if (!fs.existsSync(p)) bad(s.name + '.svg 缺失 → 跑 node scripts\\图标库.mjs');
      else if (!isFresh(p)) bad(s.name + '.svg 版本标记不对（不是 ' + LIB + ' ' + VER + ' 生成的）→ 跑 node scripts\\图标库.mjs --force');
      else ok(s.name + '.svg');
    }
    const extra = fs.readdirSync(OUT).filter((f) => f.endsWith('.svg') && !SPEC.some((s) => s.name + '.svg' === f));
    if (extra.length) console.log('  ! 目录里还有不在 SPEC 里的文件（不影响运行，确认一下是不是过时残留）：' + extra.join(', '));
    console.log(fails ? '\n图标库：' + fails + ' 项待修' : '\n图标库：全部就绪');
    process.exit(fails ? 1 : 0);
  }

  let got = 0, skipped = 0;
  for (const s of SPEC) {
    const p = path.join(OUT, s.name + '.svg');
    if (!FORCE && isFresh(p)) { skipped++; ok(s.name + '（已有，跳过）'); continue; }
    try {
      fs.writeFileSync(p, await fetchOne(s.name), 'utf8');
      got++; ok(s.name + ' ← ' + CDN + s.name + '.svg');
    } catch (e) {
      bad(s.name + ' 抓取失败：' + (e && e.message ? e.message : e));
    }
  }

  const readme = path.join(OUT, 'README.md');
  fs.writeFileSync(readme, readmeText().replace(/\r?\n/g, '\r\n'), 'utf8');
  console.log('\n新下载 ' + got + ' 个 / 跳过 ' + skipped + ' 个 · 清单写入 ' + path.relative(ROOT, readme));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('图标库脚本自身出错：' + (e && e.stack || e)); process.exit(1); });
