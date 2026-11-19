'use strict';
// whale_girl 换脑插件（Api 4）—— 只做「把消息交给工作台适配器，把回复交回鲸鲸」
//
// 安装位置：<whale_girl>\data\plugins\dsh-wechat.flow.json + .enabled + .flow-grant.json
// 由 外壳\微信通道.js 自动写入；不需要走插件市场。
//
// 关键约定：
//   · chat.generate 返回 {text} 会替换鲸鲸自己的模型调用；
//   · 返回空串 = 本轮 ignore（不会回落到鲸鲸模型）；
//   · 适配器不可达/超时/任何异常都返回空串，宁可这一条不回，也不让第二个人格说话。
const whale = require('whale');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOOK_NAME = 'chat.generate';
const MAX_INPUT = 4000;

// 联系人缓存由鲸鲸桥接同步（wxid → 昵称/备注；群条目还带 members）。
// 插件只读，不碰微信库；读不到就退回“朋友/群友”，绝不把 wxid 当成人名。
const CONTACT_CACHE = { file: '', mtime: 0, byId: new Map(), groups: new Map() };

function contactFile() {
  try {
    const appData = whale && whale.paths && whale.paths.appData;
    if (!appData) return '';
    return path.join(String(appData), 'contacts-cache.json');
  } catch (e) {
    return '';
  }
}

function loadContacts() {
  const file = contactFile();
  if (!file) return;
  let st;
  try { st = fs.statSync(file); } catch (e) { return; }
  if (file === CONTACT_CACHE.file && st.mtimeMs <= CONTACT_CACHE.mtime) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) { return; }
  const byId = new Map();
  const groups = new Map();
  for (const item of (Array.isArray(raw.items) ? raw.items : [])) {
    if (!item || !item.wxid) continue;
    const label = String(item.label || item.remark || item.name || item.wxid).trim();
    const hit = { wxid: String(item.wxid), name: String(item.name || ''), label: label, remark: String(item.remark || '') };
    byId.set(hit.wxid, hit);
    if (item.isGroup) {
      const members = Array.isArray(item.members) ? item.members : [];
      groups.set(hit.wxid, {
        label: label,
        members: members.map((m) => {
          if (!m || !m.wxid) return null;
          return {
            wxid: String(m.wxid),
            label: String(m.label || m.remark || m.name || m.wxid).trim(),
          };
        }).filter(Boolean),
      });
    }
  }
  CONTACT_CACHE.file = file;
  CONTACT_CACHE.mtime = st.mtimeMs;
  CONTACT_CACHE.byId = byId;
  CONTACT_CACHE.groups = groups;
}

function labelOf(id) {
  loadContacts();
  let key = String(id || '').trim();
  if (!key) return '';
  const hit = CONTACT_CACHE.byId.get(key) || CONTACT_CACHE.byId.get(key.replace(/_[0-9a-f]{4}$/i, ''));
  return hit ? String(hit.label || hit.remark || hit.name || '').trim() : '';
}

function groupNameOf(id) {
  loadContacts();
  const hit = CONTACT_CACHE.groups.get(String(id || '').trim());
  return hit ? String(hit.label || '').trim() : '';
}

function groupMemberLabels(id) {
  loadContacts();
  const hit = CONTACT_CACHE.groups.get(String(id || '').trim());
  if (!hit || !Array.isArray(hit.members)) return [];
  return [...new Set(hit.members.map((m) => String(m.label || '').trim()).filter(Boolean))].slice(0, 60);
}

function groupMemberLabel(chatId, senderId) {
  loadContacts();
  const hit = CONTACT_CACHE.groups.get(String(chatId || '').trim());
  const key = String(senderId || '').trim();
  if (!hit || !key) return '';
  const member = (hit.members || []).find((m) => String(m.wxid || '') === key
    || String(m.wxid || '').replace(/_[0-9a-f]{4}$/i, '') === key.replace(/_[0-9a-f]{4}$/i, ''));
  return member ? String(member.label || '').trim() : '';
}

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).slice(0, max || 4000);
}

function clean(text) {
  return str(text, 16000)
    // 与鲸鲸 src/services/javascriptPlugins.js 的 UNSAFE / MENTION_ALL 对齐：
    // 清不干净会被宿主判 invalid_output，然后静默退回鲸鲸自己的模型（第二人格）。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[@＠][\s\u200B-\u200D\u2060\uFEFF]*\*(?:所有人|全体成员|all)(?![\p{L}\p{N}.])/giu, '')
    .trim();
}

// 群消息常带 "wxid_xxx:\n正文" 前缀；鲸鲸内部会剥，但插件拿到的 ctx.message.text
// 是剥之前的原文。这里统一剥一次，避免把 wxid 当正文交给 DSH / 旁听记录。
function incomingText(value, max) {
  return str(value, max || 4000).trim().replace(/^[A-Za-z0-9_-]{4,}:\s+/, '');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function hash(text) {
  return crypto.createHash('sha256').update(String(text || '').trim()).digest('hex');
}

function digestSearch(value) {
  if (!value) return '';
  if (typeof value === 'string') return str(value, 4000);
  if (typeof value === 'object') {
    const text = value.text || value.summary || value.result || value.webText;
    if (typeof text === 'string' && text.trim()) return str(text, 4000);
    try { return str(JSON.stringify(value), 4000); } catch (e) { return ''; }
  }
  return str(value, 4000);
}

function fetchJson(url, body, token, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-wx-token': token
    },
    body: JSON.stringify(body),
    signal: controller ? controller.signal : undefined
  }).then(function (r) {
    return r.text().then(function (t) {
      let j = null;
      try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
      return { status: r.status, ok: r.ok, json: j, text: t };
    });
  }).finally(function () { clearTimeout(timer); });
}

exports.hooks = {
  // 入站归档：私聊和群聊每条消息都先落一份到工作台适配器（不触发回复）。
  // 群聊同时进「最近旁听」，这样群里没被 @ 的消息也在上下文里；
  // 私聊不再只靠 chat.generate，避免没触发回复的私聊漏档。
  'chat.received': async function (ctx) {
    try {
      const m = (ctx && ctx.message) || {};
      const chatId = str(m.chatId, 200);
      const text = incomingText(m.text, 2000);
      if (!chatId || !text) return {};
      const s = (ctx && ctx.settings) || {};
      const base = str(s.adapterUrl, 500).replace(/\/+$/, '');
      const token = str(s.token, 200);
      if (!base || !token) return {};
      const isGroup = String(m.chatType || '') === 'group';
      const chatLabel = isGroup ? (groupNameOf(chatId) || '群聊') : (labelOf(chatId) || labelOf(m.senderId) || '朋友');
      const senderLabel = isGroup
        ? (labelOf(m.senderId) || groupMemberLabel(chatId, m.senderId) || '群友')
        : (labelOf(m.senderId) || labelOf(chatId) || '朋友');
      const payload = {
        v: 1,
        msg_id: crypto.createHash('sha256')
          .update(chatId + '|' + str(m.senderId, 200) + '|' + String(ctx.now || '') + '|' + text)
          .digest('hex').slice(0, 16),
        chat_id: chatId,
        chat_type: isGroup ? 'group' : 'private',
        chat_title: chatLabel,
        sender_id: str(m.senderId, 200),
        sender_name: senderLabel,
        group_members: isGroup ? groupMemberLabels(chatId) : [],
        text: text
      };
      // 只记不回复；失败不影响本轮聊天。500ms 上限，本地适配器够用。
      await fetchJson(base + '/api/social/wechat/listen', payload, token, 500);
      return {};
    } catch (e) {
      return {};
    }
  },

  'chat.generate': async function (ctx) {
    try {
      const m = (ctx && ctx.message) || {};
      const text = incomingText(m.text, MAX_INPUT);
      if (!text) return { text: '' };

      const s = (ctx && ctx.settings) || {};
      const base = str(s.adapterUrl, 500).replace(/\/+$/, '');
      const token = str(s.token, 200);
      if (!base || !token) return { text: '' };

      // 桥接其实已经解析出了 senderName/chatTitle，但 pluginContext 只暴露固定字段；
      // 这里用桥接同步下来的联系人缓存补名字。sender_id 仍然原样保留做路由，
      // 只把“给人看/给模型看”的字段换成昵称，不能让人格拿 wxid 去认人。
      const isGroup = m.chatType === 'group';
      const chatId = str(m.chatId, 200);
      const chatLabel = isGroup ? (groupNameOf(chatId) || '群聊') : (labelOf(chatId) || '朋友');
      const senderLabel = isGroup
        ? (labelOf(m.senderId) || groupMemberLabel(chatId, m.senderId) || '群友')
        : (labelOf(chatId) || labelOf(m.senderId) || '朋友');
      const groupMembers = isGroup ? groupMemberLabels(chatId) : [];

      const payload = {
        v: 1,
        // pluginContext 不带 msgId/senderName/chatTitle（鲸鲸只给固定字段）；
        // 用 wxid/群 id + 当前时间 + 正文拼一个伪 id，够适配器做 5 分钟去重。
        msg_id: str(m.msgId, 200) || crypto.createHash('sha256')
          .update(str(m.chatId, 200) + '|' + str(m.senderId, 200) + '|' + String(ctx.now || '') + '|' + text)
          .digest('hex').slice(0, 16),
        chat_id: chatId,
        chat_type: isGroup ? 'group' : 'private',
        chat_title: chatLabel,
        sender_id: str(m.senderId, 200),
        sender_name: senderLabel,
        group_members: groupMembers,
        text: text,
        at_me: !!m.atMe,
        // 原生链路已经做过链接解析/联网检索；换脑后要把结果一起交给工作台，
        // 否则「链接提取 / 搜索 / 热榜」这三项在 DSH 接管期间等于没开。
        link_text: str(ctx.linkText, 4000),
        search_text: digestSearch(ctx.search),
        voice_requested: Boolean(ctx.voiceRequested),
        // 群聊“旁听记忆”：把最近几条原始消息带给 DSH，不能只让它看到被 @ 的那一条，
        // 否则它接话时不知道前文在聊什么。私聊不传：DSH 自己的会话转录已经是唯一记忆源。
        history: (ctx.message && String(ctx.message.chatType) === 'group' && Array.isArray(ctx.history)
          ? ctx.history.slice(-12).map(function (h) { return { role: String(h.role || ''), text: str(h.text, 300) }; })
          : [])
      };

      // DSH 回复本身可能等到 30 秒按需表情生成；适配器给足余量，避免先断在插件这层。
      const r = await fetchJson(base + '/api/social/wechat', payload, token, 170000);
      if (!r.ok || !r.json || r.json.ok !== true || typeof r.json.text !== 'string') {
        return { text: '' };
      }
      const out = clean(r.json.text).slice(0, 16000);
      // chat.reply 的安全网：只有 hash 对得上才放行。模型兜底/插件换版本时正文对不上，
      // chat.reply 返回空串，鲸鲸 finalize 得到空回复 = 这条不回，不会说出第二人格的话。
      return { text: out, state: { h: out ? hash(out) : '', at: Date.now() } };
    } catch (e) {
      // 不抛出：抛出会让宿主降级回鲸鲸自己的模型。返回空串才是「这一条不回」。
      return { text: '' };
    }
  },

  // 只在 chat.generate 产出的正文上放行；对不上（= 鲸鲸模型兜底/旧状态）一律空串。
  'chat.reply': async function (ctx) {
    try {
      const text = str((ctx && ctx.text), 16000);
      const st = (ctx && ctx.state) || {};
      if (st.h && st.h === hash(text)) return { text: text };
      return { text: '' };
    } catch (e) {
      return { text: '' };
    }
  }
};

// tool.run：面板「发测试消息」用；走鲸鲸自己的 sendText，账号校验/草稿保护都还在。
exports.run = async function (ctx) {
  try {
    const input = (ctx && ctx.input) || {};
    if (input.action === 'delivery') {
      const id = str(input.id, 200);
      if (!id) return { ok: false, error: 'missing_id' };
      return { ok: true, delivery: await whale.delivery(id) };
    }
    if (input.action !== 'sendTest') return { ok: false, error: 'unknown_action' };

    const chatId = str(input.chatId, 200) || 'filehelper';
    const name = str(input.name, 200) || '文件传输助手';
    const text = str(input.text, 500) || '微信通道自检';

    const submitted = await whale.sendText(chatId, text, { name: name, chatType: 'private' });
    let delivery = null;
    try {
      await sleep(4000);
      delivery = await whale.delivery(submitted.id);
    } catch (e) {
      delivery = { error: String((e && e.message) || e) };
    }
    return { ok: true, submitted: submitted, delivery: delivery };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};
