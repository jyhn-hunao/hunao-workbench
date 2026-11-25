// 场景设置目录（2026-11-25）
// 目的：每个场景一个常驻「设置」卡，卡里点开就是弹窗；弹窗里哪些项能改、字段类型、真源文件，全部集中在这张表，
// 不散落到渲染器里。写盘只写白名单字段（读现状 → 改指定键 → 写回），不做整文件覆盖，避免把手写过的 JSON 洗掉。
// 凭证类字段（adapterToken / breezeApiKey / bootstrapPassword 等）一律不进表：面板只做开关与口径，不摆密钥。

const path = require('path');
const fs = require('fs');

// 1. 读写工具：路径点号取值、只改指定键、值格式化
function readJsonFile(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // 手写/记事本存的文件常带 BOM，不剥掉 JSON.parse 直接炸
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), missing: !!(e && e.code === 'ENOENT') };
  }
}

function getPath(obj, dotPath) {
  return String(dotPath).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setPath(obj, dotPath, val) {
  const parts = String(dotPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

function fmt(v) {
  if (v == null) return '未设置';
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (Array.isArray(v)) return v.length + ' 项';
  if (typeof v === 'object') return Object.keys(v).length + ' 项';
  return String(v);
}

// 「定时任务」的字段是现算的：tasks 条数不定，一条任务 = 时间 + 开关 + 让它干什么。
// 放在模块级是因为 buildSpecs（出目录）与 read/save（出字段）都要用同一份算法。
// group 用任务名：弹窗里一条任务一块，免得几条任务的时间/文本混在同一张网格里分不清谁是谁（2026-11-25 重做排版）。
function petTimerFields(file) {
  const r = readJsonFile(file);
  const tasks = (r.ok && r.data && Array.isArray(r.data.tasks)) ? r.data.tasks : [];
  const out = [];
  tasks.forEach((t, i) => {
    const name = String((t && (t.title || t.id)) || ('任务 ' + (i + 1)));
    out.push({ p: 'tasks.' + i + '.time', label: '时间', t: 'text', group: name, hint: 'HH:MM（24 小时制）' });
    out.push({ p: 'tasks.' + i + '.enabled', label: '这条开着', t: 'bool', group: name, hint: '关掉就不跑' });
    out.push({ p: 'tasks.' + i + '.text', label: '让它干什么', t: 'text', group: name, wide: true, hint: '到点后发给她的原话' });
  });
  return out;
}

// 2. 各场景的配置项表（只列真实存在、能落到文件的项）
function buildSpecs(ctx) {
  const DATA = ctx.dataDir;
  const DSH = ctx.dshHome;
  const PET = path.join(DATA, 'pet');
  const dataFile = (name) => path.join(DATA, name);

  return {
    // 人格场景：设置项在右侧「设置」竖条里，一项一个按钮；这里放「她按点干什么」和「劲儿」——都能改
    pet: [
      { key: 'persona', kind: 'open', open: 'openPetSettings', title: '桌宠设置', desc: '她是谁、怎么说、能不能主动、什么要先问你、免打扰', danger: false },
      {
        key: 'timers', kind: 'edit', title: '定时任务', desc: '按点干的事：改时间 / 开关 / 让它干什么（写 pet\\定时.json）',
        file: path.join(PET, '定时.json'), danger: false, dyn: 'petTimers', brief: ['tasks']
      },
      {
        key: 'energy', kind: 'edit', title: '劲儿', desc: '主动开口的燃料：0–100 手动补一点或压下去（写 pet\\劲儿.json）',
        file: path.join(PET, '劲儿.json'), danger: false, brief: ['energy'],
        fields: [
          { p: 'energy', label: '劲儿（0–100）', t: 'num', min: 0, max: 100, step: 1, wide: true, hint: '平时每轮自己攒、开口会消耗；这里改的是当前值' }
        ]
      }
    ],

    // 生活场景：生活设置已是专用弹窗（额度、刷什么发什么都在里面，不再单列一条只读）
    life: [
      { key: 'lifeCfg', kind: 'open', open: 'openLifeConfig', title: '生活设置', desc: '刷什么、发什么、小号同步、发布额度', danger: false }
    ],

    // 社交场景：所有设置都收在场景「设置」卡里，通道卡上不再放 ⚙（2026-11-25）
    social: [
      { key: 'order', kind: 'open', open: 'openChannelOrder', title: '主动出消息', desc: '她主动找你时先走哪条通道', danger: false },
      { key: 'qqAccess', kind: 'open', open: 'openQqChannelSettings', title: 'QQ 接入', desc: '接哪个 QQ 号、哪个聊天进哪条会话（会话路由也在这里）', danger: false },
      { key: 'qqReply', kind: 'open', open: 'openQqReplySettings', title: 'QQ 群聊与语音', desc: '群旁听、随机接话概率、语音出站、表情包、语音合成', danger: false },
      { key: 'wechatSet', kind: 'open', open: 'openWechatSettings', title: '鲸鲸设置（微信）', desc: '微信账号、群聊触发、原生功能、回复长度、后台发送、会话隔离', danger: false },
      {
        key: 'safety', kind: 'edit', title: '安全闸门', desc: '对外说话前的检查口径：总开关 / 模式 / 拿不准怎么办（写 安全闸门.json）',
        file: dataFile('安全闸门.json'), danger: true, brief: ['enabled', 'mode'],
        fields: [
          { p: 'enabled', label: '总开关', t: 'bool', group: '基本', hint: '关掉 ＝ 一句都不检查（只建议临时用）' },
          { p: 'mode', label: '模式', t: 'text', group: '基本', hint: 'enforce ＝ 拦住；warn ＝ 只记录不拦' },
          { p: 'unknownAction', label: '拿不准时', t: 'text', group: '基本', hint: 'block ＝ 不说；redact ＝ 打过码再说' },
          { p: 'storeBlockedText', label: '存被拦正文', t: 'bool', group: '基本', hint: '存下来方便回看为什么被拦' },
          { p: 'channels.wechat', label: '微信', t: 'bool', group: '在哪条通道生效' },
          { p: 'channels.qq', label: 'QQ', t: 'bool', group: '在哪条通道生效' },
          { p: 'channels.feishu', label: '飞书', t: 'bool', group: '在哪条通道生效' },
          { p: 'replyFallback', label: '被拦时先说这句', t: 'text', group: '拦下之后', wide: true, hint: '对方看到的替身回复，别写成道歉' }
        ]
      }
    ],
    // 记忆场景：只留「能改的」；上次整理 / 上次巡检这种台账不再单占一个按钮
    memory: [
      {
        key: 'auto', kind: 'edit', title: '自动维护', desc: '记忆整理、巡检、退出清缓存、孤儿 staging、崩溃回滚', file: dataFile('自动维护.json'), danger: true, brief: ['tidy.enabled', 'tidy.everyDays', 'inspect.everyHours'],
        fields: [
          { p: 'tidy.enabled', label: '记忆整理', t: 'bool', group: '记忆整理', hint: '把超过 180 天的条目搬进归档' },
          { p: 'tidy.everyDays', label: '整理周期（天）', t: 'num', min: 1, max: 60, group: '记忆整理' },
          { p: 'inspect.enabled', label: '记忆巡检', t: 'bool', group: '记忆巡检', hint: '查结构 / 词表 / 证据 / 索引过期' },
          { p: 'inspect.everyHours', label: '巡检周期（小时）', t: 'num', min: 1, max: 72, group: '记忆巡检' },
          { p: 'cacheClean.enabled', label: '退出清缓存', t: 'bool', group: '缓存与启动', hint: '只在正常退出时清' },
          { p: 'cacheClean.thresholdMb', label: '缓存阈值（MB）', t: 'num', min: 100, max: 8000, group: '缓存与启动' },
          { p: 'stagingClean.enabled', label: '清孤儿 staging', t: 'bool', group: '缓存与启动', hint: '下次启动生效' },
          { p: 'rollback.enabled', label: '崩溃回滚', t: 'bool', group: '缓存与启动', hint: '下次启动生效' }
        ]
      },
      {
        key: 'rotate', kind: 'edit', title: '自动换会话', desc: '上下文快满就换新会话，免得越聊越糊涂', file: dataFile('自动换会话.json'), danger: true, brief: ['enabled', 'threshold', 'minTurns'],
        fields: [
          { p: 'enabled', label: '开着', t: 'bool', group: '什么时候换' },
          { p: 'threshold', label: '用到 % 就换', t: 'num', min: 50, max: 99, group: '什么时候换' },
          { p: 'minTurns', label: '至少聊几轮', t: 'num', min: 5, max: 100, group: '什么时候换' },
          { p: 'idleMin', label: '空闲多久也算', t: 'num', min: 0, max: 240, group: '什么时候换', hint: '0 ＝ 不看空闲' },
          { p: 'cooldownMin', label: '换完冷却（分）', t: 'num', min: 5, max: 600, group: '换完之后', hint: '冷却里不再换第二次' }
        ]
      }
    ],

    // 控制台场景：工具跑起来的口径
    console: [
      {
        key: 'tools', kind: 'edit', title: '工具策略', desc: '功能台跑脚本的缓存、并发、输出截断、日志保留', file: dataFile('工具策略.json'), danger: false, brief: ['maxRunning', 'outputCapChars', 'logKeepPerFeature'],
        fields: [
          { p: 'statusCacheSec', label: '状态缓存（秒）', t: 'num', min: 0, max: 600, group: '执行' },
          { p: 'maxRunning', label: '同时最多跑几个', t: 'num', min: 1, max: 8, group: '执行' },
          { p: 'outputCapChars', label: '输出总上限（字符）', t: 'num', min: 2000, max: 200000, group: '输出截断' },
          { p: 'outputHeadChars', label: '保留开头（字符）', t: 'num', min: 200, max: 50000, group: '输出截断' },
          { p: 'outputTailChars', label: '保留结尾（字符）', t: 'num', min: 200, max: 50000, group: '输出截断' },
          { p: 'uiTextChars', label: '界面显示上限（字符）', t: 'num', min: 200, max: 20000, group: '输出截断' },
          { p: 'logKeepPerFeature', label: '每条功能留几份日志', t: 'num', min: 1, max: 50, group: '日志' },
          { p: 'recentCount', label: '最近记录几条', t: 'num', min: 5, max: 200, group: '日志' },
          { p: 'logListCount', label: '日志列表几条', t: 'num', min: 5, max: 200, group: '日志' }
        ]
      },
      {
        key: 'auto', kind: 'edit', title: '自动维护', desc: '与「记忆」场景同一个文件，改哪边都一样', file: dataFile('自动维护.json'), danger: true, brief: ['tidy.enabled', 'inspect.enabled'],
        fields: [
          { p: 'tidy.enabled', label: '记忆整理', t: 'bool', group: '开关' },
          { p: 'inspect.enabled', label: '记忆巡检', t: 'bool', group: '开关' },
          { p: 'cacheClean.enabled', label: '退出清缓存', t: 'bool', group: '开关' },
          { p: 'stagingClean.enabled', label: '清孤儿 staging', t: 'bool', group: '开关' },
          { p: 'rollback.enabled', label: '崩溃回滚', t: 'bool', group: '开关' }
        ]
      }
    ],

    // 程序开发场景：端口（能改）；变更单 / 登记项目属于台账，已从按钮里撤掉（项目在「AI多项目管理」里接）
    'code-dev': [
      {
        key: 'ports', kind: 'edit', title: '端口', desc: '引擎/站点/预览/网页版 AI 各自占哪个口', file: path.join(DSH, '机器配置.json'), danger: true, brief: ['ports.dsh', 'ports.site', 'ports.preview'],
        fields: [
          { p: 'ports.dsh', label: '引擎端口', t: 'num', min: 1024, max: 65535, group: '端口', hint: '改完重启整壳；与其它引擎冲突时用环境变量覆盖' },
          { p: 'ports.site', label: '站点端口', t: 'num', min: 1024, max: 65535, group: '端口' },
          { p: 'ports.preview', label: '预览端口', t: 'num', min: 1024, max: 65535, group: '端口' },
          { p: 'ports.webAi', label: '网页版 AI 端口', t: 'num', min: 1024, max: 65535, group: '端口' }
        ]
      }
    ],

    // 电脑清理场景：扫描口径可改（pc-scan.mjs 默认读这份）；清理台账不再单占按钮
    'pc-cleanup': [
      {
        key: 'scan', kind: 'edit', title: '扫描口径', desc: '下次扫描按这里来：多大才列出来 / 扫多深 / 最多扫几秒（写 data\\pc-cleanup.json）',
        file: dataFile('pc-cleanup.json'), danger: false, brief: ['minGb', 'depth', 'budgetSec'],
        fields: [
          { p: 'minGb', label: '只看大于（GB）', t: 'num', min: 0.01, max: 50, step: 0.1, group: '扫描口径', hint: '小于这个体积的目录不进清单' },
          { p: 'depth', label: '扫描深度', t: 'num', min: 1, max: 4, group: '扫描口径', hint: '1 ＝ 只扫盘根下第一层' },
          { p: 'budgetSec', label: '最多扫几秒', t: 'num', min: 30, max: 1800, group: '扫描口径', hint: '到点就收，先给半份结果' },
          { p: 'skipJunk', label: '跳过已知垃圾位', t: 'bool', group: '扫描口径', hint: '临时目录 / 回收站这类固定位置不扫' }
        ]
      }
    ],

    // 自我复盘场景：可配的只有「复盘目录」（写 机器配置.json 的 reviewDir，改完重启整壳）
    'self-review': [
      {
        key: 'lib', kind: 'edit', title: '复盘目录', desc: '复盘文档放哪、有几篇（写 机器配置.json 的 reviewDir）',
        file: path.join(DSH, '机器配置.json'), danger: false, brief: ['reviewDir'],
        fields: [
          { p: 'reviewDir', label: '复盘目录（绝对路径）', t: 'text', wide: true, dflt: ctx.reviewDir || '', hint: '默认 <仓根>\\自我复盘；改完重启整壳，文档面板与「库」都跟着走' }
        ]
      }
    ]
  };
}

module.exports = function createSceneConfig(ctx) {
  const SPECS = buildSpecs(ctx);

  // 字段表：静态项用表里的 fields；「定时任务」这类条数不定的现算（read 与 save 必须用同一份）
  function fieldsOf(it) {
    if (it && it.dyn === 'petTimers') return petTimerFields(it.file);
    return (it && it.fields) || [];
  }

  function itemsFor(sceneId) {
    const spec = SPECS[sceneId];
    if (!spec) return [];
    return spec.map((it) => {
      const out = { key: it.key, kind: it.kind, title: it.title, desc: it.desc || '', danger: !!it.danger };
      if (it.kind === 'open') { out.open = it.open; return out; }
      if (!it.file) { out.summary = ''; out.ok = true; return out; }
      const r = readJsonFile(it.file);
      const data = r.ok ? r.data : {};
      const fields = fieldsOf(it);
      const brief = (it.brief || []).map((p) => {
        const f = fields.find((x) => x.p === p);
        return (f ? f.label + ' ' : '') + fmt(getPath(data, p));
      });
      out.summary = brief.length ? brief.join(' · ') : (r.ok ? '' : '读不到：' + (r.missing ? '文件还没生成' : r.error));
      out.ok = r.ok;
      return out;
    });
  }

  function readItem(sceneId, key) {
    const spec = SPECS[sceneId];
    const it = spec && spec.find((x) => x.key === key);
    if (!it) return { ok: false, error: '这个场景没有这一项：' + key };
    if (it.kind === 'open') return { ok: true, kind: 'open', open: it.open, title: it.title, desc: it.desc || '' };
    if (it.kind === 'view') {
      const r = it.file ? readJsonFile(it.file) : { ok: true, data: {} };
      const data = r.ok ? r.data : {};
      const rows = (it.show || []).map((s) => ({ label: s.label, value: fmt(getPath(data, s.p)) }));
      return { ok: true, kind: 'view', title: it.title, desc: it.desc || '', file: it.file || '', rows, missing: !r.ok && !!r.missing, error: r.ok ? '' : r.error };
    }
    const r = readJsonFile(it.file);
    // 文件还没生成（比如 pc-cleanup.json 从没配过 / 机器配置里没这一项）也算「能改」：
    // 给空字段让用户填，保存时 saveItem 会把文件建出来，不把入口锁死成「读不到」。
    if (!r.ok && !r.missing) return { ok: false, error: '读不到 ' + it.file + '：' + r.error };
    const data = r.ok ? r.data : {};
    const fields = fieldsOf(it).map((f) => {
      const v = getPath(data, f.p);
      const out = Object.assign({}, f, { value: v === undefined ? (f.dflt !== undefined ? f.dflt : '') : v });
      if (v === undefined) out.unset = true;   // 界面上可以提示「还没配过，保存就建」
      return out;
    });
    return { ok: true, kind: 'edit', title: it.title, desc: it.desc || '', file: it.file, danger: !!it.danger, fields, missing: !r.ok && !!r.missing };
  }

  function saveItem(sceneId, key, patch) {
    const spec = SPECS[sceneId];
    const it = spec && spec.find((x) => x.key === key);
    if (!it || it.kind !== 'edit') return { ok: false, error: '这一项不能在这里改：' + key };
    const r = readJsonFile(it.file);
    if (!r.ok && !r.missing) return { ok: false, error: '现有文件读不动，没敢覆盖：' + r.error };
    const data = r.ok ? r.data : {};
    const fields = fieldsOf(it);
    const allowed = fields.map((f) => f.p);
    const p = patch && typeof patch === 'object' ? patch : {};
    // 只认表里列过的字段；类型按表里声明的收一下，收不住就报错，不做静默兜底
    for (const k of Object.keys(p)) {
      if (!allowed.includes(k)) continue;
      const f = fields.find((x) => x.p === k);
      let v = p[k];
      if (f.t === 'bool') v = !!v;
      else if (f.t === 'num') {
        v = Number(v);
        if (!Number.isFinite(v)) return { ok: false, error: '「' + f.label + '」不是数字' };
        if (f.min != null && v < f.min) v = f.min;
        if (f.max != null && v > f.max) v = f.max;
      } else v = String(v == null ? '' : v);
      setPath(data, k, v);
    }
    try {
      fs.mkdirSync(path.dirname(it.file), { recursive: true });
      fs.writeFileSync(it.file, JSON.stringify(data, null, 2) + '\n', 'utf8');
      return { ok: true, file: it.file };
    } catch (e) {
      return { ok: false, error: '写不进去：' + String((e && e.message) || e) };
    }
  }

  return { scenes: () => Object.keys(SPECS), list: itemsFor, read: readItem, save: saveItem };
};
