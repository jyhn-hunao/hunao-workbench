// 首启数据.js —— 安装版的数据落地（2026-11-21）
//
// 为什么需要它：源码版把会话 / 记忆放在 `12-源码照搬\引擎数据\.dsh`，而安装版没有这个目录，
//   主进程会退回 `引擎\.dsh` —— **引擎升级是整目录替换**（`引擎引导.js` 先改名 .bak 再换新），
//   数据跟着引擎走就会在第一次升级时全丢。
// 做法：安装版把数据放到安装目录之外（默认 `%LOCALAPPDATA%\胡闹的工作台`），
//   首次启动只做三件事：建目录 / 不覆盖地写一份 `机器配置.json` / 把随包的 skills 与 standards 种进去。
// ⛔ 绝不覆盖已有的 机器配置.json、绝不把用户会话与记忆搬走（只在目标不存在时补种子）。
const fs = require('fs');
const path = require('path');

function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

/** 递归复制，目标已存在就跳过（种子只补缺，不覆盖用户后来改的）。 */
function copySeed(src, dest, stat) {
  stat = stat || { files: 0, skipped: 0 };
  if (!exists(src)) return stat;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copySeed(path.join(src, name), path.join(dest, name), stat);
    return stat;
  }
  if (exists(dest)) { stat.skipped += 1; return stat; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    stat.files += 1;
  } catch (e) { stat.skipped += 1; }
  return stat;
}

function readEngineVersion(engineDir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(engineDir, 'package.json'), 'utf8')).version || ''); }
  catch (e) { return ''; }
}

/**
 * 安装版首启准备：目录 + 机器配置 + 种子。
 * @param {object} o
 * @param {string} o.dataHome    安装目录之外的数据根（%LOCALAPPDATA%\胡闹的工作台）
 * @param {string} o.shellDir    外壳目录（安装后 = resources\app）
 * @param {string} o.engineDir   引擎目录（安装后 = resources\引擎）
 * @param {string} [o.seedDir]   随包种子目录（resources\种子数据\.dsh）
 * @returns {{dshHome:string,machineFile:string,copied:object,machineCreated:boolean}}
 */
function prepare(o) {
  const dataHome = o.dataHome;
  const dshHome = path.join(dataHome, 'engine-data', '.dsh');
  const machineFile = path.join(dshHome, '机器配置.json');
  for (const d of [dataHome, path.join(dataHome, 'data'), path.dirname(dshHome), dshHome,
    path.join(dshHome, 'storages'), path.join(dshHome, '场景记忆', '_共享记忆'),
    path.join(dshHome, 'profiles'), path.join(dshHome, 'logs')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 权限问题交给引擎报 */ }
  }

  // 种子只补缺：skills / standards / AGENTS.md / profiles（记忆与会话绝不随包）
  const copied = { files: 0, skipped: 0 };
  if (o.seedDir) {
    for (const name of ['skills', 'standards', 'AGENTS.md', 'profiles']) {
      copySeed(path.join(o.seedDir, name), path.join(dshHome, name), copied);
    }
  }

  let machineCreated = false;
  if (!exists(machineFile)) {
    const cfg = {
      version: 2,
      workbenchRoot: path.dirname(o.shellDir),   // 安装后 = resources（引擎与种子都在这一级）
      repoRoot: '',
      codeRoot: '',
      // ⛔ 不写 ports：端口默认值只留 main.js 与 工具\环境.mjs 两处真源，缺省即默认
      nodeExe: '',                                // 空 = 用 Electron 自带的 Node 24（安装版已够版本）
      engineVersion: readEngineVersion(o.engineDir),
      projects: {},
    };
    try { fs.writeFileSync(machineFile, JSON.stringify(cfg, null, 2) + '\r\n', 'utf8'); machineCreated = true; }
    catch (e) { /* 写不了就让下游按默认值跑，不静默改走别的目录 */ }
  }
  return { dshHome: dshHome, machineFile: machineFile, copied: copied, machineCreated: machineCreated };
}

module.exports = { prepare: prepare };
