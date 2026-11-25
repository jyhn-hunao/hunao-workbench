#!/usr/bin/env node
// @功能台 {"name":"她在B站说话","group":"社交","freq":"daily","plain":"查/评论/私信/动态/搜人/关注/取关：用小号做事，写操作带额度与冷却；--dry 只打印，发后回读。","why":"生活场景对外说话（评论/私信/动态）加上 B 站唯一没有开放平台接口的写操作（关注/取关）：都要可控、防重复。","label":"B站说话","timeout":120000}
// B站操作.mjs —— 生活场景对外说话（2026-11-25）
//
// 三条出口 + 一个关注：
//   · 评论：视频评论区发一条（可带 @ 主人）
//   · 私信：只发给主人在 生活\发布.json 里配置的 ownerMid（默认空 = 未开）
//   · 动态：纯文字动态
//   · 关注/取关：官方开放平台没这个接口，只能打网页端 x/relation/modify（幂等，已关注不重复点）
//     搜人（名字→mid）走 WBI 签名的 search/type，见 内容源\bilibili.mjs 的 searchUp
//
// 账号：壳从生活场景网页面板分区（persist:embed-bv-web）自动同步到 外壳\data\bili-account.json；
//   用户只需在「生活」场景的网页里登录小号，不用手填 cookie。
//
// 克制（对标 dsh-bili-whale 的写预算，数值写死，不给旋钮）：
//   · 写 12/时 · 30/天；两次写至少隔 120 秒；同一视频 7 天只评论一次
//   · --dry 只打印请求（不落盘、不扣额度）；--go 才真发
//   · 发后必回读：评论回读评论区找自己那条；私信/动态以平台返回 code=0 + 记录为准
//
// 用法：
//   node 工具\B站操作.mjs 状态
//   node 工具\B站操作.mjs 评论 --bv BV1xx --说 "…" [--dry]
//   node 工具\B站操作.mjs 私信 --说 "…" [--dry]
//   node 工具\B站操作.mjs 动态 --说 "…" [--dry]
//   node 工具\B站操作.mjs 搜人 --名 "大肥鱼小课堂"   名字 → mid（WBI 签名，只读）
//   node 工具\B站操作.mjs 关注 --mid <uid> [--dry]   关注（也可 --名 "…" 自动认 mid）
//   node 工具\B站操作.mjs 取关 --mid <uid> [--dry]
//   node 工具\B站操作.mjs 额度                     查看今天/本小时用量与冷却
//
// 退出码：0 成功（发成功 / dry / 状态）· 1 额度或冷却挡住 / 发送失败 · 2 账号或参数不成立

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as biliSrc from './内容源/bilibili.mjs';
import { load as loadRhythm } from './生活节奏.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHELL = path.join(ROOT, '外壳');
const MEM = path.join(process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh'), '场景记忆', '生活');
const DATA_DIR = path.join(process.env.DSH_SHELL_DATA || path.join(SHELL, 'data'));
const ACCOUNT_FILE = path.join(DATA_DIR, 'bili-account.json');
const PUB_FILE = path.join(MEM, '发布.json');
const QUOTA_FILE = path.join(MEM, '发布额度.json');
const LOG_FILE = path.join(MEM, '发布日志.md');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// 说话额度（2026-11-25 起真源是 生活\节奏.json 的 comment 段，面板「生活 → 节奏」可改）
const RHYTHM = loadRhythm();
const COMMENT_CFG = RHYTHM.comment;
const HOUR_MAX = COMMENT_CFG.hourMax;
const DAY_MAX = COMMENT_CFG.dayMax;
const COOLDOWN_MS = COMMENT_CFG.cooldownSec * 1000;
const VIDEO_COOLDOWN_MS = COMMENT_CFG.videoCooldownDays * 24 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '');
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const say = (s) => console.log(s);

function readJson(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function dayKey() {
  return stamp().slice(0, 10);
}
function hourKey() {
  return stamp().slice(0, 10) + 'T' + stamp().slice(11, 13);
}

// 1. 账号：壳同步的 bili-account.json
function loadAccount() {
  const acc = readJson(ACCOUNT_FILE, null);
  if (!acc || !acc.sessdata) return null;
  const bits = [];
  bits.push('SESSDATA=' + acc.sessdata);
  if (acc.biliJct) bits.push('bili_jct=' + acc.biliJct);
  if (acc.buvid3) bits.push('buvid3=' + acc.buvid3);
  if (acc.dedeUserID) bits.push('DedeUserID=' + acc.dedeUserID);
  return { ...acc, cookie: bits.join('; '), csrf: String(acc.biliJct || '') };
}

// 1.5 出口审批：尊重 设置.json 的 approval.outbound
//   read = 直接发（她用自己的小号说话，主人已经点头过）；confirm = 只把内容打出来等人点头，退出码 1
//   改这一项在「设置 · 规矩 · 对外」，不用手改 JSON。
function outboundMode() {
  const s = readJson(path.join(DATA_DIR, 'pet', '设置.json'), null);
  const m = String((s && s.approval && s.approval.outbound) || 'read').trim();
  return m === 'confirm' ? 'confirm' : 'read';
}
function gateOutbound(kind, text) {
  if (outboundMode() === 'read') return 0;
  say('· 出口审批是「要点头」（设置 · 规矩 · 对外）：这条没发出去');
  say('  ' + kind + '：' + text);
  say('  改成「直接发」再跑；或到 待批准 队列点一下。');
  return 1;
}

// 2. 额度账：小时/天/冷却/同视频 7 天
function readQuota() {
  const q = readJson(QUOTA_FILE, null) || {};
  const day = dayKey();
  const hour = hourKey();
  if (q.day !== day) { q.day = day; q.dayCount = 0; }
  if (q.hourKey !== hour) { q.hourKey = hour; q.hourCount = 0; }
  q.videos = q.videos || {};
  q.dayCount = Number(q.dayCount) || 0;
  q.hourCount = Number(q.hourCount) || 0;
  q.lastAt = Number(q.lastAt) || 0;
  return q;
}
function checkQuota(q, bv) {
  if (q.hourCount >= HOUR_MAX) return '本小时写满了（' + q.hourCount + '/' + HOUR_MAX + '）';
  if (q.dayCount >= DAY_MAX) return '今天写满了（' + q.dayCount + '/' + DAY_MAX + '）';
  const since = Date.now() - q.lastAt;
  if (q.lastAt && since < COOLDOWN_MS) return '冷却中，还差 ' + Math.ceil((COOLDOWN_MS - since) / 1000) + ' 秒';
  if (bv && q.videos[bv] && Date.now() - q.videos[bv] < VIDEO_COOLDOWN_MS) {
    return '这个视频 7 天内已经评论过（' + new Date(q.videos[bv]).toLocaleDateString() + '）';
  }
  return '';
}
function markQuota(q, bv) {
  q.hourCount += 1;
  q.dayCount += 1;
  q.lastAt = Date.now();
  if (bv) q.videos[bv] = Date.now();
  // 视频记录只留 60 天
  const keep = {};
  for (const [k, v] of Object.entries(q.videos)) if (Date.now() - Number(v) < 60 * 86400000) keep[k] = v;
  q.videos = keep;
  writeJson(QUOTA_FILE, q);
}
function appendLog(line) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const head = fs.existsSync(LOG_FILE) ? '' : '# 发布日志\n\n> 一行一条：时间 · 出口 · 内容首行 · 结果。只追加。\n\n';
  fs.writeFileSync(LOG_FILE, head + '- ' + line + '\n', { flag: 'a' });
}

// 3. 平台请求（统一带 cookie + csrf）
async function api(url, { method = 'GET', form = null, acc } = {}) {
  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: acc.cookie };
  let body = null;
  if (form) {
    body = new URLSearchParams(form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(url, { method, headers, body });
  if (!r.ok) throw new Error('B站 HTTP ' + r.status);
  const j = await r.json();
  if (Number(j.code) !== 0) throw new Error('B站 code=' + j.code + '：' + (j.message || ''));
  return j.data;
}

async function nav(acc) {
  return api('https://api.bilibili.com/x/web-interface/nav', { acc });
}

// 4. 评论：--bv + --说；发后回读
async function cmdComment() {
  const bv = String(val('--bv', '')).match(/BV[0-9A-Za-z]+/);
  const text = String(val('--说', '')).trim();
  if (!bv) { say('✗ 缺 --bv BVxxx'); return 2; }
  if (!text) { say('✗ 缺 --说 "想说的话"'); return 2; }
  const acc = loadAccount();
  if (!acc) { say('✗ 没有小号登录态：去生活场景网页登录小号，再点面板「同步账号」'); return 2; }
  const pub = readJson(PUB_FILE, {});
  if (pub.commentEnabled === false) { say('✗ 评论出口在 发布.json 里关着'); return 2; }
  if (COMMENT_CFG.enabled === false) { say('✗ 评论总开关关着（面板「生活 → 节奏 → 什么时候评论」打开它）'); return 2; }
  const q = readQuota();
  const block = checkQuota(q, bv[0]);
  if (block) { say('✗ ' + block); return 1; }

  const d = await api('https://api.bilibili.com/x/web-interface/view?bvid=' + bv[0], { acc });
  const aid = Number(d.aid) || 0;
  if (!aid) { say('✗ 拿不到 aid'); return 2; }

  const form = { oid: String(aid), type: '1', message: text, csrf: acc.csrf };
  if (has('--dry')) {
    say('--dry：不发送、不扣额度');
    say('POST https://api.bilibili.com/x/v2/reply/add');
    say('form=' + JSON.stringify(form));
    return 0;
  }
  const gate = gateOutbound('评论 · BV ' + bv[0], text);
  if (gate) return gate;
  const res = await api('https://api.bilibili.com/x/v2/reply/add', { method: 'POST', form, acc });
  const rpid = String((res && (res.rpid || res.rp_id)) || '');
  markQuota(q, bv[0]);
  // 回读：评论区按时间倒序找自己那条（最多等 3 次）
  let found = false;
  for (let i = 0; i < 3 && rpid; i++) {
    try {
      const c = await api('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&ps=20&pn=1&sort=2', { acc });
      found = (c.replies || []).some((r) => String(r.rpid) === rpid);
      if (found) break;
    } catch (e) { /* 回读失败不影响已发出 */ }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  appendLog(stamp() + ' · 评论 · BV ' + bv[0] + ' · ' + text.slice(0, 30) + ' · rpid=' + (rpid || '?') + (found ? ' · 回读✓' : ' · 回读未命中'));
  say('✓ 评论已发（rpid ' + (rpid || '未知') + (found ? '，回读确认在' : '，回读暂未命中，过会儿再看') + '）');
  return 0;
}

// 5. 私信：只发 ownerMid
async function cmdDm() {
  const text = String(val('--说', '')).trim();
  if (!text) { say('✗ 缺 --说 "想说的话"'); return 2; }
  const acc = loadAccount();
  if (!acc) { say('✗ 没有小号登录态：去生活场景网页登录小号，再点面板「同步账号」'); return 2; }
  const pub = readJson(PUB_FILE, {});
  if (pub.dmEnabled === false) { say('✗ 私信出口在 发布.json 里关着'); return 2; }
  const ownerMid = String(pub.ownerMid || '').trim();
  if (!ownerMid) { say('✗ 没配主人 B站 UID：去生活场景「生活配置」面板填 ownerMid'); return 2; }
  const q = readQuota();
  const block = checkQuota(q);
  if (block) { say('✗ ' + block); return 1; }

  const me = await nav(acc);
  const selfMid = String((me && me.mid) || acc.dedeUserID || '');
  if (!selfMid) { say('✗ 登录态无效（拿不到自己 mid）：重新登录小号'); return 2; }
  const form = {
    'msg[sender_uid]': selfMid,
    'msg[receiver_id]': ownerMid,
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[content]': text,
    csrf: acc.csrf
  };
  if (has('--dry')) {
    say('--dry：不发送、不扣额度');
    say('POST https://api.bilibili.com/x/msg/send');
    say('form=' + JSON.stringify(form));
    return 0;
  }
  const gate = gateOutbound('私信 → ' + ownerMid, text);
  if (gate) return gate;
  const res = await api('https://api.bilibili.com/x/msg/send', { method: 'POST', form, acc });
  markQuota(q);
  appendLog(stamp() + ' · 私信 → ' + ownerMid + ' · ' + text.slice(0, 30) + ' · msg_key=' + String((res && (res.msg_key || res.msgKey)) || '?'));
  say('✓ 私信已发（→ ' + ownerMid + '）');
  return 0;
}

// 6. 动态：纯文字
async function cmdDynamic() {
  const text = String(val('--说', '')).trim();
  if (!text) { say('✗ 缺 --说 "想发的话"'); return 2; }
  const acc = loadAccount();
  if (!acc) { say('✗ 没有小号登录态：去生活场景网页登录小号，再点面板「同步账号」'); return 2; }
  const pub = readJson(PUB_FILE, {});
  if (pub.dynamicEnabled === false) { say('✗ 动态出口在 发布.json 里关着'); return 2; }
  const q = readQuota();
  const block = checkQuota(q);
  if (block) { say('✗ ' + block); return 1; }

  const dynReq = { content: { contents: [{ raw_text: text }] }, scene: 1 };
  const form = { dyn_req: JSON.stringify(dynReq), csrf: acc.csrf };
  if (has('--dry')) {
    say('--dry：不发送、不扣额度');
    say('POST https://api.bilibili.com/x/dynamic/feed/create/dyn');
    say('form=' + JSON.stringify(form));
    return 0;
  }
  const gate = gateOutbound('动态', text);
  if (gate) return gate;
  const res = await api('https://api.bilibili.com/x/dynamic/feed/create/dyn', { method: 'POST', form, acc });
  markQuota(q);
  const dynId = String((res && (res.dyn_id || res.dynId)) || '?');
  appendLog(stamp() + ' · 动态 · ' + text.slice(0, 30) + ' · dyn_id=' + dynId);
  say('✓ 动态已发（dyn_id ' + dynId + '）');
  return 0;
}

// 7. 状态
async function cmdStatus() {
  const acc = loadAccount();
  if (!acc) {
    say('账号：✗ 没有登录态（去生活场景网页登录小号，再点面板「同步账号」）');
  } else {
    say('账号：有 cookie（同步于 ' + new Date(Number(acc.at) || 0).toLocaleString() + '）');
    try {
      const me = await nav(acc);
      say('登录：' + (me.isLogin ? '✓ ' + (me.uname || '') + '（mid ' + me.mid + '）' : '✗ 未登录（cookie 过期，重新登录）'));
    } catch (e) {
      say('登录：✗ 校验失败：' + ((e && e.message) || e));
    }
  }
  const pub = readJson(PUB_FILE, {});
  say('出口：评论 ' + (pub.commentEnabled === false ? '关' : '开') + ' · 私信 ' + (pub.dmEnabled === false ? '关' : '开') + '（主人 mid ' + (pub.ownerMid || '未填') + '）· 动态 ' + (pub.dynamicEnabled === false ? '关' : '开'));
  const q = readQuota();
  say('额度：本小时 ' + q.hourCount + '/' + HOUR_MAX + ' · 今天 ' + q.dayCount + '/' + DAY_MAX);
  if (q.lastAt) {
    const left = COOLDOWN_MS - (Date.now() - q.lastAt);
    say('冷却：' + (left > 0 ? '还差 ' + Math.ceil(left / 1000) + ' 秒' : '已过'));
  }
  return 0;
}

// 8. 搜人：名字 → mid（关注和追更的前置）。只读，不扣额度
async function cmdFindUp() {
  const kw = String(val('--名', '') || argv.slice(1).join(' ')).trim();
  if (!kw) { say('✗ 缺 --名 "UP 主名字"'); return 2; }
  const list = await biliSrc.searchUp(kw, Number(val('--条', '5')) || 5);
  if (!list.length) { say('没搜到：' + kw + '（换个写法，或用 --mid 直接给 UID）'); return 1; }
  say('搜到 ' + list.length + ' 个：');
  list.forEach((x, i) => {
    say('  ' + (i + 1) + '. ' + x.uname + ' · mid ' + x.mid + ' · ' + x.fans + ' 粉 · ' + x.videos + ' 稿'
      + (x.official ? ' · ' + x.official : '') + (x.sign ? '「' + x.sign + '」' : ''));
  });
  say('下一步：node 工具\\B站操作.mjs 关注 --mid ' + list[0].mid);
  return 0;
}

// 8.5 找系列：只知道「系列名」不知道 UP 是谁时先跑这条（按视频作者 mid 归堆）
async function cmdFindSeries() {
  const kw = String(val('--名', '') || argv.slice(1).join(' ')).trim();
  if (!kw) { say('✗ 缺 --名 "系列名"'); return 2; }
  const list = await biliSrc.searchVideo(kw, Number(val('--条', '10')) || 10);
  if (!list.length) { say('没搜到相关视频：' + kw); return 1; }
  const byMid = new Map();
  for (const v of list) {
    const k = v.mid || '?';
    if (!byMid.has(k)) byMid.set(k, { mid: v.mid, author: v.author, n: 0, titles: [] });
    const g = byMid.get(k);
    g.n += 1;
    if (g.titles.length < 3) g.titles.push(v.title);
  }
  const groups = [...byMid.values()].sort((a, b) => b.n - a.n);
  say('搜到 ' + list.length + ' 条，按作者归堆：');
  groups.forEach((g, i) => {
    say('  ' + (i + 1) + '. ' + g.author + '（mid ' + g.mid + '）· ' + g.n + ' 条');
    g.titles.forEach((t) => say('     - ' + t));
  });
  const top = groups[0];
  if (groups.length === 1) {
    say('⇒ 这个系列只有 ' + top.author + ' 在做（mid ' + top.mid + '）');
    say('下一步：node 工具\\B站操作.mjs 关注 --mid ' + top.mid);
    return 0;
  }
  // 多个作者都在发同名内容 = 正主没定：不自己挑第一个，把候选回执给人定
  say('⇒ 有 ' + groups.length + ' 个作者在发同名内容，正主没定，不自己选。');
  say('  把这几个候选报给主人，他点头后再关注：');
  groups.forEach((g) => {
    say('  · ' + g.author + '（mid ' + g.mid + '，' + g.n + ' 条）→ node 工具\\B站操作.mjs 关注 --mid ' + g.mid);
  });
  say('  回执给人格会话：node 工具\\发消息.mjs --to 胡闹的大肥鱼 "系列「' + kw + '」有 ' + groups.length + ' 个作者在发，谁是要关注的？"');
  return 3;
}

// 9. 关注 / 取关：官方开放平台没有这个接口，只能打网页端 relation/modify（要 bili_jct）
//   幂等（已关注就不再点、本来没关注就不取关）；走过审闸门；不占评论额度
async function cmdFollow(act) {
  const acc = loadAccount();
  if (!acc) { say('✗ 没有小号登录态：去生活场景网页登录小号，再点面板「同步账号」'); return 2; }
  let mid = String(val('--mid', '')).trim();
  const name = String(val('--名', '')).trim();
  if (!mid && name) {
    const list = await biliSrc.searchUp(name, 3);
    if (!list.length) { say('✗ 搜不到「' + name + '」'); return 1; }
    mid = list[0].mid;
    say('· 按名字认到：' + list[0].uname + '（mid ' + mid + '）');
    if (list.length > 1) say('  其它候选：' + list.slice(1).map((x) => x.uname + '/' + x.mid).join(' · '));
  }
  if (!/^\d+$/.test(mid)) { say('✗ 缺 --mid（数字 UID）或 --名 "UP 主名字"'); return 2; }

  const rel = await biliSrc.relationOf(mid).catch(() => -1);
  const relText = rel === 2 ? '已关注' : rel === 6 ? '互关' : rel === 0 ? '没关注' : '查不到';
  say('· 现在：' + relText);
  if (act === 1 && (rel === 2 || rel === 6)) { say('✓ 已经关注了，不用再点'); return 0; }
  if (act === 2 && rel === 0) { say('✓ 本来就没关注'); return 0; }

  const actName = act === 1 ? '关注' : '取关';
  if (has('--dry')) {
    say('--dry：不发');
    say('POST https://api.bilibili.com/x/relation/modify');
    say('form={"fid":"' + mid + '","act":"' + act + '","re_src":"11","csrf":"<bili_jct>"}');
    return 0;
  }
  const gate = gateOutbound(actName, actName + ' mid ' + mid);
  if (gate) return gate;
  await biliSrc.followOf(mid, act);
  appendLog(stamp() + ' · ' + actName + ' · mid ' + mid + ' · 之前=' + relText);
  say('✓ 已' + actName + '（mid ' + mid + '）');
  return 0;
}

function cmdQuota() {
  const q = readQuota();
  say('本小时 ' + q.hourCount + '/' + HOUR_MAX + ' · 今天 ' + q.dayCount + '/' + DAY_MAX + ' · 最近一次 ' + (q.lastAt ? new Date(q.lastAt).toLocaleString() : '还没发过'));
  say('同视频 7 天记录：' + Object.keys(q.videos).length + ' 条');
  return 0;
}

const table = { 状态: cmdStatus, 评论: cmdComment, 私信: cmdDm, 动态: cmdDynamic, 额度: cmdQuota, 找系列: cmdFindSeries, 搜人: cmdFindUp, 关注: () => cmdFollow(1), 取关: () => cmdFollow(2) };
// 功能台「跑一遍」是空参数：默认给只读的状态（不要拿用法当结果，会被判 run-bad）
const run = cmd ? table[cmd] : cmdStatus;
if (!run) {
  say('用法：node 工具\\B站操作.mjs 状态 ｜ 评论 --bv BVxxx --说 "…" [--dry] ｜ 私信 --说 "…" [--dry] ｜ 动态 --说 "…" [--dry] ｜ 找系列 --名 "系列名" ｜ 搜人 --名 "UP主" ｜ 关注 --mid <uid> 或 --名 "UP主" [--dry] ｜ 取关 --mid <uid> ｜ 额度');
  process.exit(2);
}
Promise.resolve(run()).then((code) => process.exit(code)).catch((e) => {
  say('✗ ' + ((e && e.message) || e));
  process.exit(1);
});
