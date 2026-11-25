// 场景能力目录（2026-11-25）
// 为什么有它：用户分场景不是为了把任务推来推去，是为了两件事——
//   ① 每个场景可观测：谁做的、在哪做、用的哪条命令；
//   ② 一眼看清某个场景现在有哪些功能（面板 / 按钮 / 命令 / 能接什么任务）。
// 所以「场景 = 能力容器」：能力清单不手写第二份，一律从 scenarios\*.json（面板 + 工具条按钮）
// 与 场景配置.js（设置项）现算，任何场景会话都能查「这事该谁做」，面板直接展示这份清单。
// ⛔ 换场景/加按钮/加设置项时不用改这里；只有「能接什么任务」的关键词要跟 外壳\data\pet\设置.json 的 routes 对齐。

const fs = require('fs');
const path = require('path');

const SCEN = path.join(__dirname, 'scenarios');

// 每个场景能接什么任务（派发口径的另一半：routes 管「原话 → 场景」，这里管「场景 → 能吃哪些词」）
const KEYWORDS = {
  pet: ['人格', '语气', '说话方式', '好感', '情绪', '关系', '边界', '主动开口', '免打扰', '口令', '大肥鱼'],
  life: ['B站', 'b站', '视频', '追更', '更新', '弹幕', 'up主', 'UP主', '发动态', '生活', '小号', '刷内容', '关注'],
  social: ['QQ', 'qq', '微信', '飞书', '通道', '桥接', 'SnowLuma', '群聊', '语音', '消息流', '控制台'],
  memory: ['记忆', '整理', '归档', '巡检', '换会话', '索引', '召回', '定论', '交接'],
  'code-dev': ['代码', '项目', '仓库', 'bug', '需求', '提交', '重构', '部署', '端口', '变更'],
  'pc-cleanup': ['清理', '磁盘', 'C盘', 'D盘', '垃圾', '空间', '大文件', '腾地方', '扫描'],
  'self-review': ['复盘', '周记', '日记', '总结', '回顾', '自我'],
  console: ['功能台', '脚本', '工具', '日志', '任务', '定时', '自动维护'],
};

// 每个场景最常用的命令（面板里显示一条能直接复制的，不追求全）
const COMMANDS = {
  pet: ['node 12-源码照搬\\工具\\桌宠.mjs 派 --文本 "<原话>"', 'node 12-源码照搬\\工具\\桌宠.mjs 能主动吗'],
  life: [
    'node 12-源码照搬\\工具\\刷内容.mjs 刷',
    'node 12-源码照搬\\工具\\B站操作.mjs 找系列 --名 "<系列名>"',
    'node 12-源码照搬\\工具\\B站操作.mjs 关注 --mid <uid>',
    'node 12-源码照搬\\工具\\追更.mjs 查'
  ],
  social: ['node 12-源码照搬\\工具\\社交状态.mjs check', 'node 12-源码照搬\\工具\\社交策略.mjs --check'],
  memory: ['node 12-源码照搬\\工具\\场景记忆.mjs 收工 --场景 <场景>', 'node 12-源码照搬\\工具\\自动维护.mjs status'],
  'code-dev': ['node 12-源码照搬\\外壳\\scripts\\测试.mjs', 'node 12-源码照搬\\工具\\未定义检查.mjs'],
  'pc-cleanup': ['node 12-源码照搬\\外壳\\scripts\\pc-scan.mjs'],
  'self-review': ['node 12-源码照搬\\工具\\场景记忆.mjs 读 --场景 自我复盘 --节 §〇'],
  console: ['node 12-源码照搬\\外壳\\功能台.js --verify'],
};

const TYPE_CN = {
  harness: 'AI 对话',
  rail: '工具条',
  channels: '通道',
  msgflow: '消息流',
  neuron: '记忆图',
  embed: '网页',
  'feature-board': '功能台',
  'feature-config': '配置与记录',
  search: '搜索',
};

// 每个场景「现在到底怎么干」——大脑要的不是按钮名，是机制。
// 为什么单独一张表：面板 / 按钮能从 scenarios 现算，机制（频次、闸门、产出落哪、边界）算不出来，
// 只能有人写一次；所以这张表就是机制的**唯一真源**，改机制改这里，生成时自动同步到
// 人格的 `_场景索引.md` 与场景面板的能力弹窗。⛔ 不要在别处再抄一份机制说明。
const MECHANISMS = {
  pet: [
    '人格卡是唯一性格源（设置弹窗），每轮由记忆回响注入，别的场景不许写语气',
    '派活先 桌宠.mjs 路由：派给 X / 归 X 但没独立会话 / 认不出，三种结果都直说',
    'routes 在 设置.json，没命中再用能力表兜底；社交与控制台归「本会话做」',
    '主动开口先过 proactiveGate：档位 / 免打扰 / 每小时上限，脚本记账',
    '派发日志落 场景记忆\\胡闹的大肥鱼\\派发日志.md'
  ],
  life: [
    '刷内容每天最多 2 次、跳过 30%、深读 1 条（劲儿不够自动停）',
    '必刷项：系列「大肥鱼小课堂」（UP 卡布奇诺ultra mid 171452765）有新一期必学，跳过概率对它不生效',
    '素材投给「胡闹的大肥鱼」定看哪条，生活只取不判（工具与通道）',
    '学习笔记落人格层 记忆\\学习\\，首行带来源：系列 / UP / mid / BV / 日期',
    '写操作额度：评论 / 私信 / 动态 12 时 · 30 天 · 间隔 120 秒 · 同视频 7 天',
    '认系列用 找系列（按视频作者归堆），多作者 exit 3 → 回执等人点头'
  ],
  social: [
    '通道顺序：微信 → QQ → 飞书 → 其它',
    'QQ 自动注入只接 autoLoadUin 指定的号，双开会短暂误挂再卸',
    '回信路由是硬闸：面板来源的回合不许用通道发送工具',
    '关系与情绪只调表达（字数 / emoji / 语音概率），不影响该不该回正事',
    '通道参数在 外壳\\data\\桥接.json，排障看 logs\\reply-router.jsonl'
  ],
  memory: [
    '写入口有闸门：相似 ≥50% 拒写，拿不准进待确认（确认 / 放弃后再落盘）',
    '收工 = 索引 + 近期 + 自动沉淀定论 + check + 待确认计数',
    '召回 = 标题×3 / 标签×2 / 正文×1 + 45 天热度，默认排除归档与过期',
    '自动维护六项：换会话 / 整理 / 巡检 / 清缓存 / 孤儿 staging / 崩溃回滚，真源 外壳\\data\\自动维护.json',
    '归档 >180 天；被 定论.sources 或他条 evidence 引用的不搬'
  ],
  'code-dev': [
    '三道闸：测试.mjs → 未定义检查 → 发布前检查，交付要写实际结果或「未执行 + 原因」',
    '改 main.js / 会话绑定 / 面板结构属 M 级：先给方案等确认',
    '提交 ≤8 文件 / ≤300 行，消息 type(scope): 中文摘要',
    '只推 gitee origin，不 force、不改写已推送历史'
  ],
  'pc-cleanup': [
    '扫描口径在 外壳\\data\\pc-cleanup.json（目录 / 扩展名 / 大文件阈值）',
    '只清缓存与垃圾，不删用户文件；危险操作两步确认',
    '清理结果落 外壳\\data\\自动维护.log'
  ],
  'self-review': [
    '复盘目录取 机器配置.json 的 reviewDir，跟着配置换',
    '日记按天、周记按周，分开落，不混写',
    '结论走记忆工具落盘，不手搓 md'
  ],
  console: [
    '功能台.js --verify 逐条核按钮：脚本在 / 开关名对得上 / 只读真跑，exit 1 = 有坏项',
    '新脚本头部写 @功能台 声明，没声明的落「未登记脚本」并报 warning',
    '自动维护卡改开关 / 阈值 / 周期，staging 与 rollback 下次启动生效'
  ],
};

function readJson(p) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// 描述太长（有的场景 description 上千字）：取到第一个句号/分号/逗号，最多 46 字，弹窗里当一行副标题
function summaryOf(desc) {
  const s = String(desc || '').replace(/\s+/g, '').trim();
  const i = s.search(/[。；，]/);
  const head = i > 0 ? s.slice(0, i) : s;
  return head.length > 46 ? head.slice(0, 46) + '…' : head;
}

function sceneFiles() {
  if (!fs.existsSync(SCEN)) return [];
  return fs.readdirSync(SCEN).sort().filter((f) => f.endsWith('.json') && !f.startsWith('_'));
}

// 现算全量清单；sceneCfg 可传进来复用（主进程已经建过一份），CLI 场景自己建
function build(opts) {
  const o = opts || {};
  let svc = o.sceneCfg || null;
  if (!svc) {
    try {
      svc = require('./场景配置.js')({
        dataDir: o.dataDir || path.join(__dirname, 'data'),
        dshHome: o.dshHome || path.join(__dirname, '..', '引擎数据', '.dsh'),
        reviewDir: o.reviewDir || '',
      });
    } catch (e) { svc = null; }
  }
  const out = [];
  for (const f of sceneFiles()) {
    const j = readJson(path.join(SCEN, f));
    if (!j || !j.id) continue;
    const all = j.panels || [];
    const rail = all.find((p) => p.type === 'rail');
    const panels = all.filter((p) => p.id && p.type !== 'rail' && p.type !== 'drawer' && p.type !== 'search');
    // 工具条按钮 = 这个场景「点一下就有的功能」，原样搬过来给面板展示（open 字符串交给渲染层解析）
    // 排除能力弹窗自己那枚按钮（否则「能力」里列「能力」，自指一遍没意义）
    const entries = ((rail && rail.items) || []).filter((it) => !/^scene-abil:/.test(String(it.open || ''))).map((it) => ({
      label: String(it.label || it.title || ''),
      desc: String(it.title || ''),
      icon: String(it.icon || ''),
      action: it.kind === 'call'
        ? { t: 'call', name: String(it.open || '') }
        : { t: 'panel', id: String(it.target || '') },
    }));
    let settings = [];
    try { settings = svc ? svc.list(j.id).map((x) => ({ key: x.key, title: x.title, kind: x.kind })) : []; } catch (e) { settings = []; }
    // 派发用哪个会话：多项目那种面板（multiProject）才是「接活」的主会话，不是绑某个项目的那个
    const harn = panels.filter((p) => p.type === 'harness');
    const main = harn.find((p) => p.multiProject) || harn[0];
    out.push({
      id: j.id,
      file: f,
      name: j.name || j.id,
      summary: summaryOf(j.description),
      description: String(j.description || ''),
      keywords: KEYWORDS[j.id] || [],
      session: (main && main.sessionTitle) || '',
      sessions: harn.map((p) => ({ title: String(p.sessionTitle || ''), panel: String(p.title || p.id), multiProject: !!p.multiProject })),
      panels: panels.map((p) => ({ id: p.id, title: p.title || p.id, kind: TYPE_CN[p.type] || p.type, type: p.type })),
      entries,
      settings,
      commands: COMMANDS[j.id] || [],
      mechanisms: MECHANISMS[j.id] || [],
    });
  }
  return out;
}

// 按原话找场景：命中词越长越具体（"B站" 比 "视频" 更算数）
function find(text, all) {
  const t = String(text || '');
  let best = null;
  for (const s of (all || build())) {
    let score = 0;
    const hit = [];
    for (const k of s.keywords) {
      if (t.includes(k)) { score += k.length; hit.push(k); }
    }
    if (score > 0 && (!best || score > best.score)) best = { scene: s, score, matched: hit };
  }
  return best;
}

const cache = { at: 0, all: null };
function memo(opts) {
  if (cache.all && Date.now() - cache.at < 10000) return cache.all;
  cache.all = build(opts);
  cache.at = Date.now();
  return cache.all;
}

module.exports = function createSceneAbilities(opts) {
  const o = opts || {};
  return {
    all: () => memo(o),
    list: (sceneId) => memo(o).find((s) => s.id === sceneId) || null,
    find: (text) => find(text, memo(o)),
    keywords: KEYWORDS,
    // 落盘：给人看的 md（入库）+ 给机器读的 json（本机），由 工具\场景能力.mjs 生成 调用
    dump: () => memo(o),
  };
};
