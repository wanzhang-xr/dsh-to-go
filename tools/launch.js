'use strict';
/**
 * Portable DeepSeek Harness launcher.
 *
 * Responsibilities (all in-process, nothing persists to the host):
 *   1. resolve the active runtime slot (A/B) from runtime/current.txt
 *   2. inject every path so dsh keeps ALL user data on this drive
 *   3. unlock the A2 encrypted key store and hand the plaintext key to the child
 *      process environment only (never to a file, never to a command line)
 *   4. exec the dsh CLI of the active slot with inherited stdio
 *
 * Usage:
 *   node tools/launch.js web [-- extra dsh args]      # Web UI (default port 3180)
 *   node tools/launch.js cli <dsh args...>            # any dsh profile / headless run
 *   node tools/launch.js raw <dsh args...>            # pass args straight through
 *   node tools/launch.js selftest                     # preflight report, no agent
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const secretLib = require('./secret.js');
const sitesLib = require('./sites.js');
const watchdog = require('./watchdog.js');

/** 杀一整棵进程树（Windows 用 taskkill /T）——盘已经没了，没时间温柔 */
function killTree(pid) {
  if (!pid) return false;
  try {
    require('child_process').spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    return true;
  } catch (e) {
    try { process.kill(pid); return true; } catch (e2) { return false; }
  }
}

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const NODE_DIR = path.join(RUNTIME, 'node');
const NODE_EXE = path.join(NODE_DIR, 'node.exe');
const DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const AGENTS_HOME = path.join(DATA, 'agents');
const TMP = path.join(RUNTIME, 'tmp');
const PORT_FILE = path.join(RUNTIME, 'port.txt');
const OVERLAY = path.join(DATA, 'site-patch.yml');
const SLOT_FILE = path.join(RUNTIME, 'current.txt');
const LOG_DIR = path.join(DATA, 'logs');

function readSlot() {
  try {
    const v = fs.readFileSync(SLOT_FILE, 'utf8').trim();
    if (/^agent-[AB]$/.test(v)) return v;
  } catch (e) { /* default below */ }
  return 'agent-A';
}

function readPort() {
  try {
    const v = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    if (v >= 1 && v <= 65535) return v;
  } catch (e) { /* default below */ }
  return 3180;
}

function agentDir(slot) { return path.join(RUNTIME, slot || readSlot()); }
function dshBin(slot) { return path.join(agentDir(slot), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); }

function dshVersion(slot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(agentDir(slot), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (e) {
    return 'not-installed';
  }
}

function tempRoot(env) {
  // Where the harness process keeps its temp files.
  //
  // DEFAULT = the host user temp. The Windows ACL sandbox creates its private temp
  // directory under os.tmpdir() and then applies a security descriptor that also needs
  // WRITE_OWNER (it writes an integrity label). A data/removable volume whose root
  // grants the signed-in user only Modify (Authenticated Users:(M) with a non-elevated
  // token) makes that call fail with Win32 5 = ACCESS_DENIED, which aborts the whole
  // workspace-write policy. Opting back onto the drive is possible, but only when the
  // drive's ACL grants the user WRITE_OWNER: create runtime\usb-temp.txt.
  if (fs.existsSync(path.join(RUNTIME, 'usb-temp.txt'))) return TMP;
  const local = env.LOCALAPPDATA || process.env.LOCALAPPDATA;
  return local ? path.join(local, 'Temp') : 'C:\\Windows\\Temp';
}

function buildEnv(extra) {
  const slot = readSlot();
  const env = Object.assign({}, process.env, extra || {});
  env.DSH_HOME = DATA;
  env.DSH_AGENTS_HOME = AGENTS_HOME;
  env.DSH_RESOURCE_CACHE = path.join(DATA, 'cache', 'resources');
  env.npm_config_cache = path.join(RUNTIME, 'npm-cache');
  env.npm_config_prefix = path.join(RUNTIME, 'npm-global');
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  // npm 只读盘内配置（宿主 ~/.npmrc 不参与），换机行为一致
  const rcPath = require('./npmrc.js').ensure();
  if (rcPath) env.npm_config_userconfig = rcPath;
  const tmp = tempRoot(env);
  env.TEMP = tmp;
  env.TMP = tmp;
  delete env.TMPDIR;
  env.PATH = [NODE_DIR, path.join(agentDir(slot), 'node_modules', '.bin'), process.env.PATH || ''].join(path.delimiter);
  return env;
}

function log(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
  } catch (e) { /* logging must never break a launch */ }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function fail(msg) {
  console.error('\n【启动器】' + msg + '\n');
  process.exit(1);
}

/** 插件启停状态（插件页维护；还没有这个文件就等于都没停用）。 */
function readDisabledPlugins() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'plugins.json'), 'utf8'));
    return Array.isArray(j.disabled) ? j.disabled : [];
  } catch (e) {
    return [];
  }
}

/** 覆盖层始终由 data\sites.json 生成；启动前刷新一次，失败也不能挡住启动。 */
function refreshOverlay() {
  try {
    const st = sitesLib.readState();
    if (!st.sites.length) return null;
    return sitesLib.writeOverlay(st, { disabled: readDisabledPlugins() }).overlay;
  } catch (e) {
    log('overlay refresh failed: ' + e.message);
    return null;
  }
}

/**
 * 这次启动该给子进程注入哪些环境变量名（只看站点表，不涉及密钥值）。
 * 没有站点表（老配置）时沿用单密钥变量名。
 */
function plannedEnvNames() {
  const st = sitesLib.readState();
  const enabled = st.sites.filter((s) => s.enabled !== false);
  if (enabled.length) return enabled.map((s) => s.keyEnv);
  return [secretLib.keyName()];
}

async function resolveKey(env, opts) {
  if (opts.noKey) return env;
  const names = plannedEnvNames();

  // 逃生口：直接给值（脚本/测试用），不落盘
  if (process.env.WZD_KEY) {
    const n = process.env.WZD_KEY_NAME || names[0] || secretLib.keyName();
    env[n] = process.env.WZD_KEY;
    console.log('【启动器】密钥来自 WZD_KEY 环境变量（变量名 ' + n + '）');
    return env;
  }

  const file = secretLib.secretFile();
  const legacy = secretLib.legacyFile();
  // 「文件存在但读不出来」必须显式报出来，否则会被当成"还没配密钥"而静默跳过注入，
  // 用户只能在 dsh 里看到 MISSING_CREDENTIAL，找不到真实原因
  const stInfo = secretLib.storeState ? secretLib.storeState(file) : { state: 'missing' };
  if (stInfo.state === 'corrupt') {
    console.log('\n【启动器】密钥库文件存在但读不出来：' + (stInfo.reason || '内容损坏') + '（' + file + '）');
    console.log('【启动器】已跳过密钥注入，dsh 会以 MISSING_CREDENTIAL 失败。');
    console.log('【启动器】可以从 backups\\ 里找旧覆盖层/旧密钥文件恢复，或用 dsh-ui.cmd 重新设置密钥。');
    return env;
  }
  if (!fs.existsSync(file) && !fs.existsSync(legacy)) {
    console.log('\n【启动器】还没有配置加密密钥：' + file);
    console.log('【启动器】dsh 仍会启动，但模型请求会以 MISSING_CREDENTIAL 失败。');
    console.log('【启动器】请运行 tools\rescue\dsh-config.cmd → 5) key，或用 dsh-ui.cmd 打开图形配置页。');
    const a = (await ask('无密钥继续启动？[Y/n] ')).toLowerCase();
    if (a === 'n' || a === 'no') process.exit(0);
    return env;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    let pass;
    try {
      pass = secretLib.promptPass('U 盘密钥口令');
    } catch (e) {
      fail(e.message + '\n【启动器】提示：请从 cmd 窗口双击运行 dsh.cmd（或在图形界面里启动），掩码口令提示才会出现。');
    }

    // v2：一个文件多站点密钥
    if (secretLib.readStore(file)) {
      const r = secretLib.unlockAll(pass, file);
      if (r.ok) {
        const missing = [];
        let injected = 0;
        // 回退匹配按站点表的 id↔keyEnv 映射来查，而不是从变量名反推：
        // 站点 id 常带连字符（my-relay），反推会得到 my_relay，永远对不上
        const sitesState = sitesLib.readState();
        const metaForName = (name) => r.meta.find((m) => m.keyName === name) ||
          (() => { const s = sitesState.sites.find((x) => x.keyEnv === name); return s ? r.meta.find((m) => m.siteId === s.id) : null; })();
        for (const name of names) {
          const meta = metaForName(name);
          if (meta && r.keys[meta.siteId] !== undefined && r.keys[meta.siteId] !== null) {
            env[name] = r.keys[meta.siteId];
            injected++;
          } else missing.push(name);
        }
        if (r.failed && r.failed.length) {
          console.log('【启动器】有 ' + r.failed.length + ' 个站点的密钥解不开（记录可能损坏）：' + r.failed.join('、'));
        }
        // 补齐：新密钥库还没存的站点，看看旧的单密钥文件里有没有同一把钥匙
        // （否则「新存了一个站点」会让旧密钥突然失效——那是很难排查的坑）
        let filledFromLegacy = 0;
        if (missing.length && fs.existsSync(legacy)) {
          const lr = secretLib.unlock({ file: legacy, pass });
          if (lr.ok && lr.keyName && missing.indexOf(lr.keyName) >= 0) {
            env[lr.keyName] = lr.secret;
            filledFromLegacy++;
            missing.splice(missing.indexOf(lr.keyName), 1);
          }
        }
        console.log('【启动器】密钥已解锁：' + injected + ' 个站点注入成功（' + names.join('、') + '）' +
          (filledFromLegacy ? '，另有 ' + filledFromLegacy + ' 个沿用旧密钥文件' : ''));
        if (missing.length) {
          console.log('【启动器】没有这几个站点的密钥：' + missing.join('、') + '（这些站点会以 MISSING_CREDENTIAL 失败）');
        }
        if (filledFromLegacy || (missing.length && fs.existsSync(legacy))) {
          console.log('【启动器】建议在图形配置页里把旧密钥导入新密钥库，之后就能只维护一个文件。');
        }
        log('keys unlocked injected=' + injected + ' legacy=' + filledFromLegacy + ' names=' + names.join(','));
        return env;
      }
      if (r.reason === 'corrupt') {
        console.log('\n【启动器】密钥库读不出来：' + (r.error || '内容损坏') + '（' + file + '）');
        console.log('【启动器】已跳过密钥注入，请排查文件或用图形配置页重新设置。');
        return env;
      }
      console.log('\n【启动器】口令错误（' + attempt + '/3）');
      continue;
    }

    // 旧版单密钥文件：照旧注入，并提示可以迁移
    const r = secretLib.unlock({ file: legacy, pass });
    if (r.ok) {
      env[r.keyName] = r.secret;
      console.log('【启动器】密钥已解锁（' + r.keyName + '，' + r.secret.length + ' 字符，仅存在于内存）');
      console.log('【启动器】想用多站点密钥库可在图形配置页里迁移（旧文件不会被删）。');
      log('legacy key unlocked name=' + r.keyName);
      return env;
    }
    if (r.reason === 'missing') return env;
    console.log('\n【启动器】口令错误（' + attempt + '/3）');
  }
  fail('连续 3 次口令错误，已中止启动。');
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = (argv[0] || 'web').toLowerCase();
  let dshArgs;

  if (mode === 'keycheck') {
    const env = await resolveKey(buildEnv(), {});
    const names = plannedEnvNames();
    const probe = 'const n=' + JSON.stringify(names) + ';' +
      'console.log(n.map(function (x) { return x + ": " + (process.env[x] ? ("子进程已收到，长度 " + process.env[x].length) : "子进程未收到"); }).join("\\n"));';
    const r = require('child_process').spawnSync(NODE_EXE, ['-e', probe], { env, encoding: 'utf8' });
    process.stdout.write(String(r.stdout || ''));
    return r.status === 0 ? 0 : 1;
  }

  if (mode === 'selftest') {
    const slot = readSlot();
    const key = secretLib.secretFile();
    console.log('U 盘根目录 : ' + ROOT);
    console.log('活动槽     : ' + slot + '  (dsh ' + dshVersion(slot) + ')');
    console.log('另一槽     : ' + (slot === 'agent-A' ? 'agent-B' : 'agent-A') + '  (dsh ' + dshVersion(slot === 'agent-A' ? 'agent-B' : 'agent-A') + ')');
    console.log('便携 Node  : ' + NODE_EXE + '  ' + (fs.existsSync(NODE_EXE) ? '（存在）' : '（缺失！）'));
    console.log('数据目录   : ' + DATA);
    console.log('网页端口   : ' + readPort());
    console.log('密钥文件   : ' + (fs.existsSync(key) ? key + '（已配置）' : key + '（未配置）'));
    const legacy = secretLib.legacyFile();
    if (fs.existsSync(legacy)) console.log('旧密钥文件 : ' + legacy + '（可迁移，未被删）');
    try {
      const items = secretLib.listKeys();
      console.log('已存站点密钥: ' + (items.length ? items.map((x) => x.siteId + '(' + (x.length || '?') + '字符)').join('、') : '（无）'));
    } catch (e) { /* 没有密钥库 */ }
    const st = sitesLib.readState();
    const enabled = st.sites.filter((s) => s.enabled !== false);
    console.log('站点       : ' + (st.sites.length ? st.sites.length + ' 个（启用 ' + enabled.length + ' 个）：' +
      st.sites.map((s) => s.id + (s.enabled === false ? '×' : '')).join('、') : '（未配置，走 dsh 默认）'));
    console.log('默认模型   : ' + (st.default ? st.default.siteId + ' / ' + st.default.model : '（未设置）'));
    console.log('注入变量名 : ' + plannedEnvNames().join('、'));
    console.log('停用插件   : ' + (readDisabledPlugins().length ? readDisabledPlugins().join('、') : '（无）'));
    console.log('站点覆盖层 : ' + (fs.existsSync(OVERLAY) ? OVERLAY + '（会作为 --patch 传给 dsh）' : '未配置'));
    console.log('临时目录   : ' + tempRoot(process.env) + (fs.existsSync(path.join(RUNTIME, 'usb-temp.txt')) ? '（在 U 盘上：ACL 沙箱可能失败）' : '（宿主，推荐）'));
    return 0;
  }

  // 先把覆盖层按站点表刷新——必须在决定 --patch 参数之前：否则「站点表已配置但覆盖层
  // 文件还不存在」的首次启动会判定为"没有覆盖层"而不加 --patch，配置被静默忽略到下次启动。
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
  } catch (e) { /* 目录建不出来时后面会报更具体的错 */ }
  if (refreshOverlay()) log('overlay refreshed');

  // The relay/self-hosted site overlay goes in through dsh's own --patch flag.
  // Argument order matters: the profile must be given as `--profile <name>` (or as
  // argv[0]); a launcher flag placed *before* a bare command name makes dsh answer
  // "error: --profile <name> is required". Verified working orders:
  //   --profile web --patch <f> <app args>     (used for web mode)
  //   <command> --patch <f> <rest>             (used when the user passed a command)
  //   --patch <f> --version                    (flag-only invocations)
  const withPatch = (args) => {
    if (!fs.existsSync(OVERLAY)) return args;
    const a = args.slice();
    if (a[0] === '--profile' && a[1]) return a.slice(0, 2).concat(['--patch', OVERLAY], a.slice(2));
    if (a[0] && !a[0].startsWith('-')) return [a[0], '--patch', OVERLAY].concat(a.slice(1));
    return ['--patch', OVERLAY].concat(a);
  };
  if (mode === 'web') dshArgs = withPatch(['--profile', 'web'].concat(['--port', String(readPort())], argv.slice(1)));
  else if (mode === 'cli') dshArgs = withPatch(argv.slice(1).length ? argv.slice(1) : ['--help']);
  else dshArgs = withPatch(argv.slice(1));

  const slot = readSlot();
  const bin = dshBin(slot);
  if (!fs.existsSync(NODE_EXE)) fail('未找到便携 Node：' + NODE_EXE);
  if (!fs.existsSync(bin)) fail('活动槽 ' + slot + ' 里没有 dsh（' + bin + '）');

  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const env = await resolveKey(buildEnv(), { noKey: argv.includes('--no-key') });
  const label = '活动槽 ' + slot + ' ｜ dsh ' + dshVersion(slot) + ' ｜ 数据目录 ' + DATA;
  console.log('【启动器】' + label);
  log('launch slot=' + slot + ' version=' + dshVersion(slot) + ' args=' + dshArgs.join(' '));

  const child = spawn(NODE_EXE, [bin].concat(dshArgs.filter((a) => a !== '--no-key')), {
    env,
    stdio: 'inherit',
    cwd: process.cwd(),
    windowsHide: false,
  });
  child.on('exit', (code, signal) => {
    log('exit code=' + code + ' signal=' + signal);
    process.exit(code === null ? 1 : code);
  });

  // 拔盘守护：盘被拔走后立刻收摊。否则 dsh 会继续对着一个不存在的盘干活——
  // 会话写不回去、任务白跑，等盘插回来看到的还是旧状态，那才是真正的损失。
  const watch = new watchdog.DriveWatch({
    hostTempDir: tempRoot(process.env),
    role: 'launcher',
    log: (l) => log(l),
    onLost: (rec) => {
      console.log('');
      console.log('【启动器】本盘已不在（' + rec.reason + '）：立刻停止 dsh，避免继续在没有盘的情况下运行。');
      console.log('【启动器】这次丢盘的记录写在：' + (rec.log || '宿主临时目录（没写进去）'));
      killTree(child.pid);
      setTimeout(() => process.exit(3), 2000);
    },
  });
  watch.start();
  return -1; // keep the event loop alive until the child exits
}

module.exports = {
  ROOT, RUNTIME, DATA, NODE_EXE, OVERLAY,
  readSlot, readPort, dshBin, dshVersion, buildEnv, tempRoot,
  plannedEnvNames, readDisabledPlugins, refreshOverlay,
};

if (require.main === module) {
  main().then((rc) => { if (rc >= 0) process.exit(rc); }).catch((e) => fail(e.message));
}
