// 内容源适配器：RSS / Atom（2026-11-25）
// 零依赖正则解析，不做 XML 库；只取标题、链接、摘要，正文交上层决定是否深读。
export const meta = { id: 'rss', name: 'RSS', platform: 'rss' };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function strip(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  if (!m) return '';
  const v = m[1];
  const a = v.indexOf('<![CDATA[');
  const b = v.indexOf(']]>');
  const inner = a >= 0 && b > a ? v.slice(a + 9, b) : v;
  return strip(inner);
}

export async function list(cfg) {
  const url = String(cfg.url || '');
  if (!url) throw new Error('rss 源缺 url');
  let r;
  try {
    r = await fetch(url, { headers: { 'user-agent': UA } });
  } catch (e) {
    throw new Error('RSS 连不上：' + ((e && e.message) || e));
  }
  if (!r.ok) throw new Error('RSS HTTP ' + r.status);
  const xml = await r.text();
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const limit = Math.max(1, Math.min(30, Number(cfg.limit) || 8));
  return items.slice(0, limit).map((b, i) => {
    const title = tag(b, 'title') || ('条目 ' + (i + 1));
    const link = tag(b, 'link') || tag(b, 'id');
    const desc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || '';
    return {
      key: 'rss:' + (link || title),
      title: title.slice(0, 120),
      author: String(cfg.name || meta.name),
      desc: desc.slice(0, 120),
      url: link,
      extra: {}
    };
  });
}

export async function read(item) {
  return { text: String(item.desc || '（这条只有标题，没有摘要）') };
}
