'use strict';
/**
 * Maintenance console for the portable DeepSeek Harness.
 *
 *   node tools/config.js            # interactive menu
 *   node tools/config.js doctor
 *   node tools/config.js upgrade <version>
 *   node tools/config.js switch     # flip the A/B slot pointer
 *   node tools/config.js backup
 *   node tools/config.js key
 *   node tools/config.js versions
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');
const secretLib = require('./secret.js');
const npmsrc = require('./npmsrc.js');

const ROOT = process.env.WZD_ROOT || path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const NODE_EXE = path.join(RUNTIME, 'node', 'node.exe');
const NPM_CLI = path.join(RUNTIME, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const SLOT_FILE = path.join(RUNTIME, 'current.txt');
const PORT_FILE = path.join(RUNTIME, 'port.txt');
const BACKUP_DIR = path.join(ROOT, 'backups');
const VERSION_FILE = path.join(ROOT, 'VERSION.txt');
const REGISTRIES = [
  { url: 'https://registry.npmjs.org', label: 'npmjs (official)' },
  { url: 'https://registry.npmmirror.com', label: 'npmmirror (mirror)' }
];

function slot(name) { return path.join(RUNTIME, name); }
function binOf(name) { return path.join(slot(name), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); }
function pkgOf(name) { return path.join(slot(name), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'); }
function readCurrent() {
  try {
    const v = fs.readFileSync(SLOT_FILE, 'utf8').trim();
    return /^agent-[AB]$/.test(v) ? v : 'agent-A';
  } catch (e) { return 'agent-A'; }
}
function idleSlot() { return readCurrent() === 'agent-A' ? 'agent-B' : 'agent-A'; }
function versionOf(name) {
  try { return JSON.parse(fs.readFileSync(pkgOf(name), 'utf8')).version || 'unknown'; } catch (e) { return 'not-installed'; }
}
function readPort() {
  try { const v = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10); if (v > 0) return v; } catch (e) { /* default */ }
  return 3180;
}
function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true }, opts || {}));
}
function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + u[i];
}
function dirSize(p) {
  let total = 0;
  let stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch (err) { /* skip */ } }
    }
  }
  return total;
}
function logVersion(line) {
  fs.appendFileSync(VERSION_FILE, '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
}
const { ask, close: closeRL } = require('./ask.js');

// ---------------------------------------------------------------- doctor
function envVarFromWindows(name, scope) {
  const r = run('powershell', ['-NoProfile', '-Command', "[Console]::Out.Write('V:' + [string][Environment]::GetEnvironmentVariable('" + name + "','" + scope + "'))"]);
  const out = String(r.stdout || '');
  const i = out.indexOf('V:');
  return i >= 0 ? out.slice(i + 2).trim() : '';
}

function doctor() {
  const cur = readCurrent();
  const other = idleSlot();
  const port = readPort();
  const rows = [];
  const ok = (label, detail) => rows.push(['  OK  ', label, detail]);
  const warn = (label, detail) => rows.push([' WARN ', label, detail]);
  const bad = (label, detail) => rows.push([' FAIL ', label, detail]);

  // 1. drive / free space
  try {
    const st = fs.statfsSync(ROOT);
    const free = st.bsize * st.bavail;
    (free > 2 * 1024 * 1024 * 1024 ? ok : warn)('磁盘剩余空间', human(free) + ' 可用（' + path.parse(ROOT).root + '）');
  } catch (e) { warn('磁盘剩余空间', '读不到：' + e.message); }

  // 2. portable node
  if (fs.existsSync(NODE_EXE)) {
    const v = run(NODE_EXE, ['-v']);
    ok('便携 Node', String(v.stdout || '').trim() + '  ' + NODE_EXE);
  } else bad('便携 Node', '缺失：' + NODE_EXE);

  // 3. slots
  for (const s of ['agent-A', 'agent-B']) {
    const v = versionOf(s);
    const flag = s === cur ? '活动' : '空闲';
    if (v === 'not-installed') warn('槽位 ' + s + '（' + flag + '）', '未安装');
    else ok('槽位 ' + s + '（' + flag + '）', 'dsh ' + v + '，占用 ' + human(dirSize(slot(s))));
  }

  // 4. active dsh entry point
  if (fs.existsSync(binOf(cur))) ok('活动槽入口文件', binOf(cur));
  else bad('活动槽入口文件', '缺失：' + binOf(cur));

  // 5. npm cache
  const cache = path.join(RUNTIME, 'npm-cache');
  if (fs.existsSync(cache)) ok('npm 缓存（在盘上）', human(dirSize(cache)) + '  → 可离线重装、升级更快');
  else warn('npm 缓存', '不存在；升级会重新下载');

  // 6. data dir writable + size
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const probe = path.join(DATA, '.doctor-write-test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    ok('数据目录', DATA + '  （已用 ' + human(dirSize(DATA)) + '）');
  } catch (e) { bad('数据目录', '不可写：' + e.message); }

  // 7. key store（v2 多站点密钥库 + 旧的单密钥文件）
  const v2File = secretLib.secretFile();
  const legacyPath = secretLib.legacyFile();
  const store = secretLib.readStore(v2File);
  const legacyExists = fs.existsSync(legacyPath);
  if (store) {
    const items = secretLib.listKeys();
    ok('密钥库 ' + path.basename(v2File), '口令校验器' + (store.verifier ? '已设置' : '未设置') +
      '，站点密钥 ' + items.length + ' 个' + (items.length ? '（' + items.map((x) => x.siteId).join('、') + '）' : ''));
    const raw = fs.readFileSync(v2File, 'utf8');
    if (/sk-[A-Za-z0-9_-]{8,}/.test(raw)) bad('密钥文件明文泄漏', '文件里能直接读到疑似密钥的字符串！');
    if (legacyExists) warn('旧的单密钥文件', path.basename(legacyPath) + ' 仍在（已被新密钥库取代，可留作回退或删除）');
  } else if (legacyExists) {
    const blob = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    ok('加密密钥文件（旧单密钥格式）', blob.algo + ' / ' + blob.kdf + '，变量名 ' + (blob.key_name || secretLib.keyName()));
    const raw = fs.readFileSync(legacyPath, 'utf8');
    if (/sk-[A-Za-z0-9_-]{8,}/.test(raw)) bad('密钥文件明文泄漏', '文件里能直接读到疑似密钥的字符串！');
  } else warn('加密密钥文件', '未配置 —— 维护台 5) key 或图形配置页（dsh-ui.cmd）都可以设置');

  // 8. port availability
  let portTaken = false;
  const ns = run('netstat', ['-ano']);
  for (const line of String(ns.stdout || '').split(/\r?\n/)) {
    if (line.indexOf(':' + port) >= 0 && line.toUpperCase().indexOf('LISTENING') >= 0) portTaken = true;
  }
  if (portTaken) warn('网页端口 ' + port, '已被占用（dsh 正在运行时属正常，否则是本机别的程序占用）');
  else ok('网页端口 ' + port, '空闲');

  // 9. leaked host environment variables.
  //    Only two things are genuinely dangerous: DSH_HOME / DSH_AGENTS_HOME published
  //    at User/Machine scope (a host-installed dsh would then follow this drive), and
  //    any of these names pointing *into* this drive (a host tool would write here).
  const driveRoot = path.parse(ROOT).root.toUpperCase();
  const leaks = [];
  const benign = [];
  for (const name of ['DSH_HOME', 'DSH_AGENTS_HOME', 'npm_config_prefix', 'npm_config_cache', 'NODE_PATH']) {
    for (const scope of ['User', 'Machine']) {
      const val = envVarFromWindows(name, scope);
      if (!val) continue;
      const upper = val.toUpperCase();
      const pointsHere = upper.indexOf(driveRoot) === 0 || upper.indexOf(ROOT.toUpperCase()) >= 0;
      if (pointsHere || name === 'DSH_HOME' || name === 'DSH_AGENTS_HOME') {
        leaks.push(scope + ' 变量 ' + name + '=' + val + (pointsHere ? '（指向这块盘）' : '（会让机器上的 dsh 跟着这块盘走）'));
      } else {
        benign.push(scope + ' ' + name + '=' + val);
      }
    }
  }
  if (leaks.length) {
    bad('宿主机环境变量泄漏', leaks.join(' | ') + '   → 在「系统属性→高级→环境变量」里删除它们');
  } else if (benign.length) {
    ok('宿主机环境变量', '无泄漏；与本盘无关的既有变量：' + benign.join(' | '));
  } else {
    ok('宿主机环境变量', '无泄漏：本盘从不把 DSH_HOME／npm_config_prefix 写进系统或用户变量');
  }

  // 10. host side dsh home untouched
  const hostHome = path.join(os.homedir(), '.dsh');
  if (fs.existsSync(hostHome)) warn('宿主 ~/.dsh', '存在（' + hostHome + '）—— 是本机自己用过非便携 dsh，与本盘无关');
  else ok('宿主 ~/.dsh', '不存在 —— 宿主账户上零残留');

  console.log('');
  console.log('  便携版 DeepSeek Harness —— 自检');
  console.log('  本盘根目录: ' + ROOT);
  console.log('  ------------------------------------------------------------');
  for (const r of rows) console.log(r[0] + r[1].padEnd(26, ' ') + ' : ' + r[2]);
  console.log('  ------------------------------------------------------------');
  const fails = rows.filter((r) => r[0] === ' FAIL ').length;
  const warns = rows.filter((r) => r[0] === ' WARN ').length;
  console.log('  结果: ' + fails + ' 项失败，' + warns + ' 项警告');
  console.log('');
  return fails ? 1 : 0;
}

// ---------------------------------------------------------------- backup
// 备份 data/ 时**排除 .webview**：那是 WebView2 的用户数据（缓存/cookie），
// 运行中的浏览器进程会把 lockfile 锁住，Compress-Archive 会直接失败；
// 而且它本来也不是「用户数据」，没必要进备份。
function backupData(reason) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const WEBVIEW = path.join(DATA, '.webview');
  const used = dirSize(DATA) - (fs.existsSync(WEBVIEW) ? dirSize(WEBVIEW) : 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const zip = path.join(BACKUP_DIR, 'data-' + readCurrent() + '-' + versionOf(readCurrent()) + '-' + stamp + '.zip');
  if (used < 4096) {
    console.log('  data/ 是空的（' + used + ' 字节），跳过备份');
    return null;
  }
  console.log('  正在打包 data/ 共 ' + human(used) + '（已排除浏览器数据目录 .webview）...');
  // [Console]::OutputEncoding 让 PowerShell 的错误以 UTF-8 出来，否则日志里是 GBK 乱码。
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop';"
    + " $items = @(Get-ChildItem -LiteralPath '" + DATA + "' -Force | Where-Object { $_.Name -ne '.webview' });"
    + " if ($items.Count -eq 0) { throw '排除 .webview 后没有可备份的内容' };"
    + " Compress-Archive -Path ($items | ForEach-Object { $_.FullName }) -DestinationPath '" + zip + "' -Force";
  const r = run('powershell', ['-NoProfile', '-Command', ps]);
  if (r.status !== 0) {
    console.log('  备份失败：' + String(r.stderr || r.stdout || '').trim());
    console.log('  （升级会继续；只是这次没有留下降级用的备份）');
    return null;
  }
  logVersion('backup reason=' + (reason || 'manual') + ' file=' + path.basename(zip) + ' size=' + fs.statSync(zip).size);
  console.log('  备份已生成：' + zip + '  （' + human(fs.statSync(zip).size) + '）');
  return zip;
}

// ---------------------------------------------------------------- upgrade
async function upgrade(target, assumeYes) {
  const cur = readCurrent();
  const idle = idleSlot();
  console.log('');
  console.log('  升级：活动槽 ' + cur + '（dsh ' + versionOf(cur) + '）→ 目标版本 ' + target);
  console.log('  将装进空闲槽 ' + idle + '；只有启动检查通过后才会切换指针。');
  if (!assumeYes) {
    const a = (await ask('  确认继续？[y/N] ')).toLowerCase();
    if (a !== 'y' && a !== 'yes') { console.log('  已取消。'); return 0; }
  }

  backupData('pre-upgrade to ' + target);

  const pkgFile = path.join(slot(idle), 'package.json');
  const lockFile = path.join(slot(idle), 'package-lock.json');
  const saved = {};
  for (const f of [pkgFile, lockFile]) {
    try { saved[f] = fs.readFileSync(f, 'utf8'); } catch (e) { saved[f] = null; }
  }
  fs.mkdirSync(slot(idle), { recursive: true });
  fs.writeFileSync(pkgFile, JSON.stringify({
    name: 'dsh-agent-slot',
    version: '1.0.0',
    private: true,
    description: 'Portable DeepSeek Harness runtime slot (A/B).',
    dependencies: { '@deepseek-ai/dsh': target }
  }, null, 2) + '\n', 'utf8');

  console.log('  正在安装到 ' + idle + ' ...');
  let usedRegistry = null;
  let lastErr = '';
  // 源由用户偏好决定（页面/维护台可改），并在装之前先探一次可达性：
  // 官方源在部分网络下是「连得上但不回包」，只靠 npm 自己等会空等半小时。
  const chosen = npmsrc.list();
  console.log('  当前源偏好：' + npmsrc.read().mode + '（' + chosen.map((r) => r.label).join(' → ') + '）');
  const candidates = await npmsrc.order(chosen, (m) => console.log(m));
  for (const reg of candidates) {
    const tmo = reg.probed === false ? 120000 : 600000;
    console.log('    尝试 ' + reg.label + '（单次最多等 ' + Math.round(tmo / 60000) + ' 分钟，失败自动换源）');
    const r = run(NODE_EXE, [NPM_CLI, 'install',
      '--cache=' + path.join(RUNTIME, 'npm-cache'),
      '--registry=' + reg.url,
      '--fetch-timeout=60000', '--fetch-retries=1', '--fetch-retry-mintimeout=2000',
      '--no-audit', '--no-fund', '--loglevel=error'], { cwd: slot(idle), timeout: tmo, env: require('./npmrc.js').env() });
    if (r.status === 0) { usedRegistry = reg; break; }
    lastErr = String(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ')
      || (r.error && r.error.code === 'ETIMEDOUT' ? '超时（10 分钟没有结果）' : '未知错误');
    console.log('    ' + reg.label + ' 失败：' + lastErr);
  }
  if (!usedRegistry) {
    console.log('  所有源都安装失败 —— 已还原槽 ' + idle + '，指针保持不动。');
    for (const f of [pkgFile, lockFile]) {
      if (saved[f] !== null) fs.writeFileSync(f, saved[f], 'utf8');
      else try { fs.unlinkSync(f); } catch (e) { /* nothing to remove */ }
    }
    return 1;
  }
  console.log('    已从 ' + usedRegistry.label + ' 安装完成');

  const v = run(NODE_EXE, [binOf(idle), '--version']);
  const got = String(v.stdout || '').trim().split('\n').pop().trim();
  console.log('  启动检查 ' + idle + ' ：--version -> ' + got);
  if (v.status !== 0 || got !== target) {
    console.log('  启动检查未通过（期望 ' + target + '）—— 指针仍留在 ' + cur + '。');
    console.log('  新文件保留在 ' + idle + ' 供检查；确认无误可用 3) switch 手动切过去。');
    return 1;
  }

  fs.writeFileSync(SLOT_FILE, idle + '\n', 'utf8');
  logVersion('upgrade from ' + versionOf(cur) + '(' + cur + ') to ' + target + '(' + idle + ') registry=' + usedRegistry.url);
  console.log('');
  console.log('  完成。活动槽已切到 ' + idle + '，dsh ' + target);
  console.log('  回滚只需一行：把 ' + SLOT_FILE + ' 的内容改成 ' + cur);
  return 0;
}

// ---------------------------------------------------------------- misc actions
function switchSlot() {
  const cur = readCurrent();
  const idle = idleSlot();
  if (versionOf(idle) === 'not-installed') {
    console.log('  槽 ' + idle + ' 还没有 dsh，请先升级安装再切换。');
    return 1;
  }
  fs.writeFileSync(SLOT_FILE, idle + '\n', 'utf8');
  logVersion('switch ' + cur + ' -> ' + idle + ' (dsh ' + versionOf(idle) + ')');
  console.log('  活动槽已切换：' + cur + ' → ' + idle + '（dsh ' + versionOf(idle) + '）');
  return 0;
}

/** 维护台要操作的站点：优先默认站点，其次唯一启用的站点；多站点又没默认站时不猜。 */
function activeSiteId() {
  try {
    const st = require('./sites.js').readState();
    if (st.default && st.default.siteId) return { id: st.default.siteId };
    const en = st.sites.filter((s) => s.enabled !== false);
    if (en.length === 1) return { id: en[0].id };
    if (en.length > 1) return { id: null, count: en.length };
  } catch (e) { /* 站点表还没建起来 */ }
  return { id: null, count: 0 };
}

function setKey() {
  const site = activeSiteId();
  if (site.count > 1 && !site.id) {
    console.log('  你有多个启用的站点，维护台不猜密钥属于谁。');
    console.log('  请用图形配置页（dsh-ui.cmd）逐个站点设置密钥，或先设好默认模型。');
    return 1;
  }
  console.log('  把模型密钥以 AES-256-GCM 密文写入 ' + secretLib.secretFile() + '（多站点密钥库）。');
  console.log('  口令会问两遍，且不保存在任何地方；忘记口令只需重新输入密钥，不会丢数据。');
  if (site.id) console.log('  这本密钥属于站点：' + site.id + '（变量名按站点表自动决定）');
  const args = [path.join(__dirname, 'secret.js'), 'set'];
  if (site.id) args.push('--site', site.id);
  const r = run(NODE_EXE, args, { stdio: 'inherit' });
  return r.status === 0 ? 0 : 1;
}

function versions() {
  console.log('');
  console.log('  活动槽    : ' + readCurrent() + '   dsh ' + versionOf(readCurrent()));
  console.log('  另一槽    : ' + idleSlot() + '   dsh ' + versionOf(idleSlot()));
  console.log('  便携 Node : ' + String(run(NODE_EXE, ['-v']).stdout || '').trim());
  console.log('  网页端口  : ' + readPort());
  console.log('  上次升级源: ' + (fs.readFileSync(VERSION_FILE, 'utf8').split('\n').filter((l) => l.includes('registry=')).pop() || '无记录'));
  return 0;
}

// ---------------------------------------------------------------- menu
async function menu() {
  for (;;) {
    console.log('');
    console.log('  ============================================================');
    console.log('   便携版 DeepSeek Harness —— 维护台');
    console.log('   活动槽: ' + readCurrent() + '  dsh ' + versionOf(readCurrent()) + '   ｜   空闲槽: ' + idleSlot() + '  dsh ' + versionOf(idleSlot()));
    console.log('  ============================================================');
    console.log('   1) doctor       全面自检（路径／端口／密钥／宿主泄漏）');
    console.log('   2) upgrade      把目标版本装进空闲槽，校验通过后切换');
    console.log('   3) switch       切换 A/B 槽指针（立即回滚）');
    console.log('   4) backup       把 data/ 打包进 backups/');
    console.log('   5) key          设置／更换加密的模型密钥');
    console.log('   6) versions     查看两槽版本与上次用的源');
    console.log('   7) 站点/模型     配置非官方站点（中转站/网关：地址、协议、模型）');
    console.log('   8) 站点查看      显示或清除当前站点配置');
    console.log('   9) 图形配置      在浏览器里配置（推荐，含站点/密钥/槽位/诊断）');
    console.log('   0) exit         退出');
    const a = (await ask('  请选择> ')).trim();
    if (a === '0' || a === 'q' || a === '') return 0;
    if (a === '1') doctor();
    else if (a === '2') {
      const v = await ask('  目标版本（例如 0.2.1-alpha.2 / latest / alpha）> ');
      if (!v) { console.log('  已取消。'); continue; }
      await upgrade(v.trim());
    } else if (a === '3') switchSlot();
    else if (a === '4') backupData('manual');
    else if (a === '5') setKey();
    else if (a === '6') versions();
    else if (a === '7') {
      run(NODE_EXE, [path.join(__dirname, 'site.js'), 'set'], { stdio: 'inherit' });
      const k = (await ask('  现在就去存密钥吗？（输 5 执行 5) key，回车跳过）> ')).trim();
      if (k === '5') setKey();
    } else if (a === '8') {
      run(NODE_EXE, [path.join(__dirname, 'site.js'), 'show'], { stdio: 'inherit' });
      const c = (await ask('  输 c 清除该站点配置，其它键返回> ')).trim().toLowerCase();
      if (c === 'c') run(NODE_EXE, [path.join(__dirname, 'site.js'), 'clear'], { stdio: 'inherit' });
    } else if (a === '9') {
      console.log('  正在启动图形配置页…浏览器应会自动打开；关掉本窗口即结束。');
      run(NODE_EXE, [path.join(__dirname, 'ui-server.js')], { stdio: 'inherit' });
    }
    else console.log('  无效选择。');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'menu').toLowerCase();
  let rc = 0;
  if (cmd === 'doctor') rc = doctor();
  else if (cmd === 'upgrade') {
    if (!argv[1]) { console.log('用法：node tools/config.js upgrade <版本号> [--yes]'); rc = 2; }
    else rc = await upgrade(argv[1], argv.includes('--yes'));
  } else if (cmd === 'switch') rc = switchSlot();
  else if (cmd === 'backup') { backupData('manual'); rc = 0; }
  else if (cmd === 'key') rc = setKey();
  else if (cmd === 'versions') rc = versions();
  else if (cmd === 'site') rc = run(NODE_EXE, [path.join(__dirname, 'site.js'), 'set'], { stdio: 'inherit' }).status || 0;
  else if (cmd === 'site-show') rc = run(NODE_EXE, [path.join(__dirname, 'site.js'), 'show'], { stdio: 'inherit' }).status || 0;
  else if (cmd === 'site-clear') rc = run(NODE_EXE, [path.join(__dirname, 'site.js'), 'clear'], { stdio: 'inherit' }).status || 0;
  else rc = await menu();
  closeRL();
  process.exit(rc);
}

main().catch((e) => { console.error('维护台错误：' + e.message); process.exit(1); });
