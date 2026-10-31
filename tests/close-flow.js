'use strict';
/**
 * close-flow.js —— 关闭流程的三条分支真机验收
 *
 *   runtime\node\node.exe tests\close-flow.js
 *
 * 覆盖：
 *   1. 最小化到托盘：窗口收起来、进程还在、ui-server 还在（dsh/服务照常跑）
 *   2. 取消：什么都不变
 *   3. 完全退出：壳退出、ui-server 跟着退（不留孤儿）
 *
 * 做法：main.js 支持 DSH_SELFTEST_CLOSE=quit|tray|cancel —— 跳过弹窗、按该选择走，
 * 并在配置页加载完 1.2 秒后自动触发一次关闭。这样三条分支都能在无人值守下验。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dsh-to-go.exe');
const LOG = path.join(ROOT, 'data', 'logs', 'electron.log');

const results = [];
const ok = (n, d) => { results.push(true); console.log('  PASS  ' + n + (d ? '  — ' + d : '')); };
const bad = (n, d) => { results.push(false); console.log('  FAIL  ' + n + (d ? '  — ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 20000 });
  return String(r.stdout || '').trim();
}
function electronCount() {
  const n = parseInt(ps('(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count'), 10);
  return Number.isFinite(n) ? n : 0;
}
function uiServerPids() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ui-server.js*' } | ForEach-Object { $_.ProcessId }");
  return out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
}
function windowVisible() {
  const out = ps("Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'DSH to go' } | ForEach-Object { $_.Id }");
  return out.length > 0;
}
function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } }
function killAll() { ps('Get-Process electron,dsh-to-go -ErrorAction SilentlyContinue | Stop-Process -Force'); }

async function scenario(name, choice, check) {
  console.log('\n— ' + name + ' —');
  killAll();
  // 等上一个实例彻底退干净：Electron 的单实例锁还没释放就启动，新实例会直接退出
  for (let i = 0; i < 50 && electronCount() > 0; i++) await sleep(200);
  for (let i = 0; i < 50 && uiServerPids().length; i++) await sleep(200);
  await sleep(600);
  try { fs.unlinkSync(LOG); } catch (e) { /* 忽略 */ }

  const child = spawn(EXE, [], {
    cwd: ROOT, detached: false, windowsHide: false,
    env: Object.assign({}, process.env, { DSH_SELFTEST_CLOSE: choice }),
  });
  void child;

  let log = '';
  for (let i = 0; i < 120; i++) {
    log = readLog();
    if (/selftest close:/.test(log)) break;
    await sleep(250);
  }
  // 等关闭流程真正落地（结果行出现），最多 10 秒；不靠固定 sleep
  for (let i = 0; i < 50; i++) {
    if (/close: 用户/.test(readLog())) break;
    await sleep(200);
  }
  await sleep(600);
  await check(readLog());     // 读关闭动作之后的日志
}

(async function main() {
  if (!fs.existsSync(EXE)) { console.error('缺少 dsh-to-go.exe'); process.exit(2); }

  // 1) 最小化到托盘
  await scenario('最小化到托盘', 'tray', async (log) => {
    log = readLog();
    if (/close: 用户选择最小化到托盘/.test(log)) ok('走了托盘分支');
    else bad('走了托盘分支', log.split('\n').slice(-3).join(' | '));
    if (electronCount() > 0) ok('壳还活着', electronCount() + ' 个 electron 进程');
    else bad('壳还活着', '进程没了');
    if (uiServerPids().length > 0) ok('ui-server 还在跑', 'pid ' + uiServerPids().join(','));
    else bad('ui-server 还在跑', '服务被一起关了（不该）');
    if (/window hidden to tray/.test(log)) ok('窗口已收进托盘');
    else bad('窗口已收进托盘', '日志里没有 window hidden to tray');
  });

  // 2) 取消
  await scenario('取消', 'cancel', async (log) => {
    log = readLog();
    if (/close: 用户取消/.test(log)) ok('走了取消分支');
    else bad('走了取消分支', log.split('\n').slice(-3).join(' | '));
    if (electronCount() > 0) ok('壳还活着');
    else bad('壳还活着', '进程没了');
    if (uiServerPids().length > 0 && !/window hidden to tray/.test(log)) ok('窗口没被收起');
    else bad('窗口没被收起', '意外收起或服务掉了');
  });

  // 3) 完全退出
  await scenario('完全退出', 'quit', async (log) => {
    log = readLog();
    if (/close: 用户选择完全退出/.test(log)) ok('走了退出分支');
    else bad('走了退出分支', log.split('\n').slice(-3).join(' | '));
    // dsh 在跑时这条路径要多等（先尝试停 dsh，再收服务），轮询别用固定时长
    let stopped = '';
    for (let i = 0; i < 50; i++) {
      stopped = readLog();
      if (/ui-server stopped/.test(stopped)) break;
      await sleep(200);
    }
    if (/ui-server stopped/.test(stopped)) ok('ui-server 被停掉');
    else bad('ui-server 被停掉', stopped.split('\n').slice(-3).join(' | '));
    let left = electronCount();
    for (let i = 0; i < 25 && left > 0; i++) { await sleep(200); left = electronCount(); }
    if (!left) ok('壳已退出');
    else bad('壳已退出', '还剩 ' + left + ' 个 electron 进程');
    let servers = uiServerPids();
    for (let i = 0; i < 25 && servers.length; i++) { await sleep(200); servers = uiServerPids(); }
    if (!servers.length) ok('没有孤儿 ui-server');
    else bad('没有孤儿 ui-server', '残留 pid ' + servers.join(','));
  });

  killAll();
  const failed = results.filter((r) => !r).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' 项通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('崩了：' + (e && e.message || e)); killAll(); process.exit(1); });
