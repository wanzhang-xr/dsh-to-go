'use strict';
/**
 * launcher-e2e.js —— 启动器真机验收（起真进程，不是"编译成功"）
 *
 *   runtime\node\node.exe tests\launcher-e2e.js
 *
 * 断言：
 *   1. 双击（spawn）exe 后，窗口出现且标题是固定的 dsh-to-go（不含令牌）
 *   2. 本地服务起来了，页面加载完成（读的是启动器自己写的日志）
 *   3. 日志里没有令牌明文（只允许出现长度）
 *   4. 强杀启动器后，它起的 ui-server 会自己退出（不留孤儿服务）
 *
 * 需要：Windows、已构建的 dsh-to-go.exe、runtime\node。会短暂弹出窗口（正常）。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dsh-to-go.exe');
const LOG = path.join(ROOT, 'data', 'logs', 'launcher.log');
const NODE = process.platform === 'win32' ? 'node' : 'node';

const results = [];
const ok = (name, detail) => { results.push({ name, pass: true, detail: detail || '' }); console.log('  PASS  ' + name + (detail ? '  — ' + detail : '')); };
const bad = (name, detail) => { results.push({ name, pass: false, detail: detail || '' }); console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 20000 });
  return String(r.stdout || '').trim();
}
function launcherPids() {
  const out = ps("Get-Process dsh-to-go -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }");
  return out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
}
function uiServerPids() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ui-server.js*' } | ForEach-Object { $_.ProcessId }");
  return out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
}

(async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('缺少 dsh-to-go.exe：先跑 tools\\launcher\\build-launcher.cmd');
    process.exit(2);
  }
  if (launcherPids().length) {
    console.error('已经有一个启动器在跑，先关掉它再跑这个 e2e（否则单实例逻辑会直接激活旧窗口）。');
    process.exit(2);
  }

  const before = new Set(uiServerPids());
  try { fs.unlinkSync(LOG); } catch (e) { /* 没有就更好 */ }

  const child = spawn(EXE, [], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DSH_LAUNCHER_SELFTEST: '1' }),
    detached: false,
    windowsHide: false,
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  // ---- 1. 窗口 + 标题
  let pids = [];
  for (let i = 0; i < 40 && !pids.length; i++) { await sleep(250); pids = launcherPids(); }
  if (!pids.length) { bad('窗口出现', '没有找到 dsh-to-go 进程'); throw new Error('launcher did not start'); }
  ok('窗口出现', 'pid ' + pids.join(','));

  await sleep(1500);
  const title = ps("(Get-Process -Id " + pids[0] + " -ErrorAction SilentlyContinue).MainWindowTitle");
  if (title === 'dsh-to-go') ok('窗口标题是固定值', JSON.stringify(title));
  else bad('窗口标题是固定值', '实际 ' + JSON.stringify(title));

  // ---- 2. 服务就绪 + 页面加载（读启动器自己的日志）
  let logText = '';
  for (let i = 0; i < 120; i++) {
    try { logText = fs.readFileSync(LOG, 'utf8'); } catch (e) { logText = ''; }
    if (/page loaded/.test(logText)) break;
    await sleep(250);
  }
  if (/ui-server ready/.test(logText)) ok('本地服务就绪', (logText.match(/starting ui-server on 127\.0\.0\.1:(\d+)/) || [])[0] || '');
  else bad('本地服务就绪', logText.split('\n').slice(-4).join(' | '));
  if (/page loaded/.test(logText)) ok('页面加载完成');
  else bad('页面加载完成', logText.split('\n').slice(-4).join(' | '));
  // 这行是页面加载完成后约 1 秒才写的（页面 selftest 完成才 post），固定读一次会误判，
  // 所以轮询等它出现（最多 10 秒）。
  let bridgeSeen = false;
  for (let i = 0; i < 50; i++) {
    if (/selftest bridge: "dsh\.token token-length=\d+"/.test(logText)) { bridgeSeen = true; break; }
    await sleep(200);
    try { logText = fs.readFileSync(LOG, 'utf8'); } catch (e) { /* 日志还没刷新 */ }
  }
  if (bridgeSeen) ok('令牌桥把令牌交给页面', '日志只有长度');
  else bad('令牌桥把令牌交给页面', '等了 10 秒仍没有 selftest bridge 行');

  // ---- 3. 日志里不能有令牌明文
  const leak = /token=[A-Za-z0-9_-]{20,}/.test(logText);
  if (!leak) ok('日志里没有令牌明文');
  else bad('日志里没有令牌明文', '日志里出现了 ?token=…');

  // ---- 4. 强杀后不留孤儿服务
  const mine = uiServerPids().filter((p) => !before.has(p));
  if (!mine.length) bad('强杀清理', '没找到本次起的 ui-server（可能提前退出了）');
  ps("Stop-Process -Id " + pids[0] + " -Force -ErrorAction SilentlyContinue");
  // 进程退出是异步的：taskkill 之后立刻查会看到"正在退出"的 pid，轮询到它消失为止（最多 10 秒）
  let left = [];
  for (let i = 0; i < 50; i++) {
    left = uiServerPids().filter((p) => mine.indexOf(p) >= 0);
    if (!left.length) break;
    await sleep(200);
  }
  if (!left.length) ok('强杀启动器后 ui-server 自清', '原 pid ' + mine.join(','));
  else {
    bad('强杀启动器后 ui-server 自清', '残留 pid ' + left.join(','));
    for (const p of left) ps("Stop-Process -Id " + p + " -Force -ErrorAction SilentlyContinue");
  }
  void exited; void NODE;

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 项通过');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('e2e 崩了：' + (e && e.message ? e.message : e));
  for (const p of launcherPids()) ps("Stop-Process -Id " + p + " -Force -ErrorAction SilentlyContinue");
  process.exit(1);
});
