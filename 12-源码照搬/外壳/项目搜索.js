// 程序开发场景 · 项目文件内容搜索（只读）
// 给「全局搜索」弹窗用：输入关键字 → 返回按文件分组的命中行，双击在预览面板打开并定位。
// 范围默认是当前项目根，也可以传用户手选的任意目录（只读；不改项目绑定）。
// 为什么放主进程：渲染层没有 Node，遍历目录 / 读文件必须由主进程做；这里不写盘，只读。
// 两条路：git 仓库优先 `git grep`（快，且自动遵守 .gitignore、覆盖未跟踪文件）；
//         不是 git 仓库（或 git 不可用）才回退到并发读文件遍历。
// 保护：文件数、单文件大小、总读取量、总耗时都有上限，避免大仓库把主进程拖死。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LIMITS = {
  maxFiles: 3000,
  maxFileBytes: 1536 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  maxMatches: 600,
  maxPerFile: 25,
  maxMs: 8000,
  concurrency: 8
};

// 依赖目录 / 构建产物 / 缓存不参与搜索（即使没有 .gitignore 也不进去）
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', '.idea', '.vscode', '.vs',
  'node_modules', 'bower_components', 'jspm_packages',
  'dist', 'build', 'out', 'target', 'coverage', '.nyc_output',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  'vendor', '__pycache__', '.venv', 'venv', 'site-packages'
]);

// 锁文件 / 生成清单：内容几乎全是依赖噪音，真要查版本用文件面板看
const NOISE_FILES = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i;

const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|psd|ai|pdf|zip|rar|7z|tar|gz|bz2|xz|exe|dll|msi|pkg|bin|iso|apk|ipa|class|jar|war|ear|so|dylib|node|wasm|woff2?|ttf|otf|eot|mp3|wav|m4a|aac|flac|ogg|mp4|mov|mkv|webm|m4v|avi|flv|wmv|db|sqlite|sqlite3)$/i;

function clipLine(line, cmpQuery, caseSensitive) {
  const raw = String(line == null ? '' : line);
  const q = caseSensitive ? cmpQuery : cmpQuery.toLowerCase();
  const hay = caseSensitive ? raw : raw.toLowerCase();
  const at = hay.indexOf(q);
  if (raw.length <= 240) return raw.trim();
  const start = Math.max(0, at - 80);
  let out = raw.slice(start, start + 240);
  if (start > 0) out = '…' + out;
  if (start + 240 < raw.length) out += '…';
  return out.trim();
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function isNoiseRel(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return true;
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  return NOISE_FILES.test(parts[parts.length - 1]);
}

// git grep：一次进程拿到所有命中（path\0line\0text\n），主进程只做解析和截断。
// 返回 null = 这个目录不是 git 仓库 / git 不可用，交给读文件回退；返回结果对象 = 已完成。
function grepProject(root, query, caseSensitive, started) {
  return new Promise((resolve) => {
    try {
      const args = ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', root,
        'grep', '--untracked', '-n', '-I', '-F', '-z', '-m', String(LIMITS.maxPerFile)];
      if (!caseSensitive) args.push('-i');
      args.push('-e', query);
      execFile('git', args,
        { windowsHide: true, timeout: LIMITS.maxMs, maxBuffer: 64 << 20 },
        (err, stdout) => {
          const rawCode = err && err.code;
          const exitCode = typeof rawCode === 'number' ? rawCode : null;
          // execFile 的 maxBuffer 溢出会把部分 stdout 留在 out 里：能解析多少算多少，但要标 truncated。
          const bufferOverflow = !!(err && (rawCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(err.message || ''))));
          const out = String(stdout || '');
          // 退出码 1 = 没有命中（正常）；ENOENT / 128 / 其它启动失败且没有输出 ⇒ 回退读文件。
          if (err && !bufferOverflow && exitCode !== 1 && !out) return resolve(null);
          const files = [];
          const byRel = new Map();
          let total = 0;
          let truncated = !!(err && (err.killed || bufferOverflow || (exitCode != null && exitCode !== 1)));
          // 记录之间用换行分隔；文件名里的换行由 NUL 定位兜住（Windows 工程基本不会出现）
          const recs = out.split('\n');
          for (let i = 0; i < recs.length; i++) {
            const rec = recs[i];
            const a = rec.indexOf('\u0000');
            const b = rec.indexOf('\u0000', a + 1);
            if (a < 0 || b < 0) continue;
            const rel = rec.slice(0, a).replace(/\\/g, '/');
            if (!rel || rel.startsWith('../') || path.isAbsolute(rel) || isNoiseRel(rel)) continue;
            if (BINARY_EXT.test(rel)) continue;
            const lineNo = parseInt(rec.slice(a + 1, b), 10);
            if (!lineNo || lineNo < 1) continue;
            if (total >= LIMITS.maxMatches) { truncated = true; break; }
            const text = clipLine(rec.slice(b + 1).replace(/\r$/, ''), query, caseSensitive);
            const full = path.resolve(root, rel);
            if (full !== root && !full.startsWith(root + path.sep)) continue;
            let entry = byRel.get(rel);
            if (!entry) {
              entry = { path: full, rel: rel, name: path.basename(rel), matches: [] };
              byRel.set(rel, entry);
              files.push(entry);
            }
            if (entry.matches.length >= LIMITS.maxPerFile) continue;
            entry.matches.push({ line: lineNo, text: text });
            total++;
          }
          files.sort((x, y) => x.rel.localeCompare(y.rel, 'zh'));
          resolve({
            ok: true,
            engine: 'git',
            root: root,
            query: query,
            caseSensitive: caseSensitive,
            fromGit: true,
            files: files,
            filesMatched: files.length,
            matches: total,
            scanned: null,
            skippedLarge: 0,
            skippedBinary: 0,
            truncated: truncated,
            perFileLimit: LIMITS.maxPerFile,
            ms: Date.now() - started
          });
        });
    } catch (e) { resolve(null); }
  });
}

function listWithGit(root) {
  return new Promise((resolve) => {
    try {
      execFile('git',
        ['-c', 'core.quotepath=false', '--no-optional-locks', '-C', root,
          'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { windowsHide: true, timeout: 12000, maxBuffer: 32 << 20 },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve(String(stdout || '').split('\u0000').filter(Boolean));
        });
    } catch (e) { resolve(null); }
  });
}

async function walkList(root, started) {
  const out = [];
  let truncated = false;
  const queue = [{ dir: root, rel: '' }];
  while (queue.length) {
    if (Date.now() - started > LIMITS.maxMs) { truncated = true; break; }
    const cur = queue.shift();
    let ents = [];
    try { ents = await fs.promises.readdir(cur.dir, { withFileTypes: true }); } catch (e) { continue; }
    ents.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (let i = 0; i < ents.length; i++) {
      if (Date.now() - started > LIMITS.maxMs) { truncated = true; break; }
      const en = ents[i];
      if (en.isSymbolicLink()) continue;
      const rel = cur.rel ? cur.rel + '/' + en.name : en.name;
      if (en.isDirectory()) {
        // 回退遍历时只跳过明确的技术目录；普通点文件（.env 等）仍可被搜到
        if (en.name.startsWith('.') || SKIP_DIRS.has(en.name)) continue;
        queue.push({ dir: path.join(cur.dir, en.name), rel: rel });
      } else if (en.isFile()) {
        if (isNoiseRel(rel) || BINARY_EXT.test(en.name)) continue;
        out.push(rel);
      }
      if (out.length >= LIMITS.maxFiles * 2) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { list: out, truncated: truncated };
}

// 非 git 目录的回退：列出文件 → 并发读 → 按行找命中。
async function readProject(root, query, caseSensitive, started) {
  let rels = await listWithGit(root);
  let walkTruncated = false;
  if (!rels) {
    const walked = await walkList(root, started);
    rels = walked.list;
    walkTruncated = walked.truncated;
  }
  const candidates = rels
    .map((r) => String(r).replace(/\\/g, '/'))
    .filter((r) => r && !r.startsWith('../') && !path.isAbsolute(r) && !isNoiseRel(r))
    .filter((r) => !BINARY_EXT.test(r))
    .sort((a, b) => a.localeCompare(b, 'zh'));
  let truncated = walkTruncated || candidates.length > LIMITS.maxFiles;
  rels = candidates.slice(0, LIMITS.maxFiles);

  const cmpQuery = caseSensitive ? query : query.toLowerCase();
  let idx = 0;
  let scanned = 0;
  let matchedFiles = 0;
  let totalMatches = 0;
  let totalBytes = 0;
  let skippedLarge = 0;
  let skippedBinary = 0;
  const files = [];

  async function worker() {
    while (true) {
      if (Date.now() - started > LIMITS.maxMs) { truncated = true; return; }
      if (totalMatches >= LIMITS.maxMatches) { truncated = true; return; }
      const at = idx++;
      if (at >= rels.length) return;
      const rel = rels[at];
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) continue;
      let fst = null;
      try { fst = await fs.promises.lstat(full); } catch (e) { continue; }
      if (!fst.isFile() || fst.isSymbolicLink()) continue;
      if (fst.size > LIMITS.maxFileBytes) { skippedLarge++; continue; }
      if (totalBytes + fst.size > LIMITS.maxTotalBytes) { truncated = true; return; }

      let buf = null;
      try { buf = await fs.promises.readFile(full); } catch (e) { continue; }
      totalBytes += buf.length;
      scanned++;
      if (looksBinary(buf)) { skippedBinary++; continue; }

      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      const hits = [];
      for (let i = 0; i < lines.length && hits.length < LIMITS.maxPerFile; i++) {
        const line = lines[i];
        const hay = caseSensitive ? line : line.toLowerCase();
        if (hay.indexOf(cmpQuery) < 0) continue;
        hits.push({ line: i + 1, text: clipLine(line, cmpQuery, caseSensitive) });
      }
      if (!hits.length) continue;
      files.push({ path: full, rel: rel.replace(/\\/g, '/'), name: path.basename(rel), matches: hits });
      matchedFiles++;
      totalMatches += hits.length;
    }
  }

  await Promise.all(Array.from({ length: LIMITS.concurrency }, () => worker()));
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));

  return {
    ok: true,
    engine: 'read',
    root: root,
    query: query,
    caseSensitive: caseSensitive,
    fromGit: false,
    files: files,
    filesMatched: matchedFiles,
    matches: totalMatches,
    scanned: scanned,
    skippedLarge: skippedLarge,
    skippedBinary: skippedBinary,
    truncated: truncated,
    perFileLimit: LIMITS.maxPerFile,
    ms: Date.now() - started
  };
}

/**
 * 在指定目录内搜索关键字。
 * @param {string} root 搜索根目录（绝对路径；当前项目根或用户手选目录）
 * @param {string} query 关键字（普通文本，不是正则）
 * @param {{caseSensitive?: boolean}} opts
 */
async function searchProject(root, query, opts) {
  const started = Date.now();
  const q = String(query == null ? '' : query);
  if (!q.trim()) return { ok: false, err: '请输入要搜索的关键字' };
  const caseSensitive = !!(opts && opts.caseSensitive);
  const resolved = path.resolve(String(root || ''));
  let st = null;
  try { st = await fs.promises.stat(resolved); } catch (e) { st = null; }
  if (!st || !st.isDirectory()) return { ok: false, err: '项目目录不存在：' + resolved };

  // 1) git 仓库优先：一次 git grep 完成，快且自动排除 .gitignore
  const grep = await grepProject(resolved, q, caseSensitive, started);
  if (grep) return grep;
  // 2) 非 git 目录 / git 不可用：回退并发读
  return readProject(resolved, q, caseSensitive, started);
}

module.exports = { searchProject, LIMITS };
