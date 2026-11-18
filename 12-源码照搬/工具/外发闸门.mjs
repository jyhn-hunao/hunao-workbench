#!/usr/bin/env node
// 外发闸门.mjs —— 外发闸门的命令行壳（判定本体在 外壳\外发闸门.js，判据只有那一份）
//
// 用法：
//   node 12-源码照搬\工具\外发闸门.mjs --自检
//       跑 25 条行为用例（内网/公网 IP、路径、密钥、手机号、身份证、全角、零宽拆字、正常聊天）
//       + 4 条代理用例（拦截 / 放行 / 打码 / 附件）；有漏 ⇒ 退出码 1。
//   node 12-源码照搬\工具\外发闸门.mjs --文本 "要发出去的话" --渠道 qq
//       用当前配置和本机资产审一条，打印 verdict / 命中规则 / 打码后的正文。
//   node 12-源码照搬\工具\外发闸门.mjs --资产
//       重新采集本机资产指纹（网卡 IP、主机名、用户名、路径、通道 token）。
//   node 12-源码照搬\工具\外发闸门.mjs --状态 [--json]
//       看配置、资产数量、最近状态文件（不启动代理）。
//
// ⛔ 这个脚本不直接发任何消息；只做「判」与「自检」。
import gate from '../外壳/外发闸门.js';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = has('--json');
const CHANNEL = String(val('--渠道', 'qq')).toLowerCase();

function out(s) { console.log(s); }

if (has('--自检') || argv.length === 0) {
  const rule = gate.selfTest();
  out('规则自检：' + (rule.ok ? '✓' : '✗') + ' ' + (rule.total - rule.failed) + '/' + rule.total + ' 通过');
  if (!JSON_OUT) {
    for (const r of rule.results) {
      if (r.ok) continue;
      out('  ✗ ' + r.name + '：期望 ' + r.want + '，实际 ' + r.got + (r.rules && r.rules.length ? '（' + r.rules.join(' / ') + '）' : ''));
    }
  }
  const proxied = await gate.proxySelfTest();
  out('代理自检：' + (proxied.ok ? '✓' : '✗') + ' ' + (proxied.total - proxied.failed) + '/' + proxied.total + ' 通过');
  if (!JSON_OUT) {
    for (const r of proxied.results) {
      if (r.ok) continue;
      out('  ✗ ' + r.name + '：' + JSON.stringify(r.detail).slice(0, 200));
    }
  }
  if (JSON_OUT) out(JSON.stringify({ rule, proxy: proxied }, null, 2));
  process.exit(rule.ok && proxied.ok ? 0 : 1);
}

if (has('--资产')) {
  const a = gate.buildAssets();
  const kinds = {};
  a.items.forEach((x) => { kinds[x.kind] = (kinds[x.kind] || 0) + 1; });
  out('✓ 已采集 ' + a.items.length + ' 项本机资产：' + Object.keys(kinds).map((k) => k + ' ' + kinds[k]).join(' · '));
  process.exit(0);
}

if (has('--文本')) {
  const text = String(val('--文本', ''));
  const cfg = gate.readConfig();
  const assets = gate.loadAssets(false).items || [];
  const r = gate.checkText(text, { channel: CHANNEL }, { config: cfg, assets });
  if (JSON_OUT) {
    out(JSON.stringify(r, null, 2));
  } else {
    out('判定：' + r.verdict + (r.shadow ? '（shadow 只记录，would=' + r.would + '）' : ''));
    out('规则：' + ((r.rules && r.rules.length) ? r.rules.join(' / ') : '无'));
    if (r.verdict === 'redact') out('打码后：' + r.text);
  }
  process.exit(0);
}

if (has('--状态')) {
  const info = gate.inspect();
  if (JSON_OUT) out(JSON.stringify(info, null, 2));
  else {
    out('配置：' + info.paths.config);
    out('开关：' + (info.config.enabled ? '开' : '关') + ' · 模式 ' + info.config.mode
      + ' · 渠道 微信/' + (info.config.channels.wechat ? '开' : '关')
      + ' QQ/' + (info.config.channels.qq ? '开' : '关')
      + ' 飞书/' + (info.config.channels.feishu ? '开' : '关'));
    out('资产：' + info.assets.count + ' 项（' + Object.keys(info.assets.kinds).map((k) => k + ' ' + info.assets.kinds[k]).join(' · ') + '）');
    if (info.status) {
      out('状态：代理' + (info.status.listening ? '在听 ' + info.status.port : '未起')
        + ' · 上游' + (info.status.upstreamOk ? '通' : '不通')
        + ' · QQ ' + (info.status.qq && info.status.qq.applied ? '已过闸门' : '直连')
        + ' · 今日 检查 ' + info.status.today.checked + ' / 拦 ' + info.status.today.blocked + ' / 打码 ' + info.status.today.redacted);
    } else {
      out('状态：还没有状态文件（工作台没重启过这个版本，或还没发过消息）');
    }
  }
  process.exit(0);
}

out('用法：node 工具\\外发闸门.mjs --自检 | --文本 "…" --渠道 qq | --资产 | --状态 [--json]');
process.exit(2);
