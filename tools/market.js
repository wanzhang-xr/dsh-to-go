'use strict';
/**
 * 插件市场数据层。
 *
 * 数据源：https://awesome-dsh-plugin.com/plugins.json（社区维护的 awesome 列表，
 * 2026-10 时约 4489 个插件、4.7 MB）。它给的是**社区插件**，不含 dsh 自带的官方插件；
 * 每个条目带现成的安装命令（install 字段，例如 `dsh plugin --profile web add dsh-xxx`），
 * 我们直接照抄执行，不自己拼包名（里面有 github: / tarball 形式的，拼不出来）。
 *
 * 几个刻意的处理：
 *   - 缓存落在盘上（data/market.json），默认 24 小时内不重复下载 4.7 MB；
 *   - 缓存前先「瘦身」：只留页面要用的字段，简介截断，4.7 MB → 约 2 MB；
 *   - 下载用浏览器 UA（该站对无 UA 的请求会挡），超时给足（5 MB 不是小文件）；
 *   - 查询（关键词/分类/排序/分页）都在服务端做，页面不下载整表；
 *   - 市场里没有「适配 dsh 版本」字段，那一项由 compat.js 用 npm 的 peerDependencies 现算。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const CACHE_FILE = path.join(DATA, 'market.json');
const SOURCE = 'https://awesome-dsh-plugin.com/plugins.json';
const SOURCE_PAGE = 'https://awesome-dsh-plugin.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TTL_MS = 24 * 60 * 60 * 1000;
const DESC_ZH = 320;
const DESC_EN = 240;

// 兜底的内置分类表（源里 categories 拿不到时用；与源里的键一致）
const CATEGORY_FALLBACK = {
  agi: 'AGI 架构探索', ui: 'UI 增强', usage: '用量与计费', theme: '主题与外观',
  model: '模型与账号接入', identity: '身份与通信', session: '会话与消息', memory: '记忆',
  tools: '工具与能力', wsl: 'WSL 与 Windows 互操作', browser: '浏览器与网页',
  vision: '视觉与多模态', voice: '语音与音频', docs: '文档与渲染', skill: '技能包',
  workflow: '工作流与自动化', git: 'Git 与代码评审', notify: '通知与集成',
  dev: '开发与运行时', security: '安全与权限', remote: '远程与移动端',
  market: '插件市场与管理', fun: '娱乐',
};

function trim(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 把一个原始条目瘦身成页面要用的形状 */
function reduce(p) {
  return {
    name: p.name || '',
    owner: p.owner || '',
    url: p.url || '',
    page: p.page || '',
    category: p.category || '',
    npm: p.npm || null,
    version: p.version || null,
    stars: typeof p.stars === 'number' ? p.stars : 0,
    downloads: typeof p.downloads === 'number' ? p.downloads : null,
    install: p.install || '',
    added: p.added || null,
    capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
    redLines: Array.isArray(p.capabilityRedLines) ? p.capabilityRedLines : [],
    screenshots: Array.isArray(p.screenshots) ? p.screenshots.slice(0, 3) : [],
    tarball: p.tarball || null,
    zh: trim(p.description && p.description.zh, DESC_ZH),
    en: trim(p.description && p.description.en, DESC_EN),
  };
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.plugins)) return j;
  } catch (e) { /* 没有或坏了 */ }
  return null;
}

function writeCache(obj) {
  fs.mkdirSync(DATA, { recursive: true });
  // 先写临时文件再改名：下载到一半被打断也不会留下半个缓存
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, CACHE_FILE);
  return CACHE_FILE;
}

async function fetchSource(timeoutMs) {
  const r = await fetch(SOURCE, {
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*' },
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });
  if (!r.ok) throw new Error('市场数据源返回 HTTP ' + r.status);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { throw new Error('市场数据源不是合法 JSON（收到 ' + text.length + ' 字节）'); }
  if (!j || !Array.isArray(j.plugins)) throw new Error('市场数据源结构不对：没有 plugins 数组');
  return j;
}

/**
 * 取市场数据（默认命中缓存就不下载）
 * @param {object} opts {force, timeoutMs, maxAgeMs}
 * @returns {Promise<{source, updated, fetchedAt, fromCache, categories, plugins, count, sizeBytes}>}
 */
async function load(opts = {}) {
  const maxAge = opts.maxAgeMs == null ? TTL_MS : opts.maxAgeMs;
  const cached = readCache();
  const fresh = cached && cached.fetchedAt && (Date.now() - Date.parse(cached.fetchedAt) < maxAge);
  if (cached && fresh && !opts.force) return Object.assign({}, cached, { fromCache: true });

  const raw = await fetchSource(opts.timeoutMs);
  const cats = {};
  const srcCats = raw.categories || {};
  for (const k of Object.keys(srcCats)) {
    const v = srcCats[k];
    cats[k] = (v && (v.zh || v.en)) || CATEGORY_FALLBACK[k] || k;
  }
  const out = {
    source: raw.source || SOURCE,
    url: raw.url || SOURCE_PAGE,
    updated: raw.updated || null,
    fetchedAt: new Date().toISOString(),
    declaredCount: raw.count || raw.plugins.length,
    categories: cats,
    plugins: raw.plugins.map(reduce),
  };
  out.count = out.plugins.length;
  writeCache(out);
  return Object.assign({}, out, { fromCache: false });
}

/** 同步读缓存（没有就返回 null；页面先用它渲染，再去后台刷新） */
function loadCached() {
  const c = readCache();
  return c ? Object.assign({}, c, { fromCache: true }) : null;
}

/** 从市场的安装命令里取出安装目标（形如 `dsh plugin --profile web add <目标>`） */
function installSpecOf(cmd) {
  const m = /\sadd\s+(.+)$/.exec(String(cmd == null ? '' : cmd).trim());
  if (!m) return '';
  return m[1].replace(/^["']|["']$/g, '').trim();
}

function pickSort(items, sort) {
  const by = String(sort || 'stars');
  const cmp = {
    stars: (a, b) => (b.stars - a.stars) || a.name.localeCompare(b.name),
    downloads: (a, b) => ((b.downloads || 0) - (a.downloads || 0)) || (b.stars - a.stars),
    added: (a, b) => String(b.added || '').localeCompare(String(a.added || '')),
    name: (a, b) => a.name.localeCompare(b.name),
    updated: (a, b) => String(b.version || '').localeCompare(String(a.version || '')),
  }[by] || ((a, b) => b.stars - a.stars);
  return items.slice().sort(cmp);
}

/**
 * 查询市场（服务端过滤/排序/分页）
 * @param {object} o {q, category, sort, page, pageSize, riskOnly, installedSet}
 */
function query(o = {}) {
  const cached = readCache();
  if (!cached) return { ok: false, error: '市场数据还没缓存（需要联网下载一次）', items: [], total: 0 };
  const q = String(o.q || '').trim().toLowerCase();
  const cat = String(o.category || '').trim();
  const pageSize = Math.min(Math.max(Number(o.pageSize) || 24, 1), 100);
  const page = Math.max(Number(o.page) || 1, 1);
  const installed = o.installedSet instanceof Set ? o.installedSet : new Set(o.installedSet || []);

  let items = cached.plugins;
  if (cat) items = items.filter((p) => p.category === cat);
  if (o.riskOnly) items = items.filter((p) => p.redLines && p.redLines.length);
  if (q) {
    items = items.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.owner.toLowerCase().includes(q) ||
      String(p.npm || '').toLowerCase().includes(q) ||
      p.zh.toLowerCase().includes(q) ||
      p.en.toLowerCase().includes(q));
  }
  const total = items.length;
  items = pickSort(items, o.sort).slice((page - 1) * pageSize, page * pageSize);
  return {
    ok: true,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    source: { url: cached.url || SOURCE_PAGE, data: SOURCE, updated: cached.updated, fetchedAt: cached.fetchedAt, fromCache: true, count: cached.count },
    categories: cached.categories || CATEGORY_FALLBACK,
    items: items.map((p) => Object.assign({}, p, {
      installed: installed.has(p.name) || (p.npm ? installed.has(p.npm) : false),
    })),
  };
}

/** 单个插件（详情面板用；直接查缓存，不再下载） */
function find(name) {
  const cached = readCache();
  if (!cached) return null;
  const key = String(name || '').toLowerCase();
  return cached.plugins.find((p) => p.name.toLowerCase() === key) ||
    cached.plugins.find((p) => String(p.npm || '').toLowerCase() === key) || null;
}

function stats() {
  const cached = readCache();
  if (!cached) return { cached: false, file: CACHE_FILE };
  let size = 0;
  try { size = fs.statSync(CACHE_FILE).size; } catch (e) { /* 忽略 */ }
  return {
    cached: true, file: CACHE_FILE, count: cached.count, updated: cached.updated,
    fetchedAt: cached.fetchedAt, sizeBytes: size,
    ageMs: Date.now() - Date.parse(cached.fetchedAt || 0),
    stale: !(Date.now() - Date.parse(cached.fetchedAt || 0) < TTL_MS),
  };
}

module.exports = {
  SOURCE, SOURCE_PAGE, CACHE_FILE, UA, TTL_MS, CATEGORY_FALLBACK,
  load, loadCached, query, find, stats, reduce, trim, readCache, installSpecOf,
};

// ------------------------------------------------------------------ CLI（调试用）
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const cmd = (argv[0] || 'stats').toLowerCase();
    if (cmd === 'stats') {
      const s = stats();
      console.log('');
      console.log('  数据源  : ' + SOURCE);
      if (!s.cached) { console.log('  缓存    : 还没有（跑 `market.js fetch`）'); console.log(''); return; }
      console.log('  缓存    : ' + s.file);
      console.log('  插件数  : ' + s.count + '（源里标 ' + s.updated + '）');
      console.log('  下载于  : ' + s.fetchedAt + (s.stale ? '（已过期，下次会自动重下）' : '（还新鲜）'));
      console.log('  缓存大小: ' + (s.sizeBytes / 1048576).toFixed(2) + ' MB');
      console.log('');
      return;
    }
    if (cmd === 'fetch') {
      const r = await load({ force: true });
      console.log('  已更新：' + r.count + ' 个插件，源自 ' + r.updated);
      return;
    }
    if (cmd === 'top') {
      const r = query({ sort: argv[1] || 'stars', pageSize: Number(argv[2]) || 10 });
      if (!r.ok) { console.log('  ' + r.error); return; }
      for (const p of r.items) console.log('  ' + String(p.stars).padStart(5) + '★  ' + p.name + '  @' + p.owner + (p.version ? '  v' + p.version : ''));
      return;
    }
    if (cmd === 'search') {
      const r = query({ q: argv[1] || '', pageSize: Number(argv[2]) || 10 });
      if (!r.ok) { console.log('  ' + r.error); return; }
      console.log('  命中 ' + r.total + ' 个：');
      for (const p of r.items) console.log('  - ' + p.name + '  @' + p.owner + '  v' + (p.version || '?') + '  ' + p.zh.slice(0, 40));
      return;
    }
    console.log('  用法：market.js stats | fetch | top [stars|downloads|added] [n] | search <词> [n]');
  })().catch((e) => { console.error('失败：' + ((e && e.message) || e)); process.exit(1); });
}
