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
//   · 基本只读：不写 transcript、不改场景 JSON、不启停引擎（引擎生命周期归壳，见 AGENTS.md §8）。
//     唯一写操作是通道巡检时把 QQ 原生路由登记进 外壳\data\社交会话.json（派生索引，
//     不碰 transcript / 场景 / 引擎），供设置页与记忆回响共用。
//   · 通道状态要敢说「没通」：探不到就 off，装了没绑就 warn，**不许把「装了」显示成「通了」**。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const net = require('net');
const socialReply = require('./社交回复');

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
  // 微信通道的 prompt 头是「（微信私聊 · 张三 说）」/「（微信群聊「群名」 · 李四 说）」
  { key: 'wechat', re: /（微信|微信\s*私聊|微信\s*群聊|\[微信/ },
];
function platformOf(text) {
  const t = String(text || '');
  for (const p of PLATFORM_TAG) if (p.re.test(t)) return p.key;
  return 'other';
}

// 6.6 聚合消息流的人话标签：按聊天独立会话后，同一屏里会出现多个私聊/群聊，
//     只标「微信」不够 —— 用户要能一眼区分「微信 · 静音胡闹」和「微信群 · 一个儿子多个爹」。
//     ⛔ 不从正文猜聊天名：聊天名/类型来自 社交会话.json（通道写回的真源）。
const CHANNEL_LABEL = { wechat: '微信', qq: 'QQ', feishu: '飞书' };
function channelLabelOf(key) {
  const k = String(key || '');
  if (!k || k === 'other') return '其他';
  return CHANNEL_LABEL[k] || k;
}
function sessionLabelOf(entry) {
  const e = entry || {};
  const ch = channelLabelOf(e.channel);
  const typ = String(e.chatType || '') === 'group' ? '群' : '';
  // QQ 的 chatTitle 本身就是「（QQ 私聊）」，再加「私聊」会变成「QQ · 私聊 · （QQ 私聊）」。
  // 只有群聊才拼「群」，私聊直接用通道 + 聊天名，标签更短。
  const name = String(e.chatTitle || e.title || e.sessionTitle || e.sessionId || '').trim();
  return ch + (typ ? '群' : '') + (name ? ' · ' + name : '');
}

// 桥接配置的真实位置：插件按 用户主目录\.dsh 落（lib\env.js 的 CONFIG_FILE），不在引擎 home 里。
// 两处都找：引擎 home（换机器/自定义 DSH_HOME 的场景）优先，其次用户主目录。
function bridgeConfigPath(home) {
  const a = path.join(String(home || ''), 'qq-bridge.config.json');
  if (fs.existsSync(a)) return a;
  const b = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');
  return fs.existsSync(b) ? b : a;
}

// 7. 通道状态：QQ 桥接（OneBot 端口 + 配置）· 飞书（插件是否装）· 微信（壳里的微信通道状态文件）
//    state 只有三种：ok = 真在听/真能用；warn = 装了但没通；off = 没有/没听
const WX_STATUS_FILE = path.join(__dirname, 'data', '微信通道', '状态.json');

function wechatChannelState() {
  const st = readJson(WX_STATUS_FILE);
  if (!st || !st.at) {
    return {
      key: 'wechat', label: '微信', state: 'off',
      detail: '微信通道未启动（装好 whale_girl 后点卡片「启动」，或先点「自检」看缺哪一步）',
      account: '未启动', accountLabel: '未启动', rawAccount: '', pinnedAccount: '', pinnedAccountLabel: '',
      accounts: [], accountMismatch: false,
      peer: '', console: '',
      sessionIsolation: null,
      running: false, installed: false, port: 0
    };
  }
  const age = Date.now() - Number(st.at || 0);
  if (!Number.isFinite(age) || age > 30000) {
    return {
      key: 'wechat', label: '微信', state: st.installed ? 'warn' : 'off',
      detail: '通道状态已过期（工作台可能刚重启）：点「启动」或「自检」刷新',
      account: String(st.account || '未登录'), accountLabel: String(st.accountLabel || st.account || '未登录'),
      rawAccount: String(st.rawAccount || ''), pinnedAccount: String(st.pinnedAccount || ''),
      pinnedAccountLabel: String(st.pinnedAccountLabel || st.pinnedAccount || ''),
      accounts: Array.isArray(st.accounts) ? st.accounts : [], accountMismatch: !!st.accountMismatch,
      peer: '', console: '',
      sessionIsolation: st.sessionIsolation || null,
      running: false, installed: !!st.installed, port: st.adapterPort || 0
    };
  }
  const state = st.state === 'ok' || st.state === 'warn' ? st.state : 'off';
  return {
    key: 'wechat', label: '微信', state,
    detail: String(st.detail || ''),
    account: String(st.accountLabel || st.account || '未登录'),
    accountLabel: String(st.accountLabel || st.account || '未登录'),
    rawAccount: String(st.rawAccount || ''),
    pinnedAccount: String(st.pinnedAccount || ''),
    pinnedAccountLabel: String(st.pinnedAccountLabel || st.pinnedAccount || ''),
    accounts: Array.isArray(st.accounts) ? st.accounts : [],
    accountMismatch: !!st.accountMismatch,
    peer: '', console: '',
    sessionIsolation: st.sessionIsolation || null,
    running: !!st.running,
    installed: !!st.installed,
    port: st.adapterPort || 0,
    plugin: st.plugin || null
  };
}

async function channelStates(dshHome) {
  const home = String(dshHome || '');
  const cfg = readJson(bridgeConfigPath(home));
  // 外发闸门状态（2026-11-18）：QQ 插件可能被指到闸门端口，这时「3000 在听」不代表协议端在听。
  // 判据：桥接配置里的 onebotHttp 指向闸门端口 ⇒ 用闸门状态里的上游结论，别把闸门画成协议端。
  const gateSt = readJson(path.join(__dirname, 'data', '安全闸门', '状态.json'));
  const gateCfg = readJson(path.join(__dirname, 'data', '安全闸门.json')) || {};
  const gatePort = Number((gateCfg.qq && gateCfg.qq.listenPort) || 3100) || 3100;
  const gateFresh = !!(gateSt && gateSt.at && Date.now() - Number(gateSt.at) < 30000);
  const cfgHttpRaw = String((cfg && cfg.onebotHttp) || '');
  const viaGate = !!gatePort && new RegExp('127\\.0\\.0\\.1:' + gatePort + '\\b').test(cfgHttpRaw);
  const wsPort = portOf(cfg && cfg.wsUrl, 3001);
  const wsOn = await probePort(wsPort);
  let httpPort = portOf(cfgHttpRaw, 3000);
  let httpOn = false;
  if (viaGate) {
    httpPort = portOf(gateSt && gateSt.upstream, 3000);
    const gateListening = gateFresh ? !!gateSt.listening : await probePort(gatePort);
    httpOn = !!(gateListening && (gateFresh ? !!gateSt.upstreamOk : false));
    if (!gateFresh) httpOn = gateListening && await probePort(httpPort);
  } else {
    httpOn = await probePort(httpPort);
  }
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
        ? (viaGate
          ? '协议端在听（经安全闸门 ' + gatePort + ' → ' + httpPort + (wsOn ? ' · WS ' + wsPort : '') + '）'
          : '协议端在听（HTTP ' + httpPort + (wsOn ? ' · WS ' + wsPort : '') + '）')
        : (hasOnebot
          ? (viaGate
            ? 'QQ 已指向安全闸门，但闸门或协议端没通（闸门 ' + gatePort + ' / 上游 ' + httpPort + (wsOn ? ' · WS ' + wsPort : '') + '）'
            : '桥接插件已装，协议端未起（HTTP ' + httpPort + ' / WS ' + wsPort + ' 都没在听）')
          : '桥接插件未装'),
      account: cfg && cfg.selfUin ? '小号 ' + cfg.selfUin : '未绑小号',
      peer: cfg && cfg.peerUin ? String(cfg.peerUin) : '',
      console: 'snowluma',
      gate: { enabled: !!(gateCfg.enabled), viaGate: viaGate, listening: gateFresh ? !!gateSt.listening : false }
    },
    {
      key: 'feishu',
      label: '飞书',
      state: hasIm ? 'warn' : 'off',
      detail: hasIm ? 'dsh-im 已装，凭据与白名单在「设置 → IM机器人」绑' : 'dsh-im 未装',
      account: hasIm ? '自建应用（凭据未绑）' : '未装',
      peer: ''
    },
    wechatChannelState()
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

// 9. 缓存（2026-11-17）：三个面板（QQ 卡 / 飞书卡 / 全部消息）每 4 秒各调一次 flow()，
//    不缓存就是每 4 秒全量解压 3 次 —— 消息越多越慢。缓存以「文件 size + mtimeMs」为失效条件：
//    文件没变（没有新消息）就直接复用；变了只重解压一次（同文件的并发调用共用同一个 Promise）。
//    ⚠ 缓存的只是「精简消息」，不是 events —— 一份几万条 events 的原始对象会把内存撑爆。
const MAX_TRANSCRIPT_FILES = 4;
const MAX_CACHED_MESSAGES = 20000;
const CHANNEL_CACHE_MS = 10000;
const TITLE_CACHE_MS = 30000;

// 9.1 过滤：since / before / q 都可选；语义是「时间升序全集里取子集」，分页由调用方切片
//     · since  只留 >= since（时间范围：今天 / 7 天 / 30 天 / 归档游标）
//     · before 只留 < before（「加载更早」：传当前最早一条 +1ms，同毫秒的消息不丢，前端再去重）
//     · q      正文包含关键字（不区分大小写）
function filterMessages(messages, o) {
  const since = Number((o && o.since) || 0);
  const before = Number((o && o.before) || 0);
  const q = String((o && o.q) || '').trim().toLowerCase();
  if (!since && !before && !q) return messages || [];
  return (messages || []).filter(function (m) {
    if (since && m.at < since) return false;
    if (before && m.at >= before) return false;
    if (q && String(m.text || '').toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

// 10. 对外：一条 flow() 拿全（消息 + 通道 + 会话信息 + 分页元信息）
function createService(opts) {
  const dshHome = (opts && opts.dshHome) || process.env.DSH_HOME || '';
  const trCache = new Map();      // file -> { size, mtimeMs, messages|null, events, truncated }
  const trInflight = new Map();   // file -> Promise<{messages, events, truncated}|null>
  let chCache = null;             // { at, value: channels[] }（模板，返回前浅拷贝）
  const titleCache = new Map();   // title -> { at, value: {id, at}|null }

  function statOf(file) {
    try {
      const s = fs.statSync(file);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (e) { return null; }
  }

  function trimTrCache() {
    while (trCache.size > MAX_TRANSCRIPT_FILES) {
      const first = trCache.keys().next().value;
      trCache.delete(first);
    }
  }

  // 10.1 读一份转录（带缓存 + 单飞）：文件变了才重解压；解不开缓存 null，文件没变不反复重试
  function loadAllMessages(file) {
    const st = statOf(file);
    if (!st) { trCache.delete(file); return Promise.resolve(null); }
    const hit = trCache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      trCache.delete(file); trCache.set(file, hit);   // LRU：最近用过的挪到末尾
      return Promise.resolve(hit.messages
        ? { messages: hit.messages, events: hit.events, truncated: hit.truncated }
        : null);
    }
    if (trInflight.has(file)) return trInflight.get(file);
    const p = Promise.resolve().then(function () {
      const events = readEvents(file);
      if (!events) {
        trCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, messages: null, events: 0, truncated: false });
        trimTrCache();
        return null;
      }
      let messages = messagesOf(events, 0);   // 0 = 全量（不截最后 N 条）
      let truncated = false;
      if (messages.length > MAX_CACHED_MESSAGES) {
        messages = messages.slice(-MAX_CACHED_MESSAGES);
        truncated = true;
      }
      trCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, messages, events: events.length, truncated });
      trimTrCache();
      return { messages, events: events.length, truncated };
    }).then(function (v) { trInflight.delete(file); return v; },
           function (e) { trInflight.delete(file); throw e; });
    trInflight.set(file, p);
    return p;
  }

  // 10.2 通道探测结果缓存 10 秒：探端口是网络操作，3 个面板各 4 秒探一次没必要
  async function cachedChannelStates() {
    const now = Date.now();
    if (chCache && now - chCache.at < CHANNEL_CACHE_MS) {
      return chCache.value.map(function (c) { return Object.assign({}, c); });
    }
    // 通道巡检时顺手把 QQ 的原生路由登记进社交会话总表（只读第三方配置，写的是
    // 工作台自己的 data/社交会话.json）。配置没变时 syncQqSessions 不会重复写盘。
    try { socialReply.syncQqSessions(dshHome); } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[social] sync QQ sessions failed', e);
    }
    const v = await channelStates(dshHome);
    chCache = { at: now, value: v.map(function (c) { return Object.assign({}, c); }) };
    return v;
  }

  // 10.3 标题认会话缓存 30 秒（换会话后面板的 sessionId 通常已经换了，走不到这里）
  function cachedResolveByTitle(title) {
    const key = String(title || '').trim();
    if (!key) return null;
    const now = Date.now();
    const hit = titleCache.get(key);
    if (hit && now - hit.at < TITLE_CACHE_MS) return hit.value;
    const v = resolveByTitle(dshHome, key);
    titleCache.set(key, { at: now, value: v });
    if (titleCache.size > 16) titleCache.delete(titleCache.keys().next().value);
    return v;
  }

  // 10.4 聚合流（2026-11-19）：按聊天独立 DSH 会话后，一条消息不再都落进人格主会话。
  //      「全部消息」如果还只读面板上写死的那一个 sessionId，就会永远显示旧消息/空列表。
  //      这里按 外壳\data\社交会话.json 的总表把每个私聊/群聊的消息合并、打上来源标签，
  //      再按时间/搜索/「只看某个会话」过滤。只读转录 + 读总表，不写会话。
  async function flowAll(a) {
    const limit = Math.max(1, Math.min(200, Number(a.limit) || 40));
    const since = Number(a.since) || 0;
    const before = Number(a.before) || 0;
    const q = String(a.q || '').trim();
    const onlySession = String(a.onlySession || '').trim();

    // 1) 先让总表跟上微信映射 / QQ 原生路由（失败不阻断：能读到多少会话就聚合多少）
    let map = { version: 1, updatedAt: 0, sessions: {} };
    try { socialReply.migrateLegacyWechat(dshHome); } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[social] aggregate migrate wechat failed', e);
    }
    try { socialReply.syncQqSessions(dshHome); } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[social] aggregate sync QQ failed', e);
    }
    try { map = socialReply.readSessions(); } catch (e) {
      if (process.env.DSH_DEBUG) console.warn('[social] aggregate read sessions failed', e);
    }

    // 2) 总表里每条会话都要；面板绑定的 sessionId 如果不在总表里（例如人格主会话），也带上，
    //    否则「全部消息」会漏掉用户在人格面板里直接教她的内容。
    const entries = [];
    const seen = new Set();
    for (const [sid, item] of Object.entries((map && map.sessions) || {})) {
      if (!sid) continue;
      entries.push(Object.assign({}, item || {}, { sessionId: sid }));
      seen.add(sid);
    }
    const boundId = String(a.sessionId || '').trim();
    if (boundId && !seen.has(boundId)) {
      entries.push({
        sessionId: boundId,
        channel: 'other',
        chatType: '',
        chatId: '',
        chatTitle: String(a.sessionTitle || '人格主会话'),
        title: String(a.sessionTitle || '人格主会话'),
        senderName: ''
      });
    }

    // 3) 逐会话读转录、合并消息；每条消息带上会话来源，前端才能画「微信 · 静音胡闹」。
    const sessions = [];
    const combined = [];
    let events = 0;
    let truncated = false;
    let foundAny = false;
    for (const e of entries) {
      const file = transcriptOf(dshHome, e.sessionId);
      const meta = {
        sessionId: e.sessionId,
        channel: String(e.channel || 'other'),
        chatType: String(e.chatType || ''),
        chatId: String(e.chatId || ''),
        chatTitle: String(e.chatTitle || ''),
        title: String(e.title || ''),
        senderName: String(e.senderName || ''),
        channelLabel: channelLabelOf(e.channel),
        label: sessionLabelOf(e)
      };
      if (!file) {
        sessions.push(Object.assign({}, meta, { n: 0, lastAt: 0, found: false }));
        continue;
      }
      foundAny = true;
      const loaded = await loadAllMessages(file);
      if (!loaded) {
        sessions.push(Object.assign({}, meta, { n: 0, lastAt: 0, found: false }));
        continue;
      }
      events += Number(loaded.events) || 0;
      truncated = truncated || !!loaded.truncated;
      const msgs = loaded.messages || [];
      sessions.push(Object.assign({}, meta, {
        n: msgs.length,
        lastAt: msgs.length ? msgs[msgs.length - 1].at : 0,
        found: true
      }));
      for (const m of msgs) {
        // 入站消息的正文里常带平台标记，优先用它；她自己的回复没有标记，用会话登记的平台兜底。
        const key = (m.key && m.key !== 'other') ? m.key : (meta.channel || 'other');
        combined.push(Object.assign({}, m, meta, { key: key }));
      }
    }

    // 4) 合并后必须先按时间升序排——各会话是分别读出来的，不能拿「最后一条会话」的尾部当最新消息。
    combined.sort(function (x, y) { return (Number(x.at) || 0) - (Number(y.at) || 0); });
    // 5) 「只看某个会话」→ 时间/搜索 → 分页。会话下拉的计数用全量 n，筛选后才用 page.total。
    const scoped = onlySession
      ? combined.filter(function (m) { return m.sessionId === onlySession; })
      : combined;
    const base = filterMessages(scoped, { since: since, q: q });
    const filtered = before ? filterMessages(base, { before: before }) : base;
    const page = filtered.slice(-limit);
    sessions.sort(function (x, y) { return (Number(y.lastAt) || 0) - (Number(x.lastAt) || 0); });

    // 6) 通道状态与统计照旧；统计基于 base，避免被 limit / 分页截断成假数
    const channels = await cachedChannelStates();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const t0 = dayStart.getTime();
    const byKey = {};
    for (const m of base) {
      const k = m.key || 'other';
      (byKey[k] = byKey[k] || []).push(m);
    }
    for (const c of channels) {
      const arr = byKey[c.key] || [];
      c.n = arr.length;
      c.today = arr.filter(function (m) { return m.at >= t0; }).length;
      const last = arr.length ? arr[arr.length - 1] : null;
      c.last = last ? { at: last.at, role: last.role, text: last.text } : null;
    }

    // 7) 只挑一条会话时，session 信息也跟着切，空列表提示才能说清是哪条会话没消息
    const picked = onlySession ? sessions.find(function (s) { return s.sessionId === onlySession; }) : null;
    return {
      ok: true,
      at: Date.now(),
      aggregate: true,
      session: {
        id: onlySession || '*',
        title: picked ? picked.label : (onlySession || '全部会话'),
        found: onlySession ? !!picked && picked.found : foundAny,
        resolvedBy: 'all',
        events: events
      },
      sessions: sessions,
      channels: channels,
      others: (byKey.other || []).length,
      messages: page,
      page: {
        total: base.length,
        returned: page.length,
        hasMore: filtered.length > page.length,
        oldestAt: page.length ? page[0].at : 0,
        truncated: truncated
      }
    };
  }

  return {
    async flow(args) {
      const a = args || {};
      if (a.allSessions || a.mode === 'all') return flowAll(a);
      const sessionId = String(a.sessionId || '');
      const sessionTitle = String(a.sessionTitle || '');
      const limit = Math.max(1, Math.min(200, Number(a.limit) || 40));
      const since = Number(a.since) || 0;
      const before = Number(a.before) || 0;
      const q = String(a.q || '').trim();

      // 1) 先按面板给的 sessionId 找转录
      let sid = sessionId;
      let file = sid ? transcriptOf(dshHome, sid) : null;
      let resolvedBy = file ? 'id' : '';
      // 2) 找不到（换过会话 / 面板还没绑）⇒ 按标题重新认一条，别让面板永远空着
      if (!file && sessionTitle) {
        const hit = cachedResolveByTitle(sessionTitle);
        if (hit) {
          sid = hit.id;
          file = transcriptOf(dshHome, sid);
          resolvedBy = file ? 'title' : '';
        }
      }

      // 3) 取全量消息（缓存命中就不重解压），再按 since/before/q 过滤，最后取最后 limit 条
      const loaded = file ? await loadAllMessages(file) : null;
      const all = loaded ? loaded.messages : [];
      // base = 整个筛选范围（时间范围 + 搜索，不分页）；filtered = 再按 before 切到「更早」那一页
      const base = filterMessages(all, { since, q });
      const filtered = before ? filterMessages(base, { before }) : base;
      const page = filtered.slice(-limit);

      // 4) 通道状态（缓存 10 秒），再按平台归堆统计 —— 统计基于 base（整个范围），
      //    这样卡片上的「今日 / 近 N 条」不会被 limit 或分页截断成假数
      const channels = await cachedChannelStates();
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const t0 = dayStart.getTime();
      const byKey = {};
      for (const m of base) {
        const k = m.key || 'other';
        (byKey[k] = byKey[k] || []).push(m);
      }
      for (const c of channels) {
        const arr = byKey[c.key] || [];
        c.n = arr.length;
        c.today = arr.filter(function (m) { return m.at >= t0; }).length;
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
          events: loaded ? loaded.events : 0
        },
        channels,
        others: other.length,
        messages: page,
        // 5) 分页/搜索元信息：前端拿它画「共 N 条 / 显示 M 条 / 加载更早 / 缓存截断」
        page: {
          total: base.length,
          returned: page.length,
          hasMore: filtered.length > page.length,
          oldestAt: page.length ? page[0].at : 0,
          truncated: !!(loaded && loaded.truncated)
        }
      };
    }
  };
}

module.exports = { createService, unzstdAll, readEvents, transcriptOf, messagesOf, textOf, channelStates, probePort, resolveByTitle, platformOf, filterMessages };
