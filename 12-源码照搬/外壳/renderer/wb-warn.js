// 静默 catch 的统一出口（2026-11-13）
//   为什么：全仓 300+ 处 `catch (e) { /* 忽略 */ }`，用户看到的现象只是"点一下没反应"，
//   排障时既没有日志也没有位置，只能靠猜。这个文件给所有 renderer 脚本提供一个 wbWarn()。
//   落地方式："打不下来的错误"写进 外壳\server.log（复用 preload 的 diagLog 通道，
//   即 `ipcRenderer.send('diag:log', msg)`，main 侧已有落盘实现），不新增 IPC 通道。
//   防刷屏：同一"调用位置 + 消息"只记一次（缓存挂在 window 上，热重载后不会重复刷）。
//   加载顺序：index.html 里必须排在任何 renderer 脚本之前（renderers.js 在 118 行，本文件 116 行）。
//   顶层一律用 var：热重载会重复加载脚本，const/let 重复声明会直接抛错。
'use strict';

var wbWarn = function (e, tag) {
  try {
    var seen = window.__WB_WARN_SEEN || (window.__WB_WARN_SEEN = {});
    var msg = (e && (e.message || String(e))) || 'unknown';
    var at = '';
    try {
      var st = String(new Error().stack || '').split('\n');
      // [0] "Error" [1] wbWarn 自己 [2] 真正的调用点
      at = (st[2] || st[1] || '').trim().replace(/^at\s+/, '');
    } catch (x) { at = ''; }
    var key = String(tag || '') + '|' + msg.slice(0, 120) + '|' + at;
    if (seen[key]) return;
    seen[key] = 1;
    var line = '[renderer-warn] ' + (tag ? '(' + tag + ') ' : '') + msg + ' @ ' + at;
    if (window.app && window.app.diagLog) window.app.diagLog(line);
    else if (window.console) window.console.warn(line);
  } catch (x) {
    // 记日志本身失败也不能影响主流程（这里不再往下兜底，避免递归）
  }
};
window.__wbWarn = wbWarn;
