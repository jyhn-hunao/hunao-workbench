// 备份/回滚共用的源码清单（2026-11-19）
// 为什么单列一份：backup-gui 与 restore-gui 原来各写一份 FILES，新增顶层文件时总有一个漏 →
// 回滚时缺文件。清单只在这里维护；两边都 import 它。
// ⛔ 新增外壳顶层源码（.js / .md / 配置文件）或新增源码目录时，必须同步这里。
export const FILES = [
  // 顶层源码
  'main.js', 'preload.js', 'crash.js',
  'QQ自动注入.js', '功能台.js', '外发闸门.js', '微信通道.js',
  '桌宠设置.js', '桌宠状态.js', '社交.js', '社交回复.js', '桥接.js',
  '项目切换.js', '用量.js', '工具清单.js',
  // 配置与入口
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'start.vbs', 'icon.ico', 'icon.png',
  // 说明
  '项目信息.md', '架构索引.md',
  // pet3d 里属于源码的两份（模型/贴图/表情包是大体积资源，不进快照）
  'pet3d/app.js', 'pet3d/index.html',
  'pet3d/utils/BufferGeometryUtils.js', 'pet3d/utils/SkeletonUtils.js'
];

export const DIRS = ['renderer', 'scenarios', 'scripts', 'pet'];
