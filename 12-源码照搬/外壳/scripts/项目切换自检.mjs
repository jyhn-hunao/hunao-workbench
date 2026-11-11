// 项目切换自检 —— 验证「程序开发 · 项目下拉」的后端（外壳\项目切换.js）
//
// 为什么要它：这个功能会改场景 json、Git 仓库指向、定位卡与场景索引四处；
// 手点一次只能证明一条路径，切回/缺会话/非 git 仓这些分支必须自动跑。
//
// 用法：node 12-源码照搬\外壳\scripts\项目切换自检.mjs
// 特点：全部在系统临时目录里做（复制真实的 code-dev.json / 定位卡 / 索引作底稿），
//       不碰正在跑的工作台，也不改真实场景。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PS = require('../项目切换.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));       // 外壳\scripts
const SHELL = path.resolve(HERE, '..');                          // 外壳
const REAL_SCEN = path.join(SHELL, 'scenarios');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
};

// ---------- 临时工作区 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-project-switch-'));
const scenDir = path.join(tmp, 'scenarios');
const dshHome = path.join(tmp, 'dsh');
const projects = path.join(tmp, 'projects', 'myself');
for (const d of [scenDir, path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
  path.join(dshHome, '场景记忆', '_共享记忆'), path.join(projects, 'alpha', '.git'),
  path.join(projects, 'beta', '.git'), path.join(projects, 'gamma'), path.join(projects, 'delta'),
  path.join(projects, 'epsilon'), path.join(projects, 'scratch')]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(path.join(projects, 'delta', 'package.json'), '{}\n', 'utf8');   // 有工程标志、但没登记也没会话

const write = (p, s) => { fs.writeFileSync(p, s, 'utf8'); };
const read = (p) => fs.readFileSync(p, 'utf8');

// 场景 json：拿真实的 code-dev.json 当底稿，只把面板指向夹具里的 alpha
const scen = JSON.parse(read(path.join(REAL_SCEN, 'code-dev.json')));
const panel = scen.panels.find((p) => p.type === 'harness');
panel.sessionId = 'session-A';
panel.sessionTitle = 'alpha';
panel.pinTarget = ['alpha', '程序开发'];
const gitPanel = scen.panels.find((p) => p.type === 'git');
gitPanel.repo = path.join(projects, 'alpha');
write(path.join(scenDir, 'code-dev.json'), JSON.stringify(scen, null, 2) + '\n');

// 定位卡与索引：用真实文件（能顺带验证正则对真实排版有效）
fs.copyFileSync(path.join(REAL_SCEN, 'code-dev-context.md'), path.join(scenDir, 'code-dev-context.md'));
fs.copyFileSync(path.join(REAL_SCEN, '_场景身份索引.md'), path.join(scenDir, '_场景身份索引.md'));

// 会话夹具：alpha 有两条（一条旧标题）、beta 一条、beta 另有一条已归档
const sessDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
const mkSession = (id, cwd, title, createdAt) => write(path.join(sessDir, id + '.json'), JSON.stringify({
  version: 1,
  record: {
    identity: { formatVersion: 4, createdAt: createdAt, cwd: cwd },
    rows: { title: { ver: 1, seq: 1, val: title } }
  }
}));
mkSession('session-A', path.join(projects, 'alpha'), 'alpha', 1000);
mkSession('session-OLD', path.join(projects, 'alpha'), 'alpha-old', 2000);
mkSession('session-B', path.join(projects, 'beta'), 'beta', 3000);
mkSession('session-ARCH', path.join(projects, 'beta'), 'beta', 4000);
mkSession('session-E', path.join(projects, 'epsilon'), '', 5000);   // 无标题会话（引擎里叫「无标题」）
mkSession('session-S', path.join(projects, 'scratch'), 'scratch', 6000);   // 只存在于"工作区"、不是项目

write(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
  global: { archivedSessionIds: ['session-ARCH'] },
  tables: {
    workspaces: {
      'ws-alpha': { path: path.join(projects, 'alpha'), title: 'alpha', sessionIds: ['session-A', 'session-OLD'] },
      'ws-beta': { path: path.join(projects, 'beta'), title: 'beta', sessionIds: ['session-B', 'session-ARCH'] },
      // 一个"不是项目"的工作区（没有工程标志、也没登记）：以前会进下拉，等于把别人的会话钉上来
      'ws-scratch': { path: path.join(projects, 'scratch'), title: 'scratch', sessionIds: ['session-S'] }
    }
  }
}, null, 2));

write(path.join(dshHome, '场景记忆', '_共享记忆', '项目.json'), JSON.stringify({
  projects: [
    { name: 'alpha', paths: [path.join(projects, 'alpha')], owner: '程序开发', status: 'active' },
    { name: 'beta', paths: [path.join(projects, 'beta')], owner: '程序开发', status: 'active' },
    { name: 'gamma', paths: [path.join(projects, 'gamma')], owner: '程序开发', status: 'active' },
    { name: 'epsilon', paths: [path.join(projects, 'epsilon')], owner: '程序开发', status: 'active' },
    { name: '别场景的项目', paths: [path.join(projects, 'beta')], owner: 'B站', status: 'active' }
  ]
}, null, 2));

const fsx = {
  readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
  writeText: (p, t) => { fs.writeFileSync(p, t, 'utf8'); },
  exists: (p) => { try { return fs.existsSync(p); } catch (e) { return false; } },
  readDir: (p) => { try { return fs.readdirSync(p); } catch (e) { return []; } },
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
};
const svc = PS.createService({ scenariosDir: scenDir, dshHome: dshHome, fsx });

// ---------- 1) 对象定位 / 定点改写 ----------
console.log('\n[1] 场景 json 定点改写');
const realText = read(path.join(REAL_SCEN, 'code-dev.json'));
const range = PS.findObjectRangeById(realText, 'cd-ai');
ok(!!range, '能在真实 code-dev.json 里定位到 cd-ai 对象');
ok(range && realText.slice(range.start, range.end + 1).indexOf('"cd-ai"') > 0, '定位范围确实包含 "cd-ai"');

const multi = JSON.stringify({
  panels: [
    { id: 'p1', type: 'harness', sessionId: 's1', sessionTitle: 't1', pinTarget: ['t1'] },
    { id: 'p2', type: 'harness', sessionId: 's2', sessionTitle: 't2', pinTarget: ['t2'] },
    { id: 'g1', type: 'git', repo: 'D:\\old\\repo' }
  ]
}, null, 2) + '\n';
const pm = PS.patchScenario(multi, {
  panelId: 'p2', sessionId: 's9', sessionTitle: 't9', sceneName: 'scene-x',
  gitRoot: 'D:\\new\\repo', isGit: () => true
});
ok(pm.ok, '多 harness 面板场景可改写', pm.err);
const pmj = JSON.parse(pm.text);
ok(pmj.panels[0].sessionId === 's1' && pmj.panels[1].sessionId === 's9', '只改目标面板（p1 不动）');
ok(pmj.panels[2].repo === 'D:\\new\\repo', 'Git 面板跟着换仓库');
ok(pm.text.indexOf('"pinTarget": ["t9", "scene-x"]') > 0, 'pinTarget 仍保持行内写法（没有整文件重排）');

const noGit = PS.patchScenario(multi, {
  panelId: 'p1', sessionId: 's1', sessionTitle: 't1', sceneName: 'scene-x',
  gitRoot: 'D:\\nongit', isGit: () => false
});
ok(noGit.ok && JSON.parse(noGit.text).panels[2].repo === 'D:\\old\\repo', '非 git 项目不动 Git 面板');
ok(noGit.warnings.some((w) => w.indexOf('不是 git 仓库') >= 0), '并给出 warnings（不静默）');

const noKey = PS.patchScenario(JSON.stringify({ panels: [{ id: 'x', type: 'harness', sessionId: 's' }] }, null, 2), {
  panelId: 'x', sessionId: 'n', sessionTitle: 'n', projectName: 'n', gitRoot: 'D:\\x', isGit: () => true
});
ok(!noKey.ok && /没有 "sessionTitle"/.test(noKey.err), '缺字段时拒绝写入（不写半个配置）');

// ---------- 2) 文档同步 ----------
console.log('\n[2] 定位卡 / 场景索引同步');
const card0 = read(path.join(scenDir, 'code-dev-context.md'));
const card1 = PS.patchContextCard(card0, { name: 'beta', sessionId: 'session-B' });
ok(card1.changed, '定位卡：两行都命中并改写');
ok(/当前项目（pinTarget 首项）\s*\|\s*`beta`/.test(card1.text), '定位卡：当前项目 → beta');
ok(/会话 id\s*\|\s*`session-B`/.test(card1.text), '定位卡：会话 id → session-B');
ok(card1.text.indexOf('（换项目时会变，换完回写）') > 0, '定位卡：行尾说明没被吃掉');

const idx0 = read(path.join(scenDir, '_场景身份索引.md'));
const idx1 = PS.patchIdentityIndex(idx0, { sceneId: 'code-dev', name: 'beta', sessionId: 'session-B' });
ok(idx1.changed && /\| `code-dev` \| `cd-ai` \| AI·程序开发 \| beta \| `session-B` \|/.test(idx1.text), '索引表：code-dev 行的会话名/id 已换');
ok(idx1.text.indexOf('| `command` |') > 0, '索引表：其它场景行原样保留');

// ---------- 3) 项目列表 ----------
console.log('\n[3] 项目列表');
const list1 = svc.list('code-dev', 'cd-ai');
ok(list1.ok, 'list 返回 ok', list1.err);
const names = (list1.projects || []).map((p) => p.name);
ok(names.indexOf('gamma') >= 0, 'gamma（已登记、无会话）也在列表里');
ok(names.indexOf('别场景的项目') < 0, '别的场景（owner=B站）的项目不进本场景');
const alpha = list1.projects.find((p) => p.name === 'alpha');
const beta = list1.projects.find((p) => p.name === 'beta');
const gamma = list1.projects.find((p) => p.name === 'gamma');
ok(alpha && alpha.sessionId === 'session-A' && alpha.current, 'alpha 选中 session-A 且标为当前');
ok(alpha && alpha.sessionTitle === 'alpha', 'alpha 不会被同名旧标题（alpha-old）抢走');
ok(beta && beta.sessionId === 'session-B', 'beta 选中 session-B（已归档的同名会话被排除）');
ok(gamma && gamma.hasSession === false, 'gamma 标记为无会话');
const delta = list1.projects.find((p) => p.name === 'delta');
ok(delta && delta.discovered === true && delta.hasSession === false, 'delta（同级目录 + package.json）被扫出来，标记未接入');
const epsilon = list1.projects.find((p) => p.name === 'epsilon');
ok(epsilon && epsilon.hasSession === false, '只有「无标题」会话的项目不算可切（pinTarget 只能靠标题认人）');
ok(!list1.projects.find((p) => p.name === 'scratch'), '只有工作区、没有工程标志的目录不进下拉（免得钉到别人的会话上）');

// ---------- 4) 切换（含切回） ----------
console.log('\n[4] 切换项目');
const sw1 = svc.switchTo('code-dev', 'cd-ai', path.join(projects, 'beta'));
ok(sw1.ok, '切到 beta 成功', sw1.err);
const scenAfter = JSON.parse(read(path.join(scenDir, 'code-dev.json')));
const afterPanel = scenAfter.panels.find((p) => p.id === 'cd-ai');
ok(afterPanel.sessionId === 'session-B' && afterPanel.sessionTitle === 'beta', '场景 json：面板三字段 → beta / session-B');
ok(scenAfter.panels.find((p) => p.type === 'git').repo === path.join(projects, 'beta'), '场景 json：Git 仓库 → beta');
const scenText = read(path.join(scenDir, 'code-dev.json'));
ok(scenText.indexOf('"pinTarget": ["beta", "程序开发"]') > 0, 'pinTarget 首项 = 会话名（行内写法保留）');
ok(read(path.join(scenDir, 'code-dev-context.md')).indexOf('`session-B`') > 0, '定位卡已回写');
ok(read(path.join(scenDir, '_场景身份索引.md')).indexOf('| beta | `session-B` |') > 0, '索引表已回写');
const idxText = read(path.join(scenDir, '_场景身份索引.md'));
ok((idxText.match(/\r\n/g) || []).length === (idxText.match(/\n/g) || []).length, '索引表行尾保持 CRLF（没有整篇变 LF）');

const sw2 = svc.switchTo('code-dev', 'cd-ai', path.join(projects, 'alpha'));
ok(sw2.ok, '切回 alpha 成功', sw2.err);
ok(JSON.parse(read(path.join(scenDir, 'code-dev.json'))).panels.find((p) => p.id === 'cd-ai').sessionId === 'session-A',
  '切回后仍用原来那条会话（没有新建/重复）');
ok(JSON.parse(read(path.join(scenDir, 'code-dev.json'))).panels.find((p) => p.type === 'git').repo === path.join(projects, 'alpha'),
  '切回后 Git 仓库也回到 alpha');

const sw3 = svc.switchTo('code-dev', 'cd-ai', path.join(projects, 'gamma'));
ok(!sw3.ok && sw3.needOnboard, 'gamma 无会话 → 拒绝切换并提示先接入', sw3.err);
ok(JSON.parse(read(path.join(scenDir, 'code-dev.json'))).panels.find((p) => p.id === 'cd-ai').sessionId === 'session-A',
  '拒绝后场景 json 保持原样');

const sw4 = svc.switchTo('code-dev', 'cd-ai', path.join(projects, '不存在'));
ok(!sw4.ok && /没有这个目录/.test(sw4.err), '不存在的目录 → 明确报错');

const sw5 = svc.switchTo('code-dev', 'cd-ai', path.join(projects, 'delta'));
ok(!sw5.ok && sw5.needOnboard, 'delta 未接入 → needOnboard（交给主进程自动跑接入脚本）');

const sw6 = svc.switchTo('code-dev', 'cd-ai', path.join(projects, 'epsilon'));
ok(!sw6.ok && sw6.needOnboard, 'epsilon 只有无标题会话 → 拒绝并提示先接入');

// ---------- 输出 ----------
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
console.log('（临时目录：' + tmp + '）');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 删不掉不影响结论 */ }
process.exit(fail ? 1 : 0);
