// dsh-to-go —— 便携包构建器
//
// 在仓库目录下把「一个可移动的 DeepSeek Harness」装出来：
//   runtime\node        便携 Node（由 build.ps1 下载并校验，本脚本只检查）
//   runtime\agent-A/B   两个 dsh 槽（A 活动 + B 备用，秒级回滚）
//   runtime\npm-cache   盘内 npm 缓存（重装/升级快很多）
//   runtime\current.txt 活动槽  runtime\port.txt 网页端口
//   data\ secrets\ backups\
//
// 用法（一般由 build.cmd 调用）：
//   node tools/install.js [--a <版本|标签>] [--b <版本|标签>] [--single]
//                         [--port <端口>] [--registry <url>] [--force]
//
// 单独重跑是安全的：已存在的槽会按给定版本重装，current.txt 不指明 --force 就不动。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const npmsrc = require('./npmsrc.js');

const ROOT = process.env.WZD_ROOT || path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const NODE_EXE = path.join(RUNTIME, 'node', 'node.exe');
const NPM_CLI = path.join(RUNTIME, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const CACHE = path.join(RUNTIME, 'npm-cache');
const SLOT_FILE = path.join(RUNTIME, 'current.txt');
const PORT_FILE = path.join(RUNTIME, 'port.txt');
const VERSION_FILE = path.join(ROOT, 'VERSION.txt');

const DEFAULT_A = '0.2.1-alpha.2';
const DEFAULT_B = '0.2.0-rc.2';
const DEFAULT_PORT = 3180;
const NPM_MIRRORS = [
  { url: 'https://registry.npmjs.org', label: 'npmjs 官方源' },
  { url: 'https://registry.npmmirror.com', label: 'npmmirror 镜像源' },
];

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const o = { a: DEFAULT_A, b: DEFAULT_B, single: false, port: DEFAULT_PORT, portGiven: argv.includes('--port'), registry: null, force: false, slot: null, version: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a') o.a = argv[++i];
    else if (k === '--b') o.b = argv[++i];
    else if (k === '--port') o.port = Number(argv[++i]);
    else if (k === '--registry') o.registry = argv[++i];
    else if (k === '--slot') o.slot = argv[++i];
    else if (k === '--version') o.version = argv[++i];
    else if (k === '--single') o.single = true;
    else if (k === '--force') o.force = true;
    else if (k === '--help' || k === '-h') { usage(); process.exit(0); }
    else { console.log('  未知参数：' + k); usage(); process.exit(2); }
  }
  if (!(o.port > 0 && o.port < 65536)) { console.log('  端口不合法：' + o.port); process.exit(2); }
  if (o.slot && !/^agent-[AB]$/.test(o.slot)) { console.log('  槽名只能是 agent-A 或 agent-B：' + o.slot); process.exit(2); }
  // --version 只有和 --slot 搭配才有意义：单独给会被静默忽略，用户会以为装的是指定版本
  if (o.version && !o.slot) {
    console.log('  --version 只与 --slot 搭配使用（例：--slot agent-B --version 0.2.1-alpha.2）。');
    console.log('  要一次装两个槽请用 --a <版本> 与 --b <版本>。');
    process.exit(2);
  }
  return o;
}

function usage() {
  console.log('');
  console.log('  用法：node tools/install.js [选项]');
  console.log('    --a <版本|标签>   活动槽装的 dsh（默认 ' + DEFAULT_A + '）');
  console.log('    --b <版本|标签>   备用槽装的 dsh（默认 ' + DEFAULT_B + '）');
  console.log('    --single          只装一个槽（省一半空间，就没有秒级回滚了）');
  console.log('    --slot <槽名>     只装指定槽（agent-A / agent-B），配 --version 使用');
  console.log('    --version <版本>  与 --slot 搭配：这个槽装哪个版本');
  console.log('    --port <端口>     网页端口（默认 ' + DEFAULT_PORT + '）');
  console.log('    --registry <url>  只用一个 npm 源（默认官方源失败后自动换镜像）');
  console.log('    --force           即使已有 current.txt 也重写（不要随便用）');
  console.log('');
}

// ------------------------------------------------------------------ 工具
function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
}
function slotDir(name) { return path.join(RUNTIME, name); }
function pkgOf(name) { return path.join(slotDir(name), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'); }
function installedVersion(name) {
  try { return JSON.parse(fs.readFileSync(pkgOf(name), 'utf8')).version; } catch (e) { return null; }
}
function say(msg) { console.log('  ' + msg); }

function writeSlotPackage(name, spec) {
  fs.mkdirSync(slotDir(name), { recursive: true });
  fs.writeFileSync(path.join(slotDir(name), 'package.json'), JSON.stringify({
    name: 'dsh-agent-slot',
    version: '1.0.0',
    private: true,
    description: 'Portable DeepSeek Harness runtime slot (A/B).',
    dependencies: { '@deepseek-ai/dsh': spec },
  }, null, 2) + '\n', 'utf8');
}

function npmInstall(name, registries) {
  const t0 = Date.now();
  for (const reg of registries) {
    const tmo = reg.probed === false ? 120000 : 600000;
    say('安装到 ' + name + ' ← ' + reg.label + '（第一次要几分钟，请勿关窗；单次最多等 ' + Math.round(tmo / 60000) + ' 分钟）');
    const r = run(NODE_EXE, [NPM_CLI, 'install',
      '--cache=' + CACHE,
      '--registry=' + reg.url,
      '--fetch-timeout=60000', '--fetch-retries=1', '--fetch-retry-mintimeout=2000',
      '--no-audit', '--no-fund', '--loglevel=error'], { cwd: slotDir(name), timeout: tmo, env: require('./npmrc.js').env() });
    if (r.status === 0) {
      const secs = Math.round((Date.now() - t0) / 1000);
      say('完成：' + name + ' ← dsh ' + installedVersion(name) + '（' + secs + ' 秒）');
      return reg;
    }
    const tail = String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
    say(reg.label + ' 失败：' + tail);
  }
  return null;
}

// ------------------------------------------------------------------ 主流程
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  console.log('');
  console.log('  ── dsh-to-go 构建 ──');
  console.log('  仓库目录：' + ROOT);

  if (!fs.existsSync(NODE_EXE)) {
    console.log('');
    console.log('  找不到便携 Node：' + NODE_EXE);
    console.log('  请用 build.cmd 构建（它会先下载并校验 Node），或把 Node 解压到 runtime\\node。');
    return 1;
  }
  if (!fs.existsSync(NPM_CLI)) {
    console.log('  便携 Node 里没有 npm：' + NPM_CLI + '（Node 包不完整，请重新构建）');
    return 1;
  }
  const nodeVer = String(run(NODE_EXE, ['-v']).stdout || '').trim();
  say('便携 Node：' + nodeVer);

  for (const d of ['data', 'secrets', 'backups']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });

  const registries = opt.registry
    ? [{ url: opt.registry, label: '自定义源 ' + opt.registry }]
    : npmsrc.list();
  say('源偏好：' + npmsrc.read().mode + '（' + registries.map((r) => r.label).join(' → ') + '）');
  const liveRegistries = await npmsrc.order(registries, (m) => console.log(m));

  const plan = opt.slot
    ? [[opt.slot, opt.version || opt.a]]
    : (opt.single ? [['agent-A', opt.a]] : [['agent-A', opt.a], ['agent-B', opt.b]]);
  for (const [name, spec] of plan) {
    console.log('');
    say('槽 ' + name + ' ← 目标版本 ' + spec);
    writeSlotPackage(name, spec);
    if (!npmInstall(name, liveRegistries)) {
      console.log('');
      say('安装失败。可换源重试：node tools\\install.js --registry https://registry.npmmirror.com');
      return 1;
    }
  }

  // 活动槽：没装过就默认 A；指定 --slot 时若还没有记录则用它；
  // 已有记录时只有「那个槽里确实装着 dsh」才保留（否则会指向一个空槽/旧槽）
  let active = 'agent-A';
  if (opt.slot && !fs.existsSync(SLOT_FILE)) active = opt.slot;
  if (fs.existsSync(SLOT_FILE) && !opt.force) {
    const cur = fs.readFileSync(SLOT_FILE, 'utf8').trim();
    if (/^agent-[AB]$/.test(cur) && installedVersion(cur)) active = cur;
    else if (/^agent-[AB]$/.test(cur)) say('原来的活动槽 ' + cur + ' 里没有可用的 dsh，活动槽改为 ' + active);
  }
  fs.writeFileSync(SLOT_FILE, active + '\n', 'utf8');
  // 端口只在「显式指定」或「还没有记录」时才写：后台安装任务（jobs 的 install-slot）不带
  // --port，绝不能把用户设过的端口悄悄改回默认（否则下次启动突然换端口，很难排查）
  if (opt.portGiven || !fs.existsSync(PORT_FILE)) {
    fs.writeFileSync(PORT_FILE, String(opt.port) + '\n', 'utf8');
  } else {
    say('网页端口保持 ' + fs.readFileSync(PORT_FILE, 'utf8').trim() + '（本次没给 --port，不改动）');
  }

  const record = [
    'dsh-to-go 便携包 — 本地构建记录',
    '（本文件由构建器生成，只描述这台机器上的这次安装；不要提交到 git）',
    '',
    '构建时间   : ' + new Date().toISOString(),
    'Node       : ' + nodeVer + '  (' + NODE_EXE + ')',
    '活动槽     : ' + active,
    ...plan.map(([n]) => ('槽 ' + n.padEnd(8) + ': dsh ' + (installedVersion(n) || '未安装'))),
    '网页端口   : ' + opt.port,
    'npm 源     : ' + (opt.registry || NPM_MIRRORS.map((r) => r.url).join(' → ')),
    '',
    '升级：tools\rescue\dsh-config.cmd → 2，或图形配置页「槽位与升级」页',
    '回滚：把 runtime\\current.txt 改成另一个槽名即可',
  ].join('\n') + '\n';
  // 已有构建记录时不要覆盖（里面可能有升级历史），只追加一行
  if (fs.existsSync(VERSION_FILE)) {
    fs.appendFileSync(VERSION_FILE, '重新安装记录 ' + new Date().toISOString() + '：' +
      plan.map(([n, s]) => n + '←' + s).join('、') + '（活动槽 ' + active + '）\n', 'utf8');
  } else {
    fs.writeFileSync(VERSION_FILE, record, 'utf8');
  }

  console.log('');
  say('全部完成。活动槽 ' + active + '（dsh ' + installedVersion(active) + '）');
  console.log('');
  console.log('  下一步：');
  console.log('    1) 双击 tools\rescue\dsh-config.cmd  → 5) key 存密钥（或先用 dsh-ui.cmd 打开图形配置页）');
  console.log('    2) 双击 tools\rescue\dsh-config.cmd  → 7) site 配站点（官方 / 中转 / 自建都在这）');
  console.log('    3) 双击 dsh.cmd 启动；首次启动会在 data\\ 下建会话与工作区');
  console.log('');
  return 0;
}

main().then((rc) => process.exit(rc)).catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
