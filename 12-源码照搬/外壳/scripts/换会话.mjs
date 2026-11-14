// 「换会话」一键入口（2026-11-12 第四次改版：全自动编排，人不用再补任何一步）
//
// 用途：把某个场景面板的常驻会话**归档 + 新建一条同名的新会话顶上来**（= sessions.mjs --rotate 的傻瓜包装）。
//
//   node "<工作台>\外壳\scripts\换会话.mjs"            列出全部 AI 面板 + 是否到线 + 交接是否够新鲜
//   node "<工作台>\外壳\scripts\换会话.mjs" site-ai     空跑：打印计划，不动任何东西
//   node "<工作台>\外壳\scripts\换会话.mjs" site-ai --go   真换（用户只要记到这一条）
//   可加 --force：交接文件超过 2 小时也照换（会有警告，仍要求文件存在）
//   可加 --no-seed：不给新会话写开场消息（默认写；看到轮次真的开始就取消，最多 3 秒）
//
//   零散会话（没有场景/面板的那些）—— 走同一入口，加 --stray：
//   node "…\scripts\换会话.mjs" --stray                     列出所有零散会话
//   node "…\scripts\换会话.mjs" --stray 华为电脑管家升级        空跑：打印计划
//   node "…\scripts\换会话.mjs" --stray 华为电脑管家升级 --go    真换
//
// ---- 第四次改版（2026-11-12，用户要求「完全自动化」）----
// 一次 --go 现在按**事务顺序**跑完，且每一步失败都不会把面板留在坏状态：
//   ① 预检：引擎在跑 / 交接文件在 / 场景记忆闸过得去（卡指纹过期自动重盖章）
//   ② 建新会话 + 改名 + 原子回写场景 json（先备份，写完当场复核；复核失败自动还原）
//   ③ 回写**定位卡**（按面板 id 找那一行换会话 id —— 以前只提示、不改，实测已经漂移）
//   ④ 回写名册（sessions.mjs 内做：只改同一行既有旧 id 又有面板 id 的那行）
//   ⑤ **最后**才归档旧会话（sessions.mjs --defer-archive 把归档挪到这一步；
//      旧顺序「先归档再回写」一旦回写失败，面板就指着一条已归档的会话，打开是空白）
//   ⑥ 记忆联动：会话 id 变了 ⇒ 重跑 `场景记忆.mjs stamp`，把身份卡 / 场景画像里的「AI 会话」与新绑定对齐
//      （不重盖章的话，check 立刻报"卡指纹过期"，下一轮 AI 会以为记忆坏了）
//   ⑦ 自证：读 §〇 里本面板那行指针，验证它指的文件真的存在（相对路径曾在这里死过链）
//   ⑧ 机器可读输出 NEWID / OLDID；GUI 模式下由渲染层自己 reload 本面板（不再广播 all）
//   ⑨ 项目记忆体检（2026-11-13 B 批②）：按「会话 cwd → pinTarget → 场景唯一」三级解析出面板所属项目根，
//      再跑 `记忆.mjs 体检`（✗ 拦、⚠ 只提示）；解析不到唯一项目就明确跳过，不凭目录名猜项目。
//
// 交接文件路径不再靠硬编码表：默认按场景 json 的 `name` 解析
//   `<引擎数据>\.dsh\场景记忆\<场景名>\场景私有记忆.md`，表里登记过的优先（用于非标路径）。
//   新场景加进来不用改代码，这是「完全自动化」的前一半；后一半是 交接并换会话.mjs
//   把交接落到「面板级」文件，两个 AI 面板不再抢同一段 §〇。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));      // …\工作台外壳\scripts
const GUI = path.resolve(here, '..');                            // …\工作台外壳
const DSH_HOME = process.env.DSH_HOME || path.resolve(GUI, '..', '引擎数据', '.dsh');
const MEM_TOOL = path.resolve(GUI, '..', '工具', '场景记忆.mjs');   // 场景记忆结构闸用的工具
const PROJ_TOOL = path.resolve(GUI, '..', '工具', '记忆.mjs');       // 项目层体检用的工具（2026-11-13 B 批②）
const SESSIONS = path.join(here, 'sessions.mjs');
const ARCHIVE = path.join(here, '归档会话.mjs');
// 端口真源：唯一实现在 工具\环境.mjs（env > 机器配置 > 默认），脚本里不再写字面量（2026-11-13）
import { port } from '../../工具/环境.mjs';
const BASE = process.env.DSH_GUI_BASE || process.env.DSH_WEB_URL || ('http://127.0.0.1:' + port('dsh'));

// 面板 → 交接文件的**非标路径覆盖表**。标准路径由 handoffOf() 按场景名现算，新场景无需登记。
// 2026-11-12：补上「AI·工作区」（cd-ai-home）——同一个场景记忆文件（程序开发）。
const HANDOFF = {
  'mem-chat': path.join(DSH_HOME, '场景记忆', '记忆', '场景私有记忆.md'),
  'bv-ai': path.join(DSH_HOME, '场景记忆', 'B站', '场景私有记忆.md'),
  'cd-ai': path.join(DSH_HOME, '场景记忆', '程序开发', '场景私有记忆.md'),
  'cd-ai-home': path.join(DSH_HOME, '场景记忆', '程序开发', '场景私有记忆.md'),
  'pc-ai': path.join(DSH_HOME, '场景记忆', '本地电脑', '场景私有记忆.md'),
  'sr-ai': path.join(DSH_HOME, '场景记忆', '自我复盘', '场景私有记忆.md'),
};
const FRESH_MS = 2 * 60 * 60 * 1000;      // 与 sessions.mjs 的硬闸门一致：2 小时内改过才算"写好了"

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a) => !a.startsWith('--'));
const say = (...a) => console.log(...a);

function panels() {
  const dir = path.join(GUI, 'scenarios');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x[0] !== '_')) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
    for (const p of (j.panels || [])) if (p.type === 'harness') out.push({ file: f, scen: j.id || f, scene: j, p });
  }
  return out;
}

/** 面板的交接文件：显式覆盖表优先，否则按场景 `name` 现算（新场景不用登记）。 */
function handoffOf(scene, panelId) {
  if (HANDOFF[panelId]) return HANDOFF[panelId];
  const name = String((scene && (scene.name || scene.id)) || '').trim();
  if (!name) return '';
  return path.join(DSH_HOME, '场景记忆', name, '场景私有记忆.md');
}

/** 某个会话的工作目录（引擎 projcache 里的 identity.cwd）。读不到返回空。 */
function cwdOf(sessionId) {
  if (!sessionId) return '';
  const base = path.join(DSH_HOME, 'storages');
  if (!fs.existsSync(base)) return '';
  for (const d of fs.readdirSync(base)) {
    const f = path.join(base, d, 'sessions', String(sessionId) + '.json');
    if (!fs.existsSync(f)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8')).record?.identity?.cwd;
      if (c) return String(c);
    } catch (e) { /* 读不到就换下一个 storage */ }
  }
  return '';
}

/**
 * 场景 → 项目根（2026-11-13 B 批②：换会话前要过项目层体检，先得知道"这个面板在哪个项目"）。
 * 三级解析，**任一级唯一才采用**，都不唯一就返回空（⇒ 只跑场景层 check，不误拦）：
 *   ① 面板当前会话的 cwd 落在某项目 `paths` 下——最准，换会话换的就是这个项目的工作；
 *   ② 面板 `pinTarget[0]` 命中项目 `name` / `aliases`（工作区面板（cd-ai-home）走这条）；
 *   ③ 该场景在注册表里只有一个 active 项目、且它真有 `memory\`。
 * 程序开发场景挂了 3 个项目（工作台本体 / mlw / ai-compilation-specifications），所以不能只按场景认。
 */
function projectRootOf(scene, panel, sessionId) {
  const reg = path.join(DSH_HOME, '场景记忆', '_共享记忆', '项目.json');
  if (!fs.existsSync(reg)) return '';
  let j = null;
  try { j = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch (e) { return ''; }
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  const usable = (j && j.projects || []).filter((p) => {
    const root = String(p && (p.memoryRoot || (p.paths || [])[0]) || '');
    return root && (!p.status || p.status === 'active') && fs.existsSync(path.join(root, 'memory'));
  });
  if (!usable.length) return '';

  // ① 会话 cwd
  const cwd = norm(cwdOf(sessionId));
  if (cwd) {
    const byCwd = usable.filter((p) => (p.paths || []).some((x) => {
      const px = norm(x);
      return px && (cwd === px || cwd.startsWith(px + path.sep.toLowerCase()) || cwd.startsWith(px + '/'));
    }));
    if (byCwd.length === 1) return String(byCwd[0].memoryRoot || byCwd[0].paths[0]);
  }
  // ② pinTarget
  const pin = String((panel && Array.isArray(panel.pinTarget) ? panel.pinTarget[0] : '') || '');
  if (pin) {
    const byPin = usable.filter((p) => p.name === pin || (p.aliases || []).includes(pin));
    if (byPin.length === 1) return String(byPin[0].memoryRoot || byPin[0].paths[0]);
  }
  // ③ 场景唯一
  const sceneName = String((scene && (scene.name || scene.id)) || '');
  if (sceneName) {
    const byOwner = usable.filter((p) => p.owner === sceneName);
    if (byOwner.length === 1) return String(byOwner[0].memoryRoot || byOwner[0].paths[0]);
  }
  return '';
}

/** 面板当前的压力：读引擎 projcache（数字是引擎上次落盘的，活跃会话可能落后几分钟）。 */
function pressures() {
  const map = {};
  const base = path.join(DSH_HOME, 'storages');
  for (const d of (fs.existsSync(base) ? fs.readdirSync(base) : [])) {
    const sd = path.join(base, d, 'sessions');
    if (!fs.existsSync(sd)) continue;
    for (const f of fs.readdirSync(sd)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(sd, f);
      let r; try { r = JSON.parse(fs.readFileSync(full, 'utf8')).record } catch { continue }
      const pv = r?.rows?.contextPressure?.val;
      if (!pv) continue;
      const line = Math.floor((pv.contextWindow || 160000) * 0.8);
      const projected = pv.pressureTokens > 0
        ? Math.round(pv.pressureTokens + (pv.surfaceTokens || 0) - (pv.sampledSurfaceTokens ?? pv.surfaceTokens ?? 0))
        : Math.round(pv.surfaceTokens || 0);
      let mtime = 0; try { mtime = fs.statSync(full).mtimeMs } catch { /* 读不到就当 0 */ }
      map[f.replace(/\.json$/, '')] = {
        pct: Math.round(projected / line * 100), turns: r.rows.sessionStats?.val?.turns ?? null,
        title: r.rows.title?.val || '', mtime, stale: Date.now() - mtime > 10 * 60 * 1000,
      };
    }
  }
  return map;
}
function fresh(file) { try { return fs.statSync(file).mtimeMs } catch { return 0 } }
function ago(ms) {
  if (!ms) return '（文件不存在）';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? m + ' 分钟前' : (m < 2880 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前');
}
function runNode(script, argsArr, opts) {
  return execFileSync(process.execPath, [script, ...argsArr], Object.assign({
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 << 20,
    env: Object.assign({}, process.env, { DSH_HOME }),
  }, opts || {}));
}

/** 引擎在不在：连不上就别白跑 180 秒（cookie 反正在 server.log 里也要现取）。 */
async function engineAlive() {
  try {
    const r = await fetch(BASE + '/', { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    return r.status < 500;
  } catch (e) { return false; }
}

/**
 * 定位卡回写（2026-11-12 新增）：每个面板在定位卡里占一行，形如
 *   | 工作区会话 | `程序开发·工作区` / `session-xxxx`（面板 `cd-ai-home`，cwd = …） |
 * 只改"含本面板 id 的那一行"里的会话 id，其它行（含历史记录里的旧 id）一律不动。
 * 以前这一步只打印"还有旧 id 残留"，实测 cd-ai-home 的定位卡因此停在三代前。
 */
function patchCardByPanel(sceneId, panelId, newId) {
  const card = path.join(GUI, 'scenarios', String(sceneId) + '-context.md');
  if (!fs.existsSync(card)) return { changed: false, note: '定位卡不存在：' + card };
  const text = fs.readFileSync(card, 'utf8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const anchor = '`' + panelId + '`';
  let n = 0;
  const out = text.split(/\r?\n/).map((line) => {
    if (line.indexOf(anchor) < 0 || line.indexOf('session-') < 0) return line;
    n++;
    return line.replace(/session-[0-9a-fA-F-]{8,}/g, newId);
  });
  if (!n) return { changed: false, note: '定位卡里没有面板 ' + panelId + ' 的会话行（可能还没登记）' };
  fs.writeFileSync(card, out.join(nl), 'utf8');
  return { changed: true, note: '定位卡已回写 ' + n + ' 行（面板 ' + panelId + '）' };
}

// ── 无参数：总览 ────────────────────────────────────────────────────────────
if (!args.length) {
  const P = pressures();
  say('' + panels().length + ' 个面板现状（压力数字后面带 "(旧)" = 引擎好几分钟没落盘，仅供参考）\n');
  say('  面板       会话        压力        交接文件（改于）');
  for (const { p, scene } of panels()) {
    const st = P[p.sessionId] || null;
    const pct = st ? (st.stale ? st.pct + '%(旧)' : st.pct + '%') : '?';
    const h = handoffOf(scene, p.id) ? ago(fresh(handoffOf(scene, p.id))) : '（无交接文件）';
    say('  ' + String(p.id).padEnd(10) + String((p.sessionId || '').replace(/^session-/, '').slice(0, 8)).padEnd(11) +
      String(pct).padStart(11) + '        ' + h + (st && st.turns != null ? '   第' + st.turns + '轮' : ''));
  }
  say('\n换一个：node "…\\scripts\\换会话.mjs" <面板id> --go        只看计划就去掉 --go');
  say('零散会话（没场景的）：node "…\\scripts\\换会话.mjs" --stray        看清单；加 <名字|id> --go 换它');
  process.exit(0);
}

// ── 零散会话（--stray）：没有面板可查 ⇒ 直接转交 sessions.mjs ────────────────
if (flags.has('--stray')) {
  const q = args[0] || '';
  const pass = q ? ['--rotate', q, '--stray'] : ['--stray'];
  if (q && !flags.has('--go')) pass.push('--dry');
  if (flags.has('--force')) pass.push('--force');
  if (flags.has('--no-seed')) pass.push('--no-seed');
  const ai = argv.indexOf('--adopt');
  if (ai > -1) pass.push('--adopt', argv[ai + 1] || '');
  const hi = argv.indexOf('--handoff');
  if (hi > -1) pass.push('--handoff', argv[hi + 1] || '');
  if (q) say('零散会话（无场景）：' + q + (flags.has('--go') ? '  —— 真换' : '  —— 空跑（加 --go 才真换）') + '\n');
  try {
    const out = execFileSync(process.execPath, [SESSIONS, ...pass], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 });
    say(out);
  } catch (e) {
    if (e.stdout) say(String(e.stdout));
    if (e.stderr) console.error(String(e.stderr));
    say('✗ 没换成（上面是原样输出）' + (e.status != null ? '，退出码 ' + e.status : ''));
    process.exit(e.status || 1);
  }
  if (q && flags.has('--go')) say('\n✅ 已换。去左侧侧边栏找新会话（没立刻出现就点一下标题栏 ⟳ 刷新）。');
  process.exit(0);
}

// ── 带面板 id：检查 → 真执行 ─────────────────────────────────────────────────
const id = args[0];
const hit = panels().find((x) => x.p.id === id) || null;
if (!hit) {
  say('✗ 没有这个面板：' + id + '（写面板 id，如 site-ai；不带参数可看全部）');
  process.exit(2);
}
const handoff = handoffOf(hit.scene, id);
// 场景目录名（记忆联动要用：换完会话要重盖章、要自检 §〇 指针能否解析）
const handoffSceneDir = (String(handoff).match(/场景记忆[\\/]([^\\/]+)[\\/]场景私有记忆\.md$/) || [])[1] || '';
const P = pressures();
const st = P[hit.p.sessionId] || null;

say('面板 ' + id + '（场景 ' + hit.scen + '）');
say('  现在这轮：' + (hit.p.sessionId || '(未绑定)') + '  「' + (hit.p.sessionTitle || hit.p.title || '') + '」');
say('  体积参考：' + (st
  ? (st.stale
    ? '引擎上次落盘是 ' + ago(st.mtime) + '（' + st.pct + '%(旧)）—— 这条会话可能刚活动过，数字没刷新，**不当判据**'
    : st.pct + '% · 第' + st.turns + '轮')
  : '读不到'));
say('  交接文件：' + (handoff || '（场景 json 没有 name，算不出交接路径）'));
if (handoff) say('  改于    ：' + ago(fresh(handoff)));

const problems = [];
if (!handoff) problems.push('场景 json 没有 name ⇒ 算不出交接文件路径；给它补一个 name，或改用 --handoff 显式指定');
else if (!fresh(handoff)) problems.push('交接文件不存在：' + handoff);
else if (Date.now() - fresh(handoff) > FRESH_MS && !flags.has('--force')) problems.push('交接文件超过 2 小时没更新 ⇒ 先把 §〇 写好；确实不想写就加 --force');
// 刻意**不**拿压力当闸门：用户明确说要换就是要换；projcache 数字对活跃会话是滞后的，拿它拦人是误拦。
if (st && !st.stale && st.pct < 50) say('\n（提示：这条才 ' + st.pct + '%，换了会丢掉现在这段上下文 —— 你说了算）');

// ★ 强制闸：换会话前必须过场景记忆结构/绑定检查（--force 只免"太旧"，不免这道）
{
  const m = String(handoff).match(/场景记忆[\\/]([^\\/]+)[\\/]场景私有记忆\.md$/);
  if (m) {
    const sceneDir = m[1];
    if (!fs.existsSync(MEM_TOOL)) {
      say('\n⚠ 场景记忆结构闸跳过：没找到 ' + MEM_TOOL);
    } else {
      let ok = true, out = '';
      try {
        out = runNode(MEM_TOOL, ['check', '--场景', sceneDir]);
      } catch (e) {
        ok = false;
        out = String(e.stdout || '') + String(e.stderr || '');
      }
      if (!ok) {
        // 卡指纹过期是机械问题（定位卡/场景 json 改过、没重盖章）⇒ 自动补一次再复查，
        // 否则按钮永远卡在这条上，用户看到"换会话失败"，实际只差一次盖章。
        if (/卡指纹过期/.test(out)) {
          try {
            runNode(MEM_TOOL, ['stamp', '--场景', sceneDir]);
            say('\n（卡指纹过期 ⇒ 已自动重盖章一次，复查中…）');
            out = runNode(MEM_TOOL, ['check', '--场景', sceneDir]);
            ok = true;
          } catch (e2) {
            ok = false;
            out = String(e2.stdout || '') + String(e2.stderr || '');
          }
        }
      }
      if (!ok) {
        const detail = out.split(/\r?\n/).filter((x) => x.includes('✗')).slice(0, 6).join('；');
        problems.push('场景记忆结构闸没过（' + sceneDir + '）：' + (detail || '检查失败') + ' ⇒ 先跑 `node "' + MEM_TOOL + '" 交接 --场景 ' + sceneDir + '`');
      }
    }
  }
}

// ★ 项目层闸（2026-11-13 B 批②）：换会话是记忆接力点，项目记忆腐化就不该接力。
//   以前只验场景层（场景里面的文件结构），项目层 `memory\` 坏了照样换过去。
//   解析不到项目根（多项目场景 / 没注册）⇒ 明确跳过，绝不误拦。
{
  const projRoot = projectRootOf(hit.scene, hit.p, hit.p.sessionId);
  if (!projRoot) {
    say('\n· 项目记忆体检：跳过（这个面板的项目根解析不到唯一答案，只跑了场景层 check）');
  } else if (!fs.existsSync(PROJ_TOOL)) {
    say('\n⚠ 项目记忆体检跳过：没找到 ' + PROJ_TOOL);
  } else {
    let ok = true, out = '';
    try {
      out = runNode(PROJ_TOOL, ['体检', '--project', projRoot, '--noscene']);
    } catch (e) {
      ok = false;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    const warn = out.split(/\r?\n/).filter((x) => x.includes('⚠')).slice(0, 2).join('；');
    if (ok) say('\n· 项目记忆体检：✓ 通过（' + projRoot + '）' + (warn ? '（提醒：' + warn.slice(0, 120) + '）' : ''));
    else {
      const detail = out.split(/\r?\n/).filter((x) => x.includes('✗')).slice(0, 6).join('；');
      problems.push('项目记忆体检没过（' + projRoot + '）：' + (detail || '体检失败') + ' ⇒ 先跑 `node "' + PROJ_TOOL + '" 体检 --project "' + projRoot + '"` 修完再换');
    }
  }
}
if (problems.length) {
  say('\n⚠ 先别急：');
  for (const x of problems) say('  · ' + x);
  say('\n（没真动任何东西）');
  process.exit(3);
}

const cmd = ['"' + SESSIONS + '"', '--rotate', id, '--handoff', '"' + handoff + '"', '--defer-archive', ...(flags.has('--force') ? ['--force'] : []), ...(flags.has('--no-seed') ? ['--no-seed'] : [])];
say('\n' + (flags.has('--go') ? '▶ 开始换会话（真执行）' : '▶ 空跑计划（去掉 --go 之外什么都没发生；真要换加 --go）') + '\n');
say('  内部执行（--defer-archive：旧会话先不动，等 json/定位卡都写成功后才归档）：node ' + cmd.join(' ') + '\n');

if (!flags.has('--go')) {
  // 空跑：把 sessions.mjs 的计划原样透出来
  try {
    say(runNode(SESSIONS, ['--rotate', id, '--handoff', handoff, '--defer-archive', '--dry', ...(flags.has('--force') ? ['--force'] : []), ...(flags.has('--no-seed') ? ['--no-seed'] : [])]));
  } catch (e) {
    if (e.stdout) say(String(e.stdout));
    if (e.stderr) console.error(String(e.stderr));
    process.exit(e.status || 1);
  }
  process.exit(0);
}

// ① 预检：引擎连不上就先说清楚（比跑 180 秒再报"换不到 cookie"强）
(async () => {
  if (!await engineAlive()) {
    say('✗ 引擎没在跑（' + BASE + '）⇒ 先启动工作台，再来换会话。什么都没动。');
    process.exit(3);
  }

  // ② 轮换本体：--defer-archive ⇒ 归档旧会话挪到最后一步（见 sessions.mjs）
  let out = '';
  try {
    out = runNode(SESSIONS, ['--rotate', id, '--handoff', handoff, '--defer-archive',
      ...(flags.has('--force') ? ['--force'] : []), ...(flags.has('--no-seed') ? ['--no-seed'] : [])]);
    say(out);
  } catch (e) {
    if (e.stdout) say(String(e.stdout));
    if (e.stderr) console.error(String(e.stderr));
    say('✗ 轮换失败（上面是原样输出）' + (e.status != null ? '，退出码 ' + e.status : '') + ' ⇒ 绑定没动，旧会话还在');
    process.exit(e.status || 1);
  }

  const newId = ((out.match(/^NEWID:\s*(session-[0-9a-fA-F-]{8,})\s*$/m) || [])[1]
    || (out.match(/新会话已建[：:]\s*(session-[0-9a-fA-F-]{8,})/) || [])[1] || '').trim();
  const oldId = ((out.match(/^OLDID:\s*(session-[0-9a-fA-F-]{8,})\s*$/m) || [])[1]
    || String(hit.p.sessionId || '')).trim();
  if (!newId) {
    say('✗ 没从输出里认出新会话 id ⇒ 不敢继续（定位卡/归档都不动，避免改错）');
    process.exit(1);
  }
  say('NEWID: ' + newId);

  // ③ 定位卡回写（以前只提示不改，实测已经漂移）
  const card = patchCardByPanel(hit.scen, id, newId);
  say('  ' + (card.changed ? '✓ ' : '⚠ ') + card.note);

  // ④ 最后才归档旧会话：此时 json / 定位卡 / 名册都已经指向新会话，失败也只多一条可见的旧会话。
  let archNote = '（没有旧会话 id，跳过归档）';
  if (oldId) {
    try {
      const aout = runNode(ARCHIVE, [oldId, '--go']);
      const okLine = aout.split(/\r?\n/).find((l) => l.includes('已真归档'));
      archNote = okLine || '归档输出见上';
      say('  ✓ 旧会话归档：' + String(archNote).trim().slice(0, 200));
    } catch (e) {
      archNote = '归档失败（' + (e.status != null ? '退出码 ' + e.status : (e.message || '未知')) + '）';
      say('  ⚠ 旧会话归档没成：' + archNote);
      say('    补一次：node "…\\scripts\\归档会话.mjs" ' + oldId + ' --go');
      // 不判整次失败：面板已经指向新会话，旧会话只是还留在侧边栏（可重试、可手工取消归档）
      console.log('WARN: 旧会话归档没成（面板已切到新会话）');
    }
  }

  // ⑤ 记忆联动：会话 id 变了 ⇒ 身份卡 / 场景画像里写的「AI 会话」必须重盖章，
  //    否则 场景记忆.mjs check 立刻报"卡指纹过期"（这是换会话最隐蔽的记忆断点）。
  //    必须在归档之后：此时场景 json 已经是新 id，盖章才盖出正确的绑定。
  if (handoffSceneDir && fs.existsSync(MEM_TOOL)) {
    try {
      const sout = runNode(MEM_TOOL, ['stamp', '--场景', handoffSceneDir]);
      const okLine = sout.split(/\r?\n/).find((l) => l.includes('身份卡')) || '身份卡已重生成';
      say('  ✓ 记忆联动：' + String(okLine).replace(/^[·✓\s]+/, '').trim().slice(0, 160));
    } catch (e) {
      // 不判整次失败：会话已换好、绑定已生效，卡过期只是机械问题（下次 check 会自动补盖章）
      say('  ⚠ 记忆联动：重盖章失败（' + ((e && e.message) || '未知') + '）—— 跑一次 `node 工具\\场景记忆.mjs stamp --场景 ' + handoffSceneDir + '`');
      console.log('WARN: 身份卡未重盖章（面板已切到新会话）');
    }

    // ⑥ 自证：§〇 里本面板那条指针指向的文件真的存在吗（相对路径曾在这里死过链）
    try {
      const body = fs.readFileSync(handoff, 'utf8');
      const cut = body.indexOf('## 核心职责');
      const sec0 = cut > 0 ? body.slice(0, cut) : body;
      const line = sec0.split(/\r?\n/).find((l) => l.indexOf('面板 `' + id + '`') >= 0 && l.indexOf('`') >= 0);
      if (!line) say('  ⚠ §〇 指针：没找到本面板的指针行（新会话将读不到本面板交接）');
      else {
        const ptr = ((line.match(/交接见 `([^`]+)`/) || line.match(/`([^`]+\.md)`/) || [])[1] || '').trim();
        const full = path.isAbsolute(ptr) ? ptr : path.resolve(GUI, '..', ptr);
        if (ptr && fs.existsSync(full)) say('  ✓ §〇 指针可达：' + ptr);
        else if (ptr) { say('  ⚠ §〇 指针指向的文件不存在：' + ptr + '（按旧写法落盘的话，重跑一次交接即可修成绝对路径）'); console.log('WARN: §〇 指针不可达'); }
        else say('  ⚠ §〇 指针没写路径（只有文字）');
      }
    } catch (e) { /* 自检失败不影响换会话结果 */ }
  }

  // ⑦ 桥接路由：换的是人格面板时，QQ 插件的 routes.private[*].sessionId 必须跟着改，
  //    否则对方发来的消息会投进刚归档的旧会话（实测踩过）。脚本自带判断：不指向人格会话就只报「已是最新」。
  try {
    const syncScript = path.join(GUI, '..', '工具', '同步桥接路由.mjs');
    if (fs.existsSync(syncScript)) {
      const out = String(execFileSync(process.execPath, [syncScript], { encoding: 'utf8' }) || '').trim();
      out.split('\n').filter(Boolean).forEach((l) => say('  ' + l));
    } else {
      say('  ⚠ 找不到 工具\\同步桥接路由.mjs；人格面板有 QQ 通道时要手动改 routes');
    }
  } catch (e) {
    say('  ⚠ 桥接路由同步没成功：' + ((e && e.stdout) ? String(e.stdout).trim() : ((e && e.message) || e)));
    say('    ⇒ 手动跑 node 工具\\同步桥接路由.mjs，再重启整壳');
  }

  // ⑧ 重载：GUI 模式由渲染层自己 reload 本面板（只动这一块）；
  //    命令行模式没有渲染层，才写 reload-panels.cmd 让壳帮忙（此时才用 all）。
  if (process.env.DSH_ROTATE_SELF_RELOAD === '0') {
    say('\n✅ 已换。新会话 ' + newId + '（GUI 会自己重载本面板）');
  } else {
    try {
      const cmdFile = path.join(GUI, 'data', 'reload-panels.cmd');
      fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
      fs.writeFileSync(cmdFile, 'all', 'utf8');
      say('\n✅ 已换。面板会自动重载（壳轮询 data\\reload-panels.cmd）；没动静就把焦点切回工作台窗口。');
    } catch (e) {
      say('\n✅ 已换。自动重载没写成（' + ((e && e.message) || e) + '）⇒ 手动点一次面板标题栏 ⟳。');
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('✗ 未处理的异常：' + ((e && e.stack) || e));
  process.exit(1);
});
