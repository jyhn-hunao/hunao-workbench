// 功能台.js —— 把「只能命令行」的工作台功能接出界面入口（2026-11-14）
//
// 为什么单文件：main.js 已经 380KB，这份清单还要能脱离 Electron 自测（node 功能台.js --json）。
// 三条硬约定：
//   ① 只跑白名单里的脚本：脚本路径写死在这里，界面只能传 feature id + action id + 白名单输入项；
//   ② 不进 shell：spawn(process.execPath, [脚本, ...参数])，参数逐项进 argv，不拼命令行；
//   ③ 配置只写「真实那一份」：开关改 profile 的 patch，
//      本文件只存界面偏好（上次结果 / 常用参数），⛔ 不另造一套影子状态。
//
// 数据去向：外壳\data\功能台.json（本机，不入库）—— { ui: {...}, params: {...}, last: {...} }
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SHELL = __dirname;                              // 外壳
const ROOT = path.resolve(SHELL, '..');               // 12-源码照搬
const CFG_DIR = process.env.DSH_SHELL_DATA || path.join(SHELL, 'data');
const CFG_FILE = path.join(CFG_DIR, '功能台.json');
const SCEN_DIR = path.join(SHELL, 'scenarios');
const DSH = process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎数据', '.dsh');
const MEM_DIR = path.join(DSH, '场景记忆');

// 1. 分组：界面按组切面板，一组一块（组名与说明直接展示给人）
const GROUPS = [
  { id: 'switch', title: '插件开关', plain: '省 token / 守卫 / 记忆回响：装没装、什么模式、一条命令切（改完重启整壳生效）' },
  { id: 'memory', title: '记忆维护', plain: '近期记忆 / 人格记忆 / 通道记忆 / 场景记忆体检与收工 —— 原来全在命令行' },
  { id: 'auto', title: '自动维护', plain: '自动换会话 / 记忆整理 / 巡检 / 退出清缓存 / 孤儿 staging / 崩溃回滚：开关、阈值、上次与下次' },
  { id: 'guard', title: '自检与发布', plain: '发布前红线、各层自检、引擎升级后接线核对（只读，跑完看输出）' },
  { id: 'flow', title: '协作与通道', plain: '人格引用同步、跨场景发消息、会话改名' },
];

// 2. 功能登记：一条 = 一个脚本 + 它能干的几件事（args 是纯函数，只吃白名单输入）
//    —— 这张是「手写层」：按钮名 / 危险等级 / 参数能给准的才写这儿；
//       新脚本不想手写，在头部加一行 `// @功能台 {...}` 就会自动进目录（见 2a）。
const BASE_FEATURES = [
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
  {
    id: 'chat-archive', group: 'switch', name: '聊天档案（插件）',
    plain: '把 dsh-chat-archive 装进 web profile：按需查历史原文与单聊天记忆，往来原话落 引擎数据\\.dsh\\社交档案\\chat-archive.db。',
    why: '插件走 patch 才生效，手改 YAML 缩进错一位引擎就起不来；装完 / 改模式必须重启整壳。',
    script: '工具\\聊天档案.mjs', restart: true, statusArgs: ['--check'],
    actions: [
      { id: 'check', label: '看状态', args: () => ['--check'] },
      { id: 'apply', label: '装上', danger: 'write', args: () => ['--apply'] },
      {
        id: 'mode', label: '改模式', danger: 'write',
        inputs: [{
          key: 'mode', label: '模式', kind: 'select', def: 'enforce',
          options: [{ v: 'shadow', t: 'shadow（只看不查）' }, { v: 'enforce', t: 'enforce（真查真记）' }],
        }],
        args: (v) => ['--mode', v.mode === 'shadow' ? 'shadow' : 'enforce'],
      },
      { id: 'off', label: '摘掉', danger: 'write', args: () => ['--off'] },
    ],
  },
  {
    id: 'social-policy', group: 'switch', name: '社交策略（插件）',
    plain: '把 dsh-social-policy 装进 web profile：给已登记的社交会话每轮注入一张回复卡（语气 / 边界 / 频率）。',
    why: '回复风格写在 外壳\\data\\社交回复.json，但「让她照着说」要靠插件在引擎侧注入；装完必须重启整壳。',
    script: '工具\\社交策略.mjs', restart: true, statusArgs: ['--check'],
    actions: [
      { id: 'check', label: '看状态', args: () => ['--check'] },
      { id: 'apply', label: '装上', danger: 'write', args: () => ['--apply'] },
      {
        id: 'mode', label: '改模式', danger: 'write',
        inputs: [{
          key: 'mode', label: '模式', kind: 'select', def: 'enforce',
          options: [{ v: 'shadow', t: 'shadow（只记不注入）' }, { v: 'enforce', t: 'enforce（真注入）' }],
        }],
        args: (v) => ['--mode', v.mode === 'shadow' ? 'shadow' : 'enforce'],
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
    id: 'undef-check', group: 'guard', name: '未定义检查（no-undef）',
    plain: '用 ESLint 的 no-undef 扫全仓：引用不存在的变量 / 函数（node --check 看不见的那类，比如换会话回滚的 body0）。',
    why: '2026-11-16 换会话回滚抛 ReferenceError 才补的：语法检查过了，作用域越界照样炸；后来全仓扫出 6 类 7 处。',
    script: '工具\\未定义检查.mjs', timeout: 180000,
    actions: [{ id: 'run', label: '扫一遍', args: () => [] }],
  },
  {
    id: 'env-selftest', group: 'guard', name: '环境自检',
    plain: '开机前那套环境体检：引擎在不在、端口通不通、场景与会话对不对得上。',
    script: '外壳\\scripts\\自检.mjs', timeout: 120000,
    actions: [{ id: 'run', label: '跑一遍', args: () => [] }],
  },
  {
    id: 'patrol', group: 'guard', name: '自动巡检（一次跑完）',
    plain: '把 自检 / sessions / check-gui / 记忆体检 / 看门狗 收成一条只读巡检，结果落 外壳\\data\\巡检.json，只把有问题的项说清楚。',
    why: '原来全靠人记得手动跑，红线（面板指到已归档会话）能挂好几天；现在引擎就绪 60 秒后每天最多自动跑一次，这里给手动补跑入口。',
    script: '工具\\自动巡检.mjs', timeout: 300000,
    actions: [
      { id: 'run', label: '跑一遍', args: () => [] },
      { id: 'json', label: '跑（机器读）', args: () => ['--json'] },
    ],
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
      { id: 'offline', label: '只看上次结果', args: () => ['--offline'], okCodes: [1] },
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
  {
    id: 'outbound-selftest', group: 'guard', name: '外发闸门自检',
    plain: '跑 25 条行为用例 + 4 条代理用例：内网 / 公网 IP、路径、密钥、手机号、身份证、全角、零宽拆字、正常聊天；有漏退出码 1。',
    why: '判定本体在 外壳\\外发闸门.js（工具\\外发闸门.mjs 只是命令行壳）；改了规则先跑它，再让她往外说话。',
    script: '工具\\外发闸门.mjs', timeout: 180000,
    actions: [
      { id: 'selftest', label: '跑用例', args: () => ['--自检'] },
      { id: 'status', label: '看闸门状态', args: () => ['--状态'] },
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

  // ── 自动维护（2026-11-20）─────────────────────────────────────────────
  {
    id: 'auto-maint', group: 'auto', name: '自动维护（后台六件事）',
    plain: '自动换会话 / 记忆整理 / 巡检 / 退出清缓存 / 孤儿 staging / 崩溃回滚：开关、阈值、上次与下次、巡检失败项、清缓存最近结果都在这里。',
    why: '原来默认全开、只能改 JSON 或看日志：关不掉，也看不到上次跑没跑、下次什么时候。',
    script: '工具\\自动维护.mjs', timeout: 600000, statusArgs: ['status', '--json'],
    actions: [
      { id: 'status', label: '看状态（含上次 / 下次）', args: () => ['status'] },
      {
        id: 'rotate', label: '改自动换会话', danger: 'write',
        inputs: [
          { key: 'enabled', label: '开关', kind: 'select', def: 'keep', options: [{ v: 'keep', t: '不变（保持当前）' }, { v: 'on', t: '开' }, { v: 'off', t: '关' }] },
          { key: 'threshold', label: '压力阈值 %', kind: 'number', def: '', hint: '留空 = 保持当前；50–100，越高越晚换' },
          { key: 'turns', label: '最少轮数', kind: 'number', def: '', hint: '留空 = 保持当前；≥1，太少会刚开就换' },
          { key: 'idle', label: '空闲分钟', kind: 'number', def: '', hint: '留空 = 保持当前；正在用就不打扰' },
          { key: 'cooldown', label: '冷却分钟', kind: 'number', def: '', hint: '留空 = 保持当前；同一面板两次之间' },
        ],
        args: (v) => ['set', '--rotate', v.enabled || 'keep', '--threshold', v.threshold || '', '--turns', v.turns || '', '--idle', v.idle || '', '--cooldown', v.cooldown || ''],
      },
      {
        id: 'toggle', label: '开关某一项', danger: 'write',
        inputs: [
          {
            key: 'key', label: '哪一项', kind: 'select', def: 'tidy',
            options: [
              { v: 'tidy', t: '自动记忆整理（每周搬归档）' },
              { v: 'inspect', t: '自动巡检（开机 60 秒后）' },
              { v: 'cache', t: '退出后清缓存' },
              { v: 'staging', t: '启动清孤儿 staging' },
              { v: 'rollback', t: '崩溃自动回滚引擎配置' },
            ],
          },
          { key: 'enabled', label: '开关', kind: 'select', def: 'on', options: [{ v: 'on', t: '开' }, { v: 'off', t: '关' }] },
        ],
        args: (v) => ['set', '--' + v.key, v.enabled],
      },
      {
        id: 'limits', label: '改周期 / 阈值', danger: 'write',
        inputs: [
          { key: 'days', label: '记忆整理周期（天）', kind: 'number', def: '', hint: '留空 = 保持当前；1–30' },
          { key: 'hours', label: '巡检周期（小时）', kind: 'number', def: '', hint: '留空 = 保持当前；1–168' },
          { key: 'mb', label: '清缓存阈值（MB）', kind: 'number', def: '', hint: '留空 = 保持当前；100–10000，退壳后才真删' },
        ],
        args: (v) => ['set', '--tidy-days', v.days || '', '--inspect-hours', v.hours || '', '--cache-mb', v.mb || ''],
      },
      { id: 'tidy', label: '立即整理记忆（会搬归档）', danger: 'destructive', args: () => ['run', '--tidy'] },
      { id: 'inspect', label: '立即巡检', args: () => ['run', '--inspect'] },
    ],
    next: [{ id: 'cache-clean' }],
  },

  {
    id: 'package-build', group: 'guard', name: '打发布包',
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

// 2a. 自动登记（2026-11-19）：新脚本不用每次手改下面那张表。
//     ① 脚本头部写一行 `// @功能台 {...}` → 自动并入目录（默认只有只读「跑一遍」，复杂按钮仍手写）；
//     ② 没声明也没手写的脚本 → 进「未登记」清单；管理总览里可一键收进 外壳\data\功能台自动.json（本机、不入库）。
//     ⛔ 自动条目不带参数：声明只认 name / id / group / freq / plain / why / label / timeout / statusArgs，
//        脚本路径由文件本身决定（不让声明指定别的脚本，防越权）。
const AUTO_TAG = /^\s*\/\/\s*@功能台\s+(\{[^\n]*\})\s*$/;
const AUTO_DIRS = [path.join(ROOT, '工具'), path.join(SHELL, 'scripts')];
const ADOPT_FILE = path.join(CFG_DIR, '功能台自动.json');
// 内部模块 / 已有面板入口 / 后台定时活：不登记也不算漏，未登记清单里标出来，不催人收进
const INTERNAL = [
  '环境.mjs', '引擎token.mjs', '派发-公共.mjs', '_共用-场景记忆.mjs', '交接闸门.mjs',
  '派发.mjs', '回执.mjs', '等回执.mjs', '看门狗.mjs', '交接并换会话.mjs',
  '同步桥接路由.mjs', '消息流.mjs', '自动记忆整理.mjs',
  // 壳维护 / 面板按钮 / 调试用：入口在顶栏或场景里，不重复占功能台
  'check-gui.mjs', '备份清单.mjs', 'restore-gui.mjs', 'backup-gui.mjs', '接入项目.mjs',
  '换会话.mjs', '建会话.mjs', '归档会话.mjs', '项目切换自检.mjs', '环境适配.mjs',
  '图标库.mjs', 'pc-scan.mjs', '刷新面板.mjs',
];

function scanFiles() {
  const out = [];
  AUTO_DIRS.forEach((dir) => {
    let ds = [];
    try { ds = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if (e && e.code !== 'ENOENT') console.warn('[功能台] 自动登记扫描失败', dir, e.message); return; }
    ds.forEach((d) => {
      if (!d.isFile() || d.name.slice(-4) !== '.mjs' || d.name.charAt(0) === '_') return;
      out.push(path.join(dir, d.name));
    });
  });
  return out;
}
const relOf = (p) => path.relative(ROOT, p).replace(/\//g, '\\');

// 只读头部 60 行：声明在文件最上面的注释块里，不扫正文（正文里的字符串不算）
function declaredOf(file) {
  let head = '';
  try { head = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 60).join('\n'); }
  catch (e) { return null; }
  const line = head.split(/\r?\n/).filter((l) => AUTO_TAG.test(l))[0];
  if (!line) return null;
  const m = line.match(AUTO_TAG);
  try {
    const d = JSON.parse(m[1]);
    return (d && typeof d === 'object') ? d : { bad: '@功能台 声明不是对象' };
  } catch (e) { return { bad: '@功能台 声明 JSON 写坏了：' + e.message }; }
}
// 自动条目的 id 只留安全字符：`.` 必须去掉，否则运行键「id.action」会被点号拆错
const slugOf = (s) => String(s).replace(/\s+/g, '').replace(/[\\/:*?"<>|.]/g, '-');
function autoFeature(file, d) {
  const rel = relOf(file);
  const base = path.basename(file, '.mjs');
  const group = GROUPS.some((g) => g.id === d.group) ? d.group : 'guard';
  const freq = (d.freq === 'daily' || d.freq === 'weekly' || d.freq === 'rare') ? d.freq : 'rare';
  const timeout = Math.min(Math.max(Number(d.timeout) || 120000, 10000), 900000);
  return {
    id: 'auto-' + slugOf(d.id || base),
    group: group,
    name: String(d.name || base).slice(0, 40),
    plain: String(d.plain || (base + '（脚本自己声明，只读跑一遍）')).slice(0, 400),
    why: d.why ? String(d.why).slice(0, 400) : '',
    script: rel, timeout: timeout,
    statusArgs: Array.isArray(d.statusArgs) ? d.statusArgs.map(String).slice(0, 4) : null,
    freq: freq,
    actions: [{ id: 'run', label: String(d.label || '跑一遍').slice(0, 20), danger: 'read', args: () => [] }],
  };
}
function readAdopted() {
  try {
    const o = JSON.parse(fs.readFileSync(ADOPT_FILE, 'utf8'));
    return { items: (o && Array.isArray(o.items)) ? o.items.filter((x) => x && typeof x.script === 'string') : [] };
  } catch (e) { return { items: [] }; }
}
function writeAdopted(o) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  const tmp = ADOPT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ items: o.items || [] }, null, 1), 'utf8');
  fs.renameSync(tmp, ADOPT_FILE);
}

// 2b. 清单重建：手写优先，其次脚本声明，最后一键收进；id / 脚本都不许重
let FEATURES = BASE_FEATURES.slice();
function reloadFeatures() {
  const usedScript = new Set(BASE_FEATURES.map((f) => f.script));
  const usedId = new Set(BASE_FEATURES.map((f) => f.id));
  const out = BASE_FEATURES.slice();
  const add = (f) => {
    if (!f || usedScript.has(f.script) || usedId.has(f.id)) return false;
    usedScript.add(f.script); usedId.add(f.id); out.push(f); return true;
  };
  scanFiles().forEach((file) => {
    const rel = relOf(file);
    if (usedScript.has(rel)) return;
    const d = declaredOf(file);
    if (!d || d.bad) return;
    add(autoFeature(file, d));
  });
  readAdopted().items.forEach((it) => {
    const rel = String(it.script);
    if (!/^(工具|外壳\\scripts)\\[^\\]+\.mjs$/.test(rel)) return;
    if (!fs.existsSync(path.join(ROOT, rel))) return;
    const base = path.basename(rel, '.mjs');
    add({
      id: 'adopt-' + slugOf(base), group: 'guard', name: String(it.name || base).slice(0, 40),
      plain: '一键收进（脚本没写 @功能台 声明）：只读跑一遍；要按钮 / 参数就照 功能台.js 手写一条。',
      why: '脚本是新的、登记表还没跟上；先收进目录，别让它在界面上不存在。',
      script: rel, timeout: 120000, freq: 'rare',
      actions: [{ id: 'run', label: '跑一遍', args: () => [] }],
    });
  });
  FEATURES = out;
}

// 2c. 未登记：扫到却没进目录的脚本（声明写坏了也在这里说原因）
function unregistered() {
  const used = new Set(FEATURES.map((f) => f.script));
  const out = [];
  scanFiles().forEach((file) => {
    const rel = relOf(file);
    if (used.has(rel)) return;
    const d = declaredOf(file);
    let at = 0, size = 0;
    try { const st = fs.statSync(file); at = Math.floor(st.mtimeMs / 1000); size = st.size; }
    catch (e) { if (e && e.code !== 'ENOENT') console.warn('[功能台] 未登记脚本读不到', rel, e.message); }
    out.push({
      script: rel,
      name: (d && !d.bad && d.name) ? String(d.name) : path.basename(file, '.mjs'),
      reason: (d && d.bad) ? d.bad : '没写 @功能台 声明，也没一键收进',
      internal: INTERNAL.indexOf(path.basename(file)) >= 0,
      at: at, size: size,
    });
  });
  return out.sort((a, b) => ((a.internal ? 1 : 0) - (b.internal ? 1 : 0)) || (b.at - a.at));
}

// 2d. 配置模型（2026-11-18）：每项都要有配置位，允许为空，但空必须写清为什么。
//     kind: plugin   = 真插件，值从脚本 --status --json 读，写入走对应动作
//           machine  = 机器层只读（机器配置.json）
//           external = 配置真源在别处，这里只指路
//           none     = 无持久配置（只读检查 / 一次性动作），noWhy 必填
const CFG = {
  'token-switch': {
    kind: 'plugin',
    source: '引擎数据\\.dsh\\profiles\\web\\cordis.patch.yml',
    sourceAbs: path.join(DSH, 'profiles', 'web', 'cordis.patch.yml'),
    action: 'on',
    fields: [
      { key: 'threshold', label: '摘要阈值', kind: 'number', from: 'thresholdRatio', hint: '占上下文多少就摘要（0–1）' },
      { key: 'retain', label: '摘要后留', kind: 'number', from: 'retainRatio', hint: '保留比例，必须小于阈值' },
    ],
    fixed: '工具返回裁剪：4096 / 头 1536 / 尾 512（脚本内固定）',
  },
  'token-guard': {
    kind: 'plugin',
    source: '引擎数据\\.dsh\\profiles\\web\\package.json + node_modules\\dsh-token-guard\\cordis.patch.yml',
    sourceAbs: path.join(DSH, 'profiles', 'web', 'package.json'),
    action: 'on',
    fields: [
      { key: 'mode', label: '模式', kind: 'select', from: 'mode', options: [{ v: 'shadow', t: 'shadow（只记不拦）' }, { v: 'enforce', t: 'enforce（真拦）' }] },
    ],
  },
  'mem-recall': {
    kind: 'plugin',
    source: '引擎数据\\.dsh\\profiles\\web\\cordis.patch.yml',
    sourceAbs: path.join(DSH, 'profiles', 'web', 'cordis.patch.yml'),
    action: 'mode',
    fields: [
      { key: 'mode', label: '模式', kind: 'select', from: 'mode', options: [{ v: 'shadow', t: 'shadow（只记日志）' }, { v: 'enforce', t: 'enforce（真注入）' }] },
    ],
  },
  'chat-archive': {
    kind: 'plugin',
    source: '引擎数据\\.dsh\\profiles\\web\\cordis.patch.yml + node_modules\\dsh-chat-archive\\index.js',
    sourceAbs: path.join(DSH, 'profiles', 'web', 'cordis.patch.yml'),
    action: 'mode',
    fields: [
      { key: 'mode', label: '模式', kind: 'select', from: 'mode', options: [{ v: 'shadow', t: 'shadow（只看不查）' }, { v: 'enforce', t: 'enforce（真查真记）' }] },
    ],
    fixed: '档案库：引擎数据\\.dsh\\社交档案\\chat-archive.db（面板只读查看；原文不进 git）',
  },
  'social-policy': {
    kind: 'plugin',
    source: '引擎数据\\.dsh\\profiles\\web\\cordis.patch.yml',
    sourceAbs: path.join(DSH, 'profiles', 'web', 'cordis.patch.yml'),
    action: 'mode',
    fields: [
      { key: 'mode', label: '模式', kind: 'select', from: 'mode', options: [{ v: 'shadow', t: 'shadow（只记不注入）' }, { v: 'enforce', t: 'enforce（真注入）' }] },
    ],
    fixed: '回复策略真源：外壳\\data\\社交回复.json（保存后镜像到 场景记忆\\_共享记忆\\社交回复.json）',
  },
  'env-selftest': {
    kind: 'machine',
    source: '引擎数据\\.dsh\\机器配置.json',
    sourceAbs: path.join(DSH, '机器配置.json'),
    note: '机器层只读展示；端口真源是 机器配置.json 的 ports（改完重启整壳生效），路径 / node 用「环境适配」。',
  },
  'auto-maint': {
    kind: 'external',
    source: '外壳\\data\\自动换会话.json + 外壳\\data\\自动维护.json',
    sourceAbs: path.join(CFG_DIR, '自动维护.json'),
    note: '真源是这两个本机 JSON；本卡直接改它们，外壳下一次 5 分钟 tick / 下一次定时检查生效（staging 与回滚下次启动生效）。',
  },
  'sync-persona': {
    kind: 'external',
    source: '外壳\\scenarios\\*.json + 引擎数据\\.dsh\\qq-bridge.config.json',
    sourceAbs: path.join(SCEN_DIR, 'pet.json'),
    note: '唯一真源是 pet.json 的 pet-ai；这里只指路，点「对齐」才写。',
  },
  'pet-runtime': {
    kind: 'external',
    source: '外壳\\data\\pet\\设置.json + 引擎数据\\.dsh\\qq-bridge.config.json',
    sourceAbs: path.join(CFG_DIR, 'pet', '设置.json'),
    note: '路由 / 主动闸门 / 桥接的设置，在「胡闹的大肥鱼」场景的 ⚙ 里改。',
  },
  'outbound-selftest': {
    kind: 'external',
    source: '外壳\\data\\安全闸门.json（模式 / 渠道开关 / 规则动作 / 回话）+ 外壳\\data\\安全资产.json（本机资产指纹）',
    sourceAbs: path.join(CFG_DIR, '安全闸门.json'),
    note: '启用 / 关闭与每类规则的动作在「社交」场景的「外发设置」面板里改；这里只跑用例、看状态。',
  },
  'recent-mem': { kind: 'none', noWhy: '按场景一次性生成，没有跨次策略可配' },
  'persona-mem': { kind: 'none', noWhy: '记忆条目按次写入，没有跨次策略可配' },
  'channel-mem': { kind: 'none', noWhy: '按条数一次性捞取，无持久配置' },
  'scene-mem-check': { kind: 'none', noWhy: '只读体检，没有可配项' },
  'scene-mem-index': { kind: 'none', noWhy: '重建索引是一次性动作，无持久配置' },
  'mem-pack': { kind: 'none', noWhy: '打包 / 恢复按次给目录，无持久配置' },
  'scene-mem-finish': { kind: 'none', noWhy: '一次收尾动作，无持久配置' },
  'scene-mem-maint': { kind: 'none', noWhy: '天数 / 序号按次传入，无持久配置' },
  'mem-tool-check': { kind: 'none', noWhy: '按项目一次性体检，无持久配置' },
  'mem-selftest': { kind: 'none', noWhy: '只读自检，无配置' },
  'publish-check': { kind: 'none', noWhy: '只读红线检查，无配置' },
  'pet-selftest': { kind: 'none', noWhy: '只读行为用例，无配置' },
  'render-selftest': { kind: 'none', noWhy: '只读渲染自检，无配置' },
  'usage-selftest': { kind: 'none', noWhy: '只读自检，无配置' },
  'shell-test': { kind: 'none', noWhy: '只读静态测试，无配置' },
  'engine-after': { kind: 'none', noWhy: '只读接线核对，无配置' },
  'session-bind': { kind: 'none', noWhy: '只读绑定核对，无配置' },
  'rename-check': { kind: 'none', noWhy: '只读五处对齐核对，无配置' },
  'engine-update-check': { kind: 'none', noWhy: '只读版本查询，无配置' },
  'engine-update': { kind: 'none', noWhy: '版本 / 保留份数按次传入，不在界面存' },
  'engine-snapshot': { kind: 'none', noWhy: '代次按次传入，无持久配置' },
  'cache-clean': { kind: 'none', noWhy: '只统计 / 真删两种一次性动作，无配置' },
  'usage-ledger': { kind: 'none', noWhy: '按次选会话口径，无持久配置' },
  'undef-check': { kind: 'none', noWhy: '只读扫描；缺 eslint 会退 2（不等于通过），无配置可写' },
  'patrol': { kind: 'none', noWhy: '只读巡检，无持久配置；结果落 外壳\\data\\巡检.json（清理由巡检自己按天节流）' },
  'send-msg': { kind: 'none', noWhy: '每次发一条，无持久配置' },
  'rename-session': { kind: 'none', noWhy: '每次改一条会话，无持久配置' },
  'package-build': { kind: 'none', noWhy: '输出目录按次传入，无持久配置' },
};

// 2c. 界面侧策略值（2026-11-18）：原来写死在本文件里的数字，收进本机 工具策略.json。
//     缺文件 = 用下面这份默认；改完立即生效，不需要重启整壳（只有插件配置才要重启）。
const POLICY_FILE = path.join(CFG_DIR, '工具策略.json');
const POLICY_DEF = {
  statusCacheSec: 60, maxRunning: 2, outputCapChars: 40000, outputHeadChars: 2000, outputTailChars: 37000,
  uiTextChars: 6000, logKeepPerFeature: 20, recentCount: 10, logListCount: 8,
};
const POLICY_RANGE = {
  statusCacheSec: [5, 600], maxRunning: [1, 4], outputCapChars: [10000, 200000],
  outputHeadChars: [200, 20000], outputTailChars: [1000, 190000], uiTextChars: [500, 30000],
  logKeepPerFeature: [5, 100], recentCount: [3, 50], logListCount: [3, 30],
};

// 3. 使用频率：决定「界面上先给你看什么」。分三档，别按代码域排 —— 你按「什么时候会用」找东西。
//    daily = 每次开工/写记忆/烧 token 时；weekly = 每周或发布前；rare = 只有出问题才想起来（默认折叠）
const FREQ = {
  'usage-ledger': 'daily', 'scene-mem-maint': 'daily', 'send-msg': 'daily',
  'pet-runtime': 'daily', 'recent-mem': 'daily',
  'channel-mem': 'daily', 'scene-mem-check': 'daily',
  'publish-check': 'weekly', 'shell-test': 'weekly',
  'mem-recall': 'weekly', 'token-guard': 'weekly', 'token-switch': 'weekly',
  'chat-archive': 'weekly', 'social-policy': 'weekly', 'undef-check': 'weekly', 'patrol': 'weekly',
  'scene-mem-index': 'weekly', 'mem-tool-check': 'weekly', 'scene-mem-finish': 'weekly',
  'pet-selftest': 'rare', 'render-selftest': 'rare', 'usage-selftest': 'rare',
  'env-selftest': 'rare', 'engine-after': 'rare', 'session-bind': 'rare',
  'outbound-selftest': 'rare',
  'mem-selftest': 'rare', 'sync-persona': 'rare', 'rename-session': 'rare', 'package-build': 'rare',
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
  'publish-check': ['shell-test', 'undef-check', 'package-build'],
  'shell-test': ['undef-check', 'publish-check'],
  'chat-archive': ['social-policy'],
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
  'chat-archive': '社交「通道」的「聊天档案库」按钮：同一份库的只读浏览视图；这里管插件装没装、什么模式',
  'social-policy': '社交「回复风格」面板：策略内容（语气 / 边界 / 频率）在那边改；这里管插件装没装、什么模式',
  'outbound-selftest': '社交「外发设置」面板：启用 / 关闭与每类规则的动作在那边改；这里只跑用例',
  'patrol': '引擎就绪 60 秒后每天最多自动跑一次；这里手动补跑',
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

// 4a. 工具策略：本机 外壳\data\工具策略.json；缺文件 / 坏 JSON 一律用默认（只读不写）
function policy() {
  const out = Object.assign({}, POLICY_DEF);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')); } catch (e) { return out; }
  Object.keys(POLICY_DEF).forEach((k) => {
    const v = Number(raw && raw[k]);
    const rg = POLICY_RANGE[k];
    if (Number.isFinite(v) && v >= rg[0] && v <= rg[1]) out[k] = v;
  });
  // 头 + 尾超过单条上限会把「留头留尾」失效，整组退回默认，不拿半套值硬跑
  if (out.outputHeadChars + out.outputTailChars > out.outputCapChars) {
    out.outputCapChars = POLICY_DEF.outputCapChars;
    out.outputHeadChars = POLICY_DEF.outputHeadChars;
    out.outputTailChars = POLICY_DEF.outputTailChars;
  }
  return out;
}
function writePolicy(next) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  const clean = {};
  Object.keys(POLICY_DEF).forEach((k) => { clean[k] = Number(next[k]); });
  const tmp = POLICY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 1), 'utf8');
  fs.renameSync(tmp, POLICY_FILE);
}
// 只校验不落盘：先让整份 patch 过完校验，再写 cfg / policy，避免一半成功一半失败
function policyApply(raw) {
  const next = policy();
  for (const k of Object.keys(POLICY_DEF)) {
    if (!raw || raw[k] == null || String(raw[k]).trim() === '') continue;
    const v = Number(raw[k]);
    const rg = POLICY_RANGE[k];
    if (!Number.isFinite(v) || v < rg[0] || v > rg[1]) return { error: k + ' 要在 ' + rg[0] + '–' + rg[1] + ' 之间' };
    next[k] = v;
  }
  if (next.outputHeadChars + next.outputTailChars > next.outputCapChars) {
    return { error: '头 ' + next.outputHeadChars + ' + 尾 ' + next.outputTailChars + ' 不能超过单条上限 ' + next.outputCapChars };
  }
  return { ok: true, next: next };
}

// 4b. 机器层与配置源：给右栏总览看的只读快照（缺失不猜值）
function machineCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(DSH, '机器配置.json'), 'utf8')); } catch (e) { return null; }
}
function fileRow(label, p, note) {
  try {
    const st = fs.statSync(p);
    return { label: label, path: p, exists: true, size: st.size, at: Math.floor(st.mtimeMs / 1000), note: note || '' };
  } catch (e) {
    return { label: label, path: p, exists: false, size: 0, at: 0, note: note || '' };
  }
}
function configSources() {
  return [
    fileRow('cordis.patch.yml', path.join(DSH, 'profiles', 'web', 'cordis.patch.yml'), '插件真源（省 token / 记忆回响 / 聊天档案 / 社交策略）'),
    fileRow('profile package.json', path.join(DSH, 'profiles', 'web', 'package.json'), '插件 bundle 清单（守卫）'),
    fileRow('机器配置.json', path.join(DSH, '机器配置.json'), '端口 / node / 路径，只读'),
    fileRow('工具策略.json', POLICY_FILE, '本机策略值；缺文件时用代码默认'),
    fileRow('功能台自动.json', ADOPT_FILE, '一键收进的脚本（本机、不入库；删一项 = 移出目录）'),
  ];
}

// 配置快照：把「未登记 / 已收进」一起带回去，面板收进后不用再单独问一次
function configSnap(cfg) {
  return {
    ok: true, cfg: cfg || readCfg(), file: CFG_FILE, policy: policy(), policyFile: POLICY_FILE,
    adoptFile: ADOPT_FILE, adopted: readAdopted().items, unregistered: unregistered(),
  };
}
function configGet() { return configSnap(null); }

function configSet(patch) {
  reloadFeatures();
  const p = patch || {};
  // 收进 / 移出：只认白名单目录下的 .mjs，写本机 功能台自动.json；脚本本身一个字不改
  if (typeof p.adopt === 'string' && p.adopt) {
    const rel = String(p.adopt).replace(/\//g, '\\');
    if (!/^(工具|外壳\\scripts)\\[^\\]+\.mjs$/.test(rel)) return Object.assign(configSnap(null), { ok: false, error: '只能收进 工具\\ 或 外壳\\scripts\\ 下的 .mjs：' + rel });
    if (!fs.existsSync(path.join(ROOT, rel))) return Object.assign(configSnap(null), { ok: false, error: '脚本不在：' + rel });
    const ad = readAdopted();
    if (!ad.items.some((x) => x.script === rel)) {
      const d = declaredOf(path.join(ROOT, rel));
      ad.items.push({ script: rel, name: (d && !d.bad && d.name) ? String(d.name) : path.basename(rel, '.mjs'), at: Date.now() });
      writeAdopted(ad);
    }
  }
  if (typeof p.drop === 'string' && p.drop) {
    const rel = String(p.drop).replace(/\//g, '\\');
    const ad = readAdopted();
    const next = ad.items.filter((x) => x.script !== rel);
    if (next.length !== ad.items.length) writeAdopted({ items: next });
  }
  const pol = p.policy ? policyApply(p.policy) : null;
  if (pol && pol.error) return Object.assign(configSnap(null), { ok: false, error: pol.error });
  const cfg = readCfg();
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
  if (pol && pol.ok) writePolicy(pol.next);
  return configSnap(cfg);
}

// 5a. 子进程用哪个 node（2026-11-18 修「功能台一直读取中」）：
//     本文件在 Electron 主进程里被 require，process.execPath = **electron.exe**；
//     不带 ELECTRON_RUN_AS_NODE 去 spawn 它，等于又起一个工作台（不出 stdout、不退出），
//     status 只能等满 25 秒超时才回，面板就整块白在「读取中」。
//     顺序照 main.js 的 toolNode()：DSH_NODE → nvm → ProgramFiles → PATH 的 node；都没有才退回 electron 的 node 模式。
let NODE_SPEC = null;
function nodeSpec(extraEnv) {
  if (!NODE_SPEC) {
    const cands = [];
    if (process.env.DSH_NODE) cands.push(process.env.DSH_NODE);
    if (process.env.NVM_SYMLINK) cands.push(path.join(process.env.NVM_SYMLINK, 'node.exe'));
    if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
    if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'));
    let exe = '';
    for (let i = 0; i < cands.length; i++) {
      try { if (fs.existsSync(cands[i])) { exe = cands[i]; break; } }
      catch (e) { console.warn('[功能台] node 候选路径不可用', cands[i], e && e.message); }
    }
    if (exe) NODE_SPEC = { exe: exe, env: {} };                              // 系统 Node：工具脚本的统一口径
    else if (process.versions && process.versions.electron) NODE_SPEC = { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
    else NODE_SPEC = { exe: process.execPath || 'node', env: {} };           // 纯 node 跑（自测）
  }
  return { exe: NODE_SPEC.exe, env: Object.assign({}, process.env, NODE_SPEC.env, extraEnv || {}) };
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
    const keep = policy().logKeepPerFeature;
    while (mine.length > keep) {
      const old = mine.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (e) { if (e && e.code !== 'ENOENT') console.warn('[功能台] 旧日志删不掉', old, e.message); }
    }
    return file;
  } catch (e) { console.warn('[功能台] 历史日志没落盘', e && e.message); return ''; }
}

function run(id, actionId, rawInputs) {
  reloadFeatures();
  const f = featureOf(id), a = actionOf(f, actionId);
  if (!f || !a) return Promise.resolve({ ok: false, error: '没有这个功能 / 动作：' + id + '.' + actionId });
  if (!available(f)) return Promise.resolve({ ok: false, error: '脚本不在了：' + f.script });
  const key = id + '.' + actionId;
  if (RUNNING[key]) return Promise.resolve({ ok: false, error: '这条正在跑，等它回来再点（或先按「停」）' });
  // 全局同时可跑几条：默认 2（5 个 node 一起抢 CPU 会让人以为整块卡死）；不排队（排队更让人困惑）
  const maxRun = policy().maxRunning;
  if (Object.keys(RUNNING).length >= maxRun) {
    return Promise.resolve({ ok: false, error: '已经在跑 ' + maxRun + ' 条（同时上限 ' + maxRun + '）：等一条回来，或去那张卡点「停」再点这条' });
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
    const launch = nodeSpec({ DSH_WORKBENCH_ROOT: ROOT });
    const child = spawn(launch.exe, [scriptOf(f)].concat(argv), {
      cwd: ROOT,
      env: launch.env,
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
    // 输出上限与「留头留尾」比例走工具策略（默认 4 万字 / 头 2000 / 尾 37000）：
    // 超了只砍中间、头尾都留 —— 原来是一次 slice(0,40000) 砍掉尾部，
    // 长日志（封装 / 发布前检查）失败时 tailReason 从“被截断的尾巴”取原因，等于报错原因取错。
    const pol = policy();
    const CAP = pol.outputCapChars, KEEP_HEAD = pol.outputHeadChars, KEEP_TAIL = pol.outputTailChars;
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
      const text = out.trim().slice(0, policy().uiTextChars);
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
// 6. 只读探针：五个插件开关的当下状态（--status / --check），60 秒内复用，别每展开一次都跑 dump-config
let STATUS_CACHE = { at: 0, data: null };
let STATUS_JOB = null;                               // 同一时刻多块面板一起开：只起一轮子进程，其余复用它
function status() {
  reloadFeatures();
  if (STATUS_CACHE.data && Date.now() - STATUS_CACHE.at < policy().statusCacheSec * 1000) return Promise.resolve(STATUS_CACHE.data);
  if (STATUS_JOB) return STATUS_JOB;
  const launch = nodeSpec();
  const jobs = FEATURES.filter((f) => f.statusArgs && available(f)).map((f) => new Promise((resolve) => {
    // 结构化优先：只有 plugin 类脚本支持 --json；别的状态动作不塞未知开关
    const args = f.statusArgs.concat(cfgOf(f.id).kind === 'plugin' ? ['--json'] : []);
    const child = spawn(launch.exe, [scriptOf(f)].concat(args), { cwd: ROOT, env: launch.env, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { if (e && e.code !== 'ESRCH') console.warn('[功能台] kill 失败', e.message); } }, 25000);
    child.stdout.on('data', (b) => { out += String(b || ''); });
    child.stderr.on('data', (b) => { out += String(b || ''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ id: f.id, code: code, text: out.trim().slice(0, 1600), json: jsonOf(out) });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ id: f.id, code: -1, text: '起不来：' + e.message, json: null }); });
  }));
  STATUS_JOB = Promise.all(jobs).then((rows) => {
    const data = { ok: true, at: Date.now(), rows: rows };
    STATUS_CACHE = { at: Date.now(), data: data };
    STATUS_JOB = null;
    return data;
  });
  return STATUS_JOB;
}

// 6a. 从输出里取最后一段可解析的 JSON（脚本可能先打日志）；取不到返回 null
function jsonOf(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { /* 继续找最后一段 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  return null;
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
function cfgOf(id) {
  const c = CFG[id];
  // 未声明 = 按「无配置」处理（测试会拦）；不在这里猜一个类型出来
  return c ? Object.assign({}, c) : { kind: 'none', noWhy: '登记表没声明配置类型（按无配置处理）' };
}
function serialize(f, hits) {
  return {
    id: f.id, group: f.group, name: f.name, plain: f.plain, why: f.why || '',
    script: f.script, restart: !!f.restart, ok: available(f), freq: freqOf(f.id),
    cfg: cfgOf(f.id),
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
    return rows.sort((a, b) => b.at - a.at).slice(0, Number(n) || policy().logListCount);
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[功能台] 历史目录读不到', e.message);
    return [];
  }
}

function list() {
  reloadFeatures();
  const cfg = readCfg();
  const pol = policy();
  const cfgHits = cfg.hits || {};
  const groups = GROUPS.map((g) => ({
    id: g.id, title: g.title, plain: g.plain,
    features: FEATURES.filter((f) => f.group === g.id)
      .slice()
      .sort((a, b) => (FREQ_N[freqOf(a.id)] - FREQ_N[freqOf(b.id)]) || 0)   // 日常在前、低频在后（同档保持登记顺序）
      .map((f) => serialize(f, cfgHits)),
  }));
  const actions = FEATURES.reduce((a, f) => a + (f.actions || []).length, 0);
  // 最近操作：按 at 倒序（条数走工具策略），界面那块「最近做了什么」直接读它，不另存一份
  const recent = Object.keys(cfg.last).map((id) => {
    const rec = cfg.last[id] || {};
    const f = featureOf(id), a = actionOf(f, rec.action);
    return {
      id: id, feature: f ? f.name : id, action: a ? a.label : String(rec.action || ''),
      at: Number(rec.at) || 0, ok: !!rec.ok, reason: String(rec.reason || '').slice(0, 160),
      hits: Number((cfgHits[id] || 0)),
    };
  }).sort((x, y) => y.at - x.at).slice(0, pol.recentCount);
  const triage = TRIAGE.map((t) => {
    const f = featureOf(t.feature), a = actionOf(f, t.action);
    return {
      symptom: t.symptom, tip: t.tip, feature: t.feature, action: t.action,
      featureName: f ? f.name : t.feature, actionLabel: a ? a.label : t.action,
      ok: !!(f && a && available(f)),
    };
  });
  // 配置位统计：右栏要一句话说清「几项能改 / 几项只读 / 几项没有」
  const cfgStats = { plugin: 0, machine: 0, external: 0, none: 0 };
  FEATURES.forEach((f) => { const k = cfgOf(f.id).kind; cfgStats[k] = (cfgStats[k] || 0) + 1; });
  return {
    ok: true, file: CFG_FILE, logDir: path.join(CFG_DIR, '历史'), groups: groups, triage: triage, recent: recent,
    logs: recentLogs(pol.logListCount),
    policy: pol, policyDef: POLICY_DEF, policyFile: POLICY_FILE, configSources: configSources(), machine: machineCfg(), cfgStats: cfgStats,
    stats: { features: FEATURES.length, actions: actions, groups: GROUPS.length, daily: FEATURES.filter((f) => freqOf(f.id) === 'daily').length, rare: FEATURES.filter((f) => freqOf(f.id) === 'rare').length },
    scenes: scenarioList(), memScenes: memSceneList(),
    unregistered: unregistered(), adopted: readAdopted().items, adoptFile: ADOPT_FILE,
  };
}

// 5d. 审计：90 天没人点过的卡（防「功能越加越多、界面越来越没人用」）
function audit(days) {
  reloadFeatures();
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

// 9. 体检：逐条动作核「脚本在 / 开关名对得上 / 只读的真能跑」（2026-11-18）
//    界面上的按钮最终就是一条 argv，这里按同一份登记表把 argv 拼出来核，不另写第二份命令：
//      ① 脚本在不在（available）
//      ② argv 里每个 --开关 在脚本源码（连同它 import 的同级 / 上一级本地模块）里出不出得现
//         —— 防「脚本改了开关字，按钮还指旧的」这种静默按钮变砖
//      ③ 只读、无必填输入、不依赖引擎会话的动作真跑一次，看是不是真给出结论
//    ⛔ 写 / 破坏性动作一律不跑，只做 ①②（跑一下就会改真实配置或搬文件）。
const BAD_OUT = [/用法[:：]/, /未知的?(命令|参数|动作|开关)/, /Unknown (command|argument|option)/i, /Cannot find module/, /ERR_MODULE_NOT_FOUND/, /SyntaxError/, /TypeError:/];
const ENGINE_HINT = ['引擎token.mjs', 'process.env.DSH_TOKEN', 'process.env["DSH_TOKEN"]'];   // 真依赖引擎 token 才算（光在文案里提到 server.log 不算）

// 9a. 拼 argv 用的假输入：只取声明过的默认值 / 下拉首项；必填项留给「界面里填」，体检不代填
function sampleInputs(a) {
  const v = {};
  (a.inputs || []).forEach((s) => {
    if (s.required) return;
    if (s.def) v[s.key] = s.def;
    else if (s.kind === 'select' && s.options && s.options[0]) v[s.key] = s.options[0].v;
  });
  return v;
}
const flagsOf = (argv) => (argv || []).filter((x) => typeof x === 'string' && x.indexOf('--') === 0);

// 9b. 脚本全文（含它 import 的本地模块）：开关名可能在公共解析文件里
const SRC_CACHE = {};
function scriptTextOf(f) {
  if (SRC_CACHE[f.script] != null) return SRC_CACHE[f.script];
  let txt = '';
  try {
    const self = scriptOf(f);
    txt = fs.readFileSync(self, 'utf8');
    const dir = path.dirname(self);
    const re = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
    let m = re.exec(txt);
    while (m) {
      const p = path.resolve(dir, m[1]);
      try { if (fs.existsSync(p)) txt += '\n' + fs.readFileSync(p, 'utf8'); }
      catch (e) { console.warn('[功能台] 体检读不到导入模块', m[1], e && e.message); }
      m = re.exec(txt);
    }
  } catch (e) { txt = ''; }
  SRC_CACHE[f.script] = txt;
  return txt;
}

// 9c. 一条动作的判定：先静态，再决定要不要真跑
function verifyOne(job) {
  const f = job.f, a = job.a;
  const row = { feature: f.id, name: f.name, action: a.id, label: a.label, danger: a.danger || 'read', state: '', note: '', missing: [] };
  if (!available(f)) { row.state = 'missing-script'; row.note = '脚本不在了：' + f.script; return Promise.resolve(row); }
  let argv;
  try { argv = a.args(sampleInputs(a)); } catch (e) { row.state = 'args-error'; row.note = String((e && e.message) || e); return Promise.resolve(row); }
  if (!Array.isArray(argv)) { row.state = 'args-error'; row.note = 'args() 没给出数组'; return Promise.resolve(row); }

  const src = scriptTextOf(f);
  row.missing = flagsOf(argv).filter((x) => src.indexOf(x) < 0);
  const required = (a.inputs || []).some((s) => s.required);
  const write = a.danger === 'write' || a.danger === 'destructive';
  const needEngine = ENGINE_HINT.some((h) => src.indexOf(h) >= 0);

  // 只核开关名就收工的三类：会改东西的、要人现场填的、要引擎 token 的
  if (write || required || needEngine) {
    row.state = row.missing.length ? 'flag-missing' : (write ? 'static-ok' : (required ? 'needs-input' : 'needs-engine'));
    row.note = [
      row.missing.length ? ('开关在脚本里找不到：' + row.missing.join(' ')) : '',
      write ? '写/破坏性动作：只核开关名，不实跑' : '',
      required ? '有必填输入：只在界面里填了才跑' : '',
      needEngine ? '要引擎会话（token 只在壳里）：命令行验不了' : '',
    ].filter(Boolean).join(' / ');
    return Promise.resolve(row);
  }

  // 9d. 真跑：只读、无必填、不碰引擎
  return new Promise((resolve) => {
    const launch = nodeSpec();
    const cap = Math.min(a.timeout || f.timeout || 60000, 90000);
    const t0 = Date.now();
    let text = '', done = false;
    const cp = spawn(launch.exe, [scriptOf(f)].concat(argv), { cwd: ROOT, env: launch.env, windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { cp.kill(); } catch (e) { if (e && e.code !== 'ESRCH') console.warn('[功能台] 体检停不下来', e.message); }
      row.state = 'timeout'; row.ms = Date.now() - t0; row.note = '超过 ' + Math.round(cap / 1000) + ' 秒';
      resolve(row);
    }, cap);
    cp.stdout.on('data', (b) => { text += String(b || ''); });
    cp.stderr.on('data', (b) => { text += String(b || ''); });
    cp.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      row.state = 'spawn-error'; row.ms = Date.now() - t0; row.note = String((e && e.message) || e);
      resolve(row);
    });
    cp.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const okCodes = Array.isArray(a.okCodes) ? [0].concat(a.okCodes) : [0];
      const bad = BAD_OUT.filter((re) => re.test(text))[0];
      row.exit = code; row.ms = Date.now() - t0;
      row.state = (row.missing.length || okCodes.indexOf(code) < 0 || bad) ? 'run-bad' : 'run-ok';
      row.note = [
        row.missing.length ? ('开关在脚本里找不到：' + row.missing.join(' ')) : '',
        okCodes.indexOf(code) < 0 ? ('退出码 ' + code) : '',
        bad ? ('输出像出错：' + String(bad)) : '',
      ].filter(Boolean).join(' / ') || ('退出码 ' + code);
      row.head = text.trim().split(/\r?\n/).slice(0, 2).join(' / ').slice(0, 200);
      resolve(row);
    });
  });
}

// 9e. 全量体检：最多两条并行（再多人机都卡）；顺序按登记表，报告按功能归组
function verify() {
  reloadFeatures();
  const jobs = [];
  FEATURES.forEach((f) => (f.actions || []).forEach((a) => jobs.push({ f: f, a: a })));
  return new Promise((resolve) => {
    const rows = [];
    let next = 0, live = 0;
    const pump = () => {
      if (rows.length === jobs.length) { resolve({ ok: true, at: Date.now(), total: jobs.length, rows: rows }); return; }
      while (live < 2 && next < jobs.length) {
        const job = jobs[next]; next += 1; live += 1;
        verifyOne(job).then((row) => { rows.push(row); live -= 1; pump(); })
          .catch((e) => { rows.push({ feature: job.f.id, action: job.a.id, state: 'exception', note: String((e && e.message) || e) }); live -= 1; pump(); });
      }
    };
    pump();
  });
}

module.exports = { list, run, status, kill, audit, verify, configGet, configSet, unregistered, CFG_FILE, POLICY_FILE };

// 命令行自测：node 12-源码照搬\外壳\功能台.js [--json] [--audit 90]
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.indexOf('--audit') >= 0) {
    const i = argv.indexOf('--audit');
    const a = audit(argv[i + 1] || 90);
    console.log('功能台审计 · ' + a.days + ' 天窗口：' + a.used + ' / ' + a.total + ' 项用过，' + a.stale.length + ' 项没动');
    a.stale.forEach((r) => console.log('  · [' + r.freq + '] ' + r.name + '（' + (r.at ? r.age + ' 天前' : '从未点过') + '）'));
    process.exit(0);
  } else if (argv.indexOf('--verify') >= 0) {
    verify().then((v) => {
      const clean = ['run-ok', 'static-ok', 'needs-input', 'needs-engine'];
      const bad = v.rows.filter((r) => clean.indexOf(r.state) < 0);
      const cnt = {};
      v.rows.forEach((r) => { cnt[r.state] = (cnt[r.state] || 0) + 1; });
      if (process.argv.includes('--json')) console.log(JSON.stringify(v, null, 1));
      else {
        console.log('功能台体检 · ' + v.rows.length + ' 条动作：' + Object.keys(cnt).sort().map((k) => k + ' ' + cnt[k]).join(' / '));
        v.rows.forEach((r) => {
          const mark = clean.indexOf(r.state) < 0 ? '✗' : (r.state === 'run-ok' ? '✓' : '·');
          console.log('  ' + mark + ' [' + r.feature + '.' + r.action + '] ' + r.label + ' — ' + r.state + (r.note ? '：' + r.note : ''));
        });
      }
      process.exit(bad.length ? 1 : 0);
    });
  } else {
  const o = list();
  if (process.argv.includes('--json')) console.log(JSON.stringify(o, null, 1));
  else {
    console.log('功能台 · ' + o.stats.features + ' 个功能 / ' + o.stats.actions + ' 个动作 / ' + o.stats.groups + ' 组');
    console.log('配置位 · 可改 ' + o.cfgStats.plugin + ' / 机器层 ' + o.cfgStats.machine + ' / 在别处 ' + o.cfgStats.external + ' / 无配置 ' + o.cfgStats.none);
    o.groups.forEach((g) => {
      console.log('[' + g.title + '] ' + g.features.length + ' 项');
      g.features.forEach((f) => console.log('  ' + (f.ok ? '✓' : '✗') + ' [' + f.freq + '] ' + f.name + ' — ' + f.actions.map((a) => a.label).join(' / ')));
    });
  }
  }
}
