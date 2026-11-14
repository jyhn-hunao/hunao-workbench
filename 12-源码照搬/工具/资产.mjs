#!/usr/bin/env node
// 创意工坊 · 资产包管理（一次一个资产，一个资产一个目录）
// 为什么：流水线原来按"文件类型"分目录（工程/概念/贴图/输出/导出），多个模型混在一起，
//        交付时说不清哪张图、哪个 .blend 属于哪个角色。改成以资产为单位打包，一个资产包自带全套材料。
//
// 用法：
//   node 工具\资产.mjs new --name "木箱" [--id "Box"] [--note "…"] [--ref "<参考图>"]
//   node 工具\资产.mjs list                     # 现有资产包一览（名称 / 阶段 / 最新 .blend / 更新时间）
//   node 工具\资产.mjs check --name "木箱"       # 缺什么（lo / uv / rig / glb / 贴图）
//   node 工具\资产.mjs stage --name "木箱" --set "绑定"
//   node 工具\资产.mjs path --name "木箱"        # 打印资产包绝对路径（给别的脚本/会话用）
//
// 目录骨架（固定，岗位按这个写，不各建各的）：
//  资产\<资产名>\
//    资产.json         元信息（名称 / 命名前缀 / 阶段 / 目标引擎 / 预算）
//    brief.md          工单：需求、参考图说明、验收清单（从 工单模板.md 抄）
//    ref\              参考图 + 三视图 + 概念图（原画岗写）
//    tex\              贴图（≤2K，命名 TEX_<前缀>_<部位>）
//    render\test|final|qc\   测试渲 / 终渲 / 质检图
//    export\           导出的 GLB / FBX（可操作资产必须带 skin）
//    qc\               质检报告
//    *.blend           <前缀>_hi/_lo/_uv/_rig_v001.blend（版本只增不覆盖）
//    scripts\          该资产专用 Blender 脚本（通用脚本仍放 工作区\_脚本）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const val = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', val('--root', path.join('工作区', '创意工坊')));
const ASSETS = path.join(ROOT, '资产');
const SUB = ['ref', 'tex', path.join('render', 'test'), path.join('render', 'final'), path.join('render', 'qc'), 'export', 'qc', 'scripts'];

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function now() {
  const d = new Date(); const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 资产名做目录名：挡住 Windows 非法字符，别让一个冒号毁掉整条路径
function safeName(n) {
  const s = String(n || '').trim();
  if (!s) die('缺 --name "<资产名>"');
  if (/[\\/:*?"<>|]/.test(s)) die('资产名不能含 \\ / : * ? " < > |：' + s);
  return s;
}
function listAssets() {
  if (!fs.existsSync(ASSETS)) return [];
  return fs.readdirSync(ASSETS)
    .filter((d) => fs.statSync(path.join(ASSETS, d)).isDirectory())
    .map((d) => {
      const dir = path.join(ASSETS, d);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, '资产.json'), 'utf8')); } catch { meta = {}; }
      let newest = 0, newestFile = '';
      const walk = (p, depth) => {
        for (const e of fs.readdirSync(p)) {
          const full = path.join(p, e);
          const st = fs.statSync(full);
          if (st.isDirectory()) { if (depth < 2) walk(full, depth + 1); }
          else if (/\.blend\d?$/i.test(e) && st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = path.relative(dir, full); }
        }
      };
      try { walk(dir, 0); } catch { /* 读不到就当空包，不算错误 */ }
      return { name: d, stage: meta.stage || '—', newestFile, newest, dir };
    })
    .sort((a, b) => b.newest - a.newest);
}
function briefTemplate(name, id, note) {
  return [
    '# ' + name + ' · 资产工单',
    '',
    '- 资产名：' + name,
    '- 命名前缀：SM_' + id,
    '- 目标：低模 + 骨骼（可操作角色），引擎：' + '未定',
    '- 交付：`' + '资产' + '\\' + name + '\\` 下的 .blend、贴图、渲染图、`export\\` 里的 GLB（**必须带 skin**）',
    '',
    '## 要求',
    '',
    (note || '- （待填：造型、尺寸、比例、配色、用途）'),
    '',
    '## 参考图',
    '',
    '- `ref\\` 下的图是第一依据；没有就先去出三视图（原画岗）。',
    '',
    '## 验收',
    '',
    '- 面数：移动 ≤1.5 万 / 实时 ≤5 万；非流形 0；命名 SM_ 前缀；版本 `_hi/_lo/_uv/_rig` 只增不覆盖',
    '- 绑定：人形标准骨名，极限姿势不塌陷，导出 GLB 含 `skins/joints`',
    '',
    '## 进度',
    '',
    '| 阶段 | 状态 | 产物 |',
    '| --- | --- | --- |',
    '| 概念 | 待开始 | `ref\\` |',
    '| 建模 | 待开始 | `_lo_v001.blend` |',
    '| UV / 贴图 | 待开始 | `_uv_v001.blend` + `tex\\` |',
    '| 绑定 | 待开始 | `_rig_v001.blend` |',
    '| 质检 / 导出 | 待开始 | `export\\*.glb` + `qc\\` |',
    ''
  ].join('\r\n');
}
function cmdNew() {
  const name = safeName(val('--name'));
  const id = String(val('--id', '') || name.replace(/[^\x00-\x7F]/g, '') || 'Asset').replace(/[^\w.-]/g, '') || 'Asset';
  const note = val('--note', '');
  const ref = val('--ref', '');
  const dir = path.join(ASSETS, name);
  if (fs.existsSync(dir)) die('资产包已存在：' + dir + '（要新版本请在里面加 _v002，不要新建同名目录）');
  // 1. 目录骨架
  for (const s of SUB) fs.mkdirSync(path.join(dir, s), { recursive: true });
  // 2. 元信息
  const meta = { name, prefix: 'SM_' + id, created: now(), stage: '概念', engine: '未定', budget: { tris_mobile: 15000, tris_realtime: 50000, tex_max: 2048 }, ref: ref ? 'ref\\' + path.basename(ref) : '' };
  fs.writeFileSync(path.join(dir, '资产.json'), JSON.stringify(meta, null, 2).replace(/\n/g, '\r\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'brief.md'), briefTemplate(name, id, note), 'utf8');
  // 3. 参考图拷进来（用户丢的图就是第一依据，别让它留在剪贴板临时目录）
  if (ref) {
    if (!fs.existsSync(ref)) die('参考图不存在：' + ref);
    fs.copyFileSync(ref, path.join(dir, 'ref', path.basename(ref)));
  }
  console.log('✓ 资产包已建：' + dir);
  console.log('  命名前缀：SM_' + id + ' · 阶段：概念');
  console.log('  往里放：ref\\（参考图）、_lo_v001.blend（建模）、tex\\（贴图）、_rig_v001.blend（绑定）、export\\*.glb');
}

function cmdList() {
  const rows = listAssets();
  if (!rows.length) { console.log('（还没有资产包）先建一个：node 工具\\资产.mjs new --name "木箱"'); return; }
  console.log('资产包 ' + rows.length + ' 个（按最新改动排序）：');
  rows.forEach((r) => {
    const t = r.newest ? new Date(r.newest).toISOString().slice(0, 16).replace('T', ' ') : '—';
    console.log('  · ' + r.name + '　阶段 ' + r.stage + '　最新 ' + (r.newestFile || '（还没有 .blend）') + '　' + t);
  });
}

function cmdCheck() {
  const name = safeName(val('--name'));
  const dir = path.join(ASSETS, name);
  if (!fs.existsSync(dir)) die('没有这个资产包：' + name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '资产.json'), 'utf8'));
  const prefix = meta.prefix || 'SM_Asset';
  const need = [
    ['建模', prefix + '_lo_v*.blend'],
    ['UV/贴图', prefix + '_uv_v*.blend'],
    ['绑定', prefix + '_rig_v*.blend'],
    ['导出', '*.glb'],
    ['参考图', 'ref/*.png']
  ];
  const flat = [];
  const walk = (p) => { for (const e of fs.readdirSync(p)) { const f = path.join(p, e); if (fs.statSync(f).isDirectory()) walk(f); else flat.push(path.relative(dir, f).replace(/\\/g, '/')); } };
  walk(dir);
  let miss = 0;
  need.forEach(([label, pat]) => {
    const rx = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const hit = flat.filter((f) => rx.test(f));
    if (hit.length) console.log('  ✓ ' + label + '：' + hit[0]);
    else { console.log('  ✗ ' + label + '：缺（' + pat + '）'); miss++; }
  });
  const tex = flat.filter((f) => /^tex\//.test(f));
  console.log('  ' + (tex.length ? '✓' : '·') + ' 贴图 ' + tex.length + ' 张');
  // GLB 带 skin 校验（有 glb 就必须过，不带 skin = 不可操作资产）
  const glbs = flat.filter((f) => /\.glb$/i.test(f));
  glbs.forEach((g) => {
    try {
      const buf = fs.readFileSync(path.join(dir, g));
      const jlen = buf.readUInt32LE(12);
      const j = JSON.parse(buf.slice(20, 20 + jlen).toString('utf8'));
      const skins = (j.skins || []).length;
      console.log('  ' + (skins ? '✓' : '✗') + ' ' + g + '：skins=' + skins + ' joints=' + ((j.skins && j.skins[0] && j.skins[0].joints || []).length));
      if (!skins) miss++;
    } catch (ex) { console.log('  ✗ ' + g + ' 读不了：' + ex.message); miss++; }
  });
  console.log(miss ? '→ 还差 ' + miss + ' 项' : '→ 这个资产包齐了');
  process.exit(miss ? 1 : 0);
}

function cmdStage() {
  const name = safeName(val('--name'));
  const set = val('--set', '');
  const dir = path.join(ASSETS, name);
  const f = path.join(dir, '资产.json');
  if (!fs.existsSync(f)) die('没有这个资产包：' + name);
  const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
  meta.stage = set || meta.stage;
  meta.updated = now();
  fs.writeFileSync(f, JSON.stringify(meta, null, 2).replace(/\n/g, '\r\n'), 'utf8');
  console.log('✓ ' + name + ' 阶段 → ' + meta.stage);
}

const args = { new: cmdNew, list: cmdList, check: cmdCheck, stage: cmdStage, path: () => {
  const dir = path.join(ASSETS, safeName(val('--name')));
  if (!fs.existsSync(dir)) die('没有这个资产包：' + dir);
  console.log(dir);
} };
if (cmd === 'help' || !args[cmd]) {
  console.log('用法：new --name "木箱" [--id Box] [--note "…"] [--ref "<图>"] | list | check --name "x" | stage --name "x" --set "绑定" | path --name "x"');
  process.exit(cmd === 'help' ? 0 : 1);
}
args[cmd]();