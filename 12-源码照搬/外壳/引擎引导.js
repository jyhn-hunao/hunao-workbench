'use strict';
// 引擎引导.js —— 首启下载 DSH 引擎（检测 → 下载 → 校验 → 解包 → 整目录替换）
//
// 为什么单独一层：安装包不随引擎分发（引擎 508 MB，且是外部依赖）。
//   ⛔ 不能复用 工具\引擎更新.mjs：那套要 registry + 本机 pnpm 装整棵依赖树，
//      装机用户没有 node / pnpm。这里只认**自包含产物**（tar.gz 里已经带 node_modules 的整棵引擎目录）。
//
// 三条硬约束：
//   ① sha256 必填：下载源没配 sha256 就拒绝安装（不拿"能解压"当通过）；
//   ② 先解到临时目录、验过入口再替换，旧引擎整目录备份，失败可回滚；
//   ③ 只动引擎目录，不碰 引擎数据\.dsh（会话 / 记忆 / 凭证）。
//
// 环境变量（调试 / CI 用）：
//   DSH_ENGINE_URL / DSH_ENGINE_SHA256 / DSH_ENGINE_VERSION  覆盖下载源
//   DSH_ENGINE_DIR                                          覆盖引擎安装目录（main.js 也认这个）

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fileURLToPath } = require('url');

// 引擎两套布局：与 main.js 的 CLI_CANDS / 自检.mjs 的 ENGINE_BINS 同源
const LAYOUTS = [
  { layout: 'built', entry: path.join('lib', 'bin.js') },              // 打包版（本机现状）
  { layout: 'source', entry: path.join('apps', 'cli', 'lib', 'bin.js') } // 源码版
];

// 1. 检测引擎是否已就位
function detect(root) {
  const dir = root || '';
  if (!dir) return { ok: false, root: '', reason: 'no-dir', text: '未指定引擎目录' };
  let exists = false;
  try { exists = fs.statSync(dir).isDirectory(); } catch (e) { exists = false; }
  if (!exists) return { ok: false, root: dir, reason: 'missing', text: '引擎目录不存在' };
  for (const l of LAYOUTS) {
    const p = path.join(dir, l.entry);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) { size = 0; }
    if (size > 0) {
      const version = readVersion(dir);
      // 打包版 bin.js 依赖同目录 node_modules；没有就是半截产物，不能当"已就位"
      if (l.layout === 'built' && !fs.existsSync(path.join(dir, 'node_modules'))) {
        return { ok: false, root: dir, entry: p, layout: l.layout, version: version, reason: 'no-deps', text: '引擎入口在，但缺 node_modules（半截产物）' };
      }
      // 2026-11-21 首启失败复盘：旧安装版被 pnpm 改写过 node_modules，只剩 .pnpm 与状态文件，
      //   入口还在、node_modules 目录也在 ⇒ 旧判据会误判“已就位”，永远不再自动补装。
      //   钉一个运行时必依赖（CLI 第一行就 import 它）作为完整性判据。
      if (l.layout === 'built' && !fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'))) {
        return { ok: false, root: dir, entry: p, layout: l.layout, version: version, reason: 'no-deps', text: '引擎缺 @deepseek-ai/dsh-app-boot（node_modules 不完整，需重装引擎）' };
      }
      return { ok: true, root: dir, entry: p, layout: l.layout, version: version, reason: '', text: '引擎已就位' };
    }
  }
  return { ok: false, root: dir, reason: 'missing-entry', text: '引擎目录里没有 lib/bin.js 或 apps/cli/lib/bin.js' };
}

function readVersion(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return String(j.version || '');
  } catch (e) { return ''; }
}

// 2. 读下载源：env > 机器配置.json 的 engine.source > 外壳\引擎源.json（随包默认）
function readSource(opts) {
  const o = opts || {};
  const out = { url: '', sha256: '', version: '', bytes: 0, mirror: '', origin: [] };

  const envUrl = process.env.DSH_ENGINE_URL || '';
  const envSha = process.env.DSH_ENGINE_SHA256 || '';
  const envVer = process.env.DSH_ENGINE_VERSION || '';

  const files = [];
  if (o.configPath) files.push({ p: o.configPath, why: '机器配置.engine.source' });
  if (o.shippedPath) files.push({ p: o.shippedPath, why: '引擎源.json' });

  // 2.1 先收文件里的，再用 env 覆盖（env 优先级最高）
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(f.p, 'utf8')); } catch (e) { continue; }
    const s = (j && (j.engine && j.engine.source)) || (j && j.source) || null;
    if (!s || typeof s !== 'object') continue;
    if (!out.url && s.url) { out.url = String(s.url); out.origin.push(f.why); }
    if (!out.sha256 && s.sha256) { out.sha256 = String(s.sha256); out.origin.push(f.why); }
    if (!out.version && s.version) out.version = String(s.version);
    if (!out.bytes && Number(s.bytes) > 0) out.bytes = Number(s.bytes);
    if (!out.mirror && s.mirror) out.mirror = String(s.mirror);
  }
  if (envUrl) { out.url = envUrl; out.origin.push('env'); }
  if (envSha) { out.sha256 = envSha; out.origin.push('env'); }
  if (envVer) out.version = envVer;

  // 2.2 校验：url 必须能认，sha256 必须是 64 位十六进制
  const bad = [];
  if (!out.url) bad.push('未配置下载地址（engine.source.url）');
  if (!/^[0-9a-f]{64}$/i.test(out.sha256)) bad.push('未配置合法 sha256（需 64 位十六进制）');
  out.ok = bad.length === 0;
  out.problems = bad;
  return out;
}

// 3. 下载：支持 http/https 跳转、file:// 与本机路径；边下边算 sha256
function sha256File(file, onProgress) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    let bytes = 0;
    let total = 0;
    try { total = fs.statSync(file).size; } catch (e) { total = 0; }
    let lastAt = 0;
    rs.on('data', function (chunk) {
      bytes += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (onProgress && now - lastAt > 150) {
        lastAt = now;
        onProgress({ bytes: bytes, total: total, pct: total ? Math.round(bytes / total * 100) : 0 });
      }
    });
    rs.on('error', reject);
    rs.on('end', function () { resolve(hash.digest('hex')); });
  });
}
function download(url, dest, onProgress, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };

    const local = localPathOf(url);
    if (local) return copyLocal(local, dest, onProgress, o).then(done, fail);

    let parsed;
    try { parsed = new URL(url); } catch (e) { return fail(new Error('下载地址不合法：' + url)); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(new Error('只支持 http/https/file 下载：' + parsed.protocol));

    const mod = parsed.protocol === 'https:' ? https : http;
    let hops = 0;

    const get = (u) => {
      const req = mod.get(u, {
        headers: {
          'User-Agent': 'hunao-workbench-engine-bootstrap',
          'Accept': 'application/octet-stream'
        }
      }, function (res) {
        // 3.1 跳转：最多 5 跳
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          hops += 1;
          if (hops > 5) return fail(new Error('下载跳转超过 5 次'));
          try { return get(new URL(res.headers.location, u).toString()); } catch (e) { return fail(e); }
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('下载失败：HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length']) || 0;
        const hash = crypto.createHash('sha256');
        const ws = fs.createWriteStream(dest);
        let bytes = 0;
        let lastAt = 0;
        const started = Date.now();

        res.on('data', function (chunk) {
          bytes += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (onProgress && (now - lastAt > 150)) {
            lastAt = now;
            const secs = Math.max(0.2, (now - started) / 1000);
            onProgress({
              phase: 'download', bytes: bytes, total: total,
              pct: total ? Math.min(100, Math.round(bytes / total * 100)) : 0,
              speed: bytes / secs
            });
          }
        });
        res.on('error', fail);
        ws.on('error', fail);
        ws.on('finish', function () {
          const sha256 = hash.digest('hex');
          done({ file: dest, bytes: bytes, total: total, sha256: sha256 });
        });
        res.pipe(ws);
      });
      req.on('error', fail);
      req.setTimeout((o.timeoutMs || 30000), function () {
        req.destroy(new Error('下载超时（30s 无响应）'));
      });
    };
    get(url);
  });
}

function localPathOf(u) {
  if (!u) return '';
  if (/^file:\/\//i.test(u)) {
    try { return fileURLToPath(u); } catch (e) { return ''; }
  }
  // 盘符路径 / UNC：只看像本机路径的，不把 http 当路径
  if (/^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('\\\\')) return u;
  return '';
}

function copyLocal(src, dest, onProgress, o) {
  return new Promise(function (resolve, reject) {
    let st;
    try { st = fs.statSync(src); } catch (e) { return reject(new Error('本机源文件不存在：' + src)); }
    const total = st.size;
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    let bytes = 0;
    let lastAt = 0;
    const started = Date.now();
    rs.on('data', function (chunk) {
      bytes += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (onProgress && now - lastAt > 150) {
        lastAt = now;
        onProgress({
          phase: 'download', bytes: bytes, total: total,
          pct: total ? Math.min(100, Math.round(bytes / total * 100)) : 0,
          speed: bytes / Math.max(0.2, (now - started) / 1000)
        });
      }
    });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', function () { resolve({ file: dest, bytes: bytes, total: total, sha256: hash.digest('hex') }); });
    rs.pipe(ws);
  });
}

// 4. 解包：用系统 tar（Windows 10+ 自带 bsdtar；与 封装.mjs 同一条依赖）
function extract(tgz, destDir, onProgress) {
  return new Promise(function (resolve, reject) {
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { return reject(e); }
    if (onProgress) onProgress({ phase: 'extract', pct: 0, text: '解包中…' });
    const proc = spawn('tar', ['-xzf', tgz, '-C', destDir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', function (d) { err += String(d); });
    proc.on('error', function (e) { reject(new Error('调不动 tar：' + e.message)); });
    proc.on('exit', function (code) {
      if (code !== 0) return reject(new Error('解包失败（tar 退出码 ' + code + '）：' + err.trim().slice(0, 300)));
      if (onProgress) onProgress({ phase: 'extract', pct: 100, text: '解包完成' });
      resolve({ dir: destDir });
    });
  });
}

// 5. 找解包后的引擎根：可能是 dest 本身，也可能多包一层（引擎/ 或 dsh-x.y.z/）
function findTreeRoot(dir) {
  if (detect(dir).ok) return dir;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return ''; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    if (detect(sub).ok) return sub;
  }
  // 只到两层，再深就不是"整棵目录"产物了
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let subs = [];
    try { subs = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }); } catch (x) { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const p = path.join(dir, e.name, s.name);
      if (detect(p).ok) return p;
    }
  }
  return '';
}

// 6. 整目录替换：旧目录先改名为 .bak-<时间>，新的 rename 进来，成功后再删备份
function installTree(srcDir, targetDir, meta, onProgress) {
  return new Promise(function (resolve, reject) {
    if (onProgress) onProgress({ phase: 'install', pct: 0, text: '安装引擎…' });
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const bak = targetDir + '.bak-' + ts;
    let hadOld = false;

    // 6.1 引擎运行中会被文件锁挡住：先探一次进程（由调用方保证停机；这里只把错误说清）
    try {
      if (fs.existsSync(targetDir)) {
        hadOld = true;
        fs.renameSync(targetDir, bak);
      }
    } catch (e) {
      return reject(new Error('旧引擎目录改名失败（多半是引擎还在运行，先退出工作台）：' + e.message));
    }

    // 6.2 新目录就位；失败就把旧的改回来
    try {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(srcDir, targetDir);
    } catch (e) {
      if (hadOld) { try { fs.renameSync(bak, targetDir); } catch (x) { console.warn('[engine] 回滚旧引擎失败，备份留在 ' + bak + '：' + x.message); } }
      return reject(new Error('新引擎就位失败：' + e.message));
    }

    // 6.3 写安装凭据 + 删旧备份
    try {
      fs.writeFileSync(path.join(targetDir, '.engine.json'), JSON.stringify({
        version: meta.version || readVersion(targetDir),
        sha256: meta.sha256 || '',
        source: meta.source || '',
        installedAt: new Date().toISOString(),
        layout: detect(targetDir).layout || ''
      }, null, 1) + '\n', 'utf8');
    } catch (e) { console.warn('[engine] 安装凭据写不进（不影响运行）：' + e.message); }
    if (hadOld) { try { fs.rmSync(bak, { recursive: true, force: true }); } catch (e) { console.warn('[engine] 旧引擎备份清理失败（下次启动再清）：' + e.message); } }

    if (onProgress) onProgress({ phase: 'install', pct: 100, text: '安装完成' });
    resolve({ ok: true, root: targetDir });
  });
}

// 7. 一条链：detect → 下载 → 校验 sha256 → 解包 → 验入口 → 替换
let running = null;
function ensure(opts) {
  if (running) return running;   // 单飞：界面连点两下也只装一次
  running = ensureInner(opts || {}).finally(function () { running = null; });
  return running;
}

async function ensureInner(o) {
  const root = o.root;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : function () {};
  const say = (phase, pct, text, extra) => onProgress(Object.assign({ phase: phase, pct: pct, text: text }, extra || {}));

  // 7.1 已有引擎且不强制重装 ⇒ 直接过
  const cur = detect(root);
  if (cur.ok && !o.force) return { ok: true, skipped: true, root: root, entry: cur.entry, version: cur.version };

  // 7.2 源必须齐（url + sha256）
  const src = o.source || readSource({ configPath: o.configPath, shippedPath: o.shippedPath });
  if (!src.ok) {
    const err = new Error('下载源未配好：' + src.problems.join('；'));
    err.code = 'source-missing';
    throw err;
  }
  if (o.version && src.version && String(o.version) !== String(src.version)) {
    return { ok: false, err: '版本不一致：源是 ' + src.version + '，要求 ' + o.version };
  }

  // 7.3 临时目录放在引擎同级（同一卷才能 rename，也不会把 C 盘塞满）
  const parent = path.dirname(root);
  const stamp = Date.now();
  const work = path.join(parent, '.engine-staging-' + stamp);
  const tgz = path.join(work, 'engine.tar.gz');
  try { fs.mkdirSync(work, { recursive: true }); } catch (e) { throw new Error('建临时目录失败：' + e.message); }

  try {
    // 7.4 下载（整包重下：本流程不保留 .part，失败后临时目录在 finally 里清掉）
    say('download', 0, '准备下载引擎…', { total: src.bytes || 0 });
    const t0 = Date.now();
    const got = await download(src.url, tgz, function (p) {
      say('download', p.pct, '正在下载引擎…', { bytes: p.bytes, total: p.total, speed: p.speed });
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // 7.5 校验：没通过就当没下过
    say('verify', 100, '校验 sha256…');
    const want = String(src.sha256).toLowerCase();
    const have = String(got.sha256).toLowerCase();
    if (want !== have) {
      throw Object.assign(new Error('sha256 不匹配（期望 ' + want.slice(0, 12) + '…，实际 ' + have.slice(0, 12) + '…）'), { code: 'sha256-mismatch' });
    }

    // 7.6 解包 + 验入口
    const stage = path.join(work, 'unpack');
    await extract(tgz, stage, onProgress);
    const tree = findTreeRoot(stage);
    if (!tree) throw Object.assign(new Error('解包后没找到引擎入口（lib/bin.js 或 apps/cli/lib/bin.js 都没有）'), { code: 'bad-tarball' });
    const v = readVersion(tree) || src.version || '';

    // 7.7 替换
    await installTree(tree, root, { version: v, sha256: have, source: src.url }, onProgress);

    const after = detect(root);
    if (!after.ok) throw new Error('安装后检测仍不通过：' + after.text);
    return {
      ok: true, skipped: false, root: root, entry: after.entry,
      version: v, sha256: have, bytes: got.bytes, seconds: Number(secs)
    };
  } finally {
    // 7.8 清临时目录（成功失败都清；失败的 tgz 不留，免得占 500MB）
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { console.warn('[engine] 临时目录清理失败：' + work + '（' + e.message + '）'); }
  }
}

// 8. 找随包 / 预置的本地引擎包：安装器把 引擎-*.tar.gz 拷到 安装目录\引擎包\
//    这里只做浅层扫描（目录 + 一层子目录），不递归全盘；同名多个取最新修改的。
function findLocalPackage(dirs) {
  const found = [];
  const want = /^(引擎|engine)[-_ ].*\.(tar\.gz|tgz)$/i;
  const scan = (dir, depth) => {
    if (!dir || depth > 1) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && want.test(e.name)) {
        let st = null;
        try { st = fs.statSync(p); } catch (x) { continue; }
        // 小于 10 MB 的“引擎包”必是坏包 / 占位文件，不浪费一次解包
        if (st.size < 10 * 1024 * 1024) continue;
        found.push({ file: p, name: e.name, bytes: st.size, mtime: st.mtimeMs });
      } else if (e.isDirectory() && depth < 1 && /^(引擎包|engine-packages?)$/i.test(e.name)) {
        scan(p, depth + 1);
      }
    }
  };
  for (const d of (dirs || [])) scan(d, 0);
  found.sort(function (a, b) { return b.mtime - a.mtime; });
  return found[0] || null;
}

module.exports = {
  LAYOUTS: LAYOUTS,
  detect: detect,
  readVersion: readVersion,
  readSource: readSource,
  findLocalPackage: findLocalPackage,
  sha256File: sha256File,
  download: download,
  extract: extract,
  findTreeRoot: findTreeRoot,
  installTree: installTree,
  ensure: ensure
};
