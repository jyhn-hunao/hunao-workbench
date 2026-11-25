// 内容源适配器注册表（2026-11-25）
// 生活场景「刷内容」按 platform 找适配器；新平台加一个文件 + 这里登记一行。
//
// 统一接口：
//   meta = { id, name, platform }
//   list(cfg)  -> [{ key, title, author, desc, url, extra }]
//   read(item) -> { text, comments? } | null
//
// 已内置：bilibili（免签名热门/排行/详情/热评）、rss（RSS/Atom）、web（任意网页）
// 后置（需要登录态或 CDP，暂不内置）：douyin / xiaohongshu / weibo
import * as bilibili from './bilibili.mjs';
import * as rss from './rss.mjs';
import * as web from './web.mjs';

export const ADAPTERS = { bilibili, rss, web };

export function adapterFor(platform) {
  return ADAPTERS[String(platform || '')] || null;
}

export function listAdapters() {
  return Object.values(ADAPTERS).map((a) => a.meta);
}
