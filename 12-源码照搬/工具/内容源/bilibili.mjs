// 内容源适配器：B站（2026-11-25）
// 只读接口优先用免签名路由（popular / ranking / view / reply），避开 WBI 与高频风控；
// UP 主投稿走 space/wbi/arc/search（必须 WBI 签名，裸接口会 -352/-799），密钥 1 小时缓存。
// 撞到 412/429 由上层 刷内容.mjs / 追更.mjs 的 pacer 统一退避，这里只抛错、不重试。
export const meta = { id: 'bilibili', name: 'B站', platform: 'bilibili' };

import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// 账号 cookie：由壳从网页面板分区自动同步到 data\bili-account.json（用户在生活场景网页登录小号即可）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = process.env.DSH_SHELL_DATA || path.join(ROOT2, '外壳', 'data');
export function accountCookie() {
  try {
    const acc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bili-account.json'), 'utf8'));
    const bits = [];
    if (acc.sessdata) bits.push('SESSDATA=' + acc.sessdata);
    if (acc.biliJct) bits.push('bili_jct=' + acc.biliJct);
    if (acc.buvid3) bits.push('buvid3=' + acc.buvid3);
    if (acc.dedeUserID) bits.push('DedeUserID=' + acc.dedeUserID);
    return bits.join('; ');
  } catch (e) { return ''; }
}

async function getJson(url, referer, withCookie) {
  const r = await fetch(url, {
    headers: Object.assign(
      { 'user-agent': UA, referer: referer || 'https://www.bilibili.com/' },
      withCookie ? { cookie: accountCookie() } : {}
    )
  });
  if (!r.ok) {
    const e = new Error('B站 HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('B站返回的不是 JSON（HTTP ' + r.status + '）'); }
  const code = Number(j.code);
  if (code !== 0) {
    const e = new Error('B站 code=' + code + '：' + (j.message || ''));
    e.code = code;
    throw e;
  }
  return j.data;
}

function norm(x) {
  const bvid = String(x.bvid || '');
  return {
    key: 'bili:' + bvid,
    title: String(x.title || '').replace(/\s+/g, ' ').trim(),
    author: String((x.owner && x.owner.name) || ''),
    desc: String(x.desc || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    url: bvid ? 'https://www.bilibili.com/video/' + bvid : '',
    extra: {
      bvid,
      aid: Number(x.aid) || 0,
      view: Number((x.stat && x.stat.view) || 0),
      like: Number((x.stat && x.stat.like) || 0),
      duration: Number((x.duration || 0)),
      cid: Number(x.cid || 0)
    }
  };
}

// 1. 选题：热门 / 排行榜（都免签名）/ UP 主投稿（WBI 签名）
export async function list(cfg) {
  const kind = String(cfg.kind || 'popular');
  const limit = Math.max(1, Math.min(30, Number(cfg.limit) || 10));
  if (kind === 'popular') {
    const d = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=' + limit + '&pn=1');
    return (d.list || []).slice(0, limit).map(norm);
  }
  if (kind === 'ranking') {
    const d = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=' + (cfg.rid || '0') + '&type=all');
    return (d.list || []).slice(0, limit).map(norm);
  }
  if (kind === 'up') return await listOfUp(cfg, limit);
  throw new Error('B站适配器不认识的 kind：' + kind + '（可用 popular / ranking / up）');
}

// 1.1 UP 主最新投稿：space/wbi/arc/search 必须带 w_rid 签名，否则 -352；裸接口还会 -799 限流
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiCache = { key: '', at: 0 };

async function wbiMixin() {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600 * 1000) return wbiCache.key;
  const d = await getJson('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/', true);
  const img = d && d.wbi_img;
  if (!img) throw new Error('B站没给 wbi 密钥（nav 里没有 wbi_img，多半是登录态失效）');
  const base = (u) => String(u || '').split('/').pop().split('.')[0];
  const raw = base(img.img_url) + base(img.sub_url);
  wbiCache = { key: MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32), at: Date.now() };
  return wbiCache.key;
}

function wbiQuery(params) {
  const q = Object.keys(params).sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]).replace(/[!'()*]/g, '')))
    .join('&');
  const w_rid = crypto.createHash('md5').update(q + wbiCache.key).digest('hex');
  return q + '&w_rid=' + w_rid;
}

async function listOfUp(cfg, limit) {
  const mid = String(cfg.mid || '');
  if (!/^\d+$/.test(mid)) throw new Error('B站 UP 源缺 mid（数字 UID）：' + mid);
  await wbiMixin();
  const q = wbiQuery({ mid, ps: String(limit), pn: '1', order: 'pubdate', wts: String(Math.floor(Date.now() / 1000)) });
  const d = await getJson('https://api.bilibili.com/x/space/wbi/arc/search?' + q, 'https://space.bilibili.com/' + mid + '/video', true);
  const list = (d && d.list && d.list.vlist) || [];
  const match = String(cfg.match || '').trim();
  return list
    .filter((x) => x && x.bvid && (!match || String(x.title || '').includes(match)))
    .map((x) => ({
      key: 'bili:' + x.bvid,
      title: String(x.title || '').replace(/\s+/g, ' ').trim(),
      author: String(x.author || ''),
      desc: String(x.description || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      url: 'https://www.bilibili.com/video/' + x.bvid,
      extra: {
        bvid: String(x.bvid),
        aid: Number(x.aid) || 0,
        view: Number(x.play) || 0,
        like: 0,
        duration: lenToSec(x.length),
        cid: 0,
        pubdate: Number(x.created) || 0
      }
    }));
}

// 投稿列表的时长是 "08:47" / "1:02:30"，统一成秒；解析不出来就 0
function lenToSec(s) {
  const parts = String(s || '').split(':').map((x) => Number(x) || 0);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// 关注状态（2=已关注 6=互关 0=没关注）：只读，用来核对「关注过了没」
export async function relationOf(mid) {
  const d = await getJson('https://api.bilibili.com/x/relation?fid=' + String(mid), 'https://space.bilibili.com/' + String(mid), true);
  return Number(d && d.attribute) || 0;
}

// 1.2 按名字认人：search/type 是 WBI 接口（裸接口 412），拿 mid 才能关注/追更
export async function searchUp(keyword, limit) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('缺关键词');
  await wbiMixin();
  const q = wbiQuery({
    keyword: kw,
    search_type: 'bili_user',
    page: '1',
    page_size: String(Math.max(1, Math.min(10, Number(limit) || 5))),
    wts: String(Math.floor(Date.now() / 1000))
  });
  const d = await getJson('https://api.bilibili.com/x/web-interface/wbi/search/type?' + q, 'https://search.bilibili.com/', true);
  return ((d && d.result) || []).map((x) => ({
    mid: String(x.mid || ''),
    uname: String(x.uname || ''),
    fans: Number(x.fans) || 0,
    videos: Number(x.videos) || 0,
    sign: String(x.usign || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    official: String((x.official_verify && x.official_verify.desc) || '')
  }));
}

// 1.2.1 按视频找系列：只知道「系列名」不知道「UP 主是谁」时先走这条
//   search_type=video 搜标题，按作者 mid 归堆 → 这个系列到底是哪个 UP 做的
export async function searchVideo(keyword, limit) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('缺关键词');
  await wbiMixin();
  const q = wbiQuery({
    keyword: kw,
    search_type: 'video',
    page: '1',
    page_size: String(Math.max(1, Math.min(20, Number(limit) || 10))),
    wts: String(Math.floor(Date.now() / 1000))
  });
  const d = await getJson('https://api.bilibili.com/x/web-interface/wbi/search/type?' + q, 'https://search.bilibili.com/', true);
  return ((d && d.result) || []).filter((x) => x && x.bvid).map((x) => ({
    bvid: String(x.bvid || ''),
    title: String(x.title || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    author: String(x.author || ''),
    mid: String(x.mid || ''),
    play: Number(x.play) || 0,
    pubdate: Number(x.pubdate) || 0
  }));
}

// 1.3 关注 / 取关：唯一没有开放平台接口的写操作，只能打网页端 relation/modify（要 bili_jct）
//   act：1 关注 · 2 取关 · 3 悄悄关注。返回平台 code（0 成功）
export async function followOf(mid, act) {
  const m = String(mid || '');
  if (!/^\d+$/.test(m)) throw new Error('mid 不对（要数字 UID）：' + m);
  const ck = accountCookie();
  const csrf = (/bili_jct=([^;]+)/.exec(ck) || [])[1] || '';
  if (!csrf) throw new Error('cookie 里没有 bili_jct（登录态不完整，重新登录小号）');
  const a = [1, 2, 3].includes(Number(act)) ? Number(act) : 1;
  const body = new URLSearchParams({ fid: m, act: String(a), re_src: '11', csrf }).toString();
  const r = await fetch('https://api.bilibili.com/x/relation/modify', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      referer: 'https://space.bilibili.com/' + m + '/',
      origin: 'https://space.bilibili.com',
      cookie: ck,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const j = await r.json();
  if (Number(j.code) !== 0) throw new Error('B站 code=' + j.code + '：' + (j.message || ''));
  return { act: a, code: Number(j.code) };
}

// 2. 深读：简介 + 热评（拿不到热评不影响主体）
export async function read(item) {
  const bv = String((item.extra && item.extra.bvid) || (String(item.url || '').match(/BV[0-9A-Za-z]+/) || [''])[0]);
  if (!bv) return null;
  const d = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bv);
  const aid = Number(d.aid) || 0;
  const cid = Number(d.cid) || 0;
  const desc = String(d.desc || '').replace(/\s+/g, ' ').trim();
  const lines = ['视频简介：' + (desc || '（没有简介）').slice(0, 400)];
  let comments = [];
  if (aid) {
    try {
      const c = await getJson('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&ps=8&pn=1&sort=2');
      comments = (c.replies || [])
        .map((r) => String((r.content && r.content.message) || '').replace(/\s+/g, ' ').trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 6);
      if (comments.length) lines.push('热评：', ...comments.map((x, i) => (i + 1) + '. ' + x));
    } catch (e) {
      lines.push('（热评这次没读到：' + ((e && e.message) || e) + '）');
    }
  }
  // 弹幕：重复最多的（whale 的 top repeated 思路，压过开场刷屏）
  try {
    const dm = await danmakuOf(cid);
    const top = topRepeated(dm, 10);
    if (top.length) lines.push('弹幕（重复最多的）：', top.join(' / '));
  } catch (e) { /* 弹幕失败不影响主体 */ }
  // 字幕：需要登录 cookie（小号登录后自动有）；拿不到就跳过
  try {
    const sub = await subtitlesOf(bv, aid, cid, String(d.title || '') + ' ' + desc);
    if (sub) lines.push('字幕（节选）：' + sub.slice(0, 800));
  } catch (e) { /* 字幕失败不影响主体 */ }
  return { text: lines.join('\n'), comments };
}

// 3. 字幕（登录态）：player/v2 拿字幕轨 → subtitle_url → JSON 正文
// 实测坑（2026-11-25）：同一个 aid+cid 连续请求，B站会随机返回别的视频的 AI 字幕（餐厅探店 / 英文歌词都撞过）。
// 所以抽 3 次，按「跟标题+简介的三字词重合度 + 中文字符占比」打分，低于阈值就整条丢掉——宁可不给，也不给错。
async function subtitlesOf(bv, aid, cid, refText) {
  if (!aid || !cid) return '';
  const ck = accountCookie();
  let best = { text: '', score: 0 };
  for (let i = 0; i < 3; i++) {
    let text = '';
    try {
      const r = await fetch('https://api.bilibili.com/x/player/v2?aid=' + aid + '&cid=' + cid, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/video/' + bv, cookie: ck }
      });
      if (!r.ok) continue;
      const j = await r.json();
      const subs = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
      if (!subs.length) return '';
      const pickOne = subs.find((s) => String(s.lang || '').toLowerCase().includes('zh')) || subs[0];
      const su = String(pickOne.subtitle_url || '');
      if (!su.startsWith('//') && !/^https?:/.test(su)) continue;
      const u = su.startsWith('//') ? 'https:' + su : su;
      const t = await fetch(u, { headers: { 'user-agent': UA } });
      if (!t.ok) continue;
      const body = await t.json();
      text = (body.body || []).map((x) => String(x.content || '')).join(' ').replace(/\s+/g, ' ').trim();
    } catch (e) { continue; }
    const s = subScore(text, refText);
    if (s > best.score) best = { text, score: s };
    if (best.score >= 22) break;   // 够像了就不再抽，省请求
    await new Promise((res) => setTimeout(res, 800));
  }
  return best.score >= 14 ? best.text : '';
}

// 字幕可信度：中文字符占比（压英文歌词）+ 与标题/简介的三字词重合数（二字词太泛，错配也能撞上十几个）
function subScore(text, refText) {
  const s = String(text || '');
  if (s.length < 40) return 0;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const ratio = cjk / s.length;
  if (ratio < 0.25) return 0;
  const grams = (x, n) => {
    const t = String(x).replace(/[\s\p{P}]/gu, '');
    const out = new Set();
    for (let i = 0; i < t.length - n + 1; i++) out.add(t.slice(i, i + n));
    return out;
  };
  const ref = grams(refText, 3);
  const g = grams(s, 3);
  let hit = 0;
  for (const x of ref) if (g.has(x)) hit++;
  return hit;
}

// 4. 弹幕（免签名 XML）：<d p="...">文本</d>
async function danmakuOf(cid) {
  if (!cid) return [];
  const r = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + cid, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
  });
  if (!r.ok) return [];
  const xml = await r.text();
  const out = [];
  const re = /<d[^>]*>([^<]*)<\/d>/g;
  let m;
  while ((m = re.exec(xml))) out.push(decodeEntities(m[1]));
  return out;
}
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function topRepeated(list, n) {
  const cnt = new Map();
  for (const x of list) {
    const t = String(x).replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2) continue;
    cnt.set(t, (cnt.get(t) || 0) + 1);
  }
  return [...cnt.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t, c]) => t + '（' + c + '）');
}
