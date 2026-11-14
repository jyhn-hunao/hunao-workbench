// ── 场景图标登记表（单处权威）───────────────────────────────────────────────
// 2026-11-13：场景加到第 7 个，图标不够用了 —— 原来每个图标都是一段手写 SVG，而且要写在两个
// 地方（外壳 renderer.js 的 ICONS、热更新层 renderers.js 的 SCENARIO_ICONS）；**没登记的场次
// 一律退回同一个 🧩**，「胡闹的大肥鱼」和「社交」就是这么顶上了同一枚图标，分不出来。
//
// 现在的规矩（新场景照这个办）：
//   ① 常规场景 → 从本地图标库取：`renderer\assets\icons\*.svg`（Lucide 抓下来的一份，见同目录
//      README.md；脚本 `scripts\图标库.mjs` 生成），**这里登记场景 id → 图标名**；
//   ② 要品牌感 / 官方 logo 的（同花顺、B站、抖音、Blender…）→ 仍然走 renderers.js 的
//      SCENARIO_ICONS（手绘 SVG 或 <img> 官方图），它优先；
//   ③ 第 ③ 层：两个都没有 ⇒ 从「兜底池」里领一个**还没被占用**的图标（见 pickUnused），
//      所以两个场景绝不会顶同一枚图；check-gui.mjs 会把"没登记"直接报成 FAIL，催你补登记。
//
// 这层是纯数据 + 纯函数，两个渲染层共用：外壳 renderer.js 建标签时调 markupOf()，
// 热更新层 renderers.js 的 decorateScenarioIcons() 也调它（同一份数据，不再两边各写一份）。
(function () {
  var DIR = 'assets/icons/';          // 相对 renderer\ —— 和 assets\webai\ 那套一样，别写绝对路径

  // 场景 id → Lucide 图标名（图标名去 https://lucide.dev/icons 搜）
  var MAP = {
    'pet': 'fish',                  // 胡闹的大肥鱼：人格本体，一条鱼（原来和「社交」一起退回 🧩）
    'social': 'message-circle-more', // 社交：气泡 + 三个点 = 多平台通道 / 合并消息流（16px 下最认得出）
    'creative': 'box'               // 创意工坊：一个立方体 = 三维建模 / 场景搭建
  };

  // 兜底池：未登记的场景按标签顺序各领一个没被占用的，避免两枚图撞在一起
  // （这几个图标也都落地在 assets\icons\ 里，由 scripts\图标库.mjs 抓取）
  var POOL = ['shapes', 'layers', 'box', 'sparkles', 'circle-dot', 'radar'];

  // 图标位统一尺寸：17px（与手绘 SVG 那批一致；CSS 里 .tab-ico-img.tab-ico-svg 去掉圆角底/描边环）
  function markup(name) {
    if (!name) return '';
    return '<img class="tab-ico-img tab-ico-svg" src="' + DIR + name + '.svg" width="17" height="17" alt="">';
  }

  function nameOf(id) { return (id && MAP[id]) || ''; }

  window.WB_SCENE_ICONS = {
    dir: DIR,
    map: MAP,
    pool: POOL,
    name: nameOf,                    // 场景 id → 图标名（没登记返回 ''）
    markup: markup,                  // 图标名 → 图标位的整段标记（<img …>）
    markupOf: function (id) { return markup(nameOf(id)); },
    pickUnused: function (taken) {   // taken = 已被占用的图标名集合；返回一个没被占的（池用完返回 ''）
      var used = taken || {};
      for (var i = 0; i < POOL.length; i++) { if (!used[POOL[i]]) return POOL[i]; }
      return '';
    }
  };
})();
