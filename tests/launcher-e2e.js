'use strict';
/**
 * launcher-e2e.js —— 启动器真机验收（起真进程，不是"编译成功"）
 *
 *   runtime\\node\\node.exe tests\\launcher-e2e.js
 *
 * 现在这套壳是 Electron（tools\\electron\\main.js）：
 *   根目录 dsh-to-go.exe 只是个小 shim，负责拉起 Electron；起不来就回退 dsh-ui.cmd。
 *
 * 断言：
 *   1. 双击（spawn）exe 后，出现标题为 DSH to go 的窗口（标题固定，不含令牌）
 *   2. shim 自己不驻留（拉完 Electron 就退出，不多占一个进程）
 *   3. 本地服务起来了、配置页加载完成（读壳自己写的日志）
 *   4. 日志里没有令牌明文（只允许出现长度）
 *   5. 强杀壳之后，它起的 ui-server 会自己退出（不留孤儿服务）
 *
 * 需要：Windows、已构建的 dsh-to-go.exe、runtime\\node、runtime\\electron。会短暂弹出窗口（正常）。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dsh-to-go.exe');
const LOG = path.join(ROOT, 'data', 'logs', 'electron.log');
const TITLE = 'DSH to go';

const results = [];
const ok = (name, detail) => { results.push({ name, pass: true, detail: detail || '' }); console.log('  PASS  ' + name + (detail ? '  — ' + detail : '')); };
const bad = (name, detail) => { results.push({ name, pass: false, detail: detail || '' }); console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 20000 });
  return String(r.stdout || '').trim();
}
function named(processName) {
  const out = ps('Get-Process ' + processName + ' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }');
  return out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
}
function electronPids() { return named('electron'); }
function shimPids() { return named('dsh-to-go'); }
function windowPid() {
  const out = ps("Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '" + TITLE + "' } | ForEach-Object { $_.Id }");
  const n = parseInt(out.split(/\r?\n/)[0], 10);
  return Number.isFinite(n) ? n : 0;
}
function uiServerPids() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ui-server.js*' } | ForEach-Object { $_.ProcessId }");
  return out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
}
function readLog() {
  try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; }
}

(async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('缺少 dsh-to-go.exe：先跑 runtime\\node\\node.exe tools\\launcher\\build-launcher.cmd');
    process.exit(2);
  }
  const electronExe = path.join(ROOT, 'runtime', 'electron', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    console.error('缺少 runtime\\electron（桌面壳）。先跑 build.cmd 下载，或改用 dsh-ui.cmd 回退路径。');
    process.exit(2);
  }
  if (electronPids().length) {
    console.error('已经有 Electron 实例在跑，先关掉 DSH to go 窗口再跑这个 e2e（单实例逻辑会直接聚焦旧窗口）。');
    process.exit(2);
  }

  const before = new Set(uiServerPids());
  try { fs.unlinkSync(LOG); } catch (e) { /* 没有更好 */ }

  const child = spawn(EXE, [], { cwd: ROOT, detached: false, windowsHide: false });
  let shimExited = false;
  child.on('exit', () => { shimExited = true; });

  // ---- 1. 窗口出现 + 标题固定
  let pid = 0;
  for (let i = 0; i < 80 && !pid; i++) { await sleep(250); pid = windowPid(); }
  if (!pid) {
    bad('窗口出现', '20 秒内没有出现标题为 "' + TITLE + '" 的窗口');
    throw new Error('electron window did not appear');
  }
  ok('窗口出现', 'pid ' + pid + '，标题 "' + TITLE + '"');

  // ---- 2. shim 不驻留
  for (let i = 0; i < 20 && !shimExited; i++) await sleep(200);
  const shimLeft = shimPids();
  if (shimExited && !shimLeft.length) ok('shim 拉完就退出（不驻留）');
  else bad('shim 拉完就退出（不驻留）', '仍在跑：' + shimLeft.join(',') );

  // ---- 3. 服务就绪 + 配置页加载
  let logText = '';
  for (let i = 0; i < 120; i++) {
    logText = readLog();
    if (/config page loaded/.test(logText)) break;
    await sleep(250);
  }
  if (/starting ui-server on 127\.0\.0\.1:(\d+)/.test(logText)) {
    ok('本地服务就绪', (logText.match(/starting ui-server on 127\.0\.0\.1:\d+/) || [])[0]);
  } else bad('本地服务就绪', logText.split('\n').slice(-4).join(' | '));

  if (/config page loaded/.test(logText)) ok('配置页加载完成');
  else bad('配置页加载完成', logText.split('\n').slice(-4).join(' | '));

  // ---- 4. 令牌只记长度
  if (/token captured \(length \d+\)/.test(logText)) ok('令牌由壳接住', '日志只记长度');
  else bad('令牌由壳接住', '日志里没有 token captured 行');
  if (!/token=[A-Za-z0-9_-]{20,}/.test(logText)) ok('日志里没有令牌明文');
  else bad('日志里没有令牌明文', '日志里出现了 ?token=…');

  // ---- 5. 强杀后不留孤儿服务
  const mine = uiServerPids().filter((p) => !before.has(p));
  if (!mine.length) bad('强杀清理', '没找到本次起的 ui-server（可能已经退出）');
  ps('Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force');
  let left = [];
  for (let i = 0; i < 50; i++) {
    left = uiServerPids().filter((p) => mine.indexOf(p) >= 0);
    if (!left.length) break;
    await sleep(200);
  }
  if (!left.length) ok('强杀壳之后 ui-server 自清', '原 pid ' + mine.join(','));
  else {
    bad('强杀壳之后 ui-server 自清', '残留 pid ' + left.join(','));
    for (const p of left) ps('Stop-Process -Id ' + p + ' -Force -ErrorAction SilentlyContinue');
  }

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 项通过');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('e2e 崩了：' + (e && e.message ? e.message : e));
  ps('Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force');
  process.exit(1);
});
