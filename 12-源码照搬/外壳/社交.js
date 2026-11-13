// 社交.js —— 「社交」场景消息流的数据面（2026-11-13）
//
// 干什么：给「社交」场景的 so-msg 面板供数 —— 一条消息流 + 几条通道状态。
//   用户的原话是「没有社交场景的面板，功能看上去就是断的」：通道归协议端，但**看得见**归面板。
//
// 数据源（只读，三处）：
//   ① 引擎 transcript：引擎数据\.dsh\sessions\<cwd 编码目录>\<会话id>\session.v4.jsonl.zstd
//      · 里面 user/message = 对面进来的（IM 通道投进来的也是它），assistant/message = 她回的；
//      · ⛔ 不解 transcript 就等于没有消息流，口径照抄 工具\派发-公共.mjs 的 unzstdAll / readEvents。
//   ② OneBot 端口：qq-bridge.config.json 里的 onebotHttp / wsUrl，探 3000 / 3001 有没有在听。
//      · 端口在听 = 协议端（NapCat / SnowLuma / Lagrange）真起来了；插件「QQ 桥接」页填的也是这两个。
//   ③ DSH profile 的 node_modules：@xmanrui/dsh-im / dsh-onebot-channel 装没装。
//
// 规矩：
//   · 只读：不写 transcript、不改场景 JSON、不启停引擎（引擎生命周期归壳，见 AGENTS.md §8）。
//   · 通道状态要敢说「没通」：探不到就 off，装了没绑就 warn，**不许把「装了」显示成「通了」**。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const net = require('net');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NOISE = ['<system-reminder', '<permission', '<environment', '<agent', '<tool', '<workspace',
  '【场景：'];   // 换会话时工具注入的开场消息（列记忆接力点 + 只回一句「已读交接」），不算聊天

// 1. 解 transcript：引擎按「一次写一帧」追加，zstd 多帧拼接（只解第一帧会只剩几百字节）
function unzstdAll(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) >= 0) { starts.push(i); i += ZSTD_MAGIC.length; }
  if (!starts.length) return zlib.zstdDecompressSync(buf);
  const parts = [];
  let pending = null;
  for (let k = 0; k < starts.length; k++) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    const t = pending ? Buffer.concat([pending, seg]) : seg;
    try { parts.push(zlib.zstdDecompressSync(t)); pending = null; } catch (e) {
      if (k === starts.length - 1 && parts.length) { pending = null; break; }   // 尾帧写了一半，丢掉
      pending = t;
    }
  }
  if (pending) parts.push(zlib.zstdDecompressSync(pending));
  return Buffer.concat(parts);
}

// 2. 找会话转录：引擎按 cwd 分目录，目录名被编码过 ⇒ 不推导文件名，直接遍历
function transcriptOf(dshHome, sessionId) {
  const base = path.join(String(dshHome || ''), 'sessions');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, String(sessionId || ''), 'session.v4.jsonl.zstd');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 3. 读事件：坏行（尾行只写一半）跳过；整个文件解不开返回 null（调用方显示「读不到」）
function readEvents(file) {
  if (!file || !fs.existsSync(file)) return null;
  let txt;
  try { txt = unzstdAll(fs.readFileSync(file)).toString('utf8'); } catch (e) { return null; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* 半行 */ }
  }
  return out;
}

// 4. 取正文：只要 text 段（reasoning 不要）；系统注入（AGENTS.md / system-reminder）不是人说的话，滤掉
function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || c.type !== 'text' || typeof c.text !== 'string') continue;
    const t = c.text.trim();
    if (!t) continue;
    if (NOISE.some((p) => t.toLowerCase().startsWith(p))) continue;
    parts.push(t);
  }
  return parts.join('\n').trim();
}

// 5. 事件 → 消息流：user = 对面（含 IM 通道投进来的），assistant = 她
//    ⛔ user/message 里混着引擎注入的上下文（AGENTS.md / runtime-context / skill 目录 / 时间快照，
//        kind = agent-instructions / runtime-context / skill-catalog / time-context）。
//        只有 source.kind === 'user' 才是真有人说话 —— 不筛这一下，面板会满屏「Current runtime context」。
function messagesOf(events, limit) {
  const out = [];
  for (const e of events || []) {
    if (!e || !e.type) continue;
    // 通道消息（QQ / 飞书）不走 user/message，而是由桥接插件以 agent/inbox/spliced 投递进来；
    // 不认这一支，面板与「通道记忆」都会漏掉真正聊过的内容（2026-11-13 修）。
    if (e.type === 'agent/inbox/spliced') {
      const ins = (e.data && e.data.inserted) || [];
      for (const it of ins) {
        if (!it) continue;
        const rk = (it.role === 'assistant' || it.role === 'agent') ? 'her' : 'them';
        if (rk === 'them' && !(it.source && it.source.kind === 'user')) continue;
        const t1 = textOf(it.content || (it.message && it.message.content));
        if (!t1) continue;
        out.push({ at: Number(it.time || e.time) || 0, role: rk, key: platformOf(t1), text: t1.length > 420 ? t1.slice(0, 420) + '…' : t1 });
      }
      continue;
    }
    let role = '';
    let content = null;
    if (e.type === 'user/message') {
      if (!(e.data && e.data.source && e.data.source.kind === 'user')) continue;
      role = 'them'; content = e.data.content;
    } else if (e.type === 'assistant/message') {
      role = 'her'; content = e.data && e.data.message && e.data.message.content;
    } else continue;
    const t = textOf(content);
    if (!t) continue;
    out.push({
      at: Number(e.time) || 0,
      role,
      key: platformOf(t),
      text: t.length > 420 ? t.slice(0, 420) + '…' : t
    });
  }
  return limit > 0 ? out.slice(-limit) : out;
}

// 6. 端口探测：只连 200ms，不断言服务类型，能连上就算「在听」
function probePort(port, timeoutMs) {
  const p = Number(port);
  if (!p || p <= 0 || p > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: p });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs || 200, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function portOf(urlOrNum, fallback) {
  if (typeof urlOrNum === 'number' && urlOrNum > 0) return urlOrNum;
  const m = String(urlOrNum || '').match(/(\d{2,5})\s*\/?\s*$/);
  return m ? Number(m[1]) : Number(fallback);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// 6.5 消息归平台：桥接插件在正文前加前缀（QQ 路由前缀「（QQ 私聊）」），据此把消息分到各平台卡片。
//     认不出前缀的统一进 other，不硬猜（宁可显示「未标来源」也不把飞书的消息算给 QQ）。
const PLATFORM_TAG = [
  // 通道消息的真实形态是「（关于他：…）\n（时间）…（QQ 私聊·用户本人 QQ 2310468741）内容」——
  // 前缀不一定在开头，所以按「任意位置出现」认，别只认行首（2026-11-13 修）。
  { key: 'qq', re: /（QQ|QQ\s*私聊|QQ 群聊|\[QQ/ },
  { key: 'feishu', re: /（飞书|飞书\s*私聊|\[飞书/ },
];
function platformOf(text) {
  const t = String(text || '');
  for (const p of PLATFORM_TAG) if (p.re.test(t)) return p.key;
  return 'other';
}

// 桥接配置的真实位置：插件按 用户主目录\.dsh 落（lib\env.js 的 CONFIG_FILE），不在引擎 home 里。
// 两处都找：引擎 home（换机器/自定义 DSH_HOME 的场景）优先，其次用户主目录。
function bridgeConfigPath(home) {
  const a = path.join(String(home || ''), 'qq-bridge.config.json');
  if (fs.existsSync(a)) return a;
  const b = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');
  return fs.existsSync(b) ? b : a;
}

// 7. 通道状态：QQ 桥接（OneBot 端口 + 配置）· 飞书（插件是否装）
//    state 只有三种：ok = 真在听/真能用；warn = 装了但没通；off = 没有/没听
async function channelStates(dshHome) {
  const home = String(dshHome || '');
  const cfg = readJson(bridgeConfigPath(home));
  const httpPort = portOf(cfg && cfg.onebotHttp, 3000);
  const wsPort = portOf(cfg && cfg.wsUrl, 3001);
  const httpOn = await probePort(httpPort);
  const wsOn = await probePort(wsPort);
  const on = httpOn || wsOn;

  const nm = path.join(home, 'profiles', 'web', 'node_modules');
  const hasIm = fs.existsSync(path.join(nm, '@xmanrui', 'dsh-im'));
  const hasOnebot = fs.existsSync(path.join(nm, 'dsh-onebot-channel'));

  return [
    {
      key: 'qq',
      label: 'QQ',
      state: on ? 'ok' : (hasOnebot ? 'warn' : 'off'),
      detail: on
        ? '协议端在听（HTTP ' + httpPort + (wsOn ? ' · WS ' + wsPort : '') + '）'
        : (hasOnebot
          ? '桥接插件已装，协议端未起（HTTP ' + httpPort + ' / WS ' + wsPort + ' 都没在听）'
          : '桥接插件未装'),
      account: cfg && cfg.selfUin ? '小号 ' + cfg.selfUin : '未绑小号',
      peer: cfg && cfg.peerUin ? String(cfg.peerUin) : '',
      console: 'snowluma'
    },
    {
      key: 'feishu',
      label: '飞书',
      state: hasIm ? 'warn' : 'off',
      detail: hasIm ? 'dsh-im 已装，凭据与白名单在「设置 → IM机器人」绑' : 'dsh-im 未装',
      account: hasIm ? '自建应用（凭据未绑）' : '未装',
      peer: ''
    }
  ];
}

// 8. 按标题认会话：换会话之后面板里写死的 sessionId 会过期，靠标题从投影缓存里重新认一条
//    口径照抄 工具\派发-公共.mjs 的 loadSessions：逐会话缓存是真源，标题要逐字相等，取最近建的那条
function resolveByTitle(dshHome, title) {
  const want = String(title || '').trim();
  if (!want) return null;
  const dir = path.join(String(dshHome || ''), 'storages', 'session_projcache', 'sessions');
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(dir, f));
    const rec = j && j.record;
    if (!rec) continue;
    const rows = rec.rows || {};
    const t = String((rows.title && rows.title.val) || '').trim();
    if (t !== want) continue;
    const at = Number((rec.identity && rec.identity.createdAt) || 0);
    const id = f.replace(/\.json$/, '');
    if (!best || at > best.at) best = { id, at };
  }
  return best;
}

// 9. 对外：一条 flow() 拿全（消息 + 通道 + 会话信息）
function createService(opts) {
  const dshHome = (opts && opts.dshHome) || process.env.DSH_HOME || '';
  return {
    async flow(args) {
      const a = args || {};
      const sessionId = String(a.sessionId || '');
      const sessionTitle = String(a.sessionTitle || '');
      const limit = Math.max(1, Math.min(200, Number(a.limit) || 40));

      // 1) 先按面板给的 sessionId 找转录
      let sid = sessionId;
      let file = sid ? transcriptOf(dshHome, sid) : null;
      let resolvedBy = file ? 'id' : '';
      // 2) 找不到（换过会话 / 面板还没绑）⇒ 按标题重新认一条，别让面板永远空着
      if (!file && sessionTitle) {
        const hit = resolveByTitle(dshHome, sessionTitle);
        if (hit) {
          sid = hit.id;
          file = transcriptOf(dshHome, sid);
          resolvedBy = file ? 'title' : '';
        }
      }
      const events = file ? readEvents(file) : null;
      const messages = events ? messagesOf(events, limit) : [];
      const channels = await channelStates(dshHome);

      // 3) 按平台归堆：卡片面板要「这个平台今天几条、最后一条是谁说的什么」
      //    口径：today 用本机日历日比；last 取该平台最后一条（role 用 them/her 原值）
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const t0 = dayStart.getTime();
      const byKey = {};
      for (const m of messages) {
        const k = m.key || 'other';
        (byKey[k] = byKey[k] || []).push(m);
      }
      for (const c of channels) {
        const arr = byKey[c.key] || [];
        c.n = arr.length;
        c.today = arr.filter((m) => m.at >= t0).length;
        const last = arr.length ? arr[arr.length - 1] : null;
        c.last = last ? { at: last.at, role: last.role, text: last.text } : null;
      }
      const other = byKey.other || [];

      return {
        ok: true,
        at: Date.now(),
        session: {
          id: sid,
          title: sessionTitle,
          found: !!file,
          resolvedBy,
          events: events ? events.length : 0
        },
        channels,
        others: other.length,
        messages
      };
    }
  };
}

module.exports = { createService, unzstdAll, readEvents, transcriptOf, messagesOf, textOf, channelStates, probePort, resolveByTitle, platformOf };
