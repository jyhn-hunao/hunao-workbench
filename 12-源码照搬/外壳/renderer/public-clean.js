/* public-clean.js —— 开源版：隐藏只属于「本机私有」的功能入口
 * 用法：index.html 末尾引入即可。
 * 说明：不是删除能力，只是开源模板里不展示（本地抠图、远程控制、模型提供方、本地模型）。
 *
 * 2026-11-20 卡顿治理：原来是 setInterval(sweep, 1500) 永远全量扫 `.menu-item,...button,a,li`
 *   并逐个读 textContent —— DOM 一大就每 1.5 秒烧一次 CPU，而且绝大多数轮次没有新节点可藏。
 *   现在改成「DOM 变了才扫」：MutationObserver 置脏标记 + 1s 合并；每 6 秒只检查一次脏标记本身；
 *   场景切换（wb:scene-activate）后再补扫两次（顶栏重渲染后仍能藏住）。
 */
(function () {
  var HIDE = ['#btn-remote', '#btn-models', '#btn-cut', '#btn-localmodel'];
  var TEXT_HIDE = ['远程控制', '手机远程访问', '本地抠图', '模型提供方', '记忆管理'];
  var dirty = true;
  var sweepPending = false;
  function css() {
    if (document.getElementById('public-clean-css')) return;
    var s = document.createElement('style');
    s.id = 'public-clean-css';
    s.textContent = HIDE.join(',') + '{display:none!important}';
    document.head.appendChild(s);
  }
  function sweep() {
    dirty = false;
    css();
    var items = document.querySelectorAll('.menu-item,.pop-item,.dd-item,button,a,li');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var t = (it.textContent || '').trim();
      if (!t) continue;
      for (var k = 0; k < TEXT_HIDE.length; k++) {
        if (t === TEXT_HIDE[k] || t.indexOf(TEXT_HIDE[k]) === 0) {
          it.style.display = 'none';
          break;
        }
      }
    }
  }
  function schedule() {
    if (sweepPending) return;
    sweepPending = true;
    setTimeout(function () { sweepPending = false; if (dirty) sweep(); }, 400);
  }
  function boot() {
    sweep();
    try {
      new MutationObserver(function () { dirty = true; schedule(); })
        .observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    // 兜底：只查脏标记（纯内存布尔），不扫 DOM；有变化才真正扫
    setInterval(function () { if (dirty) schedule(); }, 6000);
    // 切场景后顶栏会重渲染：补扫两次（80ms / 600ms），保证藏得住
    window.addEventListener('wb:scene-activate', function () {
      dirty = true;
      setTimeout(function () { dirty = true; schedule(); }, 80);
      setTimeout(function () { dirty = true; schedule(); }, 600);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
