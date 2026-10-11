'use strict';
/**
 * 插件与本槽 dsh 的兼容性判定（页面上「适配版本」那一项的来源）。
 *
 * 依据：插件的 package.json 里声明了对 dsh 内部包的要求，例如
 *   "@deepseek-ai/dsh-llm": "^0.1.2-alpha.1 || ^0.2.0-rc.1",
 *   "@deepseek-ai/dsh-session": "^0.2.0-rc.1"
 * dsh 自己的兼容闸门就是拿这些去比对**本槽实际装的版本**：不满足就直接拒绝安装，
 * 并打印一条「接受风险」的豁免命令。所以我们能提前算出同一个结论——
 * 页面在「安装」之前就能告诉用户：这台机器上装它会不会被拦。
 *
 * 实现取舍：优先用槽里自带的 semver（dsh 的依赖，一定有，行为与 dsh 完全一致）；
 * 拿不到时退回一个只认常见写法的近似匹配（^ ~ >= <= > < 精确 * 与 || 并用），
 * 并在结果里标明用的是哪种（how: 'semver' | 'approx'），不假装精确。
 * 判定走 includePrerelease —— 这个生态里插件声明的区间本身就带 alpha/rc
 * （例如 ^0.1.2-alpha.1），不放预发布的话几乎没人能满足。
 */
const fs = require('fs');
const path = require('path');

function loadSemver(slotDir) {
  const tries = [];
  if (slotDir) tries.push(path.join(slotDir, 'node_modules', 'semver'));
  tries.push('semver');
  for (const p of tries) {
    try { return require(p); } catch (e) { /* 下一个 */ }
  }
  return null;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

function cmpNum(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** -1 / 0 / 1：按 semver 的先后比（预发布版本小于同号正式版） */
function compare(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  if (!A || !B) return null;
  for (let i = 0; i < 3; i++) { const c = cmpNum(A.main[i], B.main[i]); if (c) return c; }
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;   // 正式版 > 预发布
  if (!B.pre.length) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const c = cmpNum(Number(x), Number(y)); if (c) return c; }
    else if (nx !== ny) return nx ? -1 : 1;   // 数字段 < 字母段
    else { const c = x < y ? -1 : x > y ? 1 : 0; if (c) return c; }
  }
  return 0;
}

/** 近似匹配：只认 ^ ~ >= <= > < = 与精确、* 以及用 || 连接的多个区间 */
function approxSatisfies(range, version) {
  const v = parseVersion(version);
  if (!v) return null;
  const alts = String(range || '').split('||').map((s) => s.trim()).filter(Boolean);
  if (!alts.length) return true;
  for (const alt of alts) {
    if (alt === '*' || alt === '' || /^x$/i.test(alt)) return true;
    if (alt.indexOf(' ') > 0) {   // 空格分隔的复合区间（如 ">=1.0.0 <2.0.0"）：要求全部满足
      const parts = alt.split(/\s+/).filter(Boolean);
      if (parts.every((p) => approxSatisfies(p, version) === true)) return true;
      continue;
    }
    const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(alt);
    if (!m) continue;
    const op = m[1] || '=';
    const maj = Number(m[2]);
    const min = m[3] === undefined || /x|\*/.test(m[3]) ? null : Number(m[3]);
    const pat = m[4] === undefined || /x|\*/.test(m[4]) ? null : Number(m[4]);
    const pre = m[5] || '';
    const lower = maj + '.' + (min == null ? 0 : min) + '.' + (pat == null ? 0 : pat) + (pre ? '-' + pre : '');
    const cLow = compare(version, lower);
    if (cLow === null) continue;
    if (op === '=') {
      if (min == null) { if (v.main[0] === maj) return true; continue; }
      if (pat == null) { if (v.main[0] === maj && v.main[1] === min) return true; continue; }
      if (cLow === 0) return true;
      continue;
    }
    if (op === '>=') { if (cLow >= 0) return true; continue; }
    if (op === '>') { if (cLow > 0) return true; continue; }
    if (op === '<=') { if (cLow <= 0) return true; continue; }
    if (op === '<') { if (cLow < 0) return true; continue; }
    if (op === '^') {
      const upper = maj > 0 ? (maj + 1) + '.0.0' : (min != null ? '0.' + (min + 1) + '.0' : '1.0.0');
      // 与 semver 一致：区间里写了预发布时，上界要收成 `<upper>-0`，
      // 这样上界自己的预发布（0.2.0-rc.1 之于 <0.2.0）不算满足
      const lim = pre ? upper + '-0' : upper;
      if (cLow >= 0 && compare(version, lim) < 0) return true;
      continue;
    }
    if (op === '~') {
      const upper = min != null ? maj + '.' + (min + 1) + '.0' : (maj + 1) + '.0.0';
      const lim = pre ? upper + '-0' : upper;
      if (cLow >= 0 && compare(version, lim) < 0) return true;
      continue;
    }
  }
  return false;
}

function satisfies(range, version, semverLib) {
  if (semverLib && typeof semverLib.satisfies === 'function') {
    try { return semverLib.satisfies(version, range, { includePrerelease: true }); } catch (e) { /* 落到近似 */ }
  }
  return approxSatisfies(range, version);
}

/** 从若干个 node_modules 里找某个包实际装的版本 */
function resolveInstalled(dep, dirs) {
  for (const d of dirs) {
    if (!d) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, dep, 'package.json'), 'utf8'));
      if (j && j.version) return j.version;
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

/**
 * 检查一份 peerDependencies 能不能配得上本槽。
 * @param {object} peers   插件的 peerDependencies
 * @param {object} opts    {slotDir, profileDir, slotVersion, semverDir}
 * @returns {{checked:number, ok:boolean|null, how:string, checks:Array, fails:Array, unresolved:Array}}
 */
function check(peers, opts = {}) {
  const slotDir = opts.slotDir || null;
  const dirs = [slotDir && path.join(slotDir, 'node_modules'), opts.profileDir && path.join(opts.profileDir, 'node_modules')];
  const sv = loadSemver(opts.semverDir || slotDir);
  const checks = [], fails = [], unresolved = [];
  const keys = Object.keys(peers || {});
  for (const dep of keys) {
    const range = String(peers[dep]);
    const have = resolveInstalled(dep, dirs);
    if (!have) {
      unresolved.push({ dep, range, have: null });
      checks.push({ dep, range, have: null, ok: null });
      continue;
    }
    const ok = satisfies(range, have, sv);
    checks.push({ dep, range, have, ok });
    if (ok !== true) fails.push({ dep, range, have, ok });
  }
  const resolved = checks.filter((c) => c.have);
  return {
    checked: keys.length,
    ok: resolved.length === 0 ? null : fails.length === 0,
    how: sv && typeof sv.satisfies === 'function' ? 'semver' : 'approx',
    checks, fails, unresolved,
  };
}

/** 直接拿一个已装包的目录来查（读它的 package.json） */
function checkPackage(pkgDir, opts = {}) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch (e) { return { checked: 0, ok: null, how: 'none', checks: [], fails: [], unresolved: [], error: '读不到 package.json' }; }
  const out = check(j.peerDependencies || {}, opts);
  out.pkg = j.name || null;
  out.version = j.version || null;
  return out;
}

/** 给页面用的一句话结论 */
function verdict(res, slotVersion) {
  if (!res || res.checked === 0) return { level: 'none', text: '没声明对 dsh 的依赖要求' };
  if (res.ok === null) return { level: 'unknown', text: '无法判定（本槽里找不到它依赖的包）' };
  if (res.ok) return { level: 'ok', text: '适配本槽' + (slotVersion ? '（dsh ' + slotVersion + '）' : '') };
  return { level: 'need-exempt', text: '与本槽不匹配，装它会被 dsh 拒绝并要你显式豁免（' + res.fails.map((f) => f.dep.replace('@deepseek-ai/', '') + ' 要 ' + f.range + '，本槽 ' + f.have).slice(0, 2).join('；') + '）' };
}

module.exports = { check, checkPackage, verdict, satisfies, approxSatisfies, compare, parseVersion, resolveInstalled, loadSemver };

// ------------------------------------------------------------------ CLI（调试用）
if (require.main === module) {
  const argv = process.argv.slice(2);
  const pkgDir = argv[0];
  if (!pkgDir) { console.log('  用法：compat.js <已装插件的目录>'); process.exit(2); }
  const plugins = require('./plugins.js');
  const slot = plugins.slotDir ? plugins.slotDir() : null;
  const res = checkPackage(pkgDir, { slotDir: slot, profileDir: plugins.profileDir('web') });
  console.log(JSON.stringify(res, null, 2));
  console.log('  结论：' + verdict(res).text);
}
