// 内容源适配器：任意网页（2026-11-25）
// 一个页面算一条候选；取 <title> / og:description / description 当摘要，正文深读剥标签取前 800 字。
export const meta = { id: 'web', name: '网页', platform: 'web' };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function decode(html) {
  const m = html.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  const cs = (m && m[1] || 'utf-8').toLowerCase();
  if (cs.includes('gb')) {
    try {
      // Node 内置 TextDecoder 支持 gbk（full-icu）；不支持就按 utf8 兜底
      return new TextDecoder('gbk').decode(Buffer.from(html, 'binary'));
    } catch (e) { return html; }
  }
  return html;
}

function metaOf(html, name) {
  const re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]+content=["\']([^"\']*)["\']', 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

function strip(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
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

async function fetchHtml(url) {
  let r;
  try {
    r = await fetch(url, { headers: { 'user-agent': UA } });
  } catch (e) {
    throw new Error('网页连不上：' + ((e && e.message) || e));
  }
  if (!r.ok) throw new Error('网页 HTTP ' + r.status);
  return decode(await r.text());
}

export async function list(cfg) {
  const url = String(cfg.url || '');
  if (!url) throw new Error('web 源缺 url');
  const html = await fetchHtml(url);
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') || String(cfg.name || url);
  const desc = metaOf(html, 'og:description') || metaOf(html, 'description') || '';
  return [{
    key: 'web:' + url,
    title: title.slice(0, 120),
    author: String(cfg.name || meta.name),
    desc: strip(desc).slice(0, 120),
    url,
    extra: {}
  }];
}

export async function read(item) {
  const url = String(item.url || '');
  if (!url) return { text: String(item.desc || '') };
  try {
    const html = await fetchHtml(url);
    return { text: strip(html).slice(0, 800) };
  } catch (e) {
    return { text: String(item.desc || '') + '\n（正文没读到：' + ((e && e.message) || e) + '）' };
  }
}
