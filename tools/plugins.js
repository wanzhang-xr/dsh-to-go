/**
 * 插件层：**未运行状态**下的插件维护（列条目 / 启停 / 安装 / 卸载）。
 *
 * 已验证的事实（别照猜，改前先复核）：
 *  1. 条目启停走「按 id 打补丁」：`- id: <条目id>` + `disabled: true`，写在我们的覆盖层里，
 *     由启动器作为 `--patch` 传入。**运行时确实生效**（实测：停用 `webserver` 后
 *     dsh 启动失败并列出 4 个等待 webServer 服务的插件）。
 *  2. **`--dump-config` 不体现覆盖层给的 disabled**（不生效也别以为是没生效）：
 *     dump 只反映 bundle 层自带的 disabled。所以「停用是否生效」只能在运行时报错里看，
 *     不能看 dump。这里只用 dump 拿「有哪些条目、id 叫什么、官方默认是否停用」。
 *  3. 安装/卸载 = `dsh plugin --profile <名> add|remove <包名>`，它把参数原样转给
 *     **profile 目录里的 pnpm**：所以 PATH 里必须有 pnpm，否则报
 *     「pnpm was not found; install pnpm and make it available on PATH」。
 *  4. 安装有**版本兼容闸门**：候选插件的 peerDependencies 与当前 dsh 版本不匹配会被拒绝，
 *     并给出显式风险豁免命令（dsh plugin allow-version ... --accept-risk）。
 *  5. 插件没有官方索引/发现 API：npm 上按包名找（本模块提供 registry 关键词搜索做辅助）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
let DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const NODE_EXE = path.join(RUNTIME, 'node', 'node.exe');
const PNPM_DIR = path.join(RUNTIME, 'pnpm');
const PNPM_STORE = path.join(RUNTIME, 'pnpm-store');
/** 我们自己的覆盖层条目 id——不能出现在「可启停的插件」列表里（那是站点配置）。 */
const RESERVED = ['llm-pi-ai', 'agent-default-model'];

/** 测试/多实例用：重定向数据目录与根目录。 */
function setRoots(opts) {
  const o = opts || {};
  if (o.root) {
    ROOT_OVERRIDE = path.resolve(o.root);
  }
  if (o.data) DATA = path.resolve(o.data);
  return { ROOT, DATA, pluginsFile: pluginsFile() };
}
let ROOT_OVERRIDE = null;

function pluginsFile() { return path.join(DATA, 'plugins.json'); }
function profileDir(profile) { return path.join(DATA, 'profiles', profile || 'web'); }

/** 读启停状态：`{ disabled: [...], enabled: [...] }`（enabled 用于显式启用官方默认停用的条目）。 */
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(pluginsFile(), 'utf8'));
    return {
      disabled: (Array.isArray(j.disabled) ? j.disabled : []).map(String),
      enabled: (Array.isArray(j.enabled) ? j.enabled : []).map(String),
    };
  } catch (e) {
    return { disabled: [], enabled: [] };
  }
}

/** 写启停状态（排序去重后写，diff 干净；我们自己的条目 id 不许出现在这里）。 */
function writeState(state) {
  const clean = (a) => Array.from(new Set((a && a.length ? a : []) || [])).map(String)
    .filter((x) => x && RESERVED.indexOf(x) < 0).sort();
  const out = { disabled: clean((state || {}).disabled), enabled: clean((state || {}).enabled) };
  // 两边都出现的以 disabled 为准（避免自相矛盾的覆盖层）
  out.enabled = out.enabled.filter((x) => out.disabled.indexOf(x) < 0);
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = pluginsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, pluginsFile());
  return out;
}

/** 我们对某个条目的启停决定：'disabled' | 'enabled' | null（没表态，跟随官方默认）。 */
function ourChoice(state, id) {
  const d = (state && state.disabled) || [];
  const e = (state && state.enabled) || [];
  if (d.indexOf(id) >= 0) return 'disabled';
  if (e.indexOf(id) >= 0) return 'enabled';
  return null;
}

/**
 * 把 dump 文本解析成条目列表。
 * 顶层条目是**行首**的 `- id: X`；缩进的 `- id:` 是条目 config 里的引用（比如预设里的工具清单），不是条目本身。
 */
function parseEntries(text) {
  const out = [];
  let cur = null;
  let section = '';
  const finish = () => { if (cur) { out.push(cur); cur = null; } };
  for (const line of String(text).split('\n')) {
    const sec = /^# == (.+)$/.exec(line);
    if (sec) { finish(); section = sec[1].trim(); continue; }
    const top = /^- id: (.+)$/.exec(line);
    if (top) {
      finish();
      cur = { id: top[1].trim().replace(/^['"]|['"]$/g, ''), name: null, disabledShipped: false, disabledExpr: null, section };
      continue;
    }
    if (!cur) continue;
    if (/^\S/.test(line)) { finish(); continue; }          // 段落/文件头，条目结束
    const n = /^\s+name: (.+)$/.exec(line);
    if (n && !cur.name) { cur.name = n[1].trim().replace(/^['"]|['"]$/g, ''); continue; }
    const d = /^\s+disabled: (.+)$/.exec(line);
    if (d) {
      const v = d[1].trim();
      if (v === 'true') cur.disabledShipped = true;
      else if (/!!js/.test(v)) cur.disabledExpr = v;
      continue;
    }
  }
  finish();
  return out;
}

/** 拉一份 dump 并解析（慢：要拼一遍配置树，几百毫秒到几秒）。 */
function dumpEntries(opts) {
  const o = opts || {};
  const profile = o.profile || 'web';
  const slot = o.slot || readSlot();
  const bin = path.join(RUNTIME, slot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) return { ok: false, error: '活动槽里没有 dsh：' + bin };
  const r = spawnSync(NODE_EXE, [bin, '--profile', profile, '--dump-config'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
    env: Object.assign({}, process.env, pnpmEnv({ DSH_HOME: DATA, DSH_AGENTS_HOME: path.join(DATA, 'agents') })),
  });
  const text = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0) return { ok: false, error: '拿条目列表失败（退出码 ' + r.status + '）：' + text.split('\n').slice(0, 3).join(' ') };
  return { ok: true, entries: parseEntries(text), lines: text.split('\n').length };
}

function readSlot() {
  try { return fs.readFileSync(path.join(RUNTIME, 'current.txt'), 'utf8').trim(); } catch (e) { return 'agent-A'; }
}

/**
 * 条目清单（给页面用）：合并三处信息——
 *  官方 dump（有哪些条目、叫什么、官方默认停用没）、
 *  我们的 plugins.json（我们停用了谁）、
 *  我们覆盖层里保留的 id（不能让人误停用）。
 */
function listEntries(opts) {
  const state = readState();
  const d = dumpEntries(opts);
  if (!d.ok) return { ok: false, error: d.error, state, entries: [] };
  const entries = d.entries
    .filter((e) => RESERVED.indexOf(e.id) < 0)
    .map((e) => {
      const choice = ourChoice(state, e.id);
      return {
        id: e.id,
        name: e.name,
        section: e.section,
        shippedDisabled: e.disabledShipped,
        conditional: !!e.disabledExpr,          // 官方用 !!js 表达式控制的，停用/启用都可能被它覆盖
        ours: choice,                            // 'disabled' | 'enabled' | null
        effective: choice === 'disabled' ? false : (e.disabledShipped ? false : true),
      };
    });
  return { ok: true, entries, state, dumpLines: d.lines };
}

// ------------------------------------------------------------------ pnpm（按大版本并存，与 profile 对齐）
/**
 * pnpm 的 store 布局是**按大版本分目录**的（v10 / v11…），而且 pnpm 有一条硬检查：
 * 如果 node_modules 是从别的 store 链接来的，它会直接拒绝任何操作（ERR_PNPM_UNEXPECTED_STORE）。
 * 用户的盘上很可能既有我们带的 pnpm，也有别处（npx pnpm、其他工具）装的插件，
 * 所以这里做两件事：
 *   1) 按大版本并存 pnpm：runtime/pnpm（老的 10）+ runtime/pnpm-<major>（其他版本）；
 *   2) 操作某个 profile 时，用它的 .modules.yaml 里记的那份 pnpm 大版本 + store 位置。
 */
const DEFAULT_PNPM_MAJOR = '10';

function pnpmPkgDir(root) { return path.join(root, 'node_modules', 'pnpm', 'package.json'); }
function pnpmVersionIn(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(pnpmPkgDir(dir), 'utf8'));
    return (j && j.version) ? String(j.version) : null;
  } catch (e) { return null; }
}
/** 某大版本的 pnpm 装在哪（10 优先用老位置 runtime/pnpm；其他版本各占 runtime/pnpm-<major>） */
function pnpmDirFor(major) {
  const m = String(major || DEFAULT_PNPM_MAJOR);
  const legacy = PNPM_DIR;
  const per = path.join(RUNTIME, 'pnpm-' + m);
  if (m === DEFAULT_PNPM_MAJOR && pnpmVersionIn(legacy)) return legacy;
  if (pnpmVersionIn(per)) return per;
  return per;   // 该大版本还没装 → 给它规范位置（装的时候就装这里，别拿别的版本顶替）
}
function pnpmBinDirIn(dir) { return path.join(dir, 'node_modules', '.bin'); }
/**
 * pnpm 自己的入口脚本。注意大版本之间布局会变：pnpm 10 是 bin/pnpm.cjs（CJS），
 * pnpm 12 变成 bin/pnpm.mjs（ESM）＋原生二进制（.bin/pnpm.cmd 走那条）。
 * 这里按存在性挑一个能用 `node <file>` 跑的（.mjs 也能跑），别写死成 bin/pnpm.cjs。
 */
function pnpmCjsIn(dir) {
  const base = path.join(dir, 'node_modules', 'pnpm');
  for (const rel of ['bin/pnpm.cjs', 'bin/pnpm.mjs', 'bin/pnpm.js']) {
    if (fs.existsSync(path.join(base, rel))) return path.join(base, rel);
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    const b = j && j.bin && (typeof j.bin === 'string' ? j.bin : j.bin.pnpm);
    if (b && /\.(cjs|mjs|js)$/.test(b)) {
      const p = path.join(base, b);
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* 忽略 */ }
  return path.join(base, 'bin', 'pnpm.cjs');
}
function pnpmBinDir(major) { return pnpmBinDirIn(pnpmDirFor(major)); }
function pnpmCjs(major) { return pnpmCjsIn(pnpmDirFor(major)); }

/**
 * 怎么把 pnpm 跑起来（大版本之间方式不同）：
 *   pnpm 12 自带原生二进制 node_modules/pnpm/pnpm.exe → 直接跑它
 *   pnpm 10 是 bin/pnpm.cjs → node 跑它
 * 返回 {cmd, args}，调用方 spawnSync(cmd, args.concat(实际参数)) 即可。
 */
function pnpmCmdIn(dir) {
  const base = path.join(dir, 'node_modules', 'pnpm');
  const exeName = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
  const exe = path.join(base, exeName);
  if (fs.existsSync(exe)) return { cmd: exe, args: [], mode: 'native' };
  const cjs = path.join(base, 'bin', 'pnpm.cjs');
  if (fs.existsSync(cjs)) return { cmd: NODE_EXE, args: [cjs], mode: 'cjs' };
  const mjs = path.join(base, 'bin', 'pnpm.mjs');
  if (fs.existsSync(mjs)) return { cmd: NODE_EXE, args: [mjs], mode: 'mjs' };
  return { cmd: NODE_EXE, args: [path.join(base, 'bin', 'pnpm.cjs')], mode: 'missing' };
}
function pnpmCmd(major) { return pnpmCmdIn(pnpmDirFor(major)); }

/**
 * 读 profile 里 pnpm 留下的元信息（谁装的、store 在哪、什么链接方式）。
 * 文件是 node_modules/.modules.yaml —— 内容恰好是 JSON 形态的标量，按行解析即可。
 */
function profileStore(profile) {
  const pdir = profileDir(profile);
  const f = path.join(pdir, 'node_modules', '.modules.yaml');
  let text = null;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { text = null; }
  if (!text) return { exists: false, file: f, profileDir: pdir, major: null, storeDir: null };
  // 这个文件叫 .yaml，但 pnpm 实际写的是 JSON（带缩进、键带引号）；按 JSON 解析，失败再退回 YAML 式
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { obj = null; }
  const val = (key) => {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
    const m = new RegExp('^\\s*"?' + key + '"?\\s*:\\s*(.+?)\\s*$', 'm').exec(text);
    if (!m) return null;
    const raw = m[1];
    if (raw[0] === '"' || raw[0] === "'") {
      try { return JSON.parse(raw[0] === '"' ? raw : '"' + raw.slice(1, -1) + '"'); } catch (e) { return raw.slice(1, -1); }
    }
    return raw;
  };
  const pm = val('packageManager');                       // 形如 pnpm@12.11.2
  const pnpmVersion = pm ? (String(pm).split('@')[1] || null) : null;
  const storeDir = val('storeDir');
  let major = pnpmVersion ? String(pnpmVersion).split('.')[0] : null;
  if (!major && storeDir) { const m = /v(\d+)$/.exec(String(storeDir)); if (m) major = m[1]; }
  // .modules.yaml 里记的是**带布局后缀**的完整路径（…\\.pnpm-store\\v11）；而 store-dir 配置要的是父目录
  const m2 = storeDir ? /^(.*)[\\/]v(\d+)$/.exec(String(storeDir)) : null;
  const storeRoot = m2 ? m2[1] : (storeDir || null);
  const storeLayout = m2 ? ('v' + m2[2]) : null;
  return {
    exists: true, file: f, profileDir: pdir,
    packageManager: pm, pnpmVersion, major,
    storeDir: storeDir || null, storeRoot, storeLayout,
    nodeLinker: val('nodeLinker'), layoutVersion: val('layoutVersion'), lockfileVersion: val('lockfileVersion'),
    storeMissing: !!(storeDir && !fs.existsSync(storeDir)),
  };
}

/** 针对某个 profile 选好 pnpm 与 store（装卸插件时用它） */
function pnpmFor(profile) {
  const st = profileStore(profile || 'web');
  const wantMajor = st.major || null;
  const major = wantMajor || DEFAULT_PNPM_MAJOR;
  const dir = pnpmDirFor(major);
  const version = pnpmVersionIn(dir);
  const haveMajor = version ? String(version).split('.')[0] : null;
  const compatible = !!version && (!wantMajor || wantMajor === haveMajor);
  const hint = !version
    ? (wantMajor
      ? '这个 profile 是 pnpm ' + (st.pnpmVersion || ('v' + wantMajor)) + ' 装的，盘上还没有这一版：点「准备 pnpm」装一份到本盘（约 10 MB，不碰宿主）'
      : '盘上还没有 pnpm：点「准备 pnpm」装一份到本盘（约 10 MB，不碰宿主）')
    : (!compatible
      ? '这个 profile 是 pnpm ' + (st.pnpmVersion || ('v' + wantMajor)) + ' 装的，盘上这份是 ' + version +
        '——跨大版本共用 store 会被 pnpm 直接拒绝（ERR_PNPM_UNEXPECTED_STORE），所以装卸插件会失败。' +
        '装一份匹配的 pnpm 即可（不改动已装的插件）。'
      : null);
  return {
    profile: st, wantMajor, major, dir, version, installed: !!version, compatible,
    bin: pnpmBinDirIn(dir), cjs: pnpmCjsIn(dir),
    // store-dir 要设成「父目录」（pnpm 自己会在里面建 v<major>）；profile 记的是完整路径
    store: st.storeRoot || PNPM_STORE, storeDirFull: st.storeDir || null, storeMissing: !!st.storeMissing, hint,
  };
}

/** pnpm 是否可用（对这个 profile 而言） */
function pnpmInfo(profile) {
  const p = pnpmFor(profile || 'web');
  return {
    ok: p.compatible, ours: p.installed, dir: p.dir, version: p.version,
    store: p.store, wantMajor: p.wantMajor, wantVersion: p.profile.pnpmVersion || null,
    nodeLinker: p.profile.nodeLinker || null, storeMissing: p.storeMissing,
    hint: p.hint,
  };
}

/** 给子进程环境加上 pnpm 与「与这个 profile 匹配的」store（dsh 是按名字在 PATH 里找 pnpm）。 */
function pnpmEnv(base, profile) {
  const p = pnpmFor(profile || 'web');
  const env = Object.assign({}, base || process.env);
  env.PATH = p.bin + path.delimiter + path.join(RUNTIME, 'node') + path.delimiter + (env.PATH || '');
  // store 必须跟着 profile 记录的位置走，否则 pnpm 会以「store 不一致」拒绝所有操作
  env.npm_config_store_dir = p.store;
  env.PNPM_HOME = path.join(RUNTIME, 'pnpm-home');
  return env;
}

/**
 * 把指定大版本（或精确版本）的 pnpm 装到盘上，装进 runtime/pnpm-<major>。
 * 默认源用 npmmirror（本机访问 npm 官方源不稳），需要联网。
 */
function installPnpm(versionOrMajor, opts) {
  const npmCli = path.join(RUNTIME, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) return { ok: false, error: '找不到便携 npm：' + npmCli };
  const want = String(versionOrMajor || DEFAULT_PNPM_MAJOR);
  const major = want.split('.')[0];
  const dir = (major === DEFAULT_PNPM_MAJOR && pnpmVersionIn(PNPM_DIR)) ? PNPM_DIR : path.join(RUNTIME, 'pnpm-' + major);
  const registry = (opts && opts.registry) || 'https://registry.npmmirror.com';
  const args = [npmCli, 'install', '--prefix', dir, 'pnpm@' + want, '--no-fund', '--no-audit', '--loglevel=error', '--registry', registry];
  const r = spawnSync(NODE_EXE, args, {
    encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { npm_config_cache: path.join(RUNTIME, 'npm-cache') }),
  });
  const out = (String(r.stdout || '') + String(r.stderr || '')).trim();
  const version = pnpmVersionIn(dir);
  if (!version) return { ok: false, error: 'pnpm 装完但用不了：' + out.split('\n').slice(-3).join(' '), dir };
  return { ok: true, version, dir, text: out.split('\n').slice(-2).join(' ') };
}

/** 插件操作的额外 pnpm 参数。目前只有一条：放宽「新包冷却」（pnpm 12 默认 minimumReleaseAge=24h，
 *  会连普通删除都挡——因为解析时会核对整份 lockfile）。默认关，由页面上的开关显式打开。 */
function relaxArgs(enabled) {
  return enabled ? ['--config.minimumReleaseAge=0'] : [];
}
/** 组装一次插件操作的参数（dsh plugin 会把它们原样转给 pnpm） */
function pluginOpArgs(verb, name, opts) {
  const o = opts || {};
  return [verb, name].concat(relaxArgs(!!o.relaxReleaseAge));
}

// ------------------------------------------------------------------ 包名与发现
/** npm 包名合法性（含 scope）。包名会作为数组参数传给 pnpm，不会被 shell 解释，但仍要挡住明显错的东西。 */
function validPackageName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 214) return false;
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(n)) return false;
  if (/^(\.|_)/.test(n)) return false;
  return true;
}

/**
 * 安装目标合法性：比包名宽一点，因为市场里有的插件走 git 仓库或 tgz 链接。
 * 参数以数组形式传给 pnpm（不经过 shell），这里主要是挡住明显写错的、带空格的、带壳字符的东西。
 */
function validInstallSpec(spec) {
  const s = String(spec || '').trim();
  if (!s || s.length > 300 || /\s/.test(s)) return false;
  if (validPackageName(s)) return true;
  if (/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(#[\w./-]+)?$/.test(s)) return true;
  if (/^https?:\/\/[\w.-]+\/[\w./%$-]*\.(tgz|tar\.gz)$/i.test(s)) return true;
  if (s.indexOf('file:') === 0 && s.length > 6) return true;
  return false;
}

let SEARCH_CACHE = { at: 0, q: '', data: null };
/**
 * 按关键词搜 npm（**不是**插件官方索引：dsh 没有这种 API）。
 * 用途：让用户能凭关键词找到候选包名，再自行确认它是不是 dsh 插件。
 */
async function searchNpm(query, opts) {
  const o = opts || {};
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '请输入关键词（例如 deepseek dsh 插件名的一部分）' };
  const now = Date.now();
  if (!o.force && SEARCH_CACHE.data && SEARCH_CACHE.q === q && (now - SEARCH_CACHE.at) < 5 * 60 * 1000) return SEARCH_CACHE.data;
  const url = 'https://registry.npmjs.org/-/v1/search?size=20&text=' + encodeURIComponent(q);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) return { ok: false, error: 'npm 搜索返回 HTTP ' + res.status };
    const j = await res.json();
    const list = (j.objects || []).map((o2) => {
      const p = o2.package || {};
      return {
        name: p.name, version: p.version, description: (p.description || '').slice(0, 160),
        date: p.date || null, links: (p.links && p.links.npm) || null,
        keywords: (p.keywords || []).slice(0, 6),
        isDshPlugin: /dsh/i.test(String(p.name || '') + ' ' + String(p.description || '')),
      };
    });
    const data = { ok: true, query: q, count: list.length, total: (j.total || 0), results: list };
    SEARCH_CACHE = { at: now, q, data };
    return data;
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? '超时' : String((e && e.message) || e);
    return { ok: false, error: '搜不到：' + msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 已安装的插件包（profile 的 package.json）：dependencies 是装了的包，bundles 是会被加载的。 */
function listInstalled(profile) {
  const dir = profileDir(profile);
  const file = path.join(dir, 'package.json');
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* 还没初始化 */ }
  const deps = (j && j.dependencies) || {};
  const bundles = ((j && j.dsh && j.dsh.profile && j.dsh.profile.bundles) || []).slice();
  const installed = Object.keys(deps).map((name) => ({
    name, version: String(deps[name] || ''), bundle: bundles.indexOf(name) >= 0,
  }));
  return { ok: !!j, dir, installed, bundles, exists: !!j };
}

// ---------------------------------------------------------------- 卡片页要用的目录

const compat = require('./compat.js');

/** 活动槽目录：官方插件（@deepseek-ai/*）随 dsh 装在这里 */
function slotDir() { return path.join(RUNTIME, readSlot()); }

function readPkgJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { return null; }
}

function authorOf(j) {
  const a = j && j.author;
  if (typeof a === 'string') return a.replace(/<[^>]*>/g, '').trim() || null;
  if (a && a.name) return a.name;
  if (Array.isArray(j && j.maintainers) && j.maintainers[0]) {
    const m = j.maintainers[0];
    return (m && m.name) || (typeof m === 'string' ? m.replace(/<[^>]*>/g, '').trim() : null);
  }
  return null;
}

function pkgInfo(pkg, dir, kind) {
  const j = readPkgJson(dir) || {};
  const repo = typeof j.repository === 'string' ? j.repository : ((j.repository && j.repository.url) || null);
  return {
    pkg, kind, dir,
    version: j.version || null,
    author: authorOf(j),
    description: String(j.description || '').trim(),
    homepage: j.homepage || null,
    repo: repo ? String(repo).replace(/^git\+/, '').replace(/\.git$/, '') : null,
    license: j.license || null,
    peers: j.peerDependencies || {},
  };
}

/** 活动槽里 dsh 自带的包（官方插件） */
function officialPackages() {
  const base = path.join(slotDir(), 'node_modules', '@deepseek-ai');
  const out = [];
  try {
    for (const name of fs.readdirSync(base)) {
      const info = pkgInfo('@deepseek-ai/' + name, path.join(base, name), 'official');
      if (info.version) out.push(info);
    }
  } catch (e) { /* 槽里没有 */ }
  return out;
}

/** 本槽里 dsh 本体的版本（官方插件与它同版本） */
function slotDshVersion() {
  const j = readPkgJson(path.join(slotDir(), 'node_modules', '@deepseek-ai', 'dsh'));
  return (j && j.version) || null;
}

/**
 * 第三方包：**以 profile 的 package.json 的 dependencies 为准**——那才是「用户装了什么」的事实来源。
 * node_modules 里其余的（@deepseek-ai/dsh-base、dsh-web-app 的传递依赖树，几百个）不是插件，
 * 不能做成卡片、更不能给「删除」按钮（删了会把 dsh 自己搞坏）。
 */
function installedPackages(profile) {
  const pdir = profileDir(profile);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8')); } catch (e) { return []; }
  const deps = (j && j.dependencies) || {};
  const out = [];
  for (const name of Object.keys(deps)) {
    const info = pkgInfo(name, path.join(pdir, 'node_modules', name), 'third-party');
    info.spec = String(deps[name] || '');       // 装的时候用的范围/来源（github:xxx、^1.2.3 …）
    if (info.pkg) out.push(info);
  }
  return out;
}

/** node_modules 里的包总数（含传递依赖）：只用于在页面上说明「为什么这里不止那几个包」 */
function profileNodeModulesCount(profile) {
  const base = path.join(profileDir(profile), 'node_modules');
  let n = 0;
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        try { n += fs.readdirSync(path.join(base, e.name)).length; } catch (err) { /* 忽略 */ }
      } else n++;
    }
  } catch (e) { /* 还没装过任何东西 */ }
  return n;
}

/** 条目按包名归并（子条目 '@deepseek-ai/dsh-plugin-manager/tools' 归到包上） */
function groupEntries(entries) {
  const map = {};
  for (const e of entries || []) {
    const full = String(e.name || '');
    if (!full) continue;
    let base = full;
    const first = full.indexOf('/');
    if (full.startsWith('@')) { const second = full.indexOf('/', first + 1); if (second > 0) base = full.slice(0, second); }
    else if (first > 0) base = full.slice(0, first);
    (map[base] = map[base] || []).push(e);
  }
  return map;
}

/**
 * 卡片页要用的完整目录：官方插件 / 第三方插件，各自带包元信息、条目、兼容性结论。
 * 会跑一次 dump（几秒），ui-server 端有缓存。
 */
function catalog(opts = {}) {
  const profile = opts.profile || 'web';
  const entriesRes = listEntries(opts);
  const entries = entriesRes.entries || [];
  const byPkg = groupEntries(entries);
  const slot = readSlot();
  const slotVersion = slotDshVersion();
  const pdir = profileDir(profile);
  const compatOpts = { slotDir: slotDir(), profileDir: pdir, semverDir: slotDir() };

  const official = officialPackages()
    .map((p) => Object.assign({}, p, { entries: byPkg[p.pkg] || [] }))
    .filter((p) => p.entries.length);   // 没在配置里出现的官方包不占卡片位（数量在 counts 里另给）

  const thirdParty = installedPackages(profile).map((p) => {
    const res = compat.check(p.peers, compatOpts);
    return Object.assign({}, p, {
      entries: byPkg[p.pkg] || [],
      compat: { result: res, verdict: compat.verdict(res, slotVersion) },
      installCommand: 'dsh plugin --profile ' + profile + ' add ' + p.pkg,
    });
  });

  const shown = new Set();
  official.concat(thirdParty).forEach((p) => p.entries.forEach((e) => shown.add(e.id)));
  const orphanEntries = entries.filter((e) => !shown.has(e.id));

  let officialPackagesAll = official.length;
  try { officialPackagesAll = fs.readdirSync(path.join(slotDir(), 'node_modules', '@deepseek-ai')).length; } catch (e) { /* 用上面的数 */ }

  return {
    ok: entriesRes.ok, error: entriesRes.error,
    profile, profileDir: pdir, slot, slotVersion,
    official, thirdParty, orphanEntries,
    counts: {
      officialCards: official.length, officialPackages: officialPackagesAll,
      thirdPartyCards: thirdParty.length, entries: entries.length, orphan: orphanEntries.length,
      depPackages: profileNodeModulesCount(profile),
    },
  };
}

module.exports = {
  ROOT, RUNTIME, PNPM_DIR, PNPM_STORE, RESERVED,
  setRoots, pluginsFile, profileDir, readState, writeState, ourChoice,
  parseEntries, dumpEntries, listEntries,
  pnpmBinDir, pnpmCjs, pnpmInfo, pnpmEnv, installPnpm, relaxArgs, pluginOpArgs,
  pnpmFor, pnpmVersionIn, pnpmDirFor, profileStore, DEFAULT_PNPM_MAJOR, pnpmCmd, pnpmCmdIn,
  validPackageName, validInstallSpec, searchNpm, listInstalled,
  slotDir, slotDshVersion, readPkgJson, authorOf, pkgInfo,
  officialPackages, installedPackages, profileNodeModulesCount, groupEntries, catalog,
};

if (require.main === module) {
  // 不给子命令就只打印用法：这里默认跑 list 会白等一遍 dump（几秒），容易让人以为卡住
  const cmd = process.argv[2] || '';
  const LIMIT = Number(process.env.WZD_LIMIT || 40);
  const run = async () => {
    if (cmd === 'setup-pnpm') {
      const want = process.argv[3];                       // 可以指定版本或大版本（例如 12.11.2 / 12）
      const info = pnpmInfo();
      if (info.ok && !want) { console.log('  便携 pnpm 已就绪：v' + info.version + '（' + PNPM_DIR + '）'); return 0; }
      const target = pnpmDirFor(String(want || DEFAULT_PNPM_MAJOR).split('.')[0]);
      console.log('  正在把 pnpm ' + (want || DEFAULT_PNPM_MAJOR) + ' 装到盘上：' + target);
      const r = installPnpm(want);
      console.log(r.ok ? ('  完成：pnpm v' + r.version + '（' + r.dir + '）') : ('  失败：' + r.error));
      return r.ok ? 0 : 1;
    }
    if (cmd === 'list') {
      const r = listEntries({ profile: process.argv[3] || 'web' });
      if (!r.ok) { console.log('  ' + r.error); return 1; }
      console.log('  条目 ' + r.entries.length + ' 个（dump ' + r.dumpLines + ' 行）；前 ' + LIMIT + ' 个：');
      for (const e of r.entries.slice(0, LIMIT)) {
        console.log('   ' + (e.effective ? '启用' : '停用') + '  ' + e.id + '  ' + (e.name || '')
          + (e.ours ? '  [本工具设置]' : '') + (e.conditional ? '  [官方条件控制]' : '') + (e.shippedDisabled ? '  [官方默认停用]' : ''));
      }
      return 0;
    }
    if (cmd === 'installed') {
      const r = listInstalled(process.argv[3] || 'web');
      console.log('  profile：' + r.dir + (r.exists ? '' : '（还没初始化）'));
      console.log('  已装包 ' + r.installed.length + ' 个：'
        + (r.installed.map((x) => x.name + (x.bundle ? '（会被加载）' : '')).join('、') || '（无）'));
      return 0;
    }
    if (cmd === 'search') {
      const r = await searchNpm(process.argv.slice(3).join(' '));
      if (!r.ok) { console.log('  ' + r.error); return 1; }
      console.log('  npm 匹配「' + r.query + '」：' + r.count + ' / ' + r.total + ' 个');
      for (const x of r.results) console.log('   ' + x.name + '@' + x.version + '  ' + (x.description || '').slice(0, 66));
      return 0;
    }
    console.log('用法：node tools/plugins.js <list [profile]|installed [profile]|search <关键词>|setup-pnpm [版本]>');
    console.log('（list 会跑一遍 dsh --dump-config，要几秒）');
    return 2;
  };
  run().then((rc) => process.exit(rc)).catch((e) => { console.error('插件模块错误：' + e.message); process.exit(1); });
}
