// 功能台.js —— 把「只能命令行」的工作台功能接出界面入口（2026-11-14）
//
// 为什么单文件：main.js 已经 380KB，这份清单还要能脱离 Electron 自测（node 功能台.js --json）。
// 三条硬约定：
//   ① 只跑白名单里的脚本：脚本路径写死在这里，界面只能传 feature id + action id + 白名单输入项；
//   ② 不进 shell：spawn(process.execPath, [脚本, ...参数])，参数逐项进 argv，不拼命令行；
//   ③ 配置只写「真实那一份」：开关改 profile 的 patch、生图 key 进 机器配置.json，
//      本文件只存界面偏好（上次结果 / 常用参数），⛔ 不另造一套影子状态。
//
// 数据去向：外壳\data\功能台.json（本机，不入库）—— { ui: {...}, params: {...}, last: {...} }
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SHELL = __dirname;                              // 外壳
const ROOT = path.resolve(SHELL, '..');               // 12-源码照搬
const CFG_DIR = path.join(SHELL, 'data');
const CFG_FILE = path.join(CFG_DIR, '功能台.json');
const SCEN_DIR = path.join(SHELL, 'scenarios');
const MEM_DIR = path.join(process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh'), '场景记忆');

// 1. 分组：界面按组切面板，一组一块（组名与说明直接展示给人）
const GROUPS = [
  { id: 'switch', title: '插件开关', plain: '省 token / 守卫 / 记忆回响：装没装、什么模式、一条命令切（改完重启整壳生效）' },
  { id: 'memory', title: '记忆维护', plain: '近期记忆 / 人格记忆 / 通道记忆 / 场景记忆体检与收工 —— 原来全在命令行' },
  { id: 'guard', title: '自检与发布', plain: '发布前红线、各层自检、引擎升级后接线核对（只读，跑完看输出）' },
  { id: 'flow', title: '协作与通道', plain: '人格引用同步、跨场景发消息、会话改名' },
  { id: 'creative', title: '创意与资产', plain: '生图、资产包检查、打发布包' },
];

// 2. 功能登记：一条 = 一个脚本 + 它能干的几件事（args 是纯函数，只吃白名单输入）
const FEATURES = [
  // ── 插件开关 ─────────────────────────────────────────────────────────
  {
    id: 'token-switch', group: 'switch', name: '省 token 开关',
    plain: '把引擎自带的历史摘要 / 工具返回截断按需打开，长会话不再一路涨到几十万上下文。',
    why: '原来要手改 profile 的 YAML（缩进错一位引擎就起不来），所以只留了命令行。',
    script: '工具\\省token开关.mjs', restart: true, statusArgs: ['--status'],
    actions: [
      { id: 'status', label: '看状态', args: () => ['--status'] },
      {
        id: 'on', label: '打开', danger: 'write',
        inputs: [
          { key: 'threshold', label: '阈值', kind: 'number', def: '0.5', hint: '占上下文多少就摘要，0.5 = 一半' },
          { key: 'retain', label: '摘要后留', kind: 'number', def: '0.12', hint: '保留比例，0.12 = 12%' },
        ],
        args: (v) => ['--on', '--threshold', v.threshold || '0.5', '--retain', v.retain || '0.12'],
      },
      { id: 'off', label: '关掉', danger: 'write', args: () => ['--off'] },
    ],
  },
  {
    id: 'token-guard', group: 'switch', name: '省 token 守卫（插件）',
    plain: '把 插件\\省token守卫 作为 bundle 组进 web profile；shadow 只记日志，enforce 真拦。',
    why: '走 bundle 才是官方「新增插件」通道，手写 patch 新增 id 会被引擎拒掉。',
    script: '工具\\守卫开关.mjs', restart: true, statusArgs: ['--status'],
    actions: [
      { id: 'status', label: '看状态', args: () => ['--status'] },
      {
        id: 'on', label: '装上', danger: 'write',
        inputs: [{
          key: 'mode', label: '模式', kind: 'select', def: 'shadow',
          options: [{ v: 'shadow', t: 'shadow（只记不拦）' }, { v: 'enforce', t: 'enforce（真拦）' }],
        }],
        args: (v) => ['--on', '--mode', v.mode === 'enforce' ? 'enforce' : 'shadow'],
      },
      { id: 'off', label: '摘掉', danger: 'write', args: () => ['--off'] },
    ],
  },
  {
    id: 'mem-recall', group: 'switch', name: '记忆回响（每轮注入）',
    plain: '让引擎每轮把场景记忆的 §〇 / 近期 / 命中条目注入进上下文，不再靠会话自己想起来。',
    why: '插件在引擎启动时加载，装完 / 改模式必须重启整壳（⛔ 不要只重启引擎，token 会失效）。',
    script: '工具\\记忆回响.mjs', restart: true, statusArgs: ['--check'],
    actions: [
      { id: 'check', label: '查一遍', args: () => ['--check'] },
      { id: 'apply', label: '装上', danger: 'write', args: () => ['--apply'] },
      {
        id: 'mode', label: '改模式', danger: 'write',
        inputs: [{
          key: 'mode', label: '模式', kind: 'select', def: 'shadow',
          options: [{ v: 'shadow', t: 'shadow（只记日志）' }, { v: 'enforce', t: 'enforce（真注入）' }],
        }],
        args: (v) => ['--mode', v.mode === 'enforce' ? 'enforce' : 'shadow'],
      },
      { id: 'off', label: '摘掉', danger: 'write', args: () => ['--off'] },
    ],
  },

  // ── 记忆维护 ─────────────────────────────────────────────────────────
  {
    id: 'recent-mem', group: 'memory', name: '近期记忆生成',
    plain: '从 决策\\ / 坑\\ / _待办.md 抽最近若干条，压成 _近期.md（开场注入的第三段）。',
    why: '人格场景归 人格记忆.mjs 管，这里默认拒绝覆盖它；其余 6 个场景原来没有生成器。',
    script: '工具\\近期记忆.mjs',
    actions: [
      { id: 'all', label: '全部重算', danger: 'write', args: () => ['生成', '--all'] },
      { id: 'dry', label: '只看计划', args: () => ['生成', '--all', '--dry'] },
      {
        id: 'one', label: '生成一个场景', danger: 'write',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['生成', '--场景', v.scene],
      },
    ],
  },
  {
    id: 'persona-mem', group: 'memory', name: '人格记忆（胡闹的大肥鱼）',
    plain: '把「她记得什么」写成带前置元数据的条目：记忆\\（长期）/ 对话\\（聊过）/ _待办.md。',
    why: '原来只有 AGENTS.md 一句「该记的事写记忆\\」，没有可执行工具 ⇒ 靠模型临场发挥，容易漏、容易写成孤儿文件。',
    script: '工具\\人格记忆.mjs',
    actions: [
      { id: 'check', label: '体检', args: () => ['体检'] },
      {
        id: 'read', label: '召回',
        inputs: [{ key: 'word', label: '关键词', kind: 'text', required: true, hint: '标题 / 正文里含这个词的条目' }],
        args: (v) => ['读', '--词', v.word],
      },
      {
        id: 'archive', label: '归档老条目', danger: 'write',
        inputs: [{ key: 'days', label: '超过几天', kind: 'number', def: '180' }],
        args: (v) => ['归档', '--天', v.days || '180'],
      },
      {
        id: 'archiveDry', label: '只看归档计划',
        inputs: [{ key: 'days', label: '超过几天', kind: 'number', def: '180' }],
        args: (v) => ['归档', '--天', v.days || '180', '--dry'],
      },
    ],
  },
  {
    id: 'channel-mem', group: 'memory', name: '通道记忆（QQ / 飞书）',
    plain: '从引擎转录里把带通道前缀的往来捞出来，配成「他说 → 她答」写进人格的对话记忆。',
    why: '桥接插件只负责投消息，不会替她记；隔天再开口就只剩上下文里那点残影。',
    script: '工具\\通道记忆.mjs',
    actions: [
      { id: 'dry', label: '只看会记哪几条', args: () => ['--dry'] },
      { id: 'run', label: '记进去', danger: 'write', args: () => [] },
      {
        id: 'limit', label: '限量记', danger: 'write',
        inputs: [{ key: 'n', label: '本次最多', kind: 'number', def: '40' }],
        args: (v) => ['--条', v.n || '40'],
      },
    ],
  },
  {
    id: 'scene-mem-check', group: 'memory', name: '场景记忆体检',
    plain: '场景层全量 check：§五 又攒正文 / 单篇超 2 KB / 证据指空，出包前就该拦住。',
    why: '发布前检查把它当闸门挂进去了，但想单独跑一次原来只能敲命令。',
    script: '工具\\场景记忆.mjs', timeout: 180000,
    actions: [{ id: 'all', label: '全量 check', args: () => ['check', '--all'] }],
  },
  {
    id: 'scene-mem-index', group: 'memory', name: '场景记忆索引',
    plain: '分条记忆 → _索引.json（神经元按它画点、连联想边），归档条目也进索引。',
    script: '工具\\场景记忆.mjs', timeout: 180000,
    actions: [
      { id: 'all', label: '重建全部索引', danger: 'write', args: () => ['索引', '--all'] },
      {
        id: 'one', label: '重建一个场景', danger: 'write',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['索引', '--场景', v.scene],
      },
    ],
  },
  {
    id: 'mem-pack', group: 'memory', name: '记忆打包（快照 / 核对 / 恢复）',
    plain: 'git 之外再给一层完整快照：场景记忆 + 各项目 memory\\ 整目录拷贝 + sha256 清单；换机、回滚、兜底都用它。',
    why: '归档\\、项目.json、身份卡画像这些被 gitignore 的本机内容，git 救不回来，原来只能敲命令。',
    script: '工具\\记忆打包.mjs', timeout: 600000,
    actions: [
      { id: 'pack', label: '打包一次', danger: 'write', args: () => ['打包'] },
      {
        id: 'verify', label: '核对一个包',
        inputs: [{ key: 'pack', label: '包目录', kind: 'dir', required: true }],
        args: (v) => ['核对', '--包', v.pack],
      },
      { id: 'schema', label: '升版数据契约', danger: 'write', args: () => ['升版'] },
      {
        id: 'restore', label: '恢复（先自动快照当前）', danger: 'destructive',
        inputs: [{ key: 'pack', label: '包目录', kind: 'dir', required: true }],
        args: (v) => ['恢复', '--包', v.pack],
      },
    ],
  },
  {
    id: 'scene-mem-finish', group: 'memory', name: '场景收工',
    plain: '一条命令收尾：索引 + 近期记忆 + check + 待确认计数（漏一步会出现「写了但开场没带上」）。',
    script: '工具\\场景记忆.mjs', timeout: 180000,
    actions: [{
      id: 'one', label: '收工一个场景', danger: 'write',
      inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
      args: (v) => ['收工', '--场景', v.scene],
    }],
  },
  {
    id: 'scene-mem-maint', group: 'memory', name: '场景记忆 · 写入闸门与整理',
    plain: '相似 ≥50% 拒写、拿不准进待确认；存量条目拆分、>180 天整理归档、同主题 ≥3 条沉淀定论。',
    why: '这组原来全在命令行：待确认要人一条条 --序号 点头，拆分/整理/沉淀各有 --dry 判据。',
    script: '工具\\场景记忆.mjs', timeout: 180000,
    actions: [
      {
        id: 'pending', label: '看待确认',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['待确认', '--场景', v.scene],
      },
      {
        id: 'confirm', label: '确认一条', danger: 'write',
        inputs: [
          { key: 'scene', label: '场景', kind: 'memscene', required: true },
          { key: 'no', label: '序号', kind: 'number', required: true, hint: '待确认清单里的序号' },
        ],
        args: (v) => ['确认', '--场景', v.scene, '--序号', v.no],
      },
      {
        id: 'splitDry', label: '看拆分计划',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['拆', '--场景', v.scene, '--dry'],
      },
      {
        id: 'split', label: '拆成分条', danger: 'destructive',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['拆', '--场景', v.scene],
      },
      {
        id: 'tidy', label: '整理归档（>180 天）', danger: 'destructive',
        inputs: [
          { key: 'scene', label: '场景', kind: 'memscene', required: true },
          { key: 'days', label: '超过几天', kind: 'number', def: '180' },
        ],
        args: (v) => ['整理', '--场景', v.scene, '--days', v.days || '180'],
      },
      {
        id: 'tidyDry', label: '看整理计划',
        inputs: [
          { key: 'scene', label: '场景', kind: 'memscene', required: true },
          { key: 'days', label: '超过几天', kind: 'number', def: '180' },
        ],
        args: (v) => ['整理', '--场景', v.scene, '--days', v.days || '180', '--dry'],
      },
      {
        id: 'distill', label: '沉淀定论', danger: 'destructive',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['沉淀', '--场景', v.scene],
      },
      {
        id: 'distillDry', label: '看沉淀计划',
        inputs: [{ key: 'scene', label: '场景', kind: 'memscene', required: true }],
        args: (v) => ['沉淀', '--场景', v.scene, '--dry'],
      },
    ],
  },
  {
    id: 'mem-tool-check', group: 'memory', name: '项目记忆体检',
    plain: '项目 memory\\ 的结构 / 词表 / 证据 / 召回 / 备份 / 体量 / 新鲜度一次过；exit 0 才算健康。',
    script: '工具\\记忆.mjs', timeout: 180000,
    actions: [{
      id: 'doctor', label: '体检一个项目',
      inputs: [{ key: 'project', label: '项目根目录', kind: 'dir', required: true }],
      args: (v) => ['体检', '--project', v.project],
    }],
  },
  {
    id: 'mem-selftest', group: 'memory', name: '记忆工具自检',
    plain: '在系统临时目录造样本，验 init / index / recall / card / check / migrate 与忽略规则（不碰真实项目）。',
    script: '工具\\记忆自检.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '跑一遍', args: () => [] }],
  },

  // ── 自检与发布 ────────────────────────────────────────────────────────
  {
    id: 'publish-check', group: 'guard', name: '发布前检查',
    plain: '红线（本机路径 / 密钥 / sessionId 泄露）+ 可移植性 + 场景记忆闸门；出包和推仓库前跑。',
    script: '工具\\发布前检查.mjs', timeout: 300000,
    actions: [{ id: 'run', label: '开始检查', args: () => [] }],
  },
  {
    id: 'pet-selftest', group: 'guard', name: '桌宠策略自检',
    plain: '审批策略 / 路由 / 主动闸门 13 项行为用例；改设置面板或路由后跑一次就知道有没有回归。',
    script: '工具\\桌宠自检.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '跑用例', args: () => [] }],
  },
  {
    id: 'render-selftest', group: 'guard', name: '渲染自检',
    plain: '用假 DOM 在 Node 里整份加载 renderers.js，再真调 renderers.neuron —— 拦「语法能过、运行时炸」。',
    script: '外壳\\scripts\\渲染自检.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '跑一遍', args: () => [] }],
  },
  {
    id: 'usage-selftest', group: 'guard', name: '用量自检',
    plain: '验 外壳\\用量.js 的算法 + 用量面板能跑到末尾（不开窗口也能跑）。',
    script: '外壳\\scripts\\用量自检.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '跑一遍', args: () => [] }],
  },
  {
    id: 'shell-test', group: 'guard', name: '外壳静态测试',
    plain: '端口单一真源 / 静默 catch / IPC 配对 / 场景契约 / 渲染器注册 / 图标唯一 / 全量语法，一次全过。',
    script: '外壳\\scripts\\测试.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '跑全套', args: () => [] }],
  },
  {
    id: 'env-selftest', group: 'guard', name: '环境自检',
    plain: '开机前那套环境体检：引擎在不在、端口通不通、场景与会话对不对得上。',
    script: '外壳\\scripts\\自检.mjs', timeout: 120000,
    actions: [{ id: 'run', label: '跑一遍', args: () => [] }],
  },
  {
    id: 'engine-after', group: 'guard', name: '引擎升级后接线核对',
    plain: '壳围绕引擎内部实现做的（patch 覆盖项 / 插件落点 / 会话目录），上游一改会静默降级；升级后核一遍。',
    script: '外壳\\scripts\\engine-after.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '核对', args: () => [] }, { id: 'json', label: '核对（机器读）', args: () => ['--json'] }],
  },
  {
    id: 'session-bind', group: 'guard', name: '场景与会话绑定核对',
    plain: '拿场景 json 的 sessionId / sessionTitle 去引擎逐个核对（sessions.mjs --check）；换机器、换会话之后先跑这条。',
    why: '换机搬 id 一定失效：面板会空白，但界面不会告诉你「是 id 旧了」还是「代码坏了」。',
    script: '外壳\\scripts\\sessions.mjs', timeout: 120000,
    actions: [{ id: 'check', label: '核对', args: () => ['--check'] }],
  },
  {
    id: 'rename-check', group: 'guard', name: '场景改名核对（五处对齐）',
    plain: '改了场景名 / 面板 id 之后跑：登记表 owner、记忆目录、areas 正文的「场景 id」、场景目录、记忆地图，五处漏一处就报。',
    why: '把「命令」改成「记忆」那次漏了共享登记表，图上就多出一个重复区域 + 12 条悬空边；这五处没有一处会自己报错。',
    script: '外壳\\scripts\\场景改名核对.mjs', timeout: 120000,
    actions: [
      { id: 'run', label: '核对', args: () => [] },
      { id: 'json', label: '核对（机器读）', args: () => ['--json'] },
    ],
  },
  {
    id: 'engine-update-check', group: 'guard', name: '引擎更新检查（只读）',
    plain: '拿本机版本对上游 dist-tags，顺带看 Node 相容与端口是否被占。退出码 1 = 有新版本，2 = 连不上（断网不等于已最新）。',
    script: '工具\\引擎更新检查.mjs', timeout: 120000,
    actions: [
      { id: 'run', label: '查一遍', args: () => [], okCodes: [1] },
      { id: 'json', label: '查（机器读）', args: () => ['--json'], okCodes: [1] },
      { id: 'mirror', label: '换镜像查', args: () => ['--mirror'], okCodes: [1] },
      { id: 'offline', label: '只看上次结果', args: () => ['--offline'] },
    ],
  },
  {
    id: 'engine-update', group: 'guard', name: '引擎更新（换版 / 回退）',
    plain: '查状态 → 下载装配到 staging 自证 → 备份后换入 → 探活，失败自动回退。⛔ 换版必须停机：工作台开着的时候只能查状态和备份清单。',
    why: '引擎是整目录外部依赖，升级原来只能在命令行跑一长串；壳外的 token 与生命周期归壳所有（AGENTS §8）。',
    script: '工具\\引擎更新.mjs', timeout: 900000,
    actions: [
      { id: 'status', label: '看状态', args: () => ['status'] },
      { id: 'list', label: '备份清单', args: () => ['list'] },
      {
        id: 'prepare', label: '下载装配（不换）', danger: 'write',
        inputs: [{ key: 'version', label: '目标版本（空 = 上游 latest）', kind: 'text', hint: '留空走 dist-tags' }],
        args: (v) => (v.version ? ['prepare', '--version', v.version] : ['prepare']),
      },
      {
        id: 'apply', label: '换版本（先退出工作台）', danger: 'destructive',
        inputs: [{ key: 'version', label: '目标版本（空 = staging 已备好的那版）', kind: 'text' }],
        args: (v) => (v.version ? ['apply', '--version', v.version, '--yes'] : ['apply', '--yes']),
      },
      {
        id: 'rollback', label: '回退到某份备份', danger: 'destructive',
        inputs: [{ key: 'to', label: '备份目录名（空 = 最近一份）', kind: 'text', hint: '看「备份清单」里的 gen-xxxx' }],
        args: (v) => (v.to ? ['rollback', '--to', v.to] : ['rollback']),
      },
      {
        id: 'clean', label: '清旧备份（留最近 N 份）', danger: 'destructive',
        inputs: [{ key: 'keep', label: '保留份数', kind: 'number', def: '2' }],
        args: (v) => ['clean', '--keep', v.keep || '2'],
      },
    ],
  },
  {
    id: 'engine-snapshot', group: 'guard', name: '引擎配置快照（起不来时回退）',
    plain: '只存「引擎能不能起来」的配置级东西：cordis.yml / patch / package.json / 锁 + 插件启用记录；不碰源码、会话、凭证。',
    why: '改坏启动配置引擎就起不来，原来回退只能翻 外壳\\data\\engine-good。',
    script: '工具\\引擎快照.mjs', timeout: 180000,
    actions: [
      { id: 'save', label: '打一份正常点', danger: 'write', args: () => ['--save'] },
      { id: 'list', label: '看有哪些代', args: () => ['--list'] },
      { id: 'restore', label: '回到最近一代', danger: 'destructive', args: () => ['--restore', '--yes'] },
      {
        id: 'restoreGen', label: '回到指定一代', danger: 'destructive',
        inputs: [{ key: 'gen', label: '代（gen-xxxx）', kind: 'text', required: true }],
        args: (v) => ['--restore-gen', v.gen, '--yes'],
      },
    ],
  },
  {
    id: 'cache-clean', group: 'guard', name: '清理缓存（webview / 分区缓存）',
    plain: '回收 外壳\\data\\electron-profile 里的 Chromium 缓存，只删 Cache / Code Cache / GPUCache 这类可重建的，登录态一概不碰。默认只统计。',
    why: '浏览器缓存只增不减（实测 1.2 GB / 8 千文件），原来没有任何回收入口。',
    script: '外壳\\scripts\\清理缓存.mjs', timeout: 600000,
    actions: [
      { id: 'dry', label: '只统计（不删）', args: () => [] },
      { id: 'apply', label: '真删（先在设置里退出工作台）', danger: 'destructive', args: () => ['--apply'] },
    ],
  },
  {
    id: 'usage-ledger', group: 'guard', name: '用量账本（全量口径）',    plain: '按会话算 token 账：默认只算面板钉了的，--all 连没被钉的也算（要查「谁在偷偷烧 token」用这个）。',
    script: '工具\\用量账本.mjs', timeout: 120000,
    actions: [
      { id: 'all', label: '全部会话', args: () => ['--all'] },
      {
        id: 'one', label: '只看一条',
        inputs: [{ key: 'sid', label: '会话 id', kind: 'text', required: true, hint: 'session-xxxx-…' }],
        args: (v) => ['--session', v.sid],
      },
    ],
  },

  // ── 协作与通道 ────────────────────────────────────────────────────────
  {
    id: 'sync-persona', group: 'flow', name: '人格引用同步',
    plain: '换人格会话后，把场景 json 的通道卡片与 QQ 桥接 routes 一次性对齐（唯一真源 = pet.json 的 pet-ai）。',
    why: '只改一处 = 卡片读到空会话、QQ 消息投进已归档的会话。',
    script: '工具\\同步人格引用.mjs', statusArgs: ['--check'],
    actions: [
      { id: 'check', label: '只判断一致', args: () => ['--check'] },
      { id: 'dry', label: '看会改什么', args: () => ['--dry'] },
      { id: 'apply', label: '对齐', danger: 'write', args: () => [] },
    ],
  },
  {
    id: 'send-msg', group: 'flow', name: '跨场景发消息',
    plain: '给另一个场景留一条消息（纯文件，不调接口）：目标场景私有记忆 §〇-通知 + 共享 _跨场景通知.md。',
    script: '工具\\发消息.mjs',
    actions: [
      { id: 'list', label: '看最近消息', args: () => ['--list'] },
      {
        id: 'send', label: '发一条', danger: 'write',
        inputs: [
          { key: 'to', label: '发给哪个场景', kind: 'memscene', required: true },
          { key: 'text', label: '内容', kind: 'text', required: true, long: true },
        ],
        args: (v) => ['--to', v.to, v.text],
      },
    ],
  },
  {
    id: 'rename-session', group: 'flow', name: '会话改名',
    plain: '改引擎里的会话标题（session/rename RPC）；改完场景 json 里的 sessionTitle 也要跟着改。',
    script: '外壳\\scripts\\会话改名.mjs',
    actions: [{
      id: 'rename', label: '改名', danger: 'write',
      inputs: [
        { key: 'sid', label: '会话 id', kind: 'text', required: true, hint: 'session-xxxx-…' },
        { key: 'title', label: '新标题', kind: 'text', required: true },
      ],
      args: (v) => [v.sid, v.title],
    }],
  },
  {
    id: 'pet-runtime', group: 'flow', name: '桌宠路由与主动',
    plain: '她那层的四个判断：一句话该派给谁（路由）、现在能不能主动开口（闸门）、桥接 routes 是否指回当前会话、场景·会话·记忆一张表。',
    why: '这四件事原来只能 `node 工具\\桌宠.mjs 路由/能主动吗/桥接同步/场景`，人在会话里看不到她「为什么没出声」。',
    script: '工具\\桌宠.mjs',
    actions: [
      {
        id: 'route', label: '试一条路由',
        inputs: [{ key: 'text', label: '一句话', kind: 'text', required: true, long: true, hint: '例：B站那期视频的脚本还在吗' }],
        args: (v) => ['路由', '--文本', v.text],
      },
      {
        id: 'proactive', label: '能主动吗', okCodes: [1],
        inputs: [{ key: 'record', label: '占不占额度', kind: 'select', def: 'no', options: [{ v: 'no', t: '只查询' }, { v: 'yes', t: '记账（占这一小时一次的额度）' }] }],
        args: (v) => (v.record === 'yes' ? ['能主动吗', '--记账'] : ['能主动吗']),
      },
      { id: 'sync', label: '桥接指回当前会话', danger: 'write', args: () => ['桥接同步'] },
      { id: 'scenes', label: '场景·会话·记忆表', args: () => ['场景'] },
    ],
  },

  // ── 创意与资产 ────────────────────────────────────────────────────────
  {
    id: 'gen-image', group: 'creative', name: '生图（Seedream / 火山方舟）',
    plain: '把「提示词 + 可选参考图」换成真 PNG 落盘；创意工坊原画概念岗的三视图 / 气氛图走这里。',
    script: '工具\\生图.mjs', timeout: 300000,
    actions: [
      { id: 'probe', label: '认环境', args: () => ['probe'] },
      {
        id: 'gen', label: '出一张', danger: 'write',
        inputs: [
          { key: 'prompt', label: '提示词', kind: 'text', required: true, long: true },
          { key: 'out', label: '存到', kind: 'file', required: true, hint: '…\\概念\\xx.png' },
          { key: 'size', label: '尺寸', kind: 'select', def: '2K', options: [{ v: '2K', t: '2K' }, { v: '4K', t: '4K' }] },
        ],
        args: (v) => ['gen', '--prompt', v.prompt, '--out', v.out, '--size', v.size === '4K' ? '4K' : '2K'],
      },
      {
        id: 'dry', label: '只看请求体',
        inputs: [{ key: 'prompt', label: '提示词', kind: 'text', required: true, long: true }],
        args: (v) => ['gen', '--prompt', v.prompt, '--dry'],
      },
      {
        id: 'setKey', label: '记 key', danger: 'write',
        inputs: [{ key: 'key', label: 'ARK_API_KEY', kind: 'text', required: true, hint: 'ark-… 写进 机器配置.json，不入库' }],
        args: (v) => ['set-key', '--key', v.key],
      },
    ],
  },
  {
    id: 'asset-check', group: 'creative', name: '资产包检查',
    plain: '一次一个资产、一个资产一个目录；check 看缺哪环 / GLB 有没有 skin，list 看所有包与阶段。',
    script: '工具\\资产.mjs', timeout: 120000,
    actions: [
      { id: 'list', label: '列资产包', args: () => ['list'] },
      {
        id: 'check', label: '检查一个包',
        inputs: [{ key: 'name', label: '资产名', kind: 'text', required: true }],
        args: (v) => ['check', '--name', v.name],
      },
    ],
  },
  {
    id: 'package-build', group: 'creative', name: '打发布包',
    plain: '把工作台层打成可分发 zip（默认不带引擎）；内置自检不过就不出包。',
    why: '出包会写盘几百 MB，界面上是危险动作：真跑要再点一次确认。',
    script: '工具\\封装.mjs', timeout: 900000,
    actions: [
      {
        id: 'dry', label: '只看会打什么',
        inputs: [{ key: 'out', label: '输出目录', kind: 'dir', required: true }],
        args: (v) => ['--out', v.out, '--dry'],
      },
      {
        id: 'run', label: '出包', danger: 'destructive',
        inputs: [{ key: 'out', label: '输出目录', kind: 'dir', required: true }],
        args: (v) => ['--out', v.out],
      },
      {
        id: 'withEngine', label: '连引擎一起打（≈5GB）', danger: 'destructive',
        inputs: [{ key: 'out', label: '输出目录', kind: 'dir', required: true }],
        args: (v) => ['--out', v.out, '--with-engine'],
      },
    ],
  },
];

// 3. 使用频率：决定「界面上先给你看什么」。分三档，别按代码域排 —— 你按「什么时候会用」找东西。
//    daily = 每次开工/写记忆/烧 token 时；weekly = 每周或发布前；rare = 只有出问题才想起来（默认折叠）
const FREQ = {
  'usage-ledger': 'daily', 'scene-gate': 'daily', 'send-msg': 'daily',
  'pet-runtime': 'daily', 'gen-image': 'daily', 'recent-mem': 'daily',
  'chan-mem': 'daily', 'scene-mem-check': 'daily',
  'publish-check': 'weekly', 'shell-test': 'weekly', 'asset-check': 'weekly',
  'memory-echo': 'weekly', 'guard-switch': 'weekly', 'token-switch': 'weekly',
  'scene-mem-index': 'weekly', 'scene-distill': 'weekly', 'proj-mem-check': 'weekly',
  'scene-finish': 'weekly',
  'pet-selftest': 'rare', 'render-selftest': 'rare', 'usage-selftest': 'rare',
  'env-selftest': 'rare', 'engine-after': 'rare', 'session-bind': 'rare',
  'scene-split': 'rare', 'scene-tidy': 'rare', 'mem-selftest': 'rare',
  'sync-persona': 'rare', 'rename-session': 'rare', 'package-build': 'rare',
};
const freqOf = (id) => FREQ[id] || 'weekly';
const FREQ_N = { daily: 0, weekly: 1, rare: 2 };

// 3c. 下一步：一条动作跑成功后，界面在下面给「接着做」（把工序写进登记表，不靠人记）
const NEXT = {
  'scene-mem-check': ['scene-mem-index', 'scene-mem-finish'],
  'scene-mem-index': ['scene-mem-finish'],
  'scene-mem-finish': ['scene-mem-maint'],
  'channel-mem': ['scene-mem-finish'],
  'recent-mem': ['scene-mem-check'],
  'publish-check': ['shell-test', 'package-build'],
  'shell-test': ['publish-check'],
  'gen-image': ['asset-check'],
  'asset-check': ['package-build'],
  'sync-persona': ['pet-runtime'],
  'session-bind': ['env-selftest'],
  'env-selftest': ['session-bind'],
  'engine-after': ['shell-test'],
};

// 3d. 同一个能力在别处也有入口（写清楚，免得以为界面上是两套数据）
const ALSO = {
  'usage-ledger': '顶栏「用量」面板：同一套算法，按面板钉的会话看得更细',
  'scene-mem-check': '顶栏 ⋯ 体检：只读快照；这里是真跑 check',
  'shell-test': '命令行 `npm test` 同效（CI 里跑这条）',
  'usage-selftest': '顶栏「用量」面板自带自检入口',
};

// 3b. 症状 → 该点哪张卡。界面上不指望你记 100 项功能，只记 6 条「出什么事点哪个」。
//     点进去只做「跳到那张卡」，不自动执行 —— 会不会真跑，由你在卡上决定。
const TRIAGE = [
  { symptom: '面板空白 / 换机器后没会话', tip: '场景 json 里的 sessionId 旧了，不是代码坏了', feature: 'session-bind', action: 'check' },
  { symptom: '界面白屏 · 认证失败', tip: '别在壳外重启引擎，旧 token 立刻失效', feature: 'engine-after', action: 'run' },
  { symptom: '她该出声却没出声', tip: '先看闸门档位，再看桥接 routes 指没指回当前会话', feature: 'pet-runtime', action: 'proactive' },
  { symptom: 'token 烧得飞快', tip: '默认只算钉了面板的会话，--all 才看得见「偷偷烧」的那条', feature: 'usage-ledger', action: 'all' },
  { symptom: '记忆写乱了 / 记完没生效', tip: '体检 → 索引 → 收工，三步按顺序', feature: 'scene-mem-check', action: 'all' },
  { symptom: '发布前心里没底', tip: '红线检查 → 外壳静态测试 → 出包，出包要连点两次', feature: 'publish-check', action: 'run' },
];

// 4. 输入校验：只认 action 声明过的 key；真值一律字符串、去首尾、拒 NUL 与超长
function checkInputs(action, raw) {
  const out = {};
  const specs = action.inputs || [];
  for (const s of specs) {
    const v = String((raw && raw[s.key] != null) ? raw[s.key] : '').trim();
    if (!v) {
      if (s.required) return { error: '「' + s.label + '」必填' };
      out[s.key] = '';
      continue;
    }
    if (v.indexOf('\u0000') >= 0) return { error: '「' + s.label + '」里有非法字符' };
    if (v.length > 4000) return { error: '「' + s.label + '」太长了（上限 4000 字）' };
    if (s.kind === 'number' && !/^[0-9.]+$/.test(v)) return { error: '「' + s.label + '」要填数字' };
    out[s.key] = v;
  }
  return { values: out };
}

const featureOf = (id) => FEATURES.filter((f) => f.id === id)[0] || null;
const actionOf = (f, id) => (f && (f.actions || []).filter((a) => a.id === id)[0]) || null;
const scriptOf = (f) => path.join(ROOT, f.script);
const available = (f) => { try { return fs.statSync(scriptOf(f)).isFile(); } catch (e) { return false; } };

// 4. 配置：只存界面偏好与常用参数（真实开关状态不从这儿读，一律问脚本 --status）
function defaultCfg() { return { ui: { confirmAgain: true, showWhy: true }, params: {}, last: {}, hits: {}, seen: {} }; }
function readCfg() {
  try {
    const o = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return {
      ui: Object.assign(defaultCfg().ui, o.ui || {}),
      params: (o.params && typeof o.params === 'object') ? o.params : {},
      last: (o.last && typeof o.last === 'object') ? o.last : {},
      hits: (o.hits && typeof o.hits === 'object') ? o.hits : {},
      seen: (o.seen && typeof o.seen === 'object') ? o.seen : {},
    };
  } catch (e) { return defaultCfg(); }
}
function writeCfg(cfg) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  const tmp = CFG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 1), 'utf8');
  fs.renameSync(tmp, CFG_FILE);
}

function configGet() { return { ok: true, cfg: readCfg(), file: CFG_FILE }; }
function configSet(patch) {
  const cfg = readCfg();
  const p = patch || {};
  if (p.ui && typeof p.ui === 'object') {
    const ui = cfg.ui;
    if (typeof p.ui.confirmAgain === 'boolean') ui.confirmAgain = p.ui.confirmAgain;
    if (typeof p.ui.showWhy === 'boolean') ui.showWhy = p.ui.showWhy;
  }
  if (p.params && typeof p.params === 'object') {
    for (const k of Object.keys(p.params)) {
      const dot = k.indexOf('.');
      if (dot < 0) continue;
      const f = featureOf(k.slice(0, dot));
      const a = actionOf(f, k.slice(dot + 1));
      if (!a) continue;
      const allowed = {};
      for (const s of (a.inputs || [])) {
        const v = p.params[k][s.key];
        if (v != null && String(v).length <= 4000) allowed[s.key] = String(v);
      }
      cfg.params[k] = allowed;
    }
  }
  // 重置只清「界面侧的记忆」（上次结果 / 点击计数）：不碰 profile patch、不碰历史日志目录
  if (p.reset === true) {
    cfg.last = {};
    cfg.hits = {};
  }
  writeCfg(cfg);
  return { ok: true, cfg: cfg, file: CFG_FILE };
}

// 5. 跑一条动作：spawn 脚本、逐项进 argv；超时或「停」都能结束；结果落 last + 历史日志 + 点击计数
const RUNNING = {};                                  // key -> { child, t0, killed }
function tailReason(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const pick = lines.slice(-3).map((s) => (s.length > 110 ? s.slice(0, 110) + '…' : s));
  return pick.join(' / ').slice(0, 320);
}

// 5a. 历史日志：每条动作留全文（.log，最近 20 份/功能），界面点「打开完整日志」直接看
function saveLog(id, actionId, text) {
  const dir = path.join(CFG_DIR, '历史');
  // 时间戳带毫秒：同一秒内跑两次（连点 / 重跑）原来会写同一个文件名，后一次把前一次的全文覆盖掉
  const ts = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
  const file = path.join(dir, id + '.' + ts + '.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '[' + ts + '] ' + id + '.' + actionId + '\n' + text, 'utf8');
    const mine = fs.readdirSync(dir).filter((n) => n.indexOf(id + '.') === 0).sort();
    while (mine.length > 20) {
      const old = mine.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn('[功能台] 旧日志删不掉', old, e.message); }
    }
    return file;
  } catch (e) { console.warn('[功能台] 历史日志没落盘', e && e.message); return ''; }
}

function run(id, actionId, rawInputs) {
  const f = featureOf(id), a = actionOf(f, actionId);
  if (!f || !a) return Promise.resolve({ ok: false, error: '没有这个功能 / 动作：' + id + '.' + actionId });
  if (!available(f)) return Promise.resolve({ ok: false, error: '脚本不在了：' + f.script });
  const key = id + '.' + actionId;
  if (RUNNING[key]) return Promise.resolve({ ok: false, error: '这条正在跑，等它回来再点（或先按「停」）' });
  // 全局最多同时 2 条：5 个 node 一起抢 CPU 会让人以为整块卡死；不排队（排队更让人困惑）
  if (Object.keys(RUNNING).length >= 2) {
    return Promise.resolve({ ok: false, error: '已经在跑 2 条（同时上限 2）：等一条回来，或去那张卡点「停」再点这条' });
  }
  const chk = checkInputs(a, rawInputs);
  if (chk.error) return Promise.resolve({ ok: false, error: chk.error });

  let argv;
  try { argv = a.args(chk.values); } catch (e) { return Promise.resolve({ ok: false, error: '参数拼不起来：' + e.message }); }
  const entry = { child: null, t0: Date.now(), killed: false };
  RUNNING[key] = entry;
  const ms = a.timeout || f.timeout || 120000;
  return new Promise((resolve) => {
    let out = '', done = false;
    const child = spawn(process.execPath, [scriptOf(f)].concat(argv), {
      cwd: ROOT,
      env: Object.assign({}, process.env, { DSH_WORKBENCH_ROOT: ROOT }),
      windowsHide: true,
    });
    entry.child = child;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      delete RUNNING[key];
      try { child.kill(); } catch (e) { if (e && e.code !== 'ESRCH') console.warn('[功能台] kill 失败', e.message); }
      resolve(finish(false, '超时（' + Math.round(ms / 1000) + ' 秒）还没跑完，已杀掉', '超时'));
    }, ms);
    // 输出上限 40000 字：超了只砍中间、头尾都留 —— 原来是一次 slice(0,40000) 砍掉尾部，
    // 长日志（封装 / 发布前检查）失败时 tailReason 从“被截断的尾巴”取原因，等于报错原因取错。
    const CAP = 40000, KEEP_HEAD = 2000, KEEP_TAIL = 37000;
    let dropped = 0;
    const push = (b) => {
      out += String(b || '');
      if (out.length > CAP) {
        dropped += out.length - CAP;
        out = out.slice(0, KEEP_HEAD) + '\n…（中间省略约 ' + dropped + ' 字）…\n' + out.slice(-KEEP_TAIL);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer); delete RUNNING[key];
      resolve(finish(false, '起不来：' + e.message, e.message));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer); delete RUNNING[key];
      const tail = out.trim();
      // 「不能主动开口」这类判据用退出码 1 表示「结论是否」，不是失败 ⇒ 按动作声明的 okCodes 认
      const okCodes = Array.isArray(a.okCodes) ? [0].concat(a.okCodes) : [0];
      const ok = okCodes.indexOf(code) >= 0;
      const reason = ok ? '' : (entry.killed ? '已手动停掉' : (tailReason(out) || '退出码 ' + code));
      const msg = entry.killed
        ? '已停（你按的「停」）'
        : (ok ? (code === 0 ? '完成（退出码 0）' : ('结论已出（退出码 ' + code + '，属正常返回）'))
          : ('退出码 ' + code + (tail ? '' : '（没有输出）')));
      resolve(finish(ok, msg, reason));
    });

    // 5b. 收尾：last（带动作名与失败原因）/ 点击计数 / 历史日志；关掉面板再开也看得见上次结论
    function finish(ok, msg, reason) {
      const text = out.trim().slice(0, 6000);
      let logPath = '';
      try { logPath = saveLog(id, actionId, out.trim()); } catch (e) { console.warn('[功能台] 历史日志异常', e && e.message); }
      try {
        const cfg = readCfg();
        cfg.last[id] = {
          action: actionId, at: Math.floor(Date.now() / 1000), ok: !!ok, reason: reason || '',
          text: text.slice(0, 700),
        };
        cfg.hits = cfg.hits || {};
        cfg.hits[id] = (cfg.hits[id] || 0) + 1;
        // seen 是审计证据，跟 last（展示）分开存：清「上次结果」不会把「什么时候用过」一起清掉
        cfg.seen = cfg.seen || {};
        cfg.seen[id] = cfg.last[id].at;
        writeCfg(cfg);
        // 改过开关/配置就作废这 60 秒探针缓存：不然刚切成 on，卡片上还写着「未装」
        if (ok && a.danger !== 'read') {
          STATUS_CACHE = { at: 0, data: null };
        }
      } catch (e) { console.warn('[功能台] 上次结果没落盘', e && e.message); }
      return {
        ok: !!ok, at: Math.floor(Date.now() / 1000), ms: Date.now() - entry.t0,
        msg: msg, reason: reason || '', out: text, argv: argv, logPath: logPath, killed: entry.killed,
      };
    }
  });
}

// 5c. 停：`kill(id, actionId)` 只停那一条；不带 actionId 时停这个功能下所有在跑的（兼容旧调用）
function kill(id, actionId) {
  let n = 0;
  const wantKey = actionId ? (id + '.' + actionId) : '';
  Object.keys(RUNNING).forEach((k) => {
    if (wantKey ? k !== wantKey : k.indexOf(id + '.') !== 0) return;
    const e = RUNNING[k];
    e.killed = true;
    try { if (e.child) e.child.kill(); } catch (err) { if (err && err.code !== 'ESRCH') console.warn('[功能台] 停失败', err.message); }
    n += 1;
  });
  return { ok: n > 0, killed: n, msg: n ? ('已发停止信号：' + n + ' 条') : '这条现在没在跑' };
}
// 6. 只读探针：三个插件开关的当下状态（--status / --check），60 秒内复用，别每展开一次都跑 dump-config
let STATUS_CACHE = { at: 0, data: null };
function status() {
  if (STATUS_CACHE.data && Date.now() - STATUS_CACHE.at < 60000) return Promise.resolve(STATUS_CACHE.data);
  const jobs = FEATURES.filter((f) => f.statusArgs && available(f)).map((f) => new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptOf(f)].concat(f.statusArgs), { cwd: ROOT, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { if (e && e.code !== 'ESRCH') console.warn('[功能台] kill 失败', e.message); } }, 25000);
    child.stdout.on('data', (b) => { out += String(b || ''); });
    child.stderr.on('data', (b) => { out += String(b || ''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ id: f.id, code: code, text: out.trim().slice(0, 1600) });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ id: f.id, code: -1, text: '起不来：' + e.message }); });
  }));
  return Promise.all(jobs).then((rows) => {
    const data = { ok: true, at: Date.now(), rows: rows };
    STATUS_CACHE = { at: Date.now(), data: data };
    return data;
  });
}

// 7. 界面要的两个下拉：场景（scenario）与场景记忆目录（memscene）
function scenarioList() {
  try {
    return fs.readdirSync(SCEN_DIR).filter((n) => n.endsWith('.json')).map((n) => {
      try { const o = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, n), 'utf8')); return { id: o.id, name: o.name }; } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}
function memSceneList() {
  try {
    return fs.readdirSync(MEM_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.charAt(0) !== '_').map((d) => d.name);
  } catch (e) { return []; }
}

// 8. 清单：给界面的是「能序列化的那一半」，args 函数不出主进程
function serialize(f, hits) {
  return {
    id: f.id, group: f.group, name: f.name, plain: f.plain, why: f.why || '',
    script: f.script, restart: !!f.restart, ok: available(f), freq: freqOf(f.id),
    also: ALSO[f.id] || '',
    next: (NEXT[f.id] || []).map((nid) => {
      const nf = FEATURES.filter((x) => x.id === nid)[0];
      return { id: nid, name: nf ? nf.name : '', ok: !!nf };
    }),
    hits: (hits || {})[f.id] || 0,
    actions: (f.actions || []).map((a) => ({
      id: a.id, label: a.label,
      danger: (a.danger === 'write' || a.danger === 'destructive') ? a.danger : 'read',
      inputs: (a.inputs || []).map((s) => ({
        key: s.key, label: s.label, kind: s.kind || 'text', def: s.def || '',
        required: !!s.required, hint: s.hint || '', long: !!s.long, options: s.options || [],
      })),
    })),
  };
}
// 5e. 最近日志：给配置面板列最近 8 份（只读文件名 / 大小 / 时间，点一下直接看全文）
function recentLogs(n) {
  const dir = path.join(CFG_DIR, '历史');
  try {
    const names = fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.log'));
    const rows = names.map((x) => {
      const full = path.join(dir, x);
      let size = 0, at = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        at = Math.floor(st.mtimeMs / 1000);
      } catch (e) { if (e && e.code !== 'ENOENT') console.warn('[功能台] 日志元信息读不到', x, e.message); }
      return { name: x, path: full, size: size, at: at };
    });
    return rows.sort((a, b) => b.at - a.at).slice(0, Number(n) || 8);
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[功能台] 历史目录读不到', e.message);
    return [];
  }
}

function list() {
  const cfg = readCfg();
  const cfgHits = cfg.hits || {};
  const groups = GROUPS.map((g) => ({
    id: g.id, title: g.title, plain: g.plain,
    features: FEATURES.filter((f) => f.group === g.id)
      .slice()
      .sort((a, b) => (FREQ_N[freqOf(a.id)] - FREQ_N[freqOf(b.id)]) || 0)   // 日常在前、低频在后（同档保持登记顺序）
      .map((f) => serialize(f, cfgHits)),
  }));
  const actions = FEATURES.reduce((a, f) => a + (f.actions || []).length, 0);
  // 最近操作：按 at 倒序 10 条（界面那块「最近做了什么」直接读它，不用另存一份）
  const recent = Object.keys(cfg.last).map((id) => {
    const rec = cfg.last[id] || {};
    const f = featureOf(id), a = actionOf(f, rec.action);
    return {
      id: id, feature: f ? f.name : id, action: a ? a.label : String(rec.action || ''),
      at: Number(rec.at) || 0, ok: !!rec.ok, reason: String(rec.reason || '').slice(0, 160),
      hits: Number((cfgHits[id] || 0)),
    };
  }).sort((x, y) => y.at - x.at).slice(0, 10);
  const triage = TRIAGE.map((t) => {
    const f = featureOf(t.feature), a = actionOf(f, t.action);
    return {
      symptom: t.symptom, tip: t.tip, feature: t.feature, action: t.action,
      featureName: f ? f.name : t.feature, actionLabel: a ? a.label : t.action,
      ok: !!(f && a && available(f)),
    };
  });
  return {
    ok: true, file: CFG_FILE, logDir: path.join(CFG_DIR, '历史'), groups: groups, triage: triage, recent: recent,
    logs: recentLogs(8),
    stats: { features: FEATURES.length, actions: actions, groups: GROUPS.length, daily: FEATURES.filter((f) => freqOf(f.id) === 'daily').length, rare: FEATURES.filter((f) => freqOf(f.id) === 'rare').length },
    scenes: scenarioList(), memScenes: memSceneList(),
  };
}

// 5d. 审计：90 天没人点过的卡（防「功能越加越多、界面越来越没人用」）
function audit(days) {
  const cfg = readCfg();
  const seen = cfg.seen || {};
  const d = Number(days) || 90;
  const now = Math.floor(Date.now() / 1000);
  const rows = FEATURES.map((f) => {
    // 用 seen（独立的使用痕迹），不用 last —— 清「上次结果」是展示操作，不该把审计证据一起抹掉
    const at = Number(seen[f.id]) || 0;
    return { id: f.id, name: f.name, freq: freqOf(f.id), hits: Number((cfg.hits || {})[f.id] || 0), at: at, age: at ? Math.floor((now - at) / 86400) : -1 };
  });
  const stale = rows.filter((r) => !r.at || r.age > d);
  return { ok: true, days: d, total: rows.length, used: rows.length - stale.length, stale: stale };
}

module.exports = { list, run, status, kill, audit, configGet, configSet, CFG_FILE };

// 命令行自测：node 12-源码照搬\外壳\功能台.js [--json] [--audit 90]
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.indexOf('--audit') >= 0) {
    const i = argv.indexOf('--audit');
    const a = audit(argv[i + 1] || 90);
    console.log('功能台审计 · ' + a.days + ' 天窗口：' + a.used + ' / ' + a.total + ' 项用过，' + a.stale.length + ' 项没动');
    a.stale.forEach((r) => console.log('  · [' + r.freq + '] ' + r.name + '（' + (r.at ? r.age + ' 天前' : '从未点过') + '）'));
    process.exit(0);
  }
  const o = list();
  if (process.argv.includes('--json')) console.log(JSON.stringify(o, null, 1));
  else {
    console.log('功能台 · ' + o.stats.features + ' 个功能 / ' + o.stats.actions + ' 个动作 / ' + o.stats.groups + ' 组');
    o.groups.forEach((g) => {
      console.log('[' + g.title + '] ' + g.features.length + ' 项');
      g.features.forEach((f) => console.log('  ' + (f.ok ? '✓' : '✗') + ' [' + f.freq + '] ' + f.name + ' — ' + f.actions.map((a) => a.label).join(' / ')));
    });
  }
}
