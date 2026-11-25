'use strict';
// 声音.js —— 全局唯一声音层（2026-11-25）
//
// 干什么：把「她的声音」收成一份。所有通道（QQ / 微信 / 飞书 / 以后任何新通道）要说话，
//   都从这层拿 BreezeBlue 合成，不再各自写一套 TTS。
//   配置真源：外壳\data\QQ能力.json 的 breeze* 字段（QQ / 微信 / 未来通道共用这一份，不迁移 Key）。
//   SAPI 只是本机兜底，不参与「声音是什么」——声音只有一个：BreezeBlue 的固定音色。
//
// 为什么独立出来：
//   · 原来 Breeze 合成写在 QQ能力.js 里，飞书 / 未来通道要说话就得去 require「QQ 能力」，语义错位；
//   · 微信原生语音早已复用同一份 Breeze 配置（syncBreeze ← breezeConfig），这里把它坐实成唯一入口。
//
// 边界：这层只做「合成成 WAV」这一件事；怎么发（QQ 转 SILK、微信走鲸鲸、飞书以后接 record）归各通道。
//   dsh-pet 的桌面身体 TTS 不在这里（桌面身体按 2026-11-25 决策暂不维护，dsh-pet 已卸载）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const SHELL = __dirname;
const DATA_DIR = process.env.DSH_SHELL_DATA || path.join(SHELL, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'QQ能力.json');
const VOICE_DIR = path.join(DATA_DIR, '声音');

const DEFAULTS = {
  baseUrl: 'https://api.breeze.blue',
  apiKey: '',
  voiceId: '',
  voiceName: '',
  model: 'breeze-tts-2',
  language: 'zh',
  instructions: '用饭团的语气，自然、亲近、稍微俏皮，句尾轻快。',
  fallback: true
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// 1. 读全局声音配置：只取 breeze* 字段，回落到默认。任何通道都从这一个函数拿。
function readVoiceConfig(file) {
  const raw = readJson(file || CONFIG_FILE) || {};
  return {
    baseUrl: String(raw.breezeBaseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '').slice(0, 200),
    apiKey: String(raw.breezeApiKey || '').trim().slice(0, 300),
    voiceId: String(raw.breezeVoiceId || '').trim().slice(0, 80),
    voiceName: String(raw.breezeVoiceName || '').trim().slice(0, 80),
    model: String(raw.breezeModel || DEFAULTS.model).trim().slice(0, 80),
    language: String(raw.breezeLanguage || DEFAULTS.language).trim().slice(0, 16),
    instructions: String(raw.breezeInstructions || DEFAULTS.instructions).trim().slice(0, 300),
    fallback: raw.breezeFallback !== false
  };
}

function maskKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return key.length <= 4 ? '••••' : '••••' + key.slice(-4);
}

// 2. 只发一个 JSON、收一段二进制音频；不引入 SDK，避免把 Key 交给第三方包。
function postJsonBinary(url, key, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let target;
    try { target = new URL(url); } catch (e) { reject(new Error('Breeze 地址无效')); return; }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'content-type': 'application/json',
        'content-length': payload.length
      }
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ status: Number(res.statusCode) || 0, body: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('Breeze 合成超时')); });
    req.on('error', reject);
    req.end(payload);
  });
}

function breezeErrorText(status, buf) {
  let detail = '';
  try {
    const j = JSON.parse(buf.toString('utf8'));
    detail = [j.code, j.detail].filter(Boolean).join(' · ');
  } catch (e) {
    detail = buf.toString('utf8').slice(0, 180);
  }
  return 'Breeze ' + status + (detail ? '：' + detail : '');
}

// 3. 合成：BreezeBlue → wav_24000 WAV 文件（24 kHz / 16-bit / 单声道）。
//    outFile 不传就落到 data\声音\voice-<随机>.wav；返回 { ok, file, bytes, ms }。
async function synthesizeToWav(text, cfg, outFile) {
  const c = cfg && typeof cfg === 'object' && cfg.apiKey ? cfg : readVoiceConfig();
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) throw new Error('语音正文为空');
  if (!c.apiKey) throw new Error('Breeze API Key 未配置');
  if (!c.voiceId) throw new Error('Breeze 音色 ID 未配置');

  const started = Date.now();
  const payload = { text: body, language_code: c.language, model_id: c.model };
  if (c.instructions) payload.instructions = c.instructions;
  const url = c.baseUrl + '/v1/text-to-speech/' + encodeURIComponent(c.voiceId) + '?output_format=wav_24000';

  let file = outFile || path.join(VOICE_DIR, 'voice-' + crypto.randomBytes(5).toString('hex') + '.wav');
  if (!outFile) {
    try { fs.mkdirSync(VOICE_DIR, { recursive: true }); } catch (e) { /* 调用方目录 */ }
  } else {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* 已存在 */ }
  }

  const r = await postJsonBinary(url, c.apiKey, payload, 45000);
  if (r.status !== 200) throw new Error(breezeErrorText(r.status, r.body));
  if (r.body.length < 100) throw new Error('Breeze 返回空音频');
  if (r.body.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('Breeze 返回的不是 WAV');
  fs.writeFileSync(file, r.body);
  return { ok: true, file: file, bytes: r.body.length, ms: Date.now() - started };
}

module.exports = {
  CONFIG_FILE: CONFIG_FILE,
  DEFAULTS: DEFAULTS,
  readVoiceConfig: readVoiceConfig,
  maskKey: maskKey,
  synthesizeToWav: synthesizeToWav
};
