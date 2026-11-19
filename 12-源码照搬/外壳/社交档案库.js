// 社交档案库.js —— 聊天长期档案的 SQLite 数据面（2026-11-19）
//
// 定位：档案检索层，不是第二大脑。
//   · DSH 会话继续负责当前对话、人格与推理；
//   · 这里只保存「谁在哪个聊天里说过什么」的原文、日期、发送人、chat_key；
//   · 普通闲聊不查本库；只有「昨天/上次/谁说过/原话/某天」这类历史意图才由 DSH 工具查。
//
// 为什么是 node:sqlite：
//   · 当前工作台 Electron 43 内置 Node 24.18，node:sqlite + FTS5 trigram 实测可用；
//   · 不引 better-sqlite3 等原生依赖，避免换机器/升级引擎时重新编译。
// 设计口径：
//   · 原文与日期必须可回溯；message_id/seq/hash 三路去重；
//   · FTS5 用 trigram，中文按子串匹配；精确原话另走 instr，不依赖向量；
//   · 表结构只此一份，外壳服务与 DSH 插件都 require 本文件，禁止复制第二套建表 SQL。
'use strict'

const fs = require('fs')
const path = require('path')

const DB_REL = path.join('社交档案', 'chat-archive.db')
const FTS_TRIGRAM = "tokenize='trigram'"

function dbFile(dshHome) {
  return path.join(String(dshHome || ''), DB_REL)
}

function openDb(file, opts) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = require('node:sqlite'))
  } catch (e) {
    throw new Error('当前 Node 不支持 node:sqlite：' + String((e && e.message) || e))
  }
  const o = opts || {}
  const dir = path.dirname(file)
  if (!o.readOnly) fs.mkdirSync(dir, { recursive: true })
  let db
  try {
    db = new DatabaseSync(file, o.readOnly ? { readOnly: true } : {})
  } catch (e) {
    // node:sqlite 旧版本不接受 options 时退回普通打开；只读意图由调用方保证。
    db = new DatabaseSync(file)
  }
  if (!o.readOnly) {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=NORMAL')
    db.exec('PRAGMA busy_timeout=5000')
    ensureSchema(db)
  }
  return db
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      chat_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      current_session_id TEXT NOT NULL DEFAULT '',
      first_ts INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chats_session ON chats(current_session_id);
    CREATE INDEX IF NOT EXISTS chats_last ON chats(last_ts DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'in',
      sender_id TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL DEFAULT '',
      source_message_id TEXT NOT NULL DEFAULT '',
      source_seq TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '',
      dedup_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_key, ts);
    CREATE INDEX IF NOT EXISTS messages_chat_day ON messages(chat_key, day, ts);
    CREATE INDEX IF NOT EXISTS messages_day ON messages(day, ts);
    CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id',
      ${FTS_TRIGRAM}
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_ts INTEGER NOT NULL,
      to_ts INTEGER NOT NULL,
      day TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      msg_count INTEGER NOT NULL DEFAULT 0,
      first_msg_id INTEGER NOT NULL DEFAULT 0,
      last_msg_id INTEGER NOT NULL DEFAULT 0,
      generated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(chat_key, kind, day)
    );
    CREATE INDEX IF NOT EXISTS summaries_chat_day ON summaries(chat_key, day);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      chat_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'fact',
      text TEXT NOT NULL,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.6,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, status);
    CREATE INDEX IF NOT EXISTS memories_chat ON memories(chat_key, status);

    CREATE TABLE IF NOT EXISTS sync_state (
      chat_key TEXT PRIMARY KEY,
      last_source_id TEXT NOT NULL DEFAULT '',
      last_ts INTEGER NOT NULL DEFAULT 0,
      initial_done INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `)
}

function nowMs() { return Date.now() }

function dayOf(ts) {
  const n = Number(ts) || 0
  if (!n) return ''
  // 聊天按用户本地（中国标准时间，无夏令时）记日；不依赖宿主机时区。
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function timeOf(ts) {
  const n = Number(ts) || 0
  if (!n) return ''
  const d = new Date(n + 8 * 3600 * 1000)
  const p = (v) => (v < 10 ? '0' : '') + v
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
}

function chatKey(channel, chatType, chatId) {
  const ch = String(channel || 'qq').toLowerCase()
  const t = String(chatType || 'private') === 'group' ? 'group' : 'private'
  return ch + ':' + t + ':' + String(chatId || '')
}

function parseChatKey(key) {
  const s = String(key || '')
  const m = /^([^:]+):(private|group):(.+)$/.exec(s)
  if (!m) return null
  return { channel: m[1], chatType: m[2], chatId: m[3], chatKey: s }
}

function normalizeChatInput(v) {
  return String(v || '').trim()
}

function upsertChat(db, row) {
  const r = row || {}
  const key = String(r.chatKey || chatKey(r.channel, r.chatType, r.chatId))
  const p = parseChatKey(key)
  if (!p) throw new Error('chat_key 非法：' + key)
  const at = Number(r.updatedAt) || nowMs()
  db.prepare(`
    INSERT INTO chats(chat_key, channel, account, chat_type, chat_id, display_name,
      current_session_id, first_ts, last_ts, message_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_key) DO UPDATE SET
      channel=excluded.channel,
      account=excluded.account,
      chat_type=excluded.chat_type,
      chat_id=excluded.chat_id,
      display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE chats.display_name END,
      current_session_id=CASE WHEN excluded.current_session_id<>'' THEN excluded.current_session_id ELSE chats.current_session_id END,
      first_ts=CASE WHEN chats.first_ts=0 AND excluded.first_ts>0 THEN excluded.first_ts WHEN excluded.first_ts>0 AND excluded.first_ts<chats.first_ts THEN excluded.first_ts ELSE chats.first_ts END,
      last_ts=CASE WHEN excluded.last_ts>chats.last_ts THEN excluded.last_ts ELSE chats.last_ts END,
      updated_at=excluded.updated_at
  `).run(
    key, p.channel, String(r.account || ''), p.chatType, p.chatId,
    String(r.displayName || '').slice(0, 200), String(r.currentSessionId || ''),
    Number(r.firstTs) || 0, Number(r.lastTs) || 0, Number(r.messageCount) || 0, at
  )
  return key
}

function setChatSession(db, key, sessionId) {
  db.prepare('UPDATE chats SET current_session_id=?, updated_at=? WHERE chat_key=?').run(String(sessionId || ''), nowMs(), String(key || ''))
}

function insertMessage(db, row) {
  const r = row || {}
  const key = String(r.chatKey || '')
  if (!key) return { inserted: false, error: '缺 chat_key' }
  const ts = Number(r.ts) || nowMs()
  const day = String(r.day || dayOf(ts))
  const text = String(r.text == null ? '' : r.text)
  const srcId = String(r.sourceMessageId == null ? '' : r.sourceMessageId)
  const srcSeq = String(r.sourceSeq == null ? '' : r.sourceSeq)
  const dedup = String(r.dedupKey || (key + ':' + (srcId || srcSeq || (ts + ':' + text))))
  const raw = r.raw === undefined ? '' : (typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw))
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages(chat_key, session_id, direction, sender_id, sender_name,
      ts, day, text, raw_json, source_message_id, source_seq, reply_to, dedup_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const out = stmt.run(
    key, String(r.sessionId || ''), String(r.direction || 'in'), String(r.senderId || ''),
    String(r.senderName || '').slice(0, 200), ts, day, text, String(raw).slice(0, 20000),
    srcId, srcSeq, String(r.replyTo || ''), dedup, nowMs()
  )
  return { inserted: Number(out.changes || 0) > 0, id: Number(out.lastInsertRowid || 0) }
}

function insertMany(db, rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return 0
  let n = 0
  db.exec('BEGIN')
  try {
    for (const row of list) {
      const r = insertMessage(db, row)
      if (r.inserted) n++
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch (e2) { /* 回滚失败不盖住原错误 */ }
    throw e
  }
  return n
}

function refreshChatAggregates(db, key) {
  const k = String(key || '')
  if (!k) return
  const row = db.prepare(`
    SELECT COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM messages WHERE chat_key=?
  `).get(k)
  db.prepare('UPDATE chats SET message_count=?, first_ts=?, last_ts=?, updated_at=? WHERE chat_key=?')
    .run(Number((row && row.n) || 0), Number((row && row.first_ts) || 0), Number((row && row.last_ts) || 0), nowMs(), k)
}

function getSyncState(db, key) {
  const row = db.prepare('SELECT * FROM sync_state WHERE chat_key=?').get(String(key || ''))
  return row || { chat_key: String(key || ''), last_source_id: '', last_ts: 0, initial_done: 0, updated_at: 0 }
}

function setSyncState(db, key, patch) {
  const cur = getSyncState(db, key)
  const p = patch || {}
  db.prepare(`
    INSERT INTO sync_state(chat_key, last_source_id, last_ts, initial_done, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_key) DO UPDATE SET
      last_source_id=excluded.last_source_id,
      last_ts=excluded.last_ts,
      initial_done=excluded.initial_done,
      updated_at=excluded.updated_at
  `).run(
    String(key || ''),
    p.lastSourceId === undefined ? String(cur.last_source_id || '') : String(p.lastSourceId || ''),
    p.lastTs === undefined ? Number(cur.last_ts || 0) : Number(p.lastTs || 0),
    p.initialDone === undefined ? Number(cur.initial_done || 0) : (p.initialDone ? 1 : 0),
    nowMs()
  )
}

function escapeLike(v) {
  return String(v || '').replace(/[\\%_]/g, (s) => '\\' + s)
}

function ftsPhrase(q) {
  // 只把整段作为短语；双引号转义，避免 MATCH 语法被用户输入改写。
  return '"' + String(q || '').replace(/"/g, '""') + '"'
}

function dateStartMs(date) {
  const d = String(date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0
  const n = Date.parse(d + 'T00:00:00+08:00')
  return Number.isFinite(n) ? n : 0
}

function dateEndMs(date) {
  const start = dateStartMs(date)
  return start ? start + 24 * 3600 * 1000 : 0
}

function listChats(db) {
  return db.prepare(`
    SELECT chat_key, channel, account, chat_type, chat_id, display_name, current_session_id,
      first_ts, last_ts, message_count, updated_at
    FROM chats ORDER BY last_ts DESC
  `).all().map((r) => ({
    chatKey: r.chat_key,
    channel: r.channel,
    account: r.account,
    chatType: r.chat_type,
    chatId: r.chat_id,
    displayName: r.display_name || (r.chat_type === 'group'
      ? ('群 ' + r.chat_id)
      : (({ qq: 'QQ', wechat: '微信', feishu: '飞书' }[String(r.channel || '')] || String(r.channel || '聊天')) + ' ' + r.chat_id)),
    sessionId: r.current_session_id || '',
    firstTs: Number(r.first_ts || 0),
    lastTs: Number(r.last_ts || 0),
    messageCount: Number(r.message_count || 0),
    updatedAt: Number(r.updated_at || 0)
  }))
}

function resolveChat(db, input, sessionId) {
  const v = normalizeChatInput(input)
  if (v) {
    const exact = db.prepare('SELECT chat_key FROM chats WHERE chat_key=?').get(v)
    if (exact) return { ok: true, chatKey: exact.chat_key }
    const rows = db.prepare(`
      SELECT chat_key, display_name, chat_id FROM chats
      WHERE display_name LIKE ? ESCAPE '\\' OR chat_id=?
      ORDER BY last_ts DESC LIMIT 6
    `).all('%' + escapeLike(v) + '%', v.replace(/\D/g, ''))
    if (rows.length === 1) return { ok: true, chatKey: rows[0].chat_key }
    if (rows.length > 1) return { ok: false, error: '聊天名不唯一，请改用 chat_key', candidates: rows.map((r) => ({ chatKey: r.chat_key, name: r.display_name, chatId: r.chat_id })) }
    return { ok: false, error: '没找到这个聊天：' + v }
  }
  if (sessionId) {
    const rows = db.prepare('SELECT chat_key, display_name FROM chats WHERE current_session_id=?').all(String(sessionId))
    if (rows.length === 1) return { ok: true, chatKey: rows[0].chat_key }
    if (rows.length > 1) return { ok: false, error: '当前 DSH 会话对应多个聊天，请传 chat', candidates: rows.map((r) => ({ chatKey: r.chat_key, name: r.display_name })) }
  }
  return { ok: false, error: '没说哪个聊天，且当前会话没有唯一绑定；请传 chat（chat_key 或名称）' }
}

function getChat(db, key) {
  const r = db.prepare('SELECT * FROM chats WHERE chat_key=?').get(String(key || ''))
  if (!r) return null
  return {
    chatKey: r.chat_key, channel: r.channel, account: r.account, chatType: r.chat_type,
    chatId: r.chat_id, displayName: r.display_name, sessionId: r.current_session_id,
    firstTs: Number(r.first_ts || 0), lastTs: Number(r.last_ts || 0), messageCount: Number(r.message_count || 0)
  }
}

function searchMessages(db, opts) {
  const o = opts || {}
  const chat = String(o.chatKey || '')
  const query = String(o.query || '').trim()
  const from = Number(o.fromMs) || 0
  const to = Number(o.toMs) || 0
  const sender = String(o.sender || '').trim()
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 30))
  const context = Math.max(0, Math.min(6, Number(o.context) || 0))
  const filters = []
  const params = []
  if (chat) { filters.push('m.chat_key=?'); params.push(chat) }
  if (from) { filters.push('m.ts>=?'); params.push(from) }
  if (to) { filters.push('m.ts<?'); params.push(to) }
  if (sender) { filters.push('(m.sender_name LIKE ? ESCAPE \'\\\' OR m.sender_id=?)'); params.push('%' + escapeLike(sender) + '%', sender) }
  let rows = []
  if (query) {
    try {
      rows = db.prepare(`
        SELECT m.id, m.chat_key, m.ts, m.day, m.sender_id, m.sender_name, m.text, m.direction,
          m.source_message_id
        FROM messages m JOIN messages_fts f ON f.rowid=m.id
        WHERE messages_fts MATCH ? AND ${filters.length ? filters.join(' AND ') : '1=1'}
        ORDER BY bm25(messages_fts, 1.0), m.ts DESC LIMIT ?
      `).all(ftsPhrase(query), ...params, limit)
    } catch (e) {
      rows = []
    }
  }
  if (!rows.length) {
    const q = String(query || '')
    if (q) {
      rows = db.prepare(`
        SELECT m.id, m.chat_key, m.ts, m.day, m.sender_id, m.sender_name, m.text, m.direction,
          m.source_message_id
        FROM messages m
        WHERE m.text LIKE ? ESCAPE '\\' ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
        ORDER BY m.ts DESC LIMIT ?
      `).all('%' + escapeLike(q) + '%', ...params, limit)
    }
  }
  return rows.map((r) => decorate(db, r, context))
}

function recentMessages(db, opts) {
  const o = opts || {}
  const chat = String(o.chatKey || '')
  const limit = Math.max(1, Math.min(300, Number(o.limit) || 40))
  const rows = db.prepare(`
    SELECT id, chat_key, ts, day, sender_id, sender_name, text, direction, source_message_id
    FROM messages
    ${chat ? 'WHERE chat_key=?' : ''}
    ORDER BY ts DESC, id DESC LIMIT ?
  `).all(...(chat ? [chat, limit] : [limit]))
  return rows.map((r) => decorate(db, r, 0))
}

function quoteLookup(db, opts) {
  const o = opts || {}
  const chat = String(o.chatKey || '')
  const phrase = String(o.phrase || '').trim()
  const from = Number(o.fromMs) || 0
  const to = Number(o.toMs) || 0
  const sender = String(o.sender || '').trim()
  const limit = Math.max(1, Math.min(100, Number(o.limit) || 10))
  if (!phrase) return []
  const filters = ['instr(m.text, ?) > 0']
  const params = [phrase]
  if (chat) { filters.push('m.chat_key=?'); params.push(chat) }
  if (from) { filters.push('m.ts>=?'); params.push(from) }
  if (to) { filters.push('m.ts<?'); params.push(to) }
  if (sender) { filters.push('(m.sender_name LIKE ? ESCAPE \'\\\' OR m.sender_id=?)'); params.push('%' + escapeLike(sender) + '%', sender) }
  return db.prepare(`
    SELECT m.id, m.chat_key, m.ts, m.day, m.sender_id, m.sender_name, m.text, m.direction,
      m.source_message_id
    FROM messages m
    WHERE ${filters.join(' AND ')}
    ORDER BY m.ts DESC LIMIT ?
  `).all(...params, limit).map((r) => decorate(db, r, Math.max(1, Number(o.context) || 1)))
}

function decorate(db, row, context) {
  const out = {
    id: Number(row.id),
    chatKey: row.chat_key,
    ts: Number(row.ts),
    day: row.day,
    time: timeOf(row.ts),
    senderId: row.sender_id,
    sender: row.sender_name || row.sender_id || '未知',
    text: row.text,
    direction: row.direction,
    sourceMessageId: row.source_message_id
  }
  if (context > 0) {
    const before = db.prepare(`
      SELECT id, ts, sender_name, sender_id, text FROM messages
      WHERE chat_key=? AND id<? ORDER BY id DESC LIMIT ?
    `).all(row.chat_key, Number(row.id), context).reverse()
    const after = db.prepare(`
      SELECT id, ts, sender_name, sender_id, text FROM messages
      WHERE chat_key=? AND id>? ORDER BY id ASC LIMIT ?
    `).all(row.chat_key, Number(row.id), context)
    const map = (x) => ({ id: Number(x.id), time: timeOf(x.ts), sender: x.sender_name || x.sender_id || '未知', text: x.text })
    out.before = before.map(map)
    out.after = after.map(map)
  }
  return out
}

function dailyPage(db, opts) {
  const o = opts || {}
  const day = String(o.day || '').trim()
  const chat = String(o.chatKey || '')
  const cursor = Math.max(0, Number(o.cursor) || 0)
  const limit = Math.max(1, Math.min(300, Number(o.limit) || 200))
  const rows = db.prepare(`
    SELECT id, chat_key, ts, day, sender_id, sender_name, text, direction, source_message_id
    FROM messages
    WHERE day=? ${chat ? 'AND chat_key=?' : ''} AND id>?
    ORDER BY id ASC LIMIT ?
  `).all(...(chat ? [day, chat, cursor, limit + 1] : [day, cursor, limit + 1]))
  const more = rows.length > limit
  const page = more ? rows.slice(0, limit) : rows
  return {
    day,
    chatKey: chat,
    cursor,
    limit,
    total: Number((db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE day=? ${chat ? 'AND chat_key=?' : ''}`).get(...(chat ? [day, chat] : [day])) || {}).n || 0),
    messages: page.map((r) => ({
      id: Number(r.id), chatKey: r.chat_key, time: timeOf(r.ts), day: r.day,
      senderId: r.sender_id, sender: r.sender_name || r.sender_id || '未知',
      text: r.text, direction: r.direction, sourceMessageId: r.source_message_id
    })),
    nextCursor: more ? Number(page[page.length - 1].id) : 0,
    done: !more
  }
}

function dailyStats(db, day, chatKey) {
  const rows = db.prepare(`
    SELECT chat_key, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
      COUNT(DISTINCT COALESCE(NULLIF(sender_id,''), sender_name)) AS people
    FROM messages WHERE day=? ${chatKey ? 'AND chat_key=?' : ''}
    GROUP BY chat_key ORDER BY n DESC
  `).all(...(chatKey ? [day, chatKey] : [day]))
  return rows.map((r) => ({
    chatKey: r.chat_key,
    count: Number(r.n || 0),
    people: Number(r.people || 0),
    firstTs: Number(r.first_ts || 0),
    lastTs: Number(r.last_ts || 0),
    firstTime: timeOf(r.first_ts),
    lastTime: timeOf(r.last_ts)
  }))
}

function listMemories(db, opts) {
  const o = opts || {}
  const chat = String(o.chatKey || '')
  const q = String(o.query || '').trim()
  const limit = Math.max(1, Math.min(20, Number(o.limit) || 5))
  const filters = ["status='active'"]
  const params = []
  if (chat) { filters.push('(chat_key=? OR chat_key=\'\')'); params.push(chat) }
  if (q) { filters.push('text LIKE ? ESCAPE \'\\\''); params.push('%' + escapeLike(q) + '%') }
  return db.prepare(`
    SELECT id, scope, chat_key, kind, text, evidence_ids, confidence, created_at, updated_at
    FROM memories WHERE ${filters.join(' AND ')}
    ORDER BY updated_at DESC LIMIT ?
  `).all(...params, limit).map((r) => ({
    id: Number(r.id), scope: r.scope, chatKey: r.chat_key, kind: r.kind,
    text: r.text, evidenceIds: safeJson(r.evidence_ids, []),
    confidence: Number(r.confidence || 0), createdAt: Number(r.created_at || 0), updatedAt: Number(r.updated_at || 0)
  }))
}

function addMemory(db, opts) {
  const o = opts || {}
  const chat = String(o.chatKey || '')
  const text = String(o.text || '').trim()
  if (!text) throw new Error('记忆文本不能为空')
  const evidence = Array.isArray(o.evidenceIds) ? o.evidenceIds.map((x) => Number(x)).filter((x) => x > 0) : []
  const now = nowMs()
  const out = db.prepare(`
    INSERT INTO memories(scope, chat_key, kind, text, evidence_ids, confidence, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    chat ? 'chat:' + chat : 'global', chat, String(o.kind || 'fact').slice(0, 20),
    text.slice(0, 1200), JSON.stringify(evidence), Math.max(0, Math.min(1, Number(o.confidence) || 0.6)), now, now
  )
  return { id: Number(out.lastInsertRowid || 0), chatKey: chat, text }
}

function safeJson(text, fallback) {
  try { const v = JSON.parse(String(text || '')); return v == null ? fallback : v } catch { return fallback }
}

function getStatus(db, file) {
  const chats = Number((db.prepare('SELECT COUNT(*) AS n FROM chats').get() || {}).n || 0)
  const messages = Number((db.prepare('SELECT COUNT(*) AS n FROM messages').get() || {}).n || 0)
  const days = Number((db.prepare('SELECT COUNT(DISTINCT day) AS n FROM messages').get() || {}).n || 0)
  const first = (db.prepare('SELECT MIN(day) AS d FROM messages').get() || {}).d || ''
  const last = (db.prepare('SELECT MAX(day) AS d FROM messages').get() || {}).d || ''
  let bytes = 0
  try { bytes = fs.statSync(file).size } catch { bytes = 0 }
  return { ok: true, file, chats, messages, days, firstDay: first, lastDay: last, bytes }
}

function closeDb(db) {
  try { db.close() } catch { /* 已经关闭 */ }
}

module.exports = {
  DB_REL,
  dbFile,
  openDb,
  ensureSchema,
  dayOf,
  timeOf,
  chatKey,
  parseChatKey,
  upsertChat,
  setChatSession,
  insertMessage,
  insertMany,
  refreshChatAggregates,
  getSyncState,
  setSyncState,
  listChats,
  resolveChat,
  getChat,
  searchMessages,
  recentMessages,
  quoteLookup,
  dailyPage,
  dailyStats,
  listMemories,
  addMemory,
  getStatus,
  closeDb,
  dateStartMs,
  dateEndMs
}
