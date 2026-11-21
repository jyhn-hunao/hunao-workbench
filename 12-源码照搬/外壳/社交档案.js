// 社交档案.js —— 聊天长期档案的服务面（2026-11-19）
//
// 职责：
//   1. 从 SnowLuma 的本地 messages.db 读全量私聊/群聊（在插件「只 @ 才回」过滤之前就已落盘）；
//   2. 写进本工作台自己的 chat-archive.db（原文 + 日期 + 发送人 + chat_key + 去重）；
//   3. 给外壳 IPC / 社交面板 / DSH 插件提供检索、日摘要分页、单聊天记忆。
//
// 为什么读 SnowLuma messages.db：
//   · OneBot 的 get_friend_msg_history 实测返回空（SnowLuma 不把历史缓存在协议层）；
//   · SnowLuma 自己按账号落盘 messages.db（表 messages，data 字段就是完整事件 JSON），
//     未 @ 的群消息也在里面，正好是「过滤前归档」的稳定源；
//   · 只读打开，不写 SnowLuma 的库；账号目录按 UIN 分，双开时两个号都能各自归档。
//
// 失败口径：源库不存在 / 表结构变了 / 被占用 → 状态里写清是哪一环，不静默当「没有消息」。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const lib = require('./社交档案库')
// 关系档案跟着聊天档案走：同步后按消息数/互动天数重算熟悉度；模块缺失时只跳过这一层。
let socialState = null
try { socialState = require('./社交状态') } catch (e) { /* 关系层没装，档案照旧 */ }

const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,
  autoStart: true,
  intervalMs: 8000,
  initialPages: 5,
  pageSize: 200,
  maxPagesPerSync: 8,
  includeSelfPrivate: false,
  snowlumaDataDir: '',
  source: 'snowluma-messages-db'
}

function createService(opt) {
  const o = opt || {}
  const dshHome = String(o.dshHome || '')
  const shellRoot = path.resolve(dshHome, '..', '..', '外壳')
  const shellData = process.env.DSH_SHELL_DATA || path.join(shellRoot, 'data')
  const log = typeof o.log === 'function' ? o.log : function () {}
  const settingsFile = path.join(shellData, '社交档案.json')
  const sessionsFile = path.join(shellData, '社交会话.json')
  const qqConfigFile = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json')
  const dbPath = lib.dbFile(dshHome)

  let db = null
  let timer = null
  let live = null
  let liveRetry = null
  let liveClosing = false
  let nameCache = { friends: new Map(), groups: new Map(), at: 0 }
  let listenCache = new Map()
  let running = false
  let socialStatsAt = 0
  let status = {
    ok: true,
    enabled: true,
    running: false,
    lastSyncAt: 0,
    lastError: '',
    lastNote: '',
    accounts: [],
    insertedLast: 0,
    pulledLast: 0,
    liveConnected: false,
    liveLastAt: 0,
    liveInserted: 0,
    liveError: '',
    externalInserted: 0,
    wechatImported: 0,
    wechat: null,
    source: DEFAULT_SETTINGS.source
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
  }

  function writeJson(file, value) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
      return true
    } catch (e) {
      log('[archive] 写设置失败: ' + ((e && e.message) || e))
      return false
    }
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Number(v)
    if (!Number.isFinite(n)) return dflt
    return Math.max(lo, Math.min(hi, Math.round(n)))
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {})
    s.enabled = s.enabled !== false
    s.autoStart = s.autoStart !== false
    s.intervalMs = clampInt(s.intervalMs, 3000, 120000, DEFAULT_SETTINGS.intervalMs)
    s.initialPages = clampInt(s.initialPages, 1, 50, DEFAULT_SETTINGS.initialPages)
    s.pageSize = clampInt(s.pageSize, 20, 500, DEFAULT_SETTINGS.pageSize)
    s.maxPagesPerSync = clampInt(s.maxPagesPerSync, 1, 50, DEFAULT_SETTINGS.maxPagesPerSync)
    s.includeSelfPrivate = s.includeSelfPrivate === true
    s.snowlumaDataDir = String(s.snowlumaDataDir || '').trim()
    s.source = String(s.source || DEFAULT_SETTINGS.source)
    return s
  }

  function settingsGet() {
    const raw = readJson(settingsFile, null)
    const settings = normalizeSettings(raw || DEFAULT_SETTINGS)
    return Object.assign({}, settings, {
      file: settingsFile,
      dbFile: dbPath,
      qqConfigFile,
      sourceFound: findAccounts(settings).length > 0
    })
  }

  function settingsSave(patch) {
    const cur = settingsGet()
    const next = normalizeSettings(Object.assign({}, cur, patch || {}))
    delete next.file
    delete next.dbFile
    delete next.qqConfigFile
    delete next.sourceFound
    writeJson(settingsFile, next)
    if (next.enabled) start()
    else stop()
    return { ok: true, settings: settingsGet(), status: statusGet() }
  }

  function readQqConfig() {
    const cfg = readJson(qqConfigFile, {}) || {}
    return {
      snowlumaConfigDir: String(cfg.snowlumaConfigDir || ''),
      snowlumaDataDir: String(cfg.snowlumaDataDir || ''),
      selfUin: String(cfg.selfUin || ''),
      wsUrl: String(cfg.wsUrl || ''),
      wsToken: String(cfg.wsToken || ''),
      wsEnabled: cfg.wsEnabled !== false,
      onebotHttp: String(cfg.onebotHttp || '').replace(/\/+$/, ''),
      token: String(cfg.token || '')
    }
  }

  async function fetchOneBot(action) {
    const cfg = readQqConfig()
    const base = cfg.onebotHttp
    if (!base || !cfg.token) return null
    try {
      const res = await fetch(base + '/' + action, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(6000)
      })
      if (!res.ok) return null
      const json = await res.json()
      return json && json.retcode === 0 ? json.data : null
    } catch {
      return null
    }
  }

  async function refreshNames() {
    const [friends, groups] = await Promise.all([
      fetchOneBot('get_friend_list'),
      fetchOneBot('get_group_list')
    ])
    const f = new Map()
    const g = new Map()
    if (Array.isArray(friends)) friends.forEach((x) => {
      const id = String((x && x.user_id) || '')
      const name = String((x && (x.remark || x.nickname)) || '').trim()
      if (id && name && !f.has(id)) f.set(id, name)
    })
    if (Array.isArray(groups)) groups.forEach((x) => {
      const id = String((x && x.group_id) || '')
      const name = String((x && x.group_name) || '').trim()
      if (id && name && !g.has(id)) g.set(id, name)
    })
    nameCache = { friends: f, groups: g, at: Date.now() }
  }

  function findAccounts(settings) {
    const s = settings || settingsGet()
    const qq = readQqConfig()
    const roots = []
    if (s.snowlumaDataDir) roots.push(s.snowlumaDataDir)
    if (qq.snowlumaDataDir) roots.push(qq.snowlumaDataDir)
    if (qq.snowlumaConfigDir) roots.push(path.join(path.dirname(qq.snowlumaConfigDir), 'data'))
    const out = []
    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue
        for (const name of fs.readdirSync(root)) {
          if (!/^\d{5,12}$/.test(name)) continue
          const file = path.join(root, name, 'messages.db')
          if (fs.existsSync(file)) out.push({ account: name, dir: path.join(root, name), file })
        }
      } catch (e) {
        log('[archive] 读 SnowLuma 数据目录失败 ' + root + ': ' + ((e && e.message) || e))
      }
    }
    // 去重（同一目录可能从配置和兜底各命中一次）
    const seen = new Set()
    return out.filter((x) => {
      const k = x.file.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  function openSource(file) {
    const { DatabaseSync } = require('node:sqlite')
    return new DatabaseSync(file, { readOnly: true })
  }

  function parseData(row) {
    try {
      const v = JSON.parse(String(row.data || '{}'))
      return v && typeof v === 'object' ? v : {}
    } catch { return {} }
  }

  function segmentText(segments, account) {
    if (typeof segments === 'string') return segments
    if (!Array.isArray(segments)) return ''
    return segments.map((seg) => {
      const t = String((seg && seg.type) || '')
      const d = (seg && seg.data) || {}
      if (t === 'text') return String(d.text || '')
      if (t === 'at') return d.qq === 'all' ? '@全体成员' : '@' + String(d.qq || '')
      if (t === 'image') return '[图片]'
      if (t === 'face') return '[表情]'
      if (t === 'mface') return '[表情包]'
      if (t === 'record') return '[语音]'
      if (t === 'video') return '[视频]'
      if (t === 'file') return '[文件]'
      if (t === 'reply') return ''
      if (t === 'forward') return '[转发消息]'
      if (t === 'json' || t === 'xml') return '[卡片消息]'
      if (t === 'share') return '[分享链接]'
      if (t === 'contact') return '[名片]'
      if (t === 'poke') return '[戳一戳]'
      if (t === 'markdown') return String(d.content || '')
      return '[' + t + ']'
    }).join('')
  }

  function senderNameOf(data, direction, account) {
    const sender = data.sender || {}
    const card = String(sender.card || '').trim()
    const nick = String(sender.nickname || '').trim()
    if (direction === 'out') return nick || card || '我'
    return card || nick || String(data.user_id || '')
  }

  function mapRow(row, account, chat) {
    const data = parseData(row)
    const isGroup = !!chat.isGroup
    const my = String(account || '')
    const eventUser = String(data.user_id || '')
    let direction = 'in'
    if (Number(row.private_direction) === 1) direction = 'out'
    else if (String(data.post_type || '') === 'message_sent') direction = 'out'
    else if (isGroup && my && eventUser === my) direction = 'out'
    const tsSec = Number(data.time || row.timestamp || 0)
    const ts = tsSec > 100000000000 ? tsSec : tsSec * 1000
    if (!ts) return null
    const text = segmentText(data.message, account) || String(data.raw_message || '')
    if (!text) return null
    const chatKey = lib.chatKey('qq', isGroup ? 'group' : 'private', chat.sessionId)
    const msgId = String(data.message_id == null ? row.message_hash : data.message_id)
    const seq = String(row.sequence == null ? '' : row.sequence)
    return {
      chatKey,
      sessionId: '',
      direction,
      senderId: String(data.user_id || ''),
      senderName: senderNameOf(data, direction, account),
      ts,
      day: lib.dayOf(ts),
      text,
      raw: row.data || '',
      sourceMessageId: msgId,
      sourceSeq: seq,
      dedupKey: chatKey + ':' + account + ':' + (msgId || seq || (ts + ':' + String(text).slice(0, 80))),
      replyTo: ''
    }
  }

  function mapEvent(ev, account) {
    const data = ev || {}
    const type = String(data.message_type || '')
    if (type !== 'private' && type !== 'group') return null
    const isGroup = type === 'group'
    const self = String(account || data.self_id || '')
    const eventUser = String(data.user_id || '')
    let chatId = ''
    let direction = 'in'
    if (isGroup) {
      chatId = String(data.group_id || '')
      if (self && eventUser === self) direction = 'out'
    } else if (String(data.post_type || '') === 'message_sent') {
      chatId = String(data.target_id || '')
      direction = 'out'
    } else {
      chatId = eventUser
      direction = 'in'
    }
    if (!chatId) return null
    const tsSec = Number(data.time || 0)
    const ts = tsSec > 100000000000 ? tsSec : tsSec * 1000
    if (!ts) return null
    const text = segmentText(data.message, account) || String(data.raw_message || '')
    if (!text) return null
    const chatKey = lib.chatKey('qq', isGroup ? 'group' : 'private', chatId)
    const msgId = String(data.message_id == null ? '' : data.message_id)
    const seq = String(data.message_seq == null ? '' : data.message_seq)
    return {
      chatKey,
      direction,
      senderId: eventUser,
      senderName: senderNameOf(data, direction, account),
      ts,
      day: lib.dayOf(ts),
      text,
      raw: JSON.stringify(data),
      sourceMessageId: msgId,
      sourceSeq: seq,
      dedupKey: chatKey + ':' + account + ':' + (msgId || seq || (ts + ':' + text.slice(0, 60))),
      replyTo: ''
    }
  }

  // 通用入口：微信监听、微信回复、以后飞书都从这里写同一张档案表。
  // 传进来的字段只做归一化，不在服务层猜业务；channel 决定 chat_key 前缀。
  function archiveExternal(input) {
    const x = input || {}
    const channel = String(x.channel || 'wechat').toLowerCase()
    const type = String(x.chatType || x.chat_type || '').toLowerCase() === 'group' ? 'group' : 'private'
    const chatId = String(x.chatId || x.chat_id || '').trim()
    const text = String(x.text || '').trim()
    if (!chatId || !text) return { ok: false, skipped: 'empty' }
    const account = String(x.account || channel)
    const chatKey = lib.chatKey(channel, type, chatId)
    const ts = Number(x.ts || Date.now()) || Date.now()
    const msgId = String(x.msgId || x.msg_id || '')
    const fallbackId = crypto.createHash('sha1').update(chatKey + '|' + ts + '|' + text).digest('hex').slice(0, 20)
    const dedupKey = chatKey + ':' + account + ':' + (msgId || fallbackId)
    try {
      const d = ensureDb()
      const existing = lib.getChat(d, chatKey)
      const oldName = String((existing && existing.displayName) || '').trim()
      const title = String(x.chatTitle || x.chat_title || '').trim()
      let displayName = title || oldName
      if (!displayName) displayName = (type === 'group' ? '群 ' : '') + chatId
      // 自己发出去的消息不能把好友/群名改掉：有旧名就保留，只有新聊天才用回退名。
      if (String(x.direction || 'in') === 'out' && oldName) displayName = oldName
      lib.upsertChat(d, {
        chatKey, channel, account, chatType: type, chatId,
        displayName, lastTs: ts
      })
      const row = {
        chatKey,
        sessionId: String(x.sessionId || ''),
        direction: String(x.direction || 'in') === 'out' ? 'out' : 'in',
        senderId: String(x.senderId || x.sender_id || ''),
        senderName: String(x.senderName || x.sender_name || (type === 'group' ? '群友' : '对方')),
        ts,
        day: lib.dayOf(ts),
        text,
        raw: typeof x.raw === 'string' ? x.raw : JSON.stringify(x),
        sourceMessageId: msgId,
        sourceSeq: '',
        dedupKey,
        replyTo: ''
      }
      const ins = lib.insertMessage(d, row)
      if (ins.inserted) {
        lib.refreshChatAggregates(d, chatKey)
        status.externalInserted = Number(status.externalInserted || 0) + 1
      }
      return { ok: true, inserted: !!ins.inserted, chatKey }
    } catch (e) {
      status.lastError = '写入档案失败: ' + ((e && e.message) || e)
      log('[archive] ' + status.lastError)
      return { ok: false, error: status.lastError }
    }
  }

  // 微信群聊旁听 JSONL（微信通道自己落的最近上下文）→ 档案库。
  // 只在文件大小/mtime 变了才重读，避免每 8 秒重扫 600 行。
  function importWechatListen() {
    const dir = path.join(shellData, '微信通道', '旁听')
    let inserted = 0
    let files = 0
    try {
      if (!fs.existsSync(dir)) return { inserted: 0, files: 0 }
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile() || !/\.jsonl$/i.test(ent.name)) continue
        const file = path.join(dir, ent.name)
        let st
        try { st = fs.statSync(file) } catch { continue }
        const sig = String(st.size) + ':' + String(st.mtimeMs)
        if (listenCache.get(file) === sig) continue
        let lines = []
        try { lines = fs.readFileSync(file, 'utf8').split('\n') } catch { continue }
        for (const line of lines) {
          if (!line.trim()) continue
          let rec
          try { rec = JSON.parse(line) } catch { continue }
          if (!rec || !rec.chatId || !rec.text) continue
          const r = archiveExternal({
            channel: 'wechat',
            account: 'wechat',
            chatType: 'group',
            chatId: rec.chatId,
            chatTitle: rec.chatTitle || '',
            senderId: rec.senderId || '',
            senderName: rec.senderName || '群友',
            direction: 'in',
            ts: Number(rec.at || 0) || Date.now(),
            text: rec.text,
            msgId: rec.msgId || '',
            raw: line
          })
          if (r.inserted) inserted++
        }
        listenCache.set(file, sig)
        files++
      }
    } catch (e) {
      log('[archive] 微信旁听导入失败: ' + ((e && e.message) || e))
    }
    if (inserted) status.wechatImported = Number(status.wechatImported || 0) + inserted
    return { inserted, files }
  }


  function archiveEvent(ev) {
    const cfg = readQqConfig()
    const account = String(ev && (ev.self_id || cfg.selfUin) || cfg.selfUin || '')
    const row = mapEvent(ev, account)
    if (!row) return { ok: false, skipped: 'not-message' }
    try {
      const d = ensureDb()
      const isGroup = String(ev.message_type) === 'group'
      if (!settingsGet().includeSelfPrivate && !isGroup && row.chatKey === lib.chatKey('qq', 'private', account)) {
        return { ok: true, skipped: 'self-private' }
      }
      const existing = lib.getChat(d, row.chatKey)
      const oldName = String((existing && existing.displayName) || '').trim()
      let name = ''
      if (isGroup) {
        name = nameCache.groups.get(String(ev.group_id || '')) || ev.group_name || oldName || ('群 ' + String(ev.group_id || ''))
      } else if (row.direction === 'in') {
        name = row.senderName || oldName
      } else {
        // 自己发出去的消息不能把好友名改成自己的昵称：优先用已有名字。
        name = oldName || ('QQ ' + String(ev.target_id || ''))
      }
      lib.upsertChat(d, {
        chatKey: row.chatKey, channel: 'qq', account,
        chatType: isGroup ? 'group' : 'private', chatId: lib.parseChatKey(row.chatKey).chatId,
        displayName: name,
        lastTs: row.ts
      })
      const ins = lib.insertMessage(d, row)
      if (ins.inserted) {
        lib.refreshChatAggregates(d, row.chatKey)
        status.liveInserted = Number(status.liveInserted || 0) + 1
      }
      status.liveLastAt = Date.now()
      return { ok: true, inserted: !!ins.inserted, chatKey: row.chatKey }
    } catch (e) {
      status.liveError = '实时归档失败: ' + ((e && e.message) || e)
      log('[archive] ' + status.liveError)
      return { ok: false, error: status.liveError }
    }
  }

  function startLive() {
    const cfg = readQqConfig()
    const wsUrl = String(cfg.wsUrl || '')
    const wsToken = String(cfg.wsToken || '')
    if (cfg.wsEnabled === false) {
      status.liveConnected = false
      status.liveError = 'wsEnabled=false：只靠 SnowLuma messages.db 回填'
      return { ok: false, skipped: status.liveError }
    }
    if (!wsUrl || !wsToken) {
      status.liveConnected = false
      status.liveError = '没配 wsUrl / wsToken：只靠 SnowLuma messages.db 回填'
      return { ok: false, skipped: status.liveError }
    }
    stopLive()
    liveClosing = false
    let target = wsUrl
    try {
      const u = new URL(wsUrl)
      if (u.searchParams.get('access_token') === null) u.searchParams.set('access_token', wsToken)
      target = u.toString()
    } catch { target = wsUrl }
    try {
      const socket = new WebSocket(target)
      live = socket
      socket.onopen = function () {
        status.liveConnected = true
        status.liveError = ''
        log('[archive] 实时归档已连上 SnowLuma WS（只收消息，不发动作）')
      }
      socket.onmessage = function (event) {
        let data
        try { data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
        if (!data || (data.post_type !== 'message' && data.post_type !== 'message_sent')) return
        archiveEvent(data)
      }
      socket.onerror = function () {
        status.liveError = 'WS 连接出错（事件仍会由 messages.db 回填补齐）'
      }
      socket.onclose = function () {
        status.liveConnected = false
        live = null
        if (liveClosing) return
        if (liveRetry) clearTimeout(liveRetry)
        liveRetry = setTimeout(function () { startLive() }, 10000)
      }
      return { ok: true, connected: true }
    } catch (e) {
      status.liveConnected = false
      status.liveError = 'WS 建连失败: ' + ((e && e.message) || e)
      if (liveRetry) clearTimeout(liveRetry)
      liveRetry = setTimeout(function () { startLive() }, 15000)
      return { ok: false, error: status.liveError }
    }
  }

  function stopLive() {
    liveClosing = true
    if (liveRetry) { clearTimeout(liveRetry); liveRetry = null }
    if (live) {
      try {
        live.onopen = null
        live.onmessage = null
        live.onerror = null
        live.onclose = null
        live.close()
      } catch { /* 已关闭 */ }
      live = null
    }
    status.liveConnected = false
  }

  function upsertChatFromRow(dst, account, chat, name) {
    const type = chat.isGroup ? 'group' : 'private'
    const key = lib.chatKey('qq', type, chat.sessionId)
    lib.upsertChat(dst, {
      chatKey: key,
      channel: 'qq',
      account,
      chatType: type,
      chatId: String(chat.sessionId),
      displayName: name || '',
      lastTs: Number(chat.lastTs || 0)
    })
    return key
  }

  function displayNameFor(src, chat, account) {
    const id = String(chat.sessionId || '')
    if (chat.isGroup) {
      const groupName = nameCache.groups.get(id)
      if (groupName) return groupName
      if (chat.name) return chat.name
    }
    const friendName = !chat.isGroup ? nameCache.friends.get(id) : ''
    if (friendName) return friendName
    if (chat.name) return chat.name
    if (chat.isGroup) return '群 ' + id
    const row = src.prepare(`
      SELECT data FROM messages WHERE is_group=0 AND session_id=?
      ORDER BY CASE WHEN private_direction=0 THEN 0 ELSE 1 END, timestamp DESC LIMIT 1
    `).get(Number(chat.sessionId))
    const data = parseData(row || {})
    const sender = data.sender || {}
    return String(sender.remark || sender.card || sender.nickname || '') || ('QQ ' + id)
  }

  function discoverChats(d) {
    return d.prepare(`
      SELECT is_group, session_id, COUNT(*) AS n, MAX(timestamp) AS last_ts,
        MAX(sequence) AS max_seq
      FROM messages
      WHERE session_id > 0
      GROUP BY is_group, session_id
    `).all().map((r) => ({
      isGroup: Number(r.is_group) === 1,
      sessionId: String(r.session_id),
      count: Number(r.n || 0),
      lastTs: Number(r.last_ts || 0) ? Number(r.last_ts) * 1000 : 0,
      maxSeq: Number(r.max_seq || 0)
    }))
  }

  function chatNamesFromOneBot() {
    // 只用来补显示名；协议端不在线不能阻断归档。失败就退回消息里的昵称。
    // 现在显示名直接取消息里的 sender.nickname / remark，所以这里保留为空实现，
    // 后续接群名列表时再在这里补，不把网络依赖塞进归档主路径。
    return { friends: new Map(), groups: new Map() }
  }

  function setSessionMappings(d) {
    const s = readJson(sessionsFile, null)
    const list = (s && s.sessions) || {}
    const byKey = new Map()
    Object.keys(list).forEach((sid) => {
      const x = list[sid] || {}
      const channel = String(x.channel || '').toLowerCase()
      if (channel !== 'qq') return
      const type = String(x.chatType || '').toLowerCase()
      if (type !== 'group' && type !== 'private') return
      const chatId = String(x.chatId || '')
      if (!chatId) return
      const key = lib.chatKey('qq', type, chatId)
      const at = Number(x.updatedAt || 0)
      const cur = byKey.get(key)
      if (!cur || at > cur.at) byKey.set(key, { sid, at })
    })
    byKey.forEach((v, key) => {
      try { lib.setChatSession(d, key, v.sid) } catch { /* 单个映射失败不阻断 */ }
    })
    return byKey.size
  }

  function syncChat(src, dst, account, chat, opts) {
    const s = opts || {}
    const type = chat.isGroup ? 'group' : 'private'
    const key = upsertChatFromRow(dst, account, chat)
    const name = displayNameFor(src, chat, account)
    lib.upsertChat(dst, {
      chatKey: key, channel: 'qq', account, chatType: type, chatId: String(chat.sessionId),
      displayName: name, lastTs: chat.lastTs
    })
    const state = lib.getSyncState(dst, key)
    let seq = Number(state.last_source_id || 0)
    if (!Number.isFinite(seq) || seq < 0) seq = 0
    let inserted = 0
    let pulled = 0
    let pages = 0
    const maxPages = state.initial_done ? clampInt(s.maxPagesPerSync, 1, 50, 8)
      : clampInt(s.initialPages, 1, 50, 5)
    let lastTs = Number(state.last_ts || 0)
    while (pages < maxPages) {
      const rows = src.prepare(`
        SELECT message_hash, is_group, session_id, sequence, timestamp, data, private_direction
        FROM messages
        WHERE is_group=? AND session_id=? AND sequence>?
        ORDER BY sequence ASC LIMIT ?
      `).all(chat.isGroup ? 1 : 0, Number(chat.sessionId), seq, clampInt(s.pageSize, 20, 500, 200))
      if (!rows.length) {
        if (state.initial_done !== 1) lib.setSyncState(dst, key, { lastSourceId: seq, lastTs, initialDone: 1 })
        break
      }
      const mapped = rows.map((r) => mapRow(r, account, chat)).filter(Boolean)
      if (mapped.length) {
        inserted += lib.insertMany(dst, mapped)
        const newest = mapped[mapped.length - 1]
        lastTs = Math.max(lastTs, Number(newest.ts || 0))
      }
      pulled += rows.length
      seq = Number(rows[rows.length - 1].sequence || seq)
      const more = rows.length >= clampInt(s.pageSize, 20, 500, 200)
      lib.setSyncState(dst, key, { lastSourceId: seq, lastTs, initialDone: more ? 0 : 1 })
      pages++
      if (!more) break
    }
    lib.refreshChatAggregates(dst, key)
    return { key, inserted, pulled, pages }
  }

  function syncAccount(source, settings, archive) {
    let d
    try {
      d = openSource(source.file)
    } catch (e) {
      return { account: source.account, error: '打开 SnowLuma messages.db 失败: ' + ((e && e.message) || e), inserted: 0, pulled: 0 }
    }
    let inserted = 0
    let pulled = 0
    let chats = 0
    try {
      const list = discoverChats(d)
      chats = list.length
      for (const chat of list) {
        // 跳过自己给自己：QQ 的「我的电脑/我的手机」一类，归档没有对话意义。
        if (!settings.includeSelfPrivate && !chat.isGroup && String(chat.sessionId) === String(source.account)) continue
        try {
          const r = syncChat(d, archive, source.account, chat, settings)
          inserted += r.inserted
          pulled += r.pulled
        } catch (e) {
          log('[archive] 同步 ' + source.account + ' / ' + (chat.isGroup ? '群 ' : '私聊 ') + chat.sessionId + ' 失败: ' + ((e && e.message) || e))
        }
      }
    } finally {
      try { d.close() } catch { /* 已关闭 */ }
    }
    return { account: source.account, chats, inserted, pulled }
  }

  function ensureDb() {
    if (db) return db
    db = lib.openDb(dbPath)
    return db
  }

  // 关系档案的熟悉度只由档案统计折算；这里做 10 分钟节流，避免每次同步都把全库扫一遍。
  function refreshSocialStats() {
    if (!socialState || typeof socialState.seedFromArchive !== 'function') return null
    if (Date.now() - socialStatsAt < 10 * 60 * 1000) return null
    socialStatsAt = Date.now()
    try {
      const r = socialState.seedFromArchive({})
      log('[social-state] 档案同步 ' + (r.ok
        ? (r.chats + ' 个聊天 / ' + r.people + ' 人（新增 ' + r.created + '）')
        : ('跳过：' + r.error)))
      return r
    } catch (e) {
      log('[social-state] 档案同步失败：' + String((e && e.message) || e))
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  async function syncOnce(reason) {
    if (running) return { ok: false, skipped: '正在同步中', status: statusGet() }
    if (!settingsGet().enabled) {
      status.lastError = ''
      status.lastNote = '档案已关闭'
      return { ok: false, skipped: '档案已关闭', status: statusGet() }
    }
    running = true
    status.running = true
    status.lastError = ''
    status.lastNote = String(reason || 'manual')
    const t0 = Date.now()
    let accounts = []
    let inserted = 0
    let pulled = 0
    try {
      const settings = settingsGet()
      const d = ensureDb()
      setSessionMappings(d)
      const wechat = importWechatListen()
      status.wechat = wechat
      inserted += Number(wechat.inserted || 0)
      if (Date.now() - Number(nameCache.at || 0) > 10 * 60 * 1000) await refreshNames()
      accounts = findAccounts(settings)
      status.accounts = accounts.map((x) => ({ account: x.account, file: x.file, ok: true }))
      if (!accounts.length) {
        status.lastNote = '没有 QQ 源库：QQ 部分跳过；微信档案照常实时写入'
      } else {
        for (const src of accounts) {
          const r = syncAccount(src, settings, d)
          inserted += r.inserted || 0
          pulled += r.pulled || 0
          const row = status.accounts.find((x) => x.account === src.account)
          if (row) {
            row.chats = r.chats || 0
            row.inserted = r.inserted || 0
            row.pulled = r.pulled || 0
            if (r.error) { row.ok = false; row.error = r.error; status.lastError = r.error }
          }
        }
        setSessionMappings(d)
      }
      status.lastSyncAt = Date.now()
      status.insertedLast = inserted
      status.pulledLast = pulled
      status.lastNote = (reason || 'manual') + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
      if (!status.lastError) refreshSocialStats()
      return { ok: status.lastError ? false : true, inserted, pulled, accounts, status: statusGet() }
    } catch (e) {
      status.lastError = '同步失败: ' + ((e && e.message) || e)
      status.lastSyncAt = Date.now()
      log('[archive] ' + status.lastError)
      return { ok: false, error: status.lastError, status: statusGet() }
    } finally {
      running = false
      status.running = false
    }
  }

  function statusGet() {
    let dbStatus = null
    try {
      if (fs.existsSync(dbPath)) {
        dbStatus = lib.getStatus(ensureDb(), dbPath)
        const chats = lib.listChats(ensureDb())
        dbStatus.chatsList = chats.slice(0, 30)
        dbStatus.sessionMapped = chats.filter((x) => x.sessionId).length
        const byChannel = {}
        for (const c of chats) {
          const ch = String(c.channel || 'other')
          byChannel[ch] = byChannel[ch] || { chats: 0, messages: 0 }
          byChannel[ch].chats++
          byChannel[ch].messages += Number(c.messageCount || 0)
        }
        dbStatus.channels = byChannel
      }
    } catch (e) {
      dbStatus = { ok: false, error: String((e && e.message) || e) }
    }
    return Object.assign({}, status, {
      db: dbStatus,
      settings: settingsGet(),
      running,
      enabled: settingsGet().enabled
    })
  }

  function listChatsForUi() {
    const d = ensureDb()
    return { ok: true, chats: lib.listChats(d) }
    }

  function resolveForArgs(args, sessionId) {
    const a = args || {}
    const d = ensureDb()
    return lib.resolveChat(d, a.chat || a.chatKey || '', sessionId || a.sessionId || '')
  }

  function scopeForUi(a, sessionId) {
    const input = String((a && (a.chat || a.chatKey)) || '').trim()
    if (!input && !sessionId) return { ok: true, chatKey: '' }
    return resolveForArgs(a, sessionId)
  }

  function search(args, sessionId) {
    const a = args || {}
    const r = scopeForUi(a, sessionId)
    if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
    const d = ensureDb()
    const from = a.date ? lib.dateStartMs(a.date) : (a.from ? lib.dateStartMs(a.from) : 0)
    const to = a.date ? lib.dateEndMs(a.date) : (a.to ? lib.dateEndMs(a.to) : 0)
    const rows = lib.searchMessages(d, {
      chatKey: r.chatKey, query: a.query || '', fromMs: from, toMs: to,
      sender: a.sender || '', limit: a.limit, context: a.context
    })
    return { ok: true, chatKey: r.chatKey, query: a.query || '', date: a.date || '', count: rows.length, matches: rows }
  }

  function recent(args) {
    const a = args || {}
    const d = ensureDb()
    const rows = lib.recentMessages(d, {
      chatKey: a.chat || a.chatKey || '',
      limit: a.limit
    })
    return { ok: true, count: rows.length, messages: rows }
  }

  function quote(args, sessionId) {
    const a = args || {}
    const r = scopeForUi(a, sessionId)
    if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
    const d = ensureDb()
    const from = a.date ? lib.dateStartMs(a.date) : (a.from ? lib.dateStartMs(a.from) : 0)
    const to = a.date ? lib.dateEndMs(a.date) : (a.to ? lib.dateEndMs(a.to) : 0)
    const rows = lib.quoteLookup(d, {
      chatKey: r.chatKey, phrase: a.phrase || a.query || '', fromMs: from, toMs: to,
      sender: a.sender || '', limit: a.limit, context: a.context === undefined ? 1 : a.context
    })
    return { ok: true, chatKey: r.chatKey, phrase: a.phrase || a.query || '', count: rows.length, matches: rows }
  }

  function daily(args, sessionId) {
    const a = args || {}
    const r = scopeForUi(a, sessionId)
    if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
    const d = ensureDb()
    const day = String(a.date || lib.dayOf(Date.now() - 24 * 3600 * 1000)).slice(0, 10)
    const page = lib.dailyPage(d, { day, chatKey: r.chatKey, cursor: a.cursor, limit: a.limit })
    const stats = lib.dailyStats(d, day, r.chatKey)
    return { ok: true, chatKey: r.chatKey, date: day, page, stats }
  }

 function memories(args, sessionId) {
  const a = args || {}
  const r = resolveForArgs(a, sessionId)
  if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
  const d = ensureDb()
  return { ok: true, chatKey: r.chatKey, memories: lib.listMemories(d, { chatKey: r.chatKey, query: a.query || '', limit: a.limit }) }
 }

  function memoryAdd(args, sessionId) {
    const a = args || {}
    const r = resolveForArgs(a, sessionId)
    if (!r.ok) return { ok: false, error: r.error, candidates: r.candidates || [] }
    const d = ensureDb()
    try {
      const x = lib.addMemory(d, {
        chatKey: r.chatKey, text: a.text || '', kind: a.kind || 'fact',
        evidenceIds: a.evidenceIds || a.evidence_ids || [], confidence: a.confidence
      })
      return { ok: true, chatKey: r.chatKey, memory: x }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  function start() {
    const settings = settingsGet()
    if (!settings.enabled || !settings.autoStart) {
      status.enabled = settings.enabled
      status.lastNote = settings.enabled ? 'autoStart 关闭' : '档案已关闭'
      return { ok: true, started: false, status: statusGet() }
    }
    ensureDb()
    if (timer) clearInterval(timer)
    timer = setInterval(function () {
      syncOnce('auto').catch(function (e) { log('[archive] 自动同步异常: ' + ((e && e.message) || e)) })
    }, settings.intervalMs)
    setTimeout(function () { syncOnce('auto-first').catch(function () {}) }, 2500)
    try { startLive() } catch (e) { log('[archive] 实时归档启动失败: ' + ((e && e.message) || e)) }
    status.enabled = true
    return { ok: true, started: true, status: statusGet() }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
    stopLive()
    status.running = false
    return { ok: true }
  }

  function close() {
    stop()
    try { if (db) lib.closeDb(db) } catch { /* 已关闭 */ }
    db = null
  }

  return {
    start, stop, close, syncOnce, statusGet, settingsGet, settingsSave,
    listChats: listChatsForUi, search, recent, quote, daily, memories, memoryAdd,
    archiveExternal,
    archiveWechat: function (x) { return archiveExternal(Object.assign({ channel: 'wechat', account: 'wechat' }, x || {})) },
    resolveChat: resolveForArgs, findAccounts: function () { return findAccounts(settingsGet()) },
    _test: { archiveEvent, mapEvent, refreshNames, importWechatListen }
  }
}

module.exports = { createService, DEFAULT_SETTINGS }
