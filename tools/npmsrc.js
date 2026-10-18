'use strict';
/**
 * npmsrc.js —— npm 源偏好（唯一事实来源 data\npm-source.json）+ 可达性探测
 *
 *   { "mode": "auto" | "official" | "mirror" | "custom", "url": "<custom 时使用>" }
 *
 * 为什么需要它：官方源在部分网络下会**连不上但不报错**，spawnSync 只能等超时；
 * 30 分钟的空等对用户来说就是"卡死"。所以：
 *   1) 源的偏好由用户选、存盘（页面里可选，维护台也可用）；
 *   2) 安装前先用 4 秒超时探一次可达性，不通的直接跳过；
 *   3) npm 自己再加 fetch-timeout，避免单次请求无限挂。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA, 'npm-source.json');

const KNOWN = {
  official: { url: 'https://registry.npmjs.org', label: 'npmjs 官方源' },
  mirror: { url: 'https://registry.npmmirror.com', label: 'npmmirror 镜像源' },
};
const MODES = ['auto', 'official', 'mirror', 'custom'];

function read() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { raw = {}; }
  const mode = MODES.indexOf(raw.mode) >= 0 ? raw.mode : 'auto';
  const url = typeof raw.url === 'string' && /^https?:\/\//.test(raw.url.trim()) ? raw.url.trim().replace(/\/+$/, '') : '';
  return { mode, url };
}

function write(next) {
  const mode = MODES.indexOf(next.mode) >= 0 ? next.mode : 'auto';
  const url = String(next.url || '').trim().replace(/\/+$/, '');
  if (mode === 'custom' && !/^https?:\/\//.test(url)) throw new Error('自定义源必须是 http(s) 地址');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ mode, url }, null, 2) + '\n', 'utf8');
  return { mode, url };
}

/** 偏好 → 候选源（有序）。auto = 官方优先，其余按用户选择。 */
function list() {
  const c = read();
  if (c.mode === 'official') return [{ url: KNOWN.official.url, label: KNOWN.official.label }];
  if (c.mode === 'mirror') return [{ url: KNOWN.mirror.url, label: KNOWN.mirror.label }];
  if (c.mode === 'custom' && c.url) return [{ url: c.url, label: '自定义源 ' + c.url }];
  return [{ url: KNOWN.official.url, label: KNOWN.official.label },
    { url: KNOWN.mirror.url, label: KNOWN.mirror.label }];
}

/** 4 秒探一次「这个源能不能应答」；拿到任意 HTTP 响应就算可达（404 也算通）。 */
async function reachable(reg) {
  try {
    const r = await fetch(reg.url + '/@deepseek-ai%2Fdsh', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    return r.status < 500;
  } catch (e) {
    return false;
  }
}

/**
 * 探测并排序。失败的源会被跳过并给出提示；全都探不通时保留原顺序
 * （可能是探测被挡、但 npm 自己能过，别因为探测而让安装彻底不动）。
 */
async function order(regs, say) {
  const live = [];
  for (const reg of regs) {
    const ok = await reachable(reg);
    reg.probed = ok;
    if (typeof say === 'function') say('  源 ' + reg.label + '：' + (ok ? '可达' : '不可达（仍会试一次，但只等 2 分钟）'));
    if (ok) live.push(reg);
  }
  return live.length ? live : regs;
}

module.exports = { read, write, list, reachable, order, KNOWN, MODES, FILE };
