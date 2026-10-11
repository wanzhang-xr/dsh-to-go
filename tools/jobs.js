'use strict';
/**
 * 后台任务引擎（棒 2）
 *
 * 图形界面里「选好版本先下着、同时继续配站点」靠它。设计要点：
 *   - 同一个时刻只允许一个任务（互斥），第二个请求会拿到 busy 而不是排队等死。
 *   - 任务是**独立子进程**：网页服务不会被 npm 卡住，随时能响应别的请求。
 *   - 日志边跑边落盘，界面用 `readLog(id, fromByte)` 增量取，不重复传输。
 *   - 失败会**自动回滚**：装到一个原本没装过的槽失败时，把半成品删掉，便于重试。
 *   - 记录在 data\jobs\ 里，进程被杀/拔盘后重开能看到状态（标成 interrupted 而不是假装还在跑）。
 *
 * 任务种类：
 *   install-slot  {slot, version}   只装指定槽（向导「选版本」用）
 *   upgrade       {version}         装到空闲槽 → 启动检查 → 切指针（config.js 的升级流程）
 *   plugin-pnpm   {args, profile}   dsh plugin --profile <名> <pnpm 参数>（插件页用）
 *   custom        {cmd}             直接给命令（测试/扩展用）
 *
 * CLI:
 *   node tools/jobs.js run <kind> [--key value ...]
 *   node tools/jobs.js list | status | log <id> [fromByte] | wait <id> | cancel <id>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// 路径可以重定向（测试用；也方便将来把工具装到别处）
let ROOT = process.env.WZD_ROOT || path.resolve(__dirname, '..');
let RUNTIME = path.join(ROOT, 'runtime');
let DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
let JOBS_DIR = path.join(DATA, 'jobs');
let LOCK = path.join(JOBS_DIR, '.lock');
const LOG_CAP = 4 * 1024 * 1024;      // 单个任务日志上限，超出只保留尾部
const KEEP_JOBS = 30;                  // 最多保留多少条历史记录

/** 只在测试/特殊部署里用：把根目录与数据目录指到别处。 */
function setRoots(o) {
  const opts = o || {};
  if (opts.root) { ROOT = opts.root; RUNTIME = path.join(ROOT, 'runtime'); }
  if (opts.data) { DATA = opts.data; JOBS_DIR = path.join(DATA, 'jobs'); LOCK = path.join(JOBS_DIR, '.lock'); }
  return { ROOT, RUNTIME, DATA, JOBS_DIR };
}
function nodeExe() {
  const portable = path.join(RUNTIME, 'node', 'node.exe');
  return fs.existsSync(portable) ? portable : process.execPath;
}

// ------------------------------------------------------------------ 工具
function slotBin(slot) {
  return path.join(RUNTIME, slot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
function readSlot() {
  try {
    const v = fs.readFileSync(path.join(RUNTIME, 'current.txt'), 'utf8').trim();
    if (/^agent-[AB]$/.test(v)) return v;
  } catch (e) { /* default */ }
  return 'agent-A';
}
function nowIso() { return new Date().toISOString(); }
function ensureDirs() { fs.mkdirSync(JOBS_DIR, { recursive: true }); }
function metaFile(id) { return path.join(JOBS_DIR, id + '.json'); }
function logFile(id) { return path.join(JOBS_DIR, id + '.log'); }
function newId() { return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex'); }

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch (e) { return null; }
}
function writeMeta(meta) {
  ensureDirs();
  meta.updated = nowIso();
  const tmp = metaFile(meta.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, metaFile(meta.id));
  return meta;
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** 某个 PID 的命令行：结束进程前用它确认「这确实是本次任务」，防 PID 复用误杀。 */
function pidCommandLine(pid) {
  if (!pid) return '';
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + Number(pid) + '").CommandLine'],
      { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').trim();
  } catch (e) { return ''; }
}
function appendLog(id, text) {
  ensureDirs();
  fs.appendFileSync(logFile(id), text, 'utf8');
  // 超上限只留尾部，避免一次安装把盘写满。
  // 截断点要对齐到行首，否则会切出半个 UTF-8 字符；同时递增 logEpoch，
  // 让客户端知道自己手里的偏移量已经失效（否则界面会重复渲染或漏读）。
  try {
    const st = fs.statSync(logFile(id));
    if (st.size > LOG_CAP) {
      const buf = fs.readFileSync(logFile(id));
      let start = Math.max(0, buf.length - 512 * 1024);
      while (start < buf.length && (buf[start] & 0xC0) === 0x80) start++;   // 退到字符边界
      const nl = buf.indexOf(0x0A, start);
      if (nl >= 0 && nl + 1 < buf.length) start = nl + 1;                    // 退到行首
      const tail = buf.slice(start);
      fs.writeFileSync(logFile(id), Buffer.concat([
        Buffer.from('…（较早的日志已截断，只保留尾部）\n', 'utf8'), tail,
      ]));
      const m = readMeta(id);
      if (m) { m.logEpoch = (m.logEpoch || 0) + 1; m.logTruncatedAt = nowIso(); writeMeta(m); }
    }
  } catch (e) { /* 截断失败不影响任务 */ }
}

// ------------------------------------------------------------------ 任务定义
function installRollback(opts, pre) {
  const slotDir = path.join(RUNTIME, opts.slot);
  // 只有在「这个槽原本没有可用的 dsh」时才清理，避免删掉正在工作的安装
  if (!pre || pre.slotHadDsh !== false) {
    return { rolledBack: false, reason: '槽里原本就有 dsh，保留现场以便排查' };
  }
  for (const p of ['node_modules', 'package-lock.json']) {
    try { fs.rmSync(path.join(slotDir, p), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  return { rolledBack: true, reason: '已清掉半成品，可直接重试' };
}

const KINDS = {
  'install-slot': {
    label: (o) => '安装 dsh ' + o.version + ' 到 ' + o.slot,
    cmd: (o) => [nodeExe(), path.join(__dirname, 'install.js'), '--slot', o.slot, '--version', o.version],
    validate: (o) => {
      if (!/^agent-[AB]$/.test(String(o.slot || ''))) return '槽名只能是 agent-A 或 agent-B';
      if (!o.version) return '缺少 version';
      return null;
    },
    pre: (o) => ({ slotHadDsh: fs.existsSync(slotBin(o.slot)) }),
    rollback: installRollback,
  },
  upgrade: {
    label: (o) => '升级 dsh 到 ' + o.version,
    cmd: (o) => [nodeExe(), path.join(__dirname, 'config.js'), 'upgrade', o.version, '--yes'],
    validate: (o) => (o.version ? null : '缺少 version'),
  },
  'plugin-pnpm': {
    label: (o) => '插件操作：' + (Array.isArray(o.args) ? o.args.join(' ') : ''),
    cmd: (o) => {
      const slot = o.slot || readSlot();
      return [nodeExe(), slotBin(slot), 'plugin', '--profile', o.profile || 'web'].concat(o.args || []);
    },
    validate: (o) => (Array.isArray(o.args) && o.args.length ? null : '缺少 pnpm 参数'),
  },
  // 把 pnpm 装到盘上（dsh plugin 靠 PATH 找它；便携包本身不带）。
  // version 可以指定（例如 profile 是 pnpm 12 装的，就得装 12 那份），不指定则用 profile 需要的大版本。
  'pnpm-setup': {
    label: (o) => '准备 pnpm' + (o && o.version ? '（' + o.version + '）' : ''),
    cmd: (o) => {
      const opts = o || {};
      const want = opts.version || (function () {
        try {
          const p = require('./plugins.js');
          const info = p.pnpmInfo(opts.profile || 'web');
          return info.wantVersion || info.wantMajor || '';
        } catch (e) { return ''; }
      })();
      return [nodeExe(), path.join(__dirname, 'plugins.js'), 'setup-pnpm'].concat(want ? [String(want)] : []);
    },
    validate: () => null,
  },
  custom: {
    label: (o) => o.label || '自定义任务',
    cmd: (o) => o.cmd,
    validate: (o) => (Array.isArray(o.cmd) && o.cmd.length ? null : '缺少 cmd'),
  },
};

// ------------------------------------------------------------------ 状态
const QUEUED_GRACE_MS = 60 * 1000;              // 排队超过这么久说明发起进程已经不在了
const MAX_RUN_MS = 3 * 60 * 60 * 1000;          // 兜底：跑超过 3 小时按异常处理（安装不会这么久）

/** 把「进程已经不在了」的任务收拾干净：含排队未启动的、PID 被复用的、超长挂住的。 */
function reconcile() {
  ensureDirs();
  let changed = 0;
  for (const id of listIds()) {
    const m = readMeta(id);
    if (!m) continue;

    if (m.status === 'queued') {
      const age = Date.now() - Date.parse(m.createdAt || 0);
      if (!(age > QUEUED_GRACE_MS)) continue;
      m.status = 'interrupted';
      m.message = '任务还没开始就中断了（发起它的进程已退出）';
      m.endedAt = m.endedAt || nowIso();
      writeMeta(m);
      appendLog(id, '\n=== 任务结束：interrupted（' + m.message + '）===\n');
      changed++;
      continue;
    }

    if (m.status !== 'running') continue;
    const startedMs = Date.parse(m.startedAt || 0) || 0;
    const tooLong = startedMs > 0 && (Date.now() - startedMs) > MAX_RUN_MS;
    if (!pidAlive(m.pid) || tooLong) {
      if (m.cancelled) {
        // 用户主动取消导致的退出，别报成「崩溃」——语义要诚实
        m.status = 'cancelled';
        m.message = '被用户取消';
      } else {
        m.status = 'interrupted';
        m.message = tooLong
          ? '任务超过 ' + Math.round(MAX_RUN_MS / 3600000) + ' 小时仍未结束，按异常处理'
          : '进程已不在（服务窗口被关掉、拔盘或崩溃），任务按中断处理';
        // 中断的安装任务同样要收拾现场：否则半装的 node_modules 会留在槽里
        const def = KINDS[m.kind];
        if (def && def.rollback) {
          try {
            m.rollback = def.rollback(m.opts, m.pre || {});
            appendLog(id, '\n=== 自动回滚：' + m.rollback.reason + ' ===\n');
          } catch (e) { /* 回滚失败不影响状态记录 */ }
        }
      }
      m.endedAt = m.endedAt || nowIso();
      writeMeta(m);
      appendLog(id, '\n=== 任务结束：' + m.status + '（' + m.message + '）===\n');
      changed++;
    }
  }
  if (changed) releaseLockIfStale();
  return changed;
}

function listIds() {
  ensureDirs();
  return fs.readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function listJobs(limit) {
  reconcile();
  const ids = listIds().slice(-(limit || 20));
  return ids.map((id) => readMeta(id)).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** 占用中的任务：running，或刚建好还没开始跑的 queued（否则两个请求会同时被放行）。 */
function runningJob() {
  reconcile();
  for (const m of listJobs(50)) {
    if (m.status === 'running') return m;
    if (m.status === 'queued') return m;
  }
  return null;
}
function isBusy() { return !!runningJob(); }

// ------------------------------------------------------------------ 锁
function readLock() {
  try { return fs.readFileSync(LOCK, 'utf8').trim(); } catch (e) { return null; }
}
function releaseLockIfStale() {
  const holder = readLock();
  if (!holder) return;
  const m = readMeta(holder);
  // 排队中（queued）也是"正在进行"：它刚建好、马上要跑，锁不能被别人收走
  const active = !!m && (
    m.status === 'running' ? pidAlive(m.pid)
      : m.status === 'queued' ? (Date.now() - Date.parse(m.createdAt || 0)) < QUEUED_GRACE_MS
        : false);
  if (!active) {
    try { fs.unlinkSync(LOCK); } catch (e) { /* 已释放 */ }
  }
}
function acquireLock(id) {
  ensureDirs();
  reconcile();
  const holder = readLock();
  if (holder && holder !== id) {
    const hm = readMeta(holder);
    const holderActive = !!hm && (hm.status === 'running' || hm.status === 'queued') && (hm.status === 'queued' || pidAlive(hm.pid));
    // 持有者还活着 → 老老实实失败，绝不能覆盖锁（这是「互斥」唯一的保证）
    if (holderActive) return false;
    try { fs.unlinkSync(LOCK); } catch (e) { /* 已被释放或已被接手 */ }
  }
  try {
    fs.writeFileSync(LOCK, id, { flag: 'wx' });
    return true;
  } catch (e) {
    // 极小概率竞态：再确认一次持有者是否活着
    const h2 = readLock();
    if (h2 && h2 !== id) {
      const m2 = readMeta(h2);
      if (m2 && (m2.status === 'running' || m2.status === 'queued')) return false;
    }
    try { fs.writeFileSync(LOCK, id); return true; } catch (e2) { return false; }
  }
}
function releaseLock(id) {
  if (readLock() === id) { try { fs.unlinkSync(LOCK); } catch (e) { /* 忽略 */ } }
}

// ------------------------------------------------------------------ 创建与执行
function createJob(kind, opts) {
  const def = KINDS[kind];
  if (!def) return { ok: false, error: '未知任务种类：' + kind };
  const o = opts || {};
  const bad = def.validate ? def.validate(o) : null;
  if (bad) return { ok: false, error: bad };

  const running = runningJob();
  if (running) return { ok: false, busy: true, error: '已有任务在跑：' + running.label, job: running };

  const id = newId();
  const meta = {
    id, kind,
    label: def.label(o),
    opts: o,
    status: 'queued',
    createdAt: nowIso(), startedAt: null, endedAt: null,
    pid: null, exitCode: null, message: '', stage: '排队中',
    pre: def.pre ? def.pre(o) : null,
  };
  ensureDirs();
  writeMeta(meta);
  fs.writeFileSync(logFile(id), '=== ' + meta.label + ' ===\n开始时间：' + meta.createdAt + '\n', 'utf8');
  pruneOld();
  return { ok: true, job: meta };
}

/** 历史任务只保留最近 KEEP_JOBS 条；正在跑和排队中的永不删（否则任务会被自己的清理删掉）。 */
function pruneOld() {
  const ids = listIds();
  if (ids.length <= KEEP_JOBS) return;
  let toDelete = ids.length - KEEP_JOBS;
  for (const id of ids) {
    if (toDelete <= 0) break;
    const m = readMeta(id);
    if (m && (m.status === 'running' || m.status === 'queued')) continue;
    try { fs.unlinkSync(metaFile(id)); } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(logFile(id)); } catch (e) { /* 忽略 */ }
    toDelete--;
  }
}

/** 猜当前阶段（供界面显示；模式对齐子进程的**真实**文案，不做假的百分比）。 */
function guessStage(line) {
  const l = String(line);
  if (/便携 Node[：:]/.test(l)) return '准备运行环境';
  if (/正在安装到|安装到 agent-|尝试 npmjs|尝试 npmmirror/.test(l)) return '从 npm 下载安装';
  if (/官方源 失败|镜像源 失败|换源/.test(l)) return '换源重试';
  if (/完成：agent-|全部完成/.test(l)) return '安装完成';
  if (/启动检查|--version|校验/.test(l)) return '安装后检查';
  if (/活动槽已切到|指针/.test(l)) return '切换活动槽';
  if (/失败|error|ERR!|错误/.test(l)) return '出错';
  return null;
}

function runJob(id) {
  const meta = readMeta(id);
  if (!meta) return { ok: false, error: '没有这个任务：' + id };
  const def = KINDS[meta.kind];
  const cmd = def.cmd(meta.opts);
  if (!cmd || !cmd.length) return { ok: false, error: '任务命令为空' };

  if (!acquireLock(id)) {
    meta.status = 'failed';
    meta.message = '拿不到执行锁（可能另一个窗口正在跑任务）';
    meta.endedAt = nowIso();
    writeMeta(meta);
    return { ok: false, job: meta, error: meta.message };
  }

  const cmdLine = cmd.map((c) => (c === nodeExe() ? 'node' : c)).join(' ');
  meta.cmdLine = cmdLine;
  appendLog(id, '\n$ ' + cmdLine + '\n\n');

  let child;
  try {
    // 插件的装/卸是交给 profile 目录里的 pnpm 做的（dsh plugin 只转发参数），
    // 所以这里必须把盘上自带的 pnpm 放进 PATH，并把 store 落在盘上。
    const baseEnv = Object.assign({}, process.env, {
      DSH_HOME: DATA,
      DSH_AGENTS_HOME: path.join(DATA, 'agents'),
      npm_config_cache: path.join(RUNTIME, 'npm-cache'),
    });
    const env = meta.kind === 'plugin-pnpm' ? require('./plugins.js').pnpmEnv(baseEnv, (meta.opts && meta.opts.profile) || 'web') : baseEnv;
    child = spawn(cmd[0], cmd.slice(1), {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    meta.status = 'failed';
    meta.message = '无法启动命令：' + e.message;
    meta.endedAt = nowIso();
    writeMeta(meta);
    appendLog(id, '\n=== 无法启动命令：' + e.message + ' ===\n');
    releaseLock(id);
    return { ok: false, job: meta };
  }
  // 关键：status 与 pid 一次性落盘。分两次写会留下「running 但 pid 为空」的窗口，
  // 另一个进程正好在这时 reconcile 就会把任务误判成中断。
  meta.status = 'running';
  meta.startedAt = nowIso();
  meta.stage = '启动中';
  meta.pid = child.pid;
  writeMeta(meta);

  const onData = (buf) => {
    const text = buf.toString();
    appendLog(id, text);
    const m = readMeta(id);
    if (m && m.status === 'running') {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) {
        m.lastLine = lines[lines.length - 1].slice(0, 300);
        m.stage = guessStage(lines[lines.length - 1]) || m.stage;
        writeMeta(m);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      const m = readMeta(id) || meta;
      m.status = 'failed';
      m.message = '无法启动命令：' + err.message;
      m.endedAt = nowIso();
      writeMeta(m);
      appendLog(id, '\n=== 无法启动命令：' + err.message + ' ===\n');
      releaseLock(id);
      resolve({ ok: false, job: m });
    });
    child.on('exit', (code, signal) => {
      const m = readMeta(id) || meta;
      m.exitCode = code;
      m.endedAt = nowIso();
      if (m.cancelled) {
        m.status = 'cancelled';
        m.stage = '已取消';
        m.message = '被用户取消';     // 覆盖 reconcile 可能写下的「中断」措辞
      } else if (code === 0) {
        m.status = 'done';
        m.stage = '完成';
        m.message = '成功';
      } else {
        m.status = 'failed';
        m.stage = '失败';
        m.message = '退出码 ' + code + (signal ? '（信号 ' + signal + '）' : '');
        const rb = def.rollback ? def.rollback(meta.opts, meta.pre || {}) : null;
        if (rb) {
          m.rollback = rb;
          appendLog(id, '\n=== 自动回滚：' + rb.reason + ' ===\n');
        }
      }
      appendLog(id, '\n=== 结束：' + m.status + (m.exitCode === null ? '' : '（退出码 ' + m.exitCode + '）') + ' ===\n');
      writeMeta(m);
      releaseLock(id);
      resolve({ ok: m.status === 'done', job: m });
    });
  });
}

/** 建了就跑；界面里用「先建后跑」是为了拿到 id 再返回。 */
async function startJob(kind, opts) {
  const c = createJob(kind, opts);
  if (!c.ok) return c;
  const r = await runJob(c.job.id);
  return r;
}
/** 后台任务崩溃兜底：异常绝不能逃逸出去（网页服务要长期存活）。 */
function markJobCrashed(id, e) {
  try {
    const m = readMeta(id) || { id, kind: 'custom', label: '未知任务', opts: {} };
    m.status = 'failed';
    m.message = '后台执行出错：' + ((e && e.message) || e);
    m.endedAt = nowIso();
    writeMeta(m);
    appendLog(id, '\n=== 后台执行出错：' + ((e && e.stack) || e) + ' ===\n');
    releaseLock(id);
  } catch (e2) { /* 兜底里再出错就只能放弃 */ }
}

function spawnJob(kind, opts) {
  const c = createJob(kind, opts);
  if (!c.ok) return c;
  setTimeout(() => {
    try {
      Promise.resolve(runJob(c.job.id)).catch((e) => markJobCrashed(c.job.id, e));
    } catch (e) {
      markJobCrashed(c.job.id, e);
    }
  }, 0);   // 立刻返回，任务在后台跑
  return c;
}

function readLog(id, from) {
  const f = logFile(id);
  let size = 0;
  try { size = fs.statSync(f).size; } catch (e) { return { ok: false, error: '没有这个任务的日志', text: '', next: 0, size: 0 }; }
  // 偏移量越界（日志被截断过，或客户端拿的是上一代偏移量）→ 从头给，并明确告诉它这是重来
  const reset = !(Number.isFinite(from) && from >= 0 && from <= size);
  const start = reset ? 0 : from;
  let text = '';
  try {
    const fd = fs.openSync(f, 'r');
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) {
    return { ok: false, error: e.message, text: '', next: size, size };
  }
  const m = readMeta(id) || {};
  return { ok: true, text, next: size, size, reset, logEpoch: m.logEpoch || 0 };
}

function cancelJob(id) {
  reconcile();
  const m = readMeta(id);
  if (!m) return { ok: false, error: '没有这个任务：' + id };
  if (m.status !== 'running') return { ok: false, error: '任务当前状态是 ' + m.status + '，不需要取消' };
  m.cancelled = true;
  writeMeta(m);
  appendLog(id, '\n=== 正在取消（杀掉子进程树）===\n');
  // 杀之前先确认这个 PID 还属于本次任务：PID 可能已经被系统复用给无关进程
  const cmd = pidCommandLine(m.pid);
  if (!cmd) {
    appendLog(id, '=== 未结束进程：查不到 PID ' + m.pid + ' 的命令行（多半已经退出了）===\n');
  } else if (!/(node|install\.js|launch\.js|config\.js|@deepseek-ai|dsh)/i.test(cmd)) {
    appendLog(id, '=== 未结束进程：PID ' + m.pid + ' 的命令行不像本次任务，可能已被复用 ===\n' + cmd.slice(0, 200) + '\n');
  } else {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(m.pid)], { windowsHide: true }); } catch (e) { /* 忽略 */ }
  }
  return { ok: true, job: readMeta(id) };
}

function waitFor(id, timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 30 * 60 * 1000;
  return new Promise((resolve) => {
    const tick = () => {
      const m = readMeta(id);
      if (!m) return resolve({ ok: false, error: '没有这个任务：' + id });
      if (m.status !== 'running' && m.status !== 'queued') return resolve({ ok: m.status === 'done', job: m });
      if (Date.now() - t0 > limit) return resolve({ ok: false, timeout: true, job: m });
      setTimeout(tick, 500);
    };
    tick();
  });
}

function status() {
  const running = runningJob();
  return {
    busy: !!running,
    running: running ? { id: running.id, kind: running.kind, label: running.label, stage: running.stage, startedAt: running.startedAt } : null,
    jobs: listJobs(10),
  };
}

module.exports = {
  KINDS, setRoots, nodeExe,
  createJob, spawnJob, runJob, startJob, cancelJob, waitFor,
  listJobs, status, isBusy, runningJob, reconcile, readMeta, readLog, guessStage,
  installRollback,
  get ROOT() { return ROOT; },
  get DATA() { return DATA; },
  get JOBS_DIR() { return JOBS_DIR; },
};

// ------------------------------------------------------------------ CLI
async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'status').toLowerCase();
  const kv = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { kv[k] = next; i++; } else kv[k] = true;
    }
  }
  if (cmd === 'status' || cmd === 'list') {
    const s = status();
    console.log('');
    console.log('  忙碌：' + (s.busy ? '是（' + s.running.label + '　阶段：' + s.running.stage + '）' : '否'));
    for (const j of s.jobs) {
      console.log('  - ' + j.id + '  ' + j.status.padEnd(11) + ' ' + j.label + (j.message ? '  [' + j.message + ']' : ''));
    }
    console.log('');
    return 0;
  }
  if (cmd === 'run') {
    const kind = argv[1];
    if (kind === 'install-slot') { kv.slot = kv.slot || 'agent-A'; kv.version = kv.version || kv.a; }
    if (kind === 'custom' && kv.cmdline) kv.cmd = String(kv.cmdline).split(' ');
    if (kind === 'plugin-pnpm' && kv.args) kv.args = String(kv.args).split(' ');
    const c = createJob(kind, kv);
    if (!c.ok) { console.log('  无法创建任务：' + c.error); return 1; }
    console.log('  任务已创建：' + c.job.id + '　（' + c.job.label + '）');
    // 命令行下必须等任务结束：进程一退，子进程的收尾（写状态、清锁）就没人做了。
    // 网页端走的是 spawnJob（非阻塞），那边由长驻的服务进程负责收尾。
    const r = await runJob(c.job.id);
    console.log('  结果：' + r.job.status + '　' + (r.job.message || '') +
      (r.job.rollback ? '　回滚：' + r.job.rollback.reason : ''));
    console.log('  日志：node tools/jobs.js log ' + c.job.id);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'wait') {
    const r = await waitFor(argv[1]);
    if (!r.job) { console.log('  ' + r.error); return 1; }
    console.log('  结果：' + r.job.status + '　' + (r.job.message || ''));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'log') {
    const r = readLog(argv[1], argv[2] ? Number(argv[2]) : 0);
    process.stdout.write(r.text);
    console.error('\n(下一偏移量 ' + r.next + ' / 共 ' + r.size + ' 字节)');
    return 0;
  }
  if (cmd === 'cancel') {
    const r = cancelJob(argv[1]);
    console.log(r.ok ? '  已发送取消。' : '  ' + r.error);
    return r.ok ? 0 : 1;
  }
  console.log('用法：node tools/jobs.js <run <kind> [--k v]|status|list|log <id> [from]|wait <id>|cancel <id>>');
  return 2;
}

if (require.main === module) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error('任务引擎错误：' + e.message); process.exit(1); });
}
