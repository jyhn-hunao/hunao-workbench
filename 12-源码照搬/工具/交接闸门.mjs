// 交接闸门.mjs —— 「交接算不算写好了」的唯一判定实现（2026-11-20）
//
// 为什么单独成模块：
//   同一件事原来在「换会话.mjs」和「sessions.mjs」各写一份，口径还只盯
//   `场景私有记忆.md` 的 mtime。2026-11-12 交接落点改成「面板交接\<面板id>.md」后，
//   非人格场景的 §〇 刻意不再重写 ⇒ 两份闸门同时失效，按钮每天假失败一次
//   （2026-11-20 实测：面板交接 17:54 刚写、§〇 停在前一天，退出码 3）。
//   更根本的是：生产方（交接并换会话.mjs）与消费方（两道闸门）之间没有契约，
//   也没有测试盯着，所以每加一道闸门就多一次「用户点到才发现」的假失败。
// 现在：
//   ① 判定只有这一份（换会话.mjs / sessions.mjs 都 import 这里）；
//   ② 生产方写完交接带 `--handoff-fresh` 收据，消费方凭收据放行，不再拿墙钟猜；
//   ③ `外壳\scripts\测试.mjs` 有边界用例 + 生产/消费契约扫描，改坏会在提交前报 ✗。
//
// 口径：
//   · 文件存在且非空是硬前提（§〇 或 本面板交接，任一即可）
//   · 收据（本次流程刚写）⇒ 直接算写好
//   · 没有收据 ⇒ 取较新的一份，2 小时内改过才算写好（手工 CLI 仍守「交接没写完不许换」）
import fs from 'node:fs';
import path from 'node:path';

export const FRESH_MS = 2 * 60 * 60 * 1000;
export const RECEIPT_FLAG = '--handoff-fresh';

/**
 * 可能承载交接的文件：
 *   ① §〇：`场景记忆\<场景>\场景私有记忆.md`（非标路径由调用方的 --handoff 给）
 *   ② 本面板交接：`场景记忆\<场景>\面板交接\<面板id>.md`（2026-11-12 起的完整摘要落点）
 */
export function handoffCandidates(handoff, opts) {
  const o = opts || {};
  const cands = [];
  if (handoff) cands.push(String(handoff));
  const sceneDir = (String(handoff || '').match(/场景记忆[\\/]([^\\/]+)[\\/]场景私有记忆\.md$/) || [])[1] || '';
  const sceneName = String(o.sceneName || sceneDir || '');
  const panelId = String(o.panelId || '');
  const dshHome = String(o.dshHome || '');
  if (dshHome && sceneName && panelId) {
    cands.push(path.join(dshHome, '场景记忆', sceneName, '面板交接', panelId + '.md'));
  }
  return cands.filter(Boolean);
}

/**
 * 判定交接是否写好。
 * @param {string} handoff  §〇 路径（调用方算出的 --handoff）
 * @param {object} opts     { dshHome, sceneName, panelId, receipt, now }
 * @returns {{ok:boolean, exists:boolean, fresh:boolean, file:string, ms:number, why:string}}
 *   `ok` 只表示「按交接口径算写好」；`--force` 是否放行由调用方决定。
 */
export function evaluateHandoff(handoff, opts) {
  const o = opts || {};
  let best = { file: '', ms: 0 };
  for (const f of handoffCandidates(handoff, o)) {
    let ms = 0, size = 0;
    try {
      const s = fs.statSync(f);
      if (s.isFile()) { ms = s.mtimeMs; size = s.size; }
    } catch (e) { /* 不存在当 0 */ }
    // 空文件不算写好：写失败留下 0 字节时，不能让它骗过闸门
    if (size > 0 && ms > best.ms) best = { file: f, ms: ms };
  }
  if (!best.ms) {
    return { ok: false, exists: false, fresh: false, file: '', ms: 0, why: '交接文件不存在或为空（§〇 与面板交接都没有内容）' };
  }
  if (o.receipt) {
    return { ok: true, exists: true, fresh: true, file: best.file, ms: best.ms, why: '本次流程刚写（收据）' };
  }
  const now = Number(o.now) || Date.now();
  if (now - best.ms <= FRESH_MS) {
    return { ok: true, exists: true, fresh: true, file: best.file, ms: best.ms, why: '2 小时内更新过' };
  }
  return { ok: false, exists: true, fresh: false, file: best.file, ms: best.ms, why: '超过 2 小时没更新' };
}
