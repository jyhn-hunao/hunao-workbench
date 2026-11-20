// @功能台 {"name":"内置规范检查","group":"guard","freq":"weekly","plain":"核 引擎数据\\.dsh\\standards\\ 里的规范是否齐全、入口有没有外部依赖；缺文件退出码 1。","why":"规范随仓走，换机器 / 升级后没人记得核；缺一份文档不会自己报错。","label":"核一遍"}
// 检查内置规范：工作台必须自带规范，不能引用桌面端 standards
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const standards = path.join(root, '12-源码照搬', '引擎数据', '.dsh', 'standards');

// 1. 内置规范必须齐全
const required = [
  'specs/个人编码与AI协作规范.md',
  'specs/附录-界面与交互设计.md',
  'specs/附录-提交准则.md',
  'specs/附录-文档记忆体系.md',
  'specs/附录-后端-Java-SpringBoot.md',
  'specs/附录-前端-Vue3.md',
  'specs/附录-数据-SQL与数据库.md',
  'specs/附录-算法-Python-FastAPI.md',
  'specs/个人偏好.md',
  'specs/用户画像.md',
  'rules/iron-rules.txt',
];
const missing = required.filter((rel) => !fs.existsSync(path.join(standards, rel)));
if (missing.length) {
  console.error('FAIL 内置规范缺文件：');
  for (const rel of missing) console.error('  - ' + rel);
  process.exit(1);
}

// 2. 活跃入口不得再指向桌面端 standards
const entries = [
  'AGENTS.md',
  'doc/界面与交互规范.md',
  'doc/提交准则.md',
  'doc/迁移报告.md',
  '08-升级与改造清单/外观皮肤与设计令牌.md',
  '12-源码照搬/外壳/scenarios/code-dev-context.md',
  '12-源码照搬/引擎数据/.dsh/AGENTS.md',
];
const external = /(?:~\/|[A-Za-z]:\\Users\\)[^\s`"']*\.dsh[\\/]standards/i;
const bad = [];
for (const rel of entries) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    bad.push(rel + '：文件不存在');
    continue;
  }
  if (external.test(fs.readFileSync(abs, 'utf8'))) bad.push(rel + '：仍引用桌面端 standards 路径');
}
if (bad.length) {
  console.error('FAIL 入口仍有外部规范依赖：');
  for (const item of bad) console.error('  - ' + item);
  process.exit(1);
}

console.log(`PASS 内置规范 ${required.length} 个文件齐全；${entries.length} 个入口文件无桌面端 standards 引用`);
