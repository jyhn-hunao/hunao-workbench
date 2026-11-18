// 千问表情包生成工具（工作台侧，不把 Key 写进仓库）
// 用法：
//   set QWEN_API_KEY=... && node 12-源码照搬\工具\表情包生成.mjs --model qwen-image-2.1-pro
// 输出 JSON：{ok, model, dir, files:[{name,path,bytes}]}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_REF = path.join(ROOT, '12-源码照搬', '外壳', 'pet3d', '概念', '07-气氛图.png');
const DEFAULT_OUT = path.join(ROOT, '12-源码照搬', '外壳', 'pet3d', '表情包', '鲸鲸千问');
const DEFAULT_ENDPOINT = 'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation';

function arg(name, fallback = '') {
  const eq = '--' + name + '=';
  const hit = process.argv.find((x) => x.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const KEY = String(process.env.QWEN_API_KEY || '').trim();
if (!KEY) throw new Error('缺少 QWEN_API_KEY（由工作台注入，不落盘）');
const model = arg('model', 'qwen-image-2.1-pro');
const endpoint = arg('endpoint', String(process.env.QWEN_IMAGE_ENDPOINT || '').trim() || DEFAULT_ENDPOINT);
const ref = path.resolve(arg('ref', DEFAULT_REF));
const outDir = path.resolve(arg('out', DEFAULT_OUT));
const only = String(arg('only', '')).split(',').map((x) => x.trim()).filter(Boolean);
if (!fs.existsSync(ref)) throw new Error('概念图不存在：' + ref);
fs.mkdirSync(outDir, { recursive: true });

const refB64 = fs.readFileSync(ref).toString('base64');
const base = '以参考图中的蓝发鲸鱼女仆角色为唯一角色，严格保留她的深蓝到浅蓝渐变长发、白色女仆发带、蓝色蝴蝶结、鲸鱼耳鳍、深藏青女仆裙、白色围裙与小鲸鱼图案、鲸鱼尾鳍、圆脸大眼和Q版二次元画风。';
const tail = '生成一张聊天表情贴纸：角色半身或七分身，角色居中，正方形构图，浅奶油色干净背景，贴纸感，线条清晰，无文字、无水印、无边框。不要改变角色身份、服装、配色和画风。';
const JOBS = [
  ['01-开心.png', '她开心大笑、眼睛弯弯、双手捧脸，表情夸张可爱；' + base + tail],
  ['02-傲娇.png', '她微微扭头、双手抱臂、脸颊泛红、眼神上扬，做出傲娇又不失可爱的表情；' + base + tail],
  ['03-炸毛.png', '她鼓着腮帮子、眉毛竖起、双手叉腰、头发微微炸开，做出奶凶炸毛的表情；' + base + tail],
  ['04-委屈.png', '她眼角含泪、嘴巴微微下垂、双手绞在身前，做出委屈巴巴的表情；' + base + tail]
];

async function generate(name, prompt) {
  const body = {
    model,
    input: { messages: [{ role: 'user', content: [{ image: `data:image/png;base64,${refB64}` }, { text: prompt }] }] },
    parameters: { n: 1, size: '1024*1024', prompt_extend: false, watermark: false,
      negative_prompt: '低分辨率，模糊，肢体畸形，多余手指，面部崩坏，画风改变，文字，水印，边框' }
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const content = json?.output?.choices?.[0]?.message?.content;
  const imageUrl = Array.isArray(content) ? (content.find((x) => x && x.image) || {}).image : '';
  if (!res.ok || !imageUrl) throw new Error(name + ' 千问返回 HTTP ' + res.status + '：' + text.slice(0, 500));
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(name + ' 图片下载 HTTP ' + img.status);
  const file = path.join(outDir, name);
  const bytes = Buffer.from(await img.arrayBuffer());
  fs.writeFileSync(file, bytes);
  return { name, path: file, bytes: bytes.length };
}

const files = [];
for (const [name, prompt] of JOBS) {
  if (only.length && !only.includes(name.slice(0, 2))) continue;
  files.push(await generate(name, prompt));
}
console.log(JSON.stringify({ ok: true, model, dir: outDir, files }));
