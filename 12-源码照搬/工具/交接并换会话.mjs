#!/usr/bin/env node
// 交接并换会话.mjs —— 「换会话」按钮的交接 + 轮换（2026-11-12 第二次改版）
//
// 为什么再改：用户点一次按钮要等模型跑完一整轮，慢且不可控；更糟的是壳里跑的是 Electron 内置
//   Node 24.18，zstd 只解 transcript 的第一帧 ⇒ 脚本根本看不到 turn/end，10 秒的交接也等满 600 秒。
//   现在默认**不投 prompt**：直接从旧会话 transcript 摘录最近几轮，写进 §〇，秒级轮换。
//
// 三条路（--mode）：
//   transcript（默认）：读 transcript → 摘录最近 3 轮 user/assistant → 写 §〇 → 校验 → 轮换；不调模型。
//   prompt：老的「让旧会话自己写交接」，要等一整轮 LLM（慢），保留给确实需要模型总结的场合。
//   direct：不写交接，直接轮换（--force 跳过 2 小时闸）。
//
// 进度协议：每步一行 `P|<步>|<名称> · <说明>`，壳转成按钮下的 3 行状态；
//   结束时打 `NEWID: <session-id>`、`ELAPSED: <秒>`；失败打 `✗ ...` 并以非 0 退出。
//
// 用法：
//   node 工具\交接并换会话.mjs --panel cd-ai [--mode transcript] [--dry]
//   node 工具\交接并换会话.mjs --panel cd-ai --mode prompt [--timeout 600]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DSH_HOME, ROOT, SHELL, loadSessions, getCookie, promptSession, transcriptOf, readEvents, turnStats } from './派发-公共.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const PANEL = val('--panel', '');
const MODE = String(val('--mode', 'transcript')).toLowerCase();
const TIMEOUT = Math.max(30, Number(val('--timeout', '600')) || 600);
const DRY = argv.includes('--dry');
const HANDOFF_ONLY = argv.includes('--handoff-only');   // 只写交接不轮换（验证/手工补交接用）
const POLL_MS = 3000;
const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (k, name, msg) => console.log('P|' + k + ' ' + name + ' · ' + msg);

// 1. 子进程一律用**系统 Node**：Electron 的 Node 24.18 解不了多帧 zstd（见 派发-公共.unzstdAll 注释）
const NODE = process.env.DSH_NODE || (process.versions.electron ? 'node' : process.execPath);
const MEM_TOOL = path.join(ROOT, '工具', '场景记忆.mjs');

if (!PANEL) { console.error('用法：node 工具\\交接并换会话.mjs --panel <面板id> [--mode transcript|prompt|direct] [--dry]'); process.exit(2); }
if (!['transcript', 'prompt', 'direct'].includes(MODE)) { console.error('✗ --mode 只认 transcript / prompt / direct'); process.exit(2); }

// 2. 面板 → 旧会话 id、场景名、交接文件（以场景 json 为准）
const scenDir = path.join(SHELL, 'scenarios');
let oldId = '', sceneId = '', sceneName = '';
for (const f of fs.readdirSync(scenDir).filter((x) => x.endsWith('.json') && x[0] !== '_')) {
  let sc; try { sc = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8')); } catch (e) { continue; }
  const p = (sc.panels || []).find((x) => x.id === PANEL);
  if (p) { oldId = String(p.sessionId || ''); sceneId = String(sc.id || f.replace(/\.json$/, '')); sceneName = String(sc.name || ''); break; }
}
if (!oldId) { console.error('✗ 找不到面板或它没绑 sessionId：' + PANEL); process.exit(2); }

const sessions = loadSessions();
const old = sessions.get(oldId);
const oldTitle = (old && old.title) || '';
const HANDOFF = sceneName ? path.join(DSH_HOME, '场景记忆', sceneName, '场景私有记忆.md') : '';
const transcript = transcriptOf(oldId);
say('面板 ' + PANEL + '（场景 ' + sceneId + '）· 旧会话 ' + oldId + '「' + oldTitle + '」');
if (HANDOFF) say('交接文件：' + HANDOFF);

// 3. 小工具：§〇 读写、transcript 摘录、子进程
function nlOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}
function msgText(e) {
  const d = (e && e.data) || {};
  // user/message 正文在 data.content；assistant/message 在 data.message.content（2026-11-12 实测）
  const c = d.content || (d.message && d.message.content) || [];
  return c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n').trim();
}
// 引擎会把工作区/技能提醒塞进 user 正文；摘录前先剔掉，别把 <system-reminder> 写进 §〇
function stripReminders(s) {
  return String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
}
function sec0Range(body) {
  const m = body.match(/^## (?:§〇|〇、|§0).*$/m);
  if (!m) return null;
  const start = m.index;
  const after = body.indexOf('\n## ', start + 4);
  return { start, end: after < 0 ? body.length : after, after, sec: body.slice(start, after < 0 ? body.length : after) };
}
function splitSections(sec, nl) {
  const map = new Map();
  let key = '', buf = [];
  for (const line of sec.split(/\r?\n/)) {
    if (/^### /.test(line)) {
      if (key) map.set(key, buf.join(nl).trimEnd());
      key = line.trim(); buf = [];
    } else if (key) buf.push(line);
  }
  if (key) map.set(key, buf.join(nl).trimEnd());
  return map;
}
function sectionOf(map, no, nl) {
  for (const [h, b] of map) if (new RegExp('^###\\s*' + no + '\\)').test(h)) return h + nl + b;
  const d = {
    2: ['### 2) 当前项目', '| 项目 | 记忆文件 | 状态 | 下一步 |', '|---|---|---|---|', '| （暂无） | — | — | — |'],
    3: ['### 3) 私有记忆变更', '- '],
    4: ['### 4) 下一步 / 卡点', '- '],
    5: ['### 5) 全貌', '- 见身份卡 / 场景画像；项目记忆与归档见 _文件索引.md'],
  }[no];
  return d.join(nl);
}
// 按 turn/start → turn/end 分组，只留每轮最后的 user 文本与 assistant 文本
function collectTurns(ev) {
  const out = [];
  let cur = null;
  for (const e of ev) {
    if (e.type === 'turn/start') { cur = { turn: Number(e.data && e.data.turn) || out.length + 1, users: [], assistants: [] }; continue; }
    if (!cur) continue;
    if (e.type === 'user/message') {
      const kind = e.data && e.data.source && e.data.source.kind;
      if (kind !== 'time-context') cur.users.push(e);
    } else if (e.type === 'assistant/message') cur.assistants.push(e);
    else if (e.type === 'turn/end') {
      out.push({
        turn: cur.turn,
        user: cur.users.length ? msgText(cur.users[cur.users.length - 1]) : '',
        assistant: cur.assistants.length ? msgText(cur.assistants[cur.assistants.length - 1]) : '',
      });
      cur = null;
    }
  }
  return out;
}
function runMem(cmd) {
  return spawnSync(NODE, [MEM_TOOL, cmd, '--场景', sceneName], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
}
function fail(code, msg) { console.error('✗ ' + msg); process.exit(code); }
function mtimeOf(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }

if (!HANDOFF) fail(5, '场景 json 没有 name，找不到本场景的交接文件');
if (!fs.existsSync(HANDOFF)) fail(5, '交接文件不存在：' + HANDOFF);

// 4. --dry：只打印计划，不动任何东西
if (DRY) {
  const ev = readEvents(transcript);
  const n = ev ? (turnStats(ev) || { count: 0 }).count : 0;
  say('\n--dry（mode=' + MODE + '）');
  if (MODE === 'transcript') say('  读 ' + (transcript || '(找不到 transcript)') + '（' + n + ' 轮）→ 摘录最近 3 轮写 §〇 → 轮换；不投 prompt。');
  else if (MODE === 'prompt') say('  给旧会话投交接提示并等这一轮结束（--timeout ' + TIMEOUT + ' 秒无进展才放弃）。');
  else say('  不写交接，直接轮换（--force）。');
  process.exit(0);
}

// 5. transcript 模式：脚本自己写 §〇（本轮默认路径）
function writeTranscriptHandoff() {
  step('1/3', '交接', '读取旧会话 transcript…');
  const ev = readEvents(transcript);
  if (!ev) fail(5, '读不到旧会话 transcript（' + (transcript || '文件不存在') + '）⇒ 未换会话');
  const all = collectTurns(ev).map((t) => Object.assign(t, { user: stripReminders(t.user) }));
  // 交接提示、开场消息（seed）都没有业务信息，摘录时剔掉；只剩这些 ⇒ 不重写 §〇
  const useful = all.filter((t) => t.user && !/^【换会话前交接】/.test(t.user) && !/^交接已写好：/.test(t.user));
  if (!useful.length) {
    // 旧会话是空的/只有开场消息：沿用现有 §〇，只刷新时间戳让 2 小时闸放行（别用噪声覆盖真交接）
    const now = new Date();
    try { fs.utimesSync(HANDOFF, now, now); } catch (e) { /* 时间戳刷不动就交给后面的闸门报错 */ }
    // 2026-11-12：定位卡/场景 json 可能刚被换会话或项目切换改过 ⇒ 卡指纹必过期。
    //   换会话流程**无条件先 stamp 再校验**，别把「卡过期」当失败抛给用户。
    const st = runMem('stamp');
    if (st.stdout) say(String(st.stdout).trimEnd());
    if (st.status !== 0) {
      if (st.stderr) console.error(String(st.stderr).trimEnd());
      fail(5, '盖章（stamp）失败（退出码 ' + st.status + '）⇒ 未换会话');
    }
    const chk = runMem('check');
    if (chk.status !== 0) {
      const first = String(chk.stdout || '').split(/\r?\n/).filter((l) => l.includes('✗')).slice(0, 4).join('；');
      if (chk.stdout) console.error(String(chk.stdout).trimEnd());
      fail(5, '交接校验没过：' + (first || '见上方输出') + ' ⇒ 未换会话');
    }
    step('1/3', '交接', '旧会话没有新的业务轮次 ⇒ 沿用现有 §〇（已刷新时间戳 + stamp）');
    return { turns: 0 };
  }
  const turns = useful;

  // 5.1 先走场景记忆的「交接」：把旧版整份归档 + 补骨节 + 盖章（只追加，不覆盖历史）
  const h = runMem('交接');
  if (h.stdout) say(String(h.stdout).trimEnd());
  if (h.status !== 0) {
    if (h.stderr) console.error(String(h.stderr).trimEnd());
    fail(5, '场景记忆交接命令失败（退出码 ' + h.status + '）⇒ 未换会话');
  }

  // 5.2 生成新的 §〇 第 1 节，其余 4 节原样保留
  const body0 = fs.readFileSync(HANDOFF, 'utf8');
  const nl = nlOf(body0);
  const range = sec0Range(body0);
  if (!range) fail(5, '场景私有记忆里没有 §〇 段 ⇒ 未换会话');
  const map = splitSections(range.sec, nl);
  const others = [2, 3, 4, 5].map((no) => sectionOf(map, no, nl));
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  const meta = '- ' + when + ' 换会话脚本从旧会话 `' + oldId + '`（共 ' + all.length + ' 轮）直接摘录，未经模型改写。';
  const blocks = turns.slice(-3).map((t) => [
    '- 第 ' + t.turn + ' 轮 · 用户：' + (clip(t.user, 160) || '（无文字）'),
    '  结论：' + (clip(t.assistant, 280) || '（无结论）'),
  ]);
  let prev = [];
  const old1 = [...map].find(([k]) => /^###\s*1\)/.test(k));
  if (old1 && old1[1].trim()) prev = ['- 前次交接：' + clip(old1[1].replace(/^\s*-\s*/gm, ''), 200)];
  const header = '## §〇 当前交接（≤4 KB，新会话先读这一节）';
  const compose = () => header + nl + nl + '### 1) 上次交接' + nl + [meta, ...blocks.flat(), ...prev].join(nl) + nl + nl + others.join(nl + nl) + nl;
  let sec = compose();
  // 5.3 4 KB 红线：先丢最旧轮次，再丢“前次交接”，最后丢到只剩 meta
  while (Buffer.byteLength(sec) > 4000 && blocks.length > 1) { blocks.shift(); sec = compose(); }
  while (Buffer.byteLength(sec) > 4000 && prev.length) { prev = []; sec = compose(); }
  while (Buffer.byteLength(sec) > 4000 && blocks.length) { blocks.pop(); sec = compose(); }
  if (Buffer.byteLength(sec) > 4000) fail(5, '§〇 放不下（4 KB 红线）⇒ 未换会话；先手工精简第 2–5 节');

  const tail = range.after < 0 ? '' : body0.slice(range.after + 1);
  const body1 = body0.slice(0, range.start) + sec.trimEnd() + nl + nl + tail;
  fs.writeFileSync(HANDOFF, body1, 'utf8');
  step('1/3', '交接', '已摘录最近 ' + blocks.length + ' 轮 → §〇（' + Buffer.byteLength(sec) + ' B）');

  // 5.4 无条件 stamp 再校验：定位卡可能刚被项目切换/上次换会话改过，卡指纹就会过期；
  //     这属于机械问题，不该把“卡过期”抛给用户。校验不过才回滚 §〇。
  const st = runMem('stamp');
  if (st.stdout) say(String(st.stdout).trimEnd());
  if (st.status !== 0) {
    fs.writeFileSync(HANDOFF, body0, 'utf8');
    if (st.stderr) console.error(String(st.stderr).trimEnd());
    fail(5, '盖章（stamp）失败（退出码 ' + st.status + '，已回滚 §〇）⇒ 未换会话');
  }
  const chk = runMem('check');
  if (chk.status !== 0) {
    fs.writeFileSync(HANDOFF, body0, 'utf8');
    const first = String(chk.stdout || '').split(/\r?\n/).filter((l) => l.includes('✗')).slice(0, 4).join('；');
    if (chk.stdout) console.error(String(chk.stdout).trimEnd());
    if (chk.stderr) console.error(String(chk.stderr).trimEnd());
    fail(5, '交接校验没过：' + (first || '见上方输出') + '（已回滚 §〇）⇒ 未换会话');
  }
  say('✓ 交接完成：§〇 已更新并通过结构校验（' + Buffer.byteLength(sec) + ' B）');
  return { turns: blocks.length };
}

// 6. prompt 模式：老路径（让旧会话自己写），等这一轮结束；默认不用
async function waitPromptHandoff() {
  step('1/3', '交接', '投递交接提示，等旧会话这一轮结束…');
  const TIP = '【换会话前交接】请现在把本轮结论写进本场景的 `场景记忆\\<场景>\\场景私有记忆.md` 的 §〇，口径按 `工具\\场景记忆.mjs 交接` 的四小节：'
    + '① 上次交接 ② 当前项目 ③ 私有记忆变更 ④ 下一步/卡点。只改这四小节，别新建文件、别动历史段落。'
    + '写完只回一句「交接已更新」即可，不要做别的事。';
  const ev0 = readEvents(transcript);
  if (!ev0) fail(5, '读不到旧会话 transcript ⇒ 未换会话');
  const turnsBefore = (turnStats(ev0) || { count: 0 }).count;
  const startsBefore = ev0.filter((e) => e.type === 'turn/start').length;
  const inFlight = (startsBefore - turnsBefore) === 1;
  const target = turnsBefore + 1 + (inFlight ? 1 : 0);
  const base = ev0.length;
  const sec0 = sec0Range(fs.readFileSync(HANDOFF, 'utf8'));
  try { await promptSession(oldId, TIP, await getCookie()); }
  catch (e) { fail(5, '投递失败，未换会话：' + ((e && e.message) || e)); }

  const t0 = Date.now();
  let deadline = t0 + TIMEOUT * 1000;
  let done = false, turnsNow = turnsBefore;
  let lastLen = ev0.length, lastMtime = mtimeOf(transcript);
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const ev = readEvents(transcript);
    const st = turnStats(ev);
    turnsNow = st ? st.count : 0;
    let startIdx = -1;
    if (ev) {
      for (let i = ev.length - 1; i >= base; i--) {
        if (ev[i] && ev[i].type === 'user/message' && msgText(ev[i]).includes('【换会话前交接】')) { startIdx = i; break; }
      }
      if (startIdx >= 0) {
        if (ev.some((e, i) => i > startIdx && e.type === 'turn/end')) { done = true; break; }
      } else if (st && st.count >= target) { done = true; break; }
      const mt = mtimeOf(transcript);
      // 还在写（新事件/文件时间前进）⇒ 期限推到「最后一次进展 + TIMEOUT」，不按固定秒数硬切
      if (ev.length > lastLen || mt > lastMtime) {
        lastLen = Math.max(lastLen, ev.length);
        lastMtime = Math.max(lastMtime, mt);
        deadline = Math.max(deadline, Date.now() + TIMEOUT * 1000);
      }
    }
  }
  if (!done) {
    fail(4, '等交接超时（' + Math.round((Date.now() - t0) / 1000) + ' 秒）⇒ 交接可能还在进行，已放弃换会话，绑定没动；可稍后重试或改用默认的 --mode transcript');
  }
  // 复核 §〇 真变了
  const sec1 = sec0Range(fs.readFileSync(HANDOFF, 'utf8'));
  if (!sec0 || !sec1 || sec0.sec === sec1.sec) {
    fail(5, '旧会话这一轮没写 §〇（内容没变化）⇒ 未换会话；请改用默认 --mode transcript，或手工写好 §〇 再换');
  }
  step('1/3', '交接', '旧会话已写完（' + Math.round((Date.now() - t0) / 1000) + ' 秒，共 ' + turnsNow + ' 轮）');
  // 同样：stamp 无条件先跑，再校验（卡指纹过期属于机械问题，不该当失败抛给用户）
  const st = runMem('stamp');
  if (st.stdout) say(String(st.stdout).trimEnd());
  if (st.status !== 0) fail(5, '盖章（stamp）失败（退出码 ' + st.status + '）⇒ 未换会话');
  const chk = runMem('check');
  if (chk.status !== 0) {
    const first = String(chk.stdout || '').split(/\r?\n/).filter((l) => l.includes('✗')).slice(0, 4).join('；');
    if (chk.stdout) console.error(String(chk.stdout).trimEnd());
    fail(5, '交接校验没过：' + (first || '见上方输出') + ' ⇒ 未换会话');
  }
}

// 7. 轮换：流式转发 换会话.mjs 的输出，抽新会话 id 与关键步骤
function rotate(force) {
  step('2/3', '建会话', '开始轮换…');
  return new Promise((resolve) => {
    // --no-seed：省掉 sessions.mjs 里 10 秒的“等开场消息跑起来再取消”；面板重载会立刻打开新会话，
    //   侧边栏同样看得见（2026-11-12 实测：换会话 10.5s → 6.8s）。
    const args = [path.join(SHELL, 'scripts', '换会话.mjs'), PANEL, '--go', '--no-seed'];
    if (force) args.push('--force');
    let child;
    try {
      child = spawn(NODE, args, { cwd: SHELL, env: Object.assign({}, process.env, { DSH_HOME }), windowsHide: true });
    } catch (e) { fail(6, '启动换会话失败：' + ((e && e.message) || e)); }
    let all = '', buf = '', newId = '', got3 = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (e) { /* ignore */ } }, 180000);
    const onLine = (line) => {
      if (!line.trim()) return;
      say(line);
      const m = line.match(/新会话已建[：:]\s*(session-[0-9a-f-]{8,})/);
      if (m && !newId) { newId = m[1]; step('2/3', '建会话', newId); }
      // 换绑 + 重载合并成第 3 行：面板重载提示出现时才算做完（不额外占一行）
      if (!got3 && /面板会自动重载|reload-panels/.test(line)) { got3 = true; step('3/3', '换绑', 'json / 索引已回写 · 面板重载已触发'); }
    };
    const pump = (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { all += d; pump(d); });
    child.stderr.on('data', (d) => { all += d; pump(d); });
    child.on('error', (e) => { clearTimeout(timer); fail(6, '换会话进程启动失败：' + ((e && e.message) || e)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf.trim());
      if (timedOut) { fail(6, '轮换超过 180 秒被中止（可手动跑 换会话.mjs ' + PANEL + ' --go 复查）'); }
      if (code !== 0) {
        console.error('✗ 轮换失败（退出码 ' + code + '）：' + (all.split(/\r?\n/).filter((l) => /^\s*[·✗]/.test(l)).slice(-3).join(' ') || '见上方输出'));
        process.exit(code || 1);
      }
      if (!newId) {
        const m = all.match(/(session-[0-9a-f]{8}-[0-9a-f-]{27,})/);
        if (m) newId = m[1];
      }
      if (!got3) step('3/3', '换绑', 'json / 索引已回写（重载提示未出现，面板可手动 ⟳）');
      resolve({ newId });
    });
  });
}

// 8. 主流程
(async () => {
  const t0 = Date.now();
  if (MODE === 'transcript') writeTranscriptHandoff();
  else if (MODE === 'prompt') await waitPromptHandoff();
  else step('1/3', '交接', 'direct 模式：跳过写交接');

  if (HANDOFF_ONLY) { console.log('（--handoff-only：交接已处理，按参数要求不轮换）'); process.exit(0); }

  const r = await rotate(MODE === 'direct');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  // 9. 换完再确认 §〇 在（transcript 模式刚写过，这里只兜底）
  if (r.newId && fs.existsSync(HANDOFF)) {
    const sec = sec0Range(fs.readFileSync(HANDOFF, 'utf8'));
    if (!sec || !/上次交接/.test(sec.sec)) console.log('WARN: 已换会话，但 §〇 里找不到「上次交接」小节');
  }
  console.log('✓ 换会话完成（' + elapsed + ' 秒）');
  if (r.newId) console.log('NEWID: ' + r.newId);
  console.log('ELAPSED: ' + elapsed);
  process.exit(0);
})().catch((e) => { console.error('✗ 未处理的异常：' + ((e && e.stack) || e)); process.exit(1); });
