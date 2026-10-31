'use strict';
let TOKEN = new URLSearchParams(location.search).get('token') || (location.hash || '').replace(/^#token=/, '') || null;

/* ---------------------------------------------------------------- 令牌桥
   启动器（原生窗口）不会把令牌写进地址栏：窗口打开时 URL 里没有 token，
   页面就向宿主要一次。浏览器里直接打开（dsh-ui.cmd 那条路）时 URL 里带 token，
   走不到这里；没有宿主也不会卡住（超时后给一句明确提示）。
   令牌只活在内存里，不落 localStorage / cookie / 历史。 */
function requestHostToken(timeoutMs) {
  return new Promise((resolve) => {
    const host = hostBridge();
    if (!host) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs || 4000);
    host.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m && m.type === 'dsh.token' && m.token) { clearTimeout(timer); finish(String(m.token)); }
    });
    try { host.postMessage({ type: 'dsh.token.request' }); }
    catch (err) { clearTimeout(timer); finish(null); }
  });
}
/* 宿主桥：两套壳共用同一套协议。
   · WebView2（旧壳 / 浏览器回退）：window.chrome.webview
   · Electron 壳：window.dshHost（contextBridge 暴露，形状一致）
   浏览器里两者都没有，页面就当没有宿主。 */
function hostBridge() {
  if (window.chrome && window.chrome.webview) return window.chrome.webview;
  if (window.dshHost) return window.dshHost;
  return null;
}

const el = (id) => document.getElementById(id);
let STATE = null;
let CURRENT_JOB = null;
let LOG_OFFSET = 0;
let CUR_LOG = 'job-log';
let CUR_GRID = 'job-state';
let CUR_OUT = 'job-out';
let LAST_OP = null;             // 最近一次任务的入参（失败时给「再试一次」用）
let JOB_LAST_ST = null;         // 上一次看到的状态（用于「状态变化」时才脉冲）
let POLL = null;

/* ---------------------------------------------------------------- 基础请求 */
async function api(path, body, method) {
  const empty = body === undefined || (method === 'DELETE' && !Object.keys(body || {}).length);
  const r = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'x-config-token': TOKEN },
    body: empty ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: '返回不是 JSON' }));
  if (!r.ok) {
    // 优先用服务端给的 error；没有就把子进程输出尾巴亮出来，别让用户只看到一个 "500"
    const tail = String(j.text || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' / ');
    throw new Error(j.error || tail || ('HTTP ' + r.status));
  }
  return j;
}
function flash(id, text, kind) {
  const f = el(id);
  f.className = 'flash on' + (kind ? ' ' + kind : '');
  f.textContent = text;
}
function clearFlash(id) { el(id).className = 'flash'; }
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function rows(target, pairs) {
  el(target).innerHTML = pairs.map(([k, v]) => '<div>' + k + '</div><div>' + v + '</div>').join('');
}
async function withBusy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>' + (label || '处理中…');
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}

/** 骨架屏：加载时先把版面占住（比一行「加载中…」更稳：不跳版、能看出是列表） */
function skeleton(target, lines) {
  const box = el(target);
  if (!box) return;
  box.setAttribute('aria-busy', 'true');
  box.innerHTML = '<div class="sk">' + '<i></i>'.repeat(lines || 3) + '</div>';
}
function busyDone(target) { const b = el(target); if (b) b.removeAttribute('aria-busy'); }

/** 错误提示带「下一步」：技能里明确要求错误要给恢复路径，不能只说失败了 */
function flashAction(id, text, kind, act) {
  const f = el(id);
  f.className = 'flash on' + (kind ? ' ' + kind : '');
  f.textContent = text;
  if (act && act.label && typeof act.fn === 'function' && typeof document.createElement === 'function') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn act';
    b.textContent = act.label;
    b.addEventListener('click', () => act.fn());
    f.appendChild(b);
  }
  return f;
}

/* ---------------------------------------------------------------- 标签切换 */
document.querySelectorAll('nav button[role=tab]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('main section').forEach((s) => { s.hidden = (s.id !== 'tab-' + b.dataset.tab); });
    // 插件页的条目清单要跑一遍 dsh --dump-config（慢），所以按需加载
    if (b.dataset.tab === 'plugins' && !PLUG) loadPrefs().then(() => { applyPrefs(); return loadPlugins(); }).catch(() => {});
  });
});
function goTab(name) {
  const b = document.querySelector('nav button[data-tab="' + name + '"]');
  if (b) b.click();
}

/* ---------------------------------------------------------------- 状态渲染 */
function render(s) {
  STATE = s;
  renderWatch(s);
  el('hdr-sub').textContent = '活动槽 ' + s.slot.active + '（dsh ' + s.slot.activeVersion + '） · 端口 ' + s.webPort;
  const lg = el('hdr-login');
  lg.className = 'pill ' + (s.loggedIn ? 'ok' : 'warn');
  lg.innerHTML = '<span class="dot ' + (s.loggedIn ? 'on' : 'off') + '"></span> ' + (s.loggedIn ? '已解锁' : '未解锁');
  el('btn-logout').hidden = !s.loggedIn;

  const d = s.dsh || {};
  rows('ov-dsh', [
    ['运行状态', d.running ? '<span class="pill ok"><span class="dot on"></span> 运行中</span> pid ' + (d.pid || '?') : '<span class="pill">已停止</span>'],
    ['网页地址', d.url ? '<a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.url.slice(0, 56)) + '…</a>' : '（运行后显示）'],
    ['端口', String(d.port || s.webPort) + (d.startedAt ? '　启动于 ' + esc(d.startedAt) : '')],
  ]);
  // 主操作按运行状态互斥：运行中不该还能点「启动 dsh」，停止后也不该还能点「停止」
  // 没装 dsh 时启动必然失败（子进程会立刻退出），所以直接禁用并指路，别等人点了才报错
  const notInstalled = ((s.slot && s.slot.activeVersion) || '') === 'not-installed';
  el('btn-dsh-start').disabled = !!d.running || notInstalled;
  el('btn-dsh-stop').disabled = !d.running;
  el('btn-dsh-open').disabled = !d.url;
  el('btn-dsh-start').title = notInstalled ? '活动槽里还没有 dsh：先到「升级」里安装' : '';
  el('ov-lock-note').textContent = notInstalled && !d.running
    ? '这台盘上还没装 dsh：先到「升级」里安装，再回来启动。'
    : (s.loggedIn ? '' : '启动 dsh 需要先解锁（口令用于把密钥注入 dsh 进程）');

  rows('ov-slots', [
    ['活动槽', s.slot.active + ' · dsh ' + esc(s.slot.activeVersion)],
    ['空闲槽（回滚目标）', s.slot.idle + ' · dsh ' + esc(s.slot.idleVersion)],
  ]);
  const tempOnDrive = s.tempRoot && s.root && String(s.tempRoot).toLowerCase().indexOf(String(s.root).toLowerCase()) === 0;
  rows('ov-env', [
    ['便携 Node', esc(s.node)],
    ['代码层', esc(s.sizes.runtime) + '　npm 缓存 ' + esc(s.sizes.cache)],
    ['数据', esc(s.sizes.data)],
    ['磁盘剩余', esc(s.sizes.free)],
    ['临时目录', tempOnDrive ? '本盘上' : '宿主临时目录（默认）'],
    ['路径', more('详情', '<span class="ln">本盘根目录 <code>' + esc(s.root) + '</code></span>' +
      '<span class="ln">代码层 <code>runtime\\</code>　数据 <code>data\\</code></span>' +
      '<span class="ln">临时目录 <code>' + esc(s.tempRoot) + '</code></span>')],
  ]);
  const sites = (s.sites && s.sites.list) || [];
  const keySites = (s.key && s.key.sites) || [];
  rows('ov-key', [
    ['密钥库', s.key.configured
      ? '<span class="pill ok">已配置</span> ' + keySites.length + ' 个站点密钥' +
        (s.key.store === 'legacy' ? '（旧格式）' : '')
      : '<span class="pill warn">未配置</span>'],
    ['站点', sites.length
      ? sites.map((x) => esc(x.id) + (x.enabled === false ? '（停用）' : '') + (keySites.some((k) => k.siteId === x.id) ? '✔' : '·')).join('、')
      : '（尚未配置，走 dsh 默认）'],
    ['默认模型', s.sites && s.sites.default ? esc(s.sites.default.siteId) + ' / ' + esc(s.sites.default.model) : '（未设置）'],
  ]);

  const jobs = (s.jobs && s.jobs.jobs) || [];
  el('ov-jobs').innerHTML = jobs.length
    ? '<table><thead><tr><th>任务</th><th>状态</th><th>说明</th></tr></thead><tbody>' + jobs.slice(0, 5).map((j) =>
      '<tr><td>' + esc(j.label) + '</td><td>' + statusPill(j.status) + '</td><td class="sub">' + esc(j.message || j.stage || '') + '</td></tr>'
    ).join('') + '</tbody></table>'
    : '<div class="ov-empty"><div class="ov-empty-t">还没有任务</div>'
      + '<div class="ov-empty-s">安装、升级、插件操作都会记在这里；正在跑的任务也能在这里取消。</div></div>';
  if (s.jobs && s.jobs.running) {
    CURRENT_JOB = s.jobs.running.id;
    renderJob(s.jobs.running);
  }
  el('p-port').value = s.webPort;
  // 首次使用（两个槽都没装）才显示引导，装完自动收起来
  const fresh = !s.slot.activeVersion && !s.slot.idleVersion;
  el('wizard').hidden = !fresh;
  if (fresh) markSteps();
  if (s.loggedIn) el('login-ov').hidden = true;
}

function statusPill(st) {
  const map = { done: ['ok', '完成'], running: ['', '进行中'], queued: ['', '排队'], failed: ['bad', '失败'],
    cancelled: ['warn', '已取消'], interrupted: ['warn', '中断'] };
  const m = map[st] || ['', st];
  return '<span class="pill ' + m[0] + '">' + m[1] + '</span>';
}

function renderJob(j, gridId) {
  const g = gridId || 'job-state';
  if (!j) { rows(g, [['当前任务', '（无）']]); return; }
  // 状态变了才脉冲一下（每次轮询都闪会烦人）
  const changed = j.status !== JOB_LAST_ST;
  JOB_LAST_ST = j.status;
  const pill = changed && (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    ? '<span class="pill ' + (/done/.test(j.status) ? 'ok' : 'bad') + ' pulse">' + (j.status === 'done' ? '完成' : '失败') + '</span>'
    : statusPill(j.status);
  rows(g, [
    ['任务', esc(j.label)],
    ['状态', pill + ' ' + esc(j.message || '')],
    ['阶段', esc(j.stage || '—')],
    ['开始 / 结束', esc(j.startedAt || '—') + (j.endedAt ? ' → ' + esc(j.endedAt) : '')],
    ['退出码', j.exitCode === null || j.exitCode === undefined ? '—' : String(j.exitCode)],
    ['回滚', j.rollback ? esc(j.rollback.reason) : '—'],
  ]);
}

let FAILS = 0;
async function refresh() {
  try {
    render(await api('/api/state'));
    FAILS = 0;
    renderBanner();
    return STATE;
  } catch (e) {
    FAILS++;
    if (FAILS >= 3) bannerBackendGone();
    flashAction('ov-dsh-out', '读取状态失败：' + e.message + '　—　服务是不是关了？可以再试一次。', 'err',
      { label: '重试', fn: () => refresh() });
    return null;
  }
}

/* ------------------------------------------------- 拔盘守护 / 后台断线横幅 */
function showBanner(html, danger) {
  const b = el('banner');
  b.className = danger ? 'danger' : '';
  b.innerHTML = html;
  b.hidden = false;
}
function hideBanner() { const b = el('banner'); b.innerHTML = ''; b.hidden = true; }
function renderBanner() {
  const lost = STATE && STATE.driveLost;
  if (lost) {
    showBanner('<span class="b-t">上一次运行时检测到本盘被拔出：</span>' + esc(String(lost.at || '')) +
      '（' + esc(String(lost.reason || '')) + '）——当时已自动停掉 dsh 和任务。' +
      '丢盘记录写在宿主临时目录 <code>' + esc(String(lost.log || '')) + '</code>，可在「诊断 → 拔盘守护」里清除。');
    return;
  }
  hideBanner();
}
function bannerBackendGone() {
  showBanner('<span class="b-t">后台服务没有响应</span>已连续 3 次读不到状态：可能是盘被拔出、服务窗口被关掉，或进程被结束了。' +
    '盘上的数据以最后一次成功写入为准；重新插好盘、重新打开 dsh-ui.cmd 即可继续。' +
    ' <button class="btn" id="btn-reconnect">重新连接</button>', true);
  const b = el('btn-reconnect');
  if (b) b.addEventListener('click', () => location.reload());
}
function renderWatch(s) {
  const w = s.driveWatch || {};
  rows('diag-watch', [
    ['守护状态', w.running ? '<span class="pill ok"><span class="dot on"></span> 运行中</span>' : '<span class="pill warn">未运行</span>'],
    ['判定规则', '每 ' + String(w.intervalMs || '?') + ' 毫秒读一次哨兵，连续 ' + String(w.maxMisses || '?') + ' 次读不到 → 判定丢盘'],
    ['成功 / 连续失败', String(w.oks || 0) + ' 次 / ' + String(w.misses || 0) + ' 次'],
    ['最近一次确认', w.lastOkAt ? esc(w.lastOkAt) : '（还没有）'],
    ['哨兵文件', w.sentinel ? '<span class="mono">' + esc(w.sentinel) + '</span>' : '<span class="pill warn">未建立</span>'],
  ]);
  const lost = s.driveLost;
  el('diag-watch-note').innerHTML = lost
    ? '上次丢盘：' + esc(String(lost.at || '')) + '（' + esc(String(lost.reason || '')) + '），记录在 <code>' + esc(String(lost.log || '')) + '</code>'
    : '没有丢盘记录（正常）。';
}
async function clearDriveLost() {
  try {
    await api('/api/drive-lost/clear', {});
    flash('diag-out', '已清除丢盘记录。', 'ok');
    await refresh();
  } catch (e) { flash('diag-out', '清除失败：' + e.message, 'err'); }
}

/* ---------------------------------------------------------------- 解锁 */
async function doLogin(setup) {
  const pass = el('li-pass').value;
  if (!pass) { flash('login-out', '请输入口令。', 'err'); return; }
  if (setup && pass !== el('li-pass2').value) { flash('login-out', '两次输入不一致。', 'err'); return; }
  try {
    const r = await withBusy(el('btn-login'), '解锁中…', () => api('/api/login', setup ? { pass, setup: true } : { pass }));
    if (r.firstRun && !r.created) {
      // 还没有设置过口令：引导确认
      el('login-title').textContent = '第一次使用：设置口令';
      el('li-pass2-box').hidden = false;
      el('btn-migrate').hidden = true;
      flash('login-out', r.message || '请再输一遍口令完成设置。', 'warn');
      el('btn-login').textContent = '设置口令并解锁';
      el('btn-login').dataset.setup = '1';
      return;
    }
    el('login-ov').hidden = true;
    el('li-pass').value = ''; el('li-pass2').value = '';
    flash('ov-dsh-out', '已解锁：现在可以设置密钥、启动 dsh、跑安装任务。', 'ok');
    await refresh();
    if (r.firstRun) { goTab('sites'); }
  } catch (e) {
    flash('login-out', e.message, 'err');
  }
}
el('btn-login').addEventListener('click', () => doLogin(el('btn-login').dataset.setup === '1'));
el('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-login').click(); });
el('li-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-login').click(); });
el('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  el('login-ov').hidden = false;
  el('login-title').textContent = '解锁配置页';
  el('li-pass2-box').hidden = true;
  el('btn-login').textContent = '解锁';
  delete el('btn-login').dataset.setup;
  await refresh();
});
el('btn-migrate').addEventListener('click', async (e) => {
  const pass = el('li-pass').value;
  if (!pass) { flash('login-out', '先输入旧密钥文件的口令。', 'err'); return; }
  try {
    const r = await api('/api/keys/migrate', { pass });
    flash('login-out', '已导入站点 ' + r.siteId + '（变量名 ' + r.keyName + '，' + r.length + ' 字符）。', 'ok');
    await refresh();
  } catch (err) { flash('login-out', '导入失败：' + err.message, 'err'); }
});

/* ---------------------------------------------------------------- dsh 启停 */
el('btn-dsh-start').addEventListener('click', (e) => withBusy(e.currentTarget, '启动中…', async () => {
  clearFlash('ov-dsh-out');
  flash('ov-dsh-out', '正在启动 dsh（首次启动会建会话目录，可能十几秒）…');
  try {
    const r = await api('/api/dsh/start', {});
    flash('ov-dsh-out', '已启动。\n' + (r.text || ''), r.ok ? 'ok' : 'err');
  } catch (err) { flash('ov-dsh-out', '启动失败：' + err.message, 'err'); }
  await refresh();
}));
el('btn-dsh-stop').addEventListener('click', (e) => withBusy(e.currentTarget, '停止中…', async () => {
  try {
    const r = await api('/api/dsh/stop', {});
    flash('ov-dsh-out', r.ok ? '已停止，端口已释放。' : '停止了但端口仍被占用，请稍后再看。', r.ok ? 'ok' : 'warn');
  } catch (err) { flash('ov-dsh-out', '停止失败：' + err.message, 'err'); }
  await refresh();
}));
el('btn-dsh-open').addEventListener('click', () => {
  const d = (STATE && STATE.dsh) || {};
  if (d.url) window.open(d.url, '_blank', 'noopener');
});
el('btn-switch').addEventListener('click', async () => {
  try {
    const r = await api('/api/slot/switch', {});
    flash('ov-slot-out', r.text || '已切换。', r.ok ? 'ok' : 'err');
  } catch (e) { flash('ov-slot-out', '切换失败：' + e.message, 'err'); }
  await refresh();
});

/* ---------------------------------------------------------------- 站点 */
let SITES = [];
let EDITING = null;
let KEY_LENGTHS = {};   // siteId → 已保存密钥长度（用于星号填充提示）
let PROBE_CACHE = {};   // 模型列表缓存（按站点 ID 或「地址+协议」）

/** 与后端同一个规则：先按站点 ID 找，再按「地址+协议」找；地址或协议不符不认。 */
function cacheLookup(site) {
  const c = PROBE_CACHE || {};
  const s = site || {};
  const norm = (x) => String(x || '').trim().replace(/\/+$/, '');
  const keys = [];
  if (s.id) keys.push('site:' + s.id);
  if (s.baseURL) keys.push('url:' + norm(s.baseURL) + '|' + (s.api || 'openai-completions'));
  for (const k of keys) {
    const e = c[k];
    if (!e) continue;
    if (s.baseURL && e.baseURL && norm(e.baseURL) !== norm(s.baseURL)) continue;
    if (s.api && e.api && e.api !== s.api) continue;
    return e;
  }
  return null;
}
/** 主视图只说人话：路径/文件名/内部 id 这类实现细节收进「详情」折叠（默认收起） */
function more(summary, bodyHtml) {
  return '<details class="more"><summary>' + summary + '</summary><div class="body">' + bodyHtml + '</div></details>';
}
/** 数字统一：大数加千分位，缺值统一成「—」（别一处在页面上写裸数字） */
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return x.toLocaleString('en-US');
}
/** 时间统一：主视图给相对时间，绝对时间放进 title（鼠标停一下就能看到） */
function fmtWhen(iso) {
  if (!iso) return '—';
  const abs = String(iso).replace('T', ' ').replace(/\.\d+Z?$/, '');
  return '<span title="' + esc(abs) + '">' + esc(ago(iso)) + '</span>';
}
function ago(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '时间未知';
  const d = Date.now() - t;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

async function loadSites() {
  skeleton('site-list', 3);
  const r = await api('/api/sites');
  SITES = r.sites || [];
  KEY_LENGTHS = r.keyLengths || {};
  PROBE_CACHE = r.probeCache || {};
  renderSiteList();
  // 默认模型下拉
  const ds = el('d-site'), dm = el('d-model');
  ds.innerHTML = SITES.map((s) => '<option value="' + esc(s.id) + '"' + (s.enabled === false ? ' disabled' : '') + '>' + esc(s.id) + (s.enabled === false ? '（停用）' : '') + '</option>').join('');
  const cur = (r.default && r.default.siteId) || (SITES[0] && SITES[0].id);
  if (cur) ds.value = cur;
  fillModels();
  return r;
}

/** 站点卡片列表（单独一个函数，方便在状态变化后局部重画，也方便被测试直接调用）。 */
function renderSiteList() {
  busyDone('site-list');
  const box = el('site-list');
  if (!SITES.length) { box.innerHTML = '（还没有站点）'; return; }
  box.innerHTML = SITES.map((s) => {
    const models = (s.models || []).map((m) => '<span class="tag' + (m.image ? ' vision' : '') + '">' + esc(m.id) + (m.image ? ' · 含图' : '') + '</span>').join('');
    const c = cacheLookup(s);
    const cacheLine = c ? '<div class="sub" style="margin-top:4px">模型列表已缓存：' + fmtNum(c.count) + ' 个（' + fmtWhen(c.at) + '）</div>' : '';
    return '<div class="site"><div class="top"><div class="title">' + esc(s.id) +
      (s.name ? '<span class="sub">（' + esc(s.name) + '）</span>' : '') +
      (s.enabled === false ? '<span class="pill warn">已停用</span>' : '<span class="pill ok">启用中</span>') +
      '</div><div class="row"><button class="btn" data-edit="' + esc(s.id) + '">编辑</button></div></div>' +
      '<div class="sub mono" style="margin-top:6px">' + esc(s.baseURL) + '　' + esc(s.api) + '　变量名 ' + esc(s.keyEnv) + '</div>' +
      '<div style="margin-top:6px">' + models + '</div>' + cacheLine + '</div>';
  }).join('');
  box.querySelectorAll('button[data-edit]').forEach((b) => b.addEventListener('click', () => openEditor(b.dataset.edit)));
}
function fillModels() {
  const s = SITES.find((x) => x.id === el('d-site').value);
  el('d-model').innerHTML = s ? (s.models || []).map((m) => '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>').join('') : '';
  if (STATE && STATE.sites && STATE.sites.default && STATE.sites.default.siteId === el('d-site').value) {
    el('d-model').value = STATE.sites.default.model;
  }
}
el('d-site').addEventListener('change', fillModels);

function openEditor(id) {
  EDITING = id || null;
  const s = id ? SITES.find((x) => x.id === id) : null;
  el('site-editor').hidden = false;
  el('site-editor-title').textContent = s ? ('编辑站点 ' + s.id) : '新增站点';
  el('s-id').value = s ? s.id : '';
  el('s-id').disabled = !!s;
  el('s-name').value = s ? (s.name || '') : '';
  el('s-url').value = s ? s.baseURL : '';
  el('s-api').value = s ? s.api : 'openai-completions';
  el('s-keyenv').value = s ? s.keyEnv : '';
  el('s-key').value = '';
  // 已有密钥就用「星号按长度填充」占位：一眼看出已经存过、大约多少位，又不会把密钥显示出来
  const keyLen = KEY_LENGTHS[EDITING] || 0;
  el('s-key').placeholder = keyLen ? '*'.repeat(Math.min(keyLen, 80)) : '（还没有保存过密钥）';
  el('s-key-hint').textContent = keyLen
    ? ('已保存 ' + keyLen + ' 位；留空表示不修改')
    : '（只走本地请求，进程内加密，不落明文）';
  el('s-compat').checked = !!(s && s.compat);
  el('s-enabled').checked = !s || s.enabled !== false;
  MODELS = s ? (s.models || []).map((m) => ({ id: m.id, image: !!m.image, contextWindow: m.contextWindow || null })) : [];
  // 模型列表直接用缓存（上次拉过的），不用每次重新拉；点「拉取模型」才刷新
  const cached = cacheLookup({ id: EDITING, baseURL: s ? s.baseURL : '', api: s ? s.api : '' });
  PROBED = cached ? cached.models.map((m) => m.id) : [];
  PROBED_CTX = {};
  if (cached) for (const m of cached.models) if (m.contextWindow) PROBED_CTX[m.id] = m.contextWindow;
  el('m-id').placeholder = PROBED.length
    ? ('点右边箭头从 ' + PROBED.length + ' 个模型里选，或直接输入')
    : '请先获取模型或手动输入模型';
  el('model-form').hidden = true;
  hideDd();
  renderModelList();
  el('btn-site-del').hidden = !s;
  clearFlash('site-edit-out');
  if (cached) {
    flash('s-probe-out', '模型列表用的是上次拉取的结果（' + cached.count + ' 个，' + ago(cached.at) +
      '）：可以直接点选；要刷新就点「拉取模型」。', 'warn');
  } else {
    clearFlash('s-probe-out');
  }
  el('s-id').focus();
}
el('btn-site-new').addEventListener('click', () => openEditor(null));
el('btn-site-cancel').addEventListener('click', () => { el('site-editor').hidden = true; });
el('s-id').addEventListener('input', () => {
  if (!EDITING) {
    const id = el('s-id').value.trim();
    el('s-keyenv').value = id ? (id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, '_$1') + '_API_KEY') : '';
  }
});
/* ---- 模型：列表 + 单模型表单（可点选/搜索/上下文/视觉）---- */
let MODELS = [];        // 编辑器里的模型：[{id, image, contextWindow}]
let PROBED = [];        // 从站点拉到的模型 id
let PROBED_CTX = {};    // id → 网关顺带给的上下文长度（有就预填）
let MODEL_EDIT = -1;    // 正在编辑第几个（-1 = 新增）

function renderModelList() {
  const box = el('s-model-list');
  if (!MODELS.length) {
    box.innerHTML = '<span class="sub">（还没有模型：点「添加模型」，或先「拉取模型」再点选）</span>';
    return;
  }
  box.innerHTML = '<table class="mtable"><thead><tr><th>模型</th><th>上下文</th><th>视觉</th><th></th></tr></thead><tbody>' +
    MODELS.map((m, i) => '<tr><td class="mono">' + esc(m.id) + '</td><td>' +
      (m.contextWindow ? esc(m.contextWindow) : '<span class="sub">auto</span>') +
      '</td><td>' + (m.image ? '<span class="pill ok">支持</span>' : '<span class="sub">—</span>') +
      '</td><td><button class="btn" data-medit="' + i + '">编辑</button> <button class="btn danger" data-mdel="' + i + '">删除</button></td></tr>').join('') +
    '</tbody></table>';
  box.querySelectorAll('button[data-mdel]').forEach((b) => b.addEventListener('click', () => {
    MODELS.splice(Number(b.dataset.mdel), 1);
    renderModelList();
  }));
  box.querySelectorAll('button[data-medit]').forEach((b) => b.addEventListener('click', () => openModelForm(Number(b.dataset.medit))));
}

function hideDd() { el('m-dd').hidden = true; }

function fillDd(filter) {
  const q = String(filter || '').trim().toLowerCase();
  const dd = el('m-dd');
  if (!PROBED.length) {
    // 用户要的提示语：没拉取过就点选 → 「请先获取模型或手动输入模型」
    dd.innerHTML = '<div class="empty">请先获取模型或手动输入模型（点上面的「拉取模型」）</div>';
  } else {
    const list = PROBED.filter((x) => !q || x.toLowerCase().indexOf(q) >= 0);
    dd.innerHTML = list.length
      ? list.map((x) => '<div data-pick="' + esc(x) + '">' + esc(x) +
        (PROBED_CTX[x] ? ' <span class="sub">上下文 ' + PROBED_CTX[x] + '</span>' : '') + '</div>').join('')
      : '<div class="empty">没有匹配「' + esc(q) + '」的模型</div>';
    dd.querySelectorAll('div[data-pick]').forEach((d) => d.addEventListener('mousedown', (ev) => {
      ev.preventDefault();   // 别让输入框失焦，否则下拉会先被关掉
      el('m-id').value = d.dataset.pick;
      if (PROBED_CTX[d.dataset.pick] && !el('m-ctx').value.trim()) el('m-ctx').value = String(PROBED_CTX[d.dataset.pick]);
      hideDd();
    }));
  }
  dd.hidden = false;
}

function openModelForm(idx) {
  MODEL_EDIT = (typeof idx === 'number' && idx >= 0) ? idx : -1;
  const m = MODEL_EDIT >= 0 ? MODELS[MODEL_EDIT] : null;
  el('model-form').hidden = false;
  el('model-form-title').textContent = m ? ('编辑模型 ' + m.id) : '添加模型';
  el('m-id').value = m ? m.id : '';
  el('m-ctx').value = (m && m.contextWindow) ? String(m.contextWindow) : '';
  el('m-vision').checked = !!(m && m.image);
  el('m-vision-txt').textContent = el('m-vision').checked ? '支持图片' : '不支持图片';
  el('m-id').placeholder = PROBED.length
    ? ('点右边箭头从 ' + PROBED.length + ' 个模型里选，或直接输入')
    : '请先获取模型或手动输入模型';
  hideDd();
  clearFlash('model-form-out');
  el('m-id').focus();
}

el('btn-model-add').addEventListener('click', () => openModelForm(-1));
el('btn-model-cancel').addEventListener('click', () => { el('model-form').hidden = true; hideDd(); });
el('m-toggle').addEventListener('click', () => { if (el('m-dd').hidden) fillDd(el('m-id').value); else hideDd(); });
el('m-id').addEventListener('focus', () => fillDd(el('m-id').value));
el('m-id').addEventListener('input', () => fillDd(el('m-id').value));
el('m-id').addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDd(); });
el('m-vision').addEventListener('change', () => {
  el('m-vision-txt').textContent = el('m-vision').checked ? '支持图片' : '不支持图片';
});
el('btn-model-ok').addEventListener('click', () => {
  const id = el('m-id').value.trim();
  if (!id) { flash('model-form-out', '请先获取模型或手动输入模型', 'err'); return; }
  const raw = el('m-ctx').value.trim();
  let contextWindow = null;
  if (raw && raw.toLowerCase() !== 'auto') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) { flash('model-form-out', '上下文要么留空（auto），要么填正整数。', 'err'); return; }
    contextWindow = n;
  }
  if (MODELS.some((m, i) => m.id === id && i !== MODEL_EDIT)) {
    flash('model-form-out', '这个模型已经添加过了。', 'err');
    return;
  }
  const entry = { id, image: el('m-vision').checked, contextWindow };
  if (MODEL_EDIT >= 0) MODELS[MODEL_EDIT] = entry; else MODELS.push(entry);
  el('model-form').hidden = true;
  hideDd();
  renderModelList();
  flash('s-probe-out', '已' + (MODEL_EDIT >= 0 ? '更新' : '添加') + '模型 ' + id + '（点「保存站点」才真正写进配置）。', 'ok');
});

el('btn-probe').addEventListener('click', (e) => withBusy(e.currentTarget, '拉取中…', async () => {
  clearFlash('s-probe-out');
  try {
    const r = await api('/api/sites/probe', {
      baseURL: el('s-url').value.trim(), api: el('s-api').value,
      key: el('s-key').value || undefined, siteId: EDITING || undefined,
    });
    if (!r.ok) { flash('s-probe-out', '拉取失败：' + (r.error || ''), 'err'); return; }
    PROBED = r.models || [];
    PROBED_CTX = {};
    for (const d of (r.details || [])) if (d && d.contextWindow) PROBED_CTX[d.id] = d.contextWindow;
    // 记进本地缓存，这样不刷新页面也能立刻用；后端也已经落盘了
    const key = EDITING ? ('site:' + EDITING) : ('url:' + String(el('s-url').value.trim()).replace(/\/+$/, '') + '|' + el('s-api').value);
    PROBE_CACHE[key] = {
      at: new Date().toISOString(), baseURL: el('s-url').value.trim(), api: el('s-api').value,
      count: PROBED.length,
      models: PROBED.map((id) => (PROBED_CTX[id] ? { id, contextWindow: PROBED_CTX[id] } : { id })),
    };
    const withCtx = Object.keys(PROBED_CTX).length;
    el('m-id').placeholder = PROBED.length ? ('点右边箭头从 ' + PROBED.length + ' 个模型里选，或直接输入') : '拉到了 0 个模型，可以手动输入';
    flash('s-probe-out', '拉到 ' + PROBED.length + ' 个模型' + (withCtx ? ('，其中 ' + withCtx + ' 个带上下文信息') : '') +
      '。已记下来，之后加模型不用再拉。', 'ok');
  } catch (err) { flash('s-probe-out', '拉取失败：' + err.message, 'err'); }
}));
el('btn-site-save').addEventListener('click', (e) => withBusy(e.currentTarget, '保存中…', async () => {
  clearFlash('site-edit-out');
  const site = {
    id: el('s-id').value.trim(), name: el('s-name').value.trim(), baseURL: el('s-url').value.trim(),
    api: el('s-api').value, keyEnv: el('s-keyenv').value.trim() || undefined,
    models: MODELS.slice(), compat: el('s-compat').checked ? true : null, enabled: el('s-enabled').checked,
  };
  try {
    const r = await api('/api/sites', { site });
    let msg = '站点已保存，覆盖层' + (r.backup ? '（旧文件已备份）' : '') + '。';
    const key = el('s-key').value.trim();
    // 占位星号（我们把已有密钥按长度显示成星号）绝不能被当成真密钥提交
    if (key && /^\*+$/.test(key)) {
      msg += '\n（输入框里的星号是「已有密钥」的提示，没有提交；要换密钥请直接粘贴新的）';
    } else if (key) {
      const kr = await api('/api/key', { siteId: site.id, key, keyEnv: site.keyEnv });
      msg += '\n密钥已加密保存（变量名 ' + kr.keyName + '，' + kr.length + ' 字符）。';
    }
    flash('site-edit-out', msg, 'ok');
    el('site-editor').hidden = true;
    await loadSites();
    await refresh();
  } catch (err) { flash('site-edit-out', '保存失败：' + err.message, 'err'); }
}));
el('btn-site-del').addEventListener('click', async () => {
  if (!EDITING) return;
  if (!window.confirm('删除站点 ' + EDITING + '？（会同时从覆盖层移除；密钥可选择一起删）')) return;
  const alsoKey = window.confirm('连它保存的密钥一起删除吗？（确定=一起删，取消=保留密钥）');
  try {
    const r = await api('/api/sites/delete', { siteId: EDITING, removeKey: alsoKey });
    flash('site-out', '已删除站点 ' + EDITING + (r.keyRemoved ? '（含密钥）' : ''), 'ok');
    el('site-editor').hidden = true;
    await loadSites(); await refresh();
  } catch (e) { flash('site-edit-out', '删除失败：' + e.message, 'err'); }
});
el('btn-default-save').addEventListener('click', async () => {
  const siteId = el('d-site').value, model = el('d-model').value;
  if (!siteId || !model) { flash('default-out', '请选择站点与模型。', 'err'); return; }
  try {
    await api('/api/sites', { site: SITES.find((s) => s.id === siteId), default: { siteId, model } });
    flash('default-out', '默认模型已设为 ' + siteId + ' / ' + model + '。', 'ok');
    await refresh();
  } catch (e) { flash('default-out', '设置失败：' + e.message, 'err'); }
});
el('btn-overlay-rebuild').addEventListener('click', (e) => withBusy(e.currentTarget, '生成中…', async () => {
  try {
    const r = await api('/api/overlay/rebuild', {});
    flash('site-out', '覆盖层已重写：' + r.overlay + (r.backup ? '（旧文件备份到 ' + r.backup + '）' : '（内容没变，未重写）') + '\n' + (r.dump || '').split('\n')[0], 'ok');
  } catch (e2) { flash('site-out', '生成失败：' + e2.message, 'err'); }
}));

/* ---------------------------------------------------------------- 升级与任务 */
function startPolling() {
  if (POLL) return;
  POLL = setInterval(pollJob, 1200);
}
function stopPolling() { if (POLL) { clearInterval(POLL); POLL = null; } }
async function pollJob() {
  try {
    const s = await api('/api/jobs');
    const run = s.running;
    if (run) {
      if (!CURRENT_JOB || CURRENT_JOB !== run.id) {
        CURRENT_JOB = run.id; LOG_OFFSET = 0;
        const pre = el(CUR_LOG || 'job-log');
        if (pre) pre.textContent = '';
      }
      renderJob(run, CUR_GRID || 'job-state');
    } else if (CURRENT_JOB) {
      const mine = (s.jobs || []).find((j) => j.id === CURRENT_JOB);
      if (mine) renderJob(mine, CUR_GRID || 'job-state');
      stopPolling();
      const hint = jobFailHint();
      const t = String((el(CUR_LOG || 'plug-log') || {}).textContent || '');
      if (mine && mine.status !== 'done' && /UNEXPECTED_STORE/.test(t)) {
        flashAction(CUR_OUT || 'job-out', '任务结束：' + mine.status + '　' + (mine.message || '') + '　—　' + hint, 'warn',
          { label: '装匹配的 pnpm', fn: () => el('btn-pnpm-setup').click() });
      } else if (mine && mine.status !== 'done' && /MINIMUM_RELEASE_AGE/.test(t)) {
        flashAction(CUR_OUT || 'job-out', '任务结束：' + mine.status + '　' + (mine.message || '') + '　—　' + hint, 'warn',
          { label: '放宽并重试', fn: () => { setRelax(true); if (LAST_OP) runJob(LAST_OP.path, LAST_OP.body, LAST_OP.btn, LAST_OP.label, LAST_OP.opts); } });
      } else {
        flashAction(CUR_OUT || 'job-out', '任务结束：' + (mine ? (mine.status + '　' + (mine.message || '')) : '—') + (mine && mine.status !== 'done' && hint ? '　—　' + hint : ''),
          mine && mine.status === 'done' ? 'ok' : 'warn',
          mine && mine.status !== 'done' && LAST_OP ? { label: '再试一次', fn: () => runJob(LAST_OP.path, LAST_OP.body, LAST_OP.btn, LAST_OP.label, LAST_OP.opts) } : null);
      }
      await refresh();
      if (PLUG) loadPlugins(true).catch(() => {});
      return;
    }
    if (CURRENT_JOB) await pullLog();
  } catch (e) { /* 轮询失败不打扰用户 */ }
}
async function pullLog() {
  if (!CURRENT_JOB) return;
  const pre = el(CUR_LOG || 'job-log');
  if (!pre) return;
  const r = await api('/api/jobs/log?id=' + encodeURIComponent(CURRENT_JOB) + '&from=' + LOG_OFFSET, undefined, 'GET');
  if (r && r.text) {
    if (r.reset) { pre.textContent = ''; }
    pre.textContent = (pre.textContent === '（还没有任务）' ? '' : pre.textContent) + r.text;
    pre.scrollTop = pre.scrollHeight;
    LOG_OFFSET = r.next;
  }
}
async function runJob(path, body, btn, label, opts) {
  const o = opts || {};
  LAST_OP = { path, body, btn, label, opts: o };     // 失败时可以「放宽后再试一次」，不用用户重填
  CUR_LOG = o.log || 'job-log';
  CUR_GRID = o.jobGrid || 'job-state';
  // 日志被收进折叠区时，任务一开始就展开：否则用户会以为「点了没反应」
  const logHost = el(CUR_LOG);
  if (logHost && logHost.closest) {
    const box = logHost.closest('details');
    if (box && !box.open) box.open = true;
  }
  const outId = o.out || 'job-out';
  CUR_OUT = outId;
  clearFlash(outId);
  try {
    const r = await withBusy(btn, label, () => api(path, body));
    CURRENT_JOB = r.job && r.job.id;
    LOG_OFFSET = 0;
    const pre = el(CUR_LOG);
    if (pre) pre.textContent = '';
    renderJob(r.job, o.jobGrid || 'job-state');
    flash(outId, '任务已开始：' + r.job.label + (o.keepTab ? '（日志在下面刷新）' : '（可切到别的标签页，任务在后台继续）'), 'ok');
    if (!o.keepTab) goTab('upgrade');
    startPolling();
    await pullLog();
  } catch (e) {
    flash(outId, '无法开始任务：' + e.message, 'err');
  }
}
/* ---- 版本列表：从 npm 官方源取，界面只让用户点选 ---- */
let VERSIONS = null;
async function loadVersions(force) {
  try {
    const v = await api('/api/versions' + (force ? '?force=1' : ''), undefined, 'GET');
    if (!v.ok) throw new Error(v.error || '取不到版本列表');
    VERSIONS = v;
    fillVersionSelects();
    el('u-ver-note').textContent = '共 ' + v.count + ' 个版本 · 来源 ' + v.source + ' · 标签 ' +
      Object.keys(v.tags).map((k) => k + '=' + v.tags[k]).join('、') +
      ' · 已装 A=' + (v.installed['agent-A'] || '无') + ' B=' + (v.installed['agent-B'] || '无');
    markSteps();
    return v;
  } catch (e) {
    el('u-ver-note').textContent = '取不到版本列表：' + e.message + '　（可以点「手动填版本」直接输入）';
    for (const id of ['u-ver', 'i-ver', 'wz-ver']) {
      const s = el(id);
      if (s && (!s.options || !s.options.length)) s.innerHTML = '<option value="">（取不到列表，请手动填）</option>';
    }
    return null;
  }
}
function fillVersionSelects() {
  if (!VERSIONS) return;
  const opts = VERSIONS.versions.map((v) => {
    const tags = v.tags.length ? '（' + v.tags.join(' ') + '）' : '';
    const inst = [];
    if (VERSIONS.installed['agent-A'] === v.version) inst.push('已装 A');
    if (VERSIONS.installed['agent-B'] === v.version) inst.push('已装 B');
    return '<option value="' + esc(v.version) + '">' + esc(v.version) + esc(tags) +
      (inst.length ? ' · ' + inst.join(' / ') : '') + '</option>';
  }).join('');
  for (const id of ['u-ver', 'i-ver', 'wz-ver']) el(id).innerHTML = opts;
  // 默认选中 alpha（dsh 当前只有 rc/alpha 线）；没有就选最新
  const preferred = VERSIONS.tags.alpha || VERSIONS.tags.next || VERSIONS.tags.latest ||
    (VERSIONS.versions[0] && VERSIONS.versions[0].version);
  for (const id of ['u-ver', 'i-ver', 'wz-ver']) {
    const s = el(id);
    if (!s) continue;
    if (preferred && Array.from(s.options || []).some((o) => o.value === preferred)) s.value = preferred;
  }
}
el('btn-ver-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, '刷新中…', () => loadVersions(true)));
el('btn-ver-manual').addEventListener('click', (e) => {
  const box = el('u-ver-manual-box');
  box.hidden = !box.hidden;
  e.currentTarget.textContent = box.hidden ? '手动填版本' : '用列表选择';
  if (!box.hidden) el('u-ver-raw').focus();
});
function pickedVersion() {
  if (!el('u-ver-manual-box').hidden) return el('u-ver-raw').value.trim();
  return String(el('u-ver').value || '').trim();
}


/* ---------------------------------------------------------------- 内容缩放
   窗口变宽时把内容区整体放大（字/卡片/按钮一起），顶栏和菜单栏保持原尺寸。
   基准 1180：1280 的窗口约 1.08，1600 约 1.36，1920 约 1.55（上限）。 */
let _manualZoom = 1;          // Ctrl+滚轮的手动倍率（只作用于内容区）
function applyContentZoom() {
  const m = document.querySelector('main');
  if (!m) return;
  const w = document.documentElement.clientWidth || window.innerWidth;
  let z = (w / 1180) * _manualZoom;
  // 上限压到 1.2：窗口再宽也不把卡片和字号无限放大，只多留白/多列
  if (z < 0.8) z = 0.8;
  if (z > 1.2) z = 1.2;
  m.style.zoom = z.toFixed(3);
}
applyContentZoom();
// Ctrl+滚轮：只缩放内容区，菜单栏和顶栏保持原尺寸（宿主那边已关掉 WebView2 自带缩放）
window.addEventListener('wheel', (ev) => {
  if (!ev.ctrlKey) return;
  ev.preventDefault();
  _manualZoom = Math.min(1.6, Math.max(0.7, _manualZoom + (ev.deltaY > 0 ? -0.05 : 0.05)));
  applyContentZoom();
}, { passive: false });
let _zoomTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(_zoomTimer);
  _zoomTimer = setTimeout(applyContentZoom, 80);
});


/* ---------------------------------------------------------------- 外观选项
   背景（流体渐变/纯色）、主色、动效强度；都存在服务端的 data/ui-prefs.json，
   和主题一样跟盘走。换主色只覆盖 CSS 令牌，不改任何组件样式。 */
const ACCENTS = ["green", "blue", "purple", "orange", "cyan"];
const MOTIONS = ["full", "calm", "off"];
const BGS = ["fluid", "solid", "image"];

/** 当前外观（含自定义背景）；统一从这里读，避免各处各写一份导致 wallpaper 被覆盖掉 */
let AP = { bg: 'fluid', accent: 'green', motion: 'full' };

function currentAppearance() {
  return { bg: AP.bg, accent: AP.accent, motion: AP.motion, wallpaper: AP.wallpaper };
}

/** 背景图版本号：换图后要让 url 变，否则浏览器拿缓存那张 */
function wallUrl(w) {
  return 'url("/api/wallpaper?v=' + encodeURIComponent((w && (w.at || w.bytes)) || Date.now()) + '")';
}

function applyAppearance(a, persist) {
  const h = document.documentElement;
  if (a) {
    AP = {
      bg: BGS.indexOf(a.bg) >= 0 ? a.bg : 'fluid',
      accent: ACCENTS.indexOf(a.accent) >= 0 ? a.accent : 'green',
      motion: MOTIONS.indexOf(a.motion) >= 0 ? a.motion : 'full',
      wallpaper: a.wallpaper || null,
    };
  }
  // 选了图片但盘上其实没有图 → 退回流体渐变，别给一片纯黑
  if (AP.bg === 'image' && !AP.wallpaper) AP.bg = 'fluid';

  const w = AP.wallpaper || {};
  const blur = Math.max(0, Math.min(24, Number(w.blur) || 0));
  const dim = Math.max(0, Math.min(80, Number(w.dim) === 0 ? 0 : (Number(w.dim) || 35)));
  const dark = h.dataset.theme !== 'light';

  h.dataset.bg = AP.bg;
  h.dataset.accent = AP.accent;
  h.dataset.motion = AP.motion;
  h.style.setProperty('--wall-blur', blur + 'px');
  h.style.setProperty('--wall-dim-color', dark
    ? 'rgb(0 0 0 / ' + (dim / 100) + ')'
    : 'rgb(255 255 255 / ' + (dim / 100) + ')');
  if (AP.wallpaper) h.style.setProperty('--wallpaper-image', wallUrl(w));
  else h.style.removeProperty('--wallpaper-image');

  if (el('ap-bg')) el('ap-bg').value = AP.bg;
  if (el('ap-accent')) el('ap-accent').value = AP.accent;
  if (el('ap-motion')) el('ap-motion').value = AP.motion;
  if (el('ap-theme')) el('ap-theme').value = h.dataset.theme === 'light' ? 'light' : 'dark';
  if (el('ap-wall')) el('ap-wall').hidden = AP.bg !== 'image';
  if (el('ap-wall-clear')) el('ap-wall-clear').hidden = !AP.wallpaper;
  if (el('ap-wall-dim')) el('ap-wall-dim').value = String(dim);
  if (el('ap-wall-blur')) el('ap-wall-blur').value = String(blur);
  if (el('ap-wall-size')) {
    el('ap-wall-size').textContent = AP.wallpaper
      ? (AP.wallpaper.bytes ? (Math.round(AP.wallpaper.bytes / 1024) + ' KB · ') : '') + (AP.wallpaper.mime || '')
      : '';
  }
  document.querySelectorAll('#launcher-swatches button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.accent === AP.accent ? 'true' : 'false');
  });

  if (persist) {
    api("/api/prefs", { appearance: currentAppearance() }).catch(() => {});
    // 通知桌面壳：dsh 界面那张背景也要跟着换
    try {
      const host = hostBridge();
      if (host) host.postMessage(JSON.stringify({ type: 'dsh.wallpaper' }));
    } catch (e) { /* 浏览器回退没有宿主 */ }
  }
}

/** 把用户选的图片压到最长边 2560 再传，避免 6MB 上限被一张手机原图打爆 */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX = 2560;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/webp', 0.9);
      if (out.indexOf('data:image/webp') !== 0) out = c.toDataURL('image/jpeg', 0.9);
      resolve({ dataUrl: out, w: w, h: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不出来')); };
    img.src = url;
  });
}

if (el('ap-theme')) {
  el('ap-theme').addEventListener('change', () => { applyTheme(el('ap-theme').value, true); applyAppearance(null, false); });
  const saveAp = () => {
    applyAppearance({
      bg: el("ap-bg").value,
      accent: el("ap-accent").value,
      motion: el("ap-motion").value,
      wallpaper: AP.wallpaper,
    }, true);
    if (el('ap-out')) flash('ap-out', '已应用', 'ok');
  };
  el('ap-bg').addEventListener('change', saveAp);
  document.querySelectorAll('#launcher-swatches button').forEach((b) => {
    b.addEventListener('click', () => {
      el('ap-accent').value = b.dataset.accent;
      saveAp();
    });
  });
  el('ap-motion').addEventListener('change', saveAp);

  // 选背景图
  if (el('ap-wall-pick')) {
    el('ap-wall-pick').addEventListener('click', () => el('ap-wall-file').click());
    el('ap-wall-file').addEventListener('change', async () => {
      const f = el('ap-wall-file').files && el('ap-wall-file').files[0];
      if (!f) return;
      try {
        if (el('ap-wall-pick')) { el('ap-wall-pick').disabled = true; el('ap-wall-pick').textContent = '处理中…'; }
        const shrunk = await shrinkImage(f);
        const r = await api('/api/wallpaper', {
          dataUrl: shrunk.dataUrl,
          opts: { dim: Number(el('ap-wall-dim') ? el('ap-wall-dim').value : 35), blur: Number(el('ap-wall-blur') ? el('ap-wall-blur').value : 0) },
        });
        AP.wallpaper = (r && r.appearance && r.appearance.wallpaper) || { bytes: Math.round(shrunk.dataUrl.length * 0.75), mime: 'image/webp' };
        applyAppearance({ bg: 'image', accent: AP.accent, motion: AP.motion, wallpaper: AP.wallpaper }, true);
        if (el('ap-out')) flash('ap-out', '背景已更新（配置页 + dsh 界面）', 'ok');
      } catch (e) {
        if (el('ap-out')) flash('ap-out', '设背景失败：' + (e.message || e), 'bad');
      } finally {
        if (el('ap-wall-pick')) { el('ap-wall-pick').disabled = false; el('ap-wall-pick').textContent = '选择图片…'; }
        if (el('ap-wall-file')) el('ap-wall-file').value = '';
      }
    });
  }
  if (el('ap-wall-clear')) {
    el('ap-wall-clear').addEventListener('click', async () => {
      try {
        await api('/api/wallpaper', {}, 'DELETE');
        AP.wallpaper = null;
        applyAppearance({ bg: 'fluid', accent: AP.accent, motion: AP.motion, wallpaper: null }, true);
        if (el('ap-out')) flash('ap-out', '背景已移除', 'ok');
      } catch (e) {
        if (el('ap-out')) flash('ap-out', '移除失败：' + (e.message || e), 'bad');
      }
    });
  }
  // 遮罩 / 模糊：拖动即生效，松手存盘
  ['ap-wall-dim', 'ap-wall-blur'].forEach((id) => {
    if (!el(id)) return;
    el(id).addEventListener('input', () => {
      AP.wallpaper = Object.assign({}, AP.wallpaper || {}, {
        dim: Number(el('ap-wall-dim').value),
        blur: Number(el('ap-wall-blur').value),
      });
      applyAppearance(null, false);
    });
    el(id).addEventListener('change', () => applyAppearance(Object.assign({}, currentAppearance()), true));
  });
}

/* ---------------------------------------------------------------- 自绘标题栏
   顶栏就是标题栏（和页面第一条 header 合并在一起），只在启动器宿主里出现；
   浏览器回退（dsh-ui.cmd）时不显示窗口按钮，用浏览器自己的标题栏。
   拖拽/缩放/最大化边界在宿主里做（WndProc）；页面负责：
     1) 画三颗按钮并发消息；
     2) 告诉宿主「从哪一列开始属于交互区」——右边是按钮，左边才是可拖动的空白。 */
function initTitlebar() {
  const bar = el('titlebar');
  const host = hostBridge();
  if (!bar || !host) return;
  el('tb-ctl').hidden = false;
  const post = (msg) => { try { host.postMessage(msg); } catch (e) { /* 宿主不在 */ } };
  el('tb-min').addEventListener('click', () => post({ type: 'dsh.win.min' }));
  el('tb-max').addEventListener('click', () => post({ type: 'dsh.win.max' }));
  el('tb-close').addEventListener('click', () => post({ type: 'dsh.win.close' }));
  host.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d.type === 'dsh.zoom') { syncHit(); return; }   // 缩放变了，可拖动区边界要重新量
    if (d.type !== 'dsh.win.state') return;
    const b = el('tb-max');
    if (!b) return;
    b.dataset.max = d.maximized ? '1' : '0';
    b.setAttribute('aria-label', d.maximized ? '还原' : '最大化');
  });
  // 交互区从 #tb-actions 的左边缘开始：这条线左边＝标题栏（可拖），右边＝网页（可点）
  const syncHit = () => {
    const act = el('tb-actions');
    if (!act) return;
    const x = Math.round(act.getBoundingClientRect().left);
    post({ type: 'dsh.win.hit', captionRight: x });
  };
  // 拖窗与双击最大化：交给宿主的非客户区拖动，这样贴边分屏、Snap 布局也是系统原生的
  bar.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('button, a, input, select, .pb')) return;
    post({ type: 'dsh.win.drag' });
  });
  const navBar = document.querySelector('nav');
  if (navBar) {
    navBar.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('button')) return;
      post({ type: 'dsh.win.max' });
    });
  }
  bar.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button, a, input, select, .pb')) return;
    post({ type: 'dsh.win.max' });
  });
  syncHit();
  window.addEventListener('resize', syncHit);
  if (window.ResizeObserver) new ResizeObserver(syncHit).observe(bar);
}
initTitlebar();
installResponsive();   // 宽度分档（死区，避免拖动时元素闪断）

/* ---------------------------------------------------------------- 主题
   深/浅两套皮肤只靠 CSS 变量切换（html[data-theme]），组件样式不用动。
   选择存在服务端的 data/ui-prefs.json（跟盘走，不写浏览器存储）；切换时再通知宿主，
   把原生标题栏换成同一套颜色，免得又出现「边框和内容割裂」。 */
function applyTheme(theme, persist) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  // 官方 Web UI 的设计 token 用 body[data-ds-dark-theme] 切换深色（深色时存在该属性），
  // 这里跟 html[data-theme] 一起维护，页面里那套变量才会真正跟着变。
  if (document.body) {
    if (t === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
  }
  const label = el('btn-theme-label');
  if (label) label.textContent = t === 'light' ? '深色' : '浅色';
  const b = el('btn-theme');
  if (b) b.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
  try {
    const hb = hostBridge();
    if (hb) hb.postMessage({ type: 'dsh.theme', theme: t });
  } catch (e) { /* 浏览器回退路径没有宿主 */ }
  if (persist) api('/api/prefs', { theme: t }).catch(() => {});
}
/** 宽度分档（带死区）：替代 @media 在断点附近反复闪断 */
function installResponsive() {
  const RULES = [['w-md', 1180], ['w-sm', 1040]];
  const on = {};
  let t = null;
  const apply = () => {
    const w = window.innerWidth;
    for (const [name, th] of RULES) {
      const cur = !!on[name];
      const next = cur ? w < th + 24 : w < th - 10;   // 死区 34px
      if (next !== cur) {
        on[name] = next;
        document.documentElement.classList.toggle(name, next);
      }
    }
  };
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(apply, 40); });
  apply();
}

async function loadTheme() {
  let saved = 'dark';
  let appearance = null;
  try {
    const p = await api('/api/prefs');
    if (p && (p.theme === 'light' || p.theme === 'dark')) saved = p.theme;
    // 自适应：页面自己按系统的 prefers-color-scheme 解析（桌面壳里壳会再推一次实际值）
    else if (p && p.theme === 'auto') saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    if (p && p.appearance) appearance = p.appearance;
  } catch (e) { /* 老服务没有这个接口 */ }
  applyTheme(saved, false);
  applyAppearance(appearance, false);
}
if (el('btn-theme')) {
  el('btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
  });
}

el('btn-upgrade').addEventListener('click', (e) => {
  const v = pickedVersion();
  if (!v) { flash('up-out', '请先从列表里选一个版本（或用「手动填版本」）。', 'err'); return; }
  runJob('/api/jobs/upgrade', { version: v }, e.currentTarget, '升级中…');
});

/* ---------------------------------------------------------------- 下载源
   官方源在部分网络下是「连得上但一直不回包」，以前会空等半小时才换镜像。
   这里让用户选源并存盘（data\npm-source.json），安装前还会先探一次可达性。 */
async function loadNpmSource() {
  try {
    const r = await api('/api/npm-source');
    el('npm-src-mode').value = r.mode || 'auto';
    el('npm-src-url').value = r.url || '';
    el('npm-src-url').disabled = (r.mode !== 'custom');
  } catch (e) { /* 老版本服务没有这个接口时不影响其它功能 */ }
}
el('npm-src-mode').addEventListener('change', () => {
  el('npm-src-url').disabled = el('npm-src-mode').value !== 'custom';
  if (!el('npm-src-url').disabled) el('npm-src-url').focus();
});
el('btn-npm-src-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const mode = el('npm-src-mode').value;
  const url = String(el('npm-src-url').value || '').trim();
  btn.disabled = true;
  try {
    await api('/api/npm-source', { mode, url });
    flash('npm-src-out', mode === 'custom' ? ('已保存：' + url) : '已保存：下次安装 / 升级生效', 'ok');
  } catch (err) {
    flash('npm-src-out', '保存失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});
el('btn-install-slot').addEventListener('click', (e) => {
  const version = String(el('i-ver').value || el('u-ver-raw').value || '').trim();
  if (!version) { flash('install-out', '请先从列表里选一个版本。', 'err'); return; }
  runJob('/api/jobs/install', { slot: el('i-slot').value, version }, e.currentTarget, '安装中…');
});
/* 向导：装到空闲槽（版本同样从列表里选） */
el('btn-wz-install').addEventListener('click', (e) => {
  const version = String(el('wz-ver').value || '').trim();
  if (!version) { flash('wz-out', '还没拿到版本列表：点「刷新列表」，或用「升级」页的手动填版本。', 'err'); return; }
  const idle = (STATE && STATE.slot && STATE.slot.idle) || 'agent-B';
  runJob('/api/jobs/install', { slot: idle, version }, e.currentTarget, '安装中…');
});
el('btn-wz-site').addEventListener('click', () => goTab('sites'));
function markSteps() {
  const spans = el('wz-steps').querySelectorAll('span');
  const hasSite = !!(STATE && STATE.sites && STATE.sites.list && STATE.sites.list.length);
  const hasKey = !!(STATE && STATE.key && STATE.key.configured);
  const hasVer = !!(STATE && (STATE.slot.activeVersion || STATE.slot.idleVersion)) ||
    !!(VERSIONS && (VERSIONS.installed['agent-A'] || VERSIONS.installed['agent-B']));
  const running = !!(STATE && STATE.dsh && STATE.dsh.running);
  const doneMap = { 1: hasSite && hasKey, 2: hasVer, 3: running };
  let firstOpen = true;
  spans.forEach((sp) => {
    const w = sp.dataset.w;
    if (doneMap[w]) { sp.className = 'done'; return; }
    sp.className = firstOpen ? 'on' : '';
    firstOpen = false;
  });
  el('wz-note').textContent = '① 先在「站点和模型」里加站点并保存密钥；② 选版本装进空闲槽（' +
    ((STATE && STATE.slot && STATE.slot.idle) || 'agent-B') + '）；③ 回这一页点「启动 dsh」。';
}
el('btn-job-cancel').addEventListener('click', async () => {
  if (!CURRENT_JOB) { flash('job-out', '当前没有任务。', 'warn'); return; }
  try {
    await api('/api/jobs/cancel', { id: CURRENT_JOB });
    flash('job-out', '已发送取消。', 'warn');
  } catch (e) { flash('job-out', '取消失败：' + e.message, 'err'); }
});
el('btn-job-history').addEventListener('click', async () => {
  const s = await api('/api/jobs');
  el('job-out').className = 'flash on';
  el('job-out').innerHTML = (s.jobs || []).map((j) => esc(j.id) + '　' + esc(j.status) + '　' + esc(j.label) + '　<span class="sub">' + esc(j.message || '') + '</span>').join('<br>') || '（无）';
});

/* ---------------------------------------------------------------- 诊断 */
el('btn-doctor').addEventListener('click', (e) => withBusy(e.currentTarget, '自检中…', async () => {
  try {
    const r = await api('/api/doctor', {});
    el('doctor-raw').textContent = r.text;
    el('doctor-table').innerHTML = renderDoctor(r.text);
    const bad = (r.text.match(/FAIL/g) || []).length;
    flash('diag-out', bad ? ('自检完成：有 ' + bad + ' 项失败，见下表。') : '自检完成：没有失败项。', bad ? 'warn' : 'ok');
    await refresh();
  } catch (e2) { flash('diag-out', '自检失败：' + e2.message, 'err'); }
}));
function renderDoctor(text) {
  const lines = String(text).split(/\r?\n/);
  const rowsOut = [];
  for (const line of lines) {
    const m = /^\s*(OK|WARN|FAIL)\s+(.*?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const kind = m[1] === 'OK' ? 'ok' : (m[1] === 'WARN' ? 'warn' : 'bad');
    const label = m[2].trim(), detail = m[3].trim();
    rowsOut.push('<tr><td>' + esc(label) + '</td><td><span class="pill ' + kind + '">' + m[1] + '</span></td><td class="sub">' + esc(detail) + '</td></tr>');
  }
  if (!rowsOut.length) return '<div class="sub">（没能解析成表格，请看下面的原始输出）</div>';
  return '<table><thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead><tbody>' + rowsOut.join('') + '</tbody></table>';
}
el('btn-dump').addEventListener('click', (e) => withBusy(e.currentTarget, '验收中…', async () => {
  try {
    const r = await api('/api/dump', {});
    el('dump-raw').textContent = r.text;
    flash('diag-out', /组合成功/.test(r.text) ? '验收通过：' + r.text.split('\n')[0] : '验收有问题，见下方原始输出。', /组合成功/.test(r.text) ? 'ok' : 'warn');
  } catch (e2) { flash('diag-out', '验收失败：' + e2.message, 'err'); }
}));
el('btn-backup').addEventListener('click', (e) => withBusy(e.currentTarget, '备份中…', async () => {
  try { const r = await api('/api/backup', {}); flash('diag-out', r.text, 'ok'); }
  catch (e2) { flash('diag-out', '备份失败：' + e2.message, 'err'); }
}));
el('btn-refresh').addEventListener('click', refresh);
el('btn-clear-dl').addEventListener('click', clearDriveLost);
el('btn-port').addEventListener('click', async () => {
  try {
    const r = await api('/api/port', { port: parseInt(el('p-port').value, 10) });
    flash('port-out', '已保存端口 ' + r.state.webPort + '（下次启动 dsh 生效）。', 'ok');
    await refresh();
  } catch (e) { flash('port-out', '保存失败：' + e.message, 'err'); }
});
el('btn-temp').addEventListener('click', async () => {
  try {
    await api('/api/portable-temp', { usbTemp: el('t-usb').checked });
    flash('temp-out', '已保存。' + (el('t-usb').checked ? '（盘上临时目录可能让 workspace-write 失败，请确认这块盘给足 WRITE_OWNER）' : ''), 'ok');
    await refresh();
  } catch (e) { flash('temp-out', '保存失败：' + e.message, 'err'); }
});

/* ---------------------------------------------------------------- 插件 */
/* ---------------------------------------------------------------- 插件（卡片视图） */
let PLUG = null;                 // /api/plugins/catalog 的结果
let PREFS = { plugins: { showOfficial: true, showThird: true, sub: 'installed', relaxReleaseAge: false } };
let OFF_Q = '';                  // 官方插件的筛选词
let OFF_LIMIT = 24;              // 官方卡片一次显示多少张
let MKT = { page: 1, q: '', cat: '', sort: 'stars', risk: false, data: null };

/** 图标：按名字算一个确定的颜色 + 首字母（不外链图片，离线也能看） */
function pfIcon(name) {
  const s = String(name || '?');
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  const tail = s.replace(/^@[^/]+\//, '');
  const letter = ((tail.replace(/^dsh[-_]?/i, '')[0] || s[0] || '?') + '').toUpperCase();
  return { letter, color: 'hsl(' + (h % 360) + ' 58% 60%)' };
}
function pfIconHtml(name) {
  const i = pfIcon(name);
  return '<div class="pc-icon" style="background:' + i.color + ';color:#0F172A">' + esc(i.letter) + '</div>';
}
function spill(t, kind) { return '<span class="spill' + (kind ? ' ' + kind : '') + '">' + esc(String(t)) + '</span>'; }
function cut(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function catName(k) { const c = (MKT.data && MKT.data.categories) || {}; return c[k] || k || '未分类'; }
function kvRow(k, v) { return '<div class="k">' + esc(k) + '</div><div>' + esc(String(v == null || v === '' ? '—' : v)) + '</div>'; }
function kvRowHtml(k, v) { return '<div class="k">' + esc(k) + '</div><div>' + v + '</div>'; }

async function loadPrefs() {
  try {
    const r = await api('/api/prefs', undefined, 'GET');
    if (r && r.plugins) PREFS.plugins = Object.assign(PREFS.plugins, r.plugins);
  } catch (e) { /* 用默认值 */ }
}
function savePrefs() { api('/api/prefs', { plugins: PREFS.plugins }, 'POST').catch(() => {}); }

async function loadPlugins(force) {
  try {
    if (!PLUG) { skeleton('official-cards', 3); skeleton('third-cards', 3); }   // 首次读目录要给个「在读了」的样子
    PLUG = await api('/api/plugins/catalog' + (force ? '?force=1' : ''), undefined, 'GET');
    renderPlugins();
    busyDone('official-cards'); busyDone('third-cards');
  } catch (e) { busyDone('official-cards'); busyDone('third-cards'); flash('plug-out', '读插件目录失败：' + e.message, 'err'); }
}

/** 一个条目一个开关（官方与第三方通用） */
function entrySwitch(e, running) {
  const mark = e.shippedDisabled ? '（官方默认停用）' : e.conditional ? '（官方条件控制）' : '';
  return '<label class="switch" title="' + esc(e.id + mark) + '"><input type="checkbox" role="switch" data-toggle="' + esc(e.id) + '"' +
    (e.effective ? ' checked' : '') + (running ? ' disabled' : '') + '><span class="track"></span>' +
    '<span class="sub mono">' + esc(e.id) + (mark ? ' *' : '') + '</span></label>';
}
function officialCard(p, running) {
  const entries = p.entries || [];
  const off = entries.some((e) => !e.effective);
  return '<div class="pcard' + (off ? ' off' : '') + '">' + pfIconHtml(p.pkg) + '<div class="pc-main">' +
    '<div class="pc-title"><b>' + esc(p.pkg) + '</b>' + spill('v' + (p.version || '?')) +
    spill('随 dsh ' + (PLUG.slotVersion || '?'), 'ok') + (off ? spill('有停用条目', 'warn') : '') + '</div>' +
    '<div class="pc-sub">' + esc(p.author || 'dsh 官方') + (p.license ? ' · ' + esc(p.license) : '') + ' · 条目 ' + entries.length + ' 个</div>' +
    '<div class="pc-desc">' + esc(cut(p.description || '（这个自带包没写 description）', 150)) + '</div>' +
    '<div class="pc-actions">' + entries.map((e) => entrySwitch(e, running)).join('') +
    '<button class="btn" data-pdetail="' + esc(p.pkg) + '">详细</button>' +
    '<span class="sub">官方自带，不能删除</span></div></div></div>';
}
function thirdCard(p, running) {
  const v = (p.compat && p.compat.verdict) || {};
  const kind = v.level === 'ok' ? 'ok' : (v.level === 'need-exempt' || v.level === 'unknown') ? 'warn' : '';
  const entries = p.entries || [];
  const off = entries.some((e) => !e.effective);
  return '<div class="pcard' + (off ? ' off' : '') + '">' + pfIconHtml(p.pkg) + '<div class="pc-main">' +
    '<div class="pc-title"><b>' + esc(p.pkg) + '</b>' + spill('v' + (p.version || '?')) +
    (v.text ? spill(v.text, kind) : '') + (off ? spill('有停用条目', 'warn') : '') + '</div>' +
    '<div class="pc-sub">' + esc(p.author || '未知作者') + (p.license ? ' · ' + esc(p.license) : '') +
    ' · ' + (entries.length ? '条目 ' + entries.length + ' 个' : '未被 dsh 加载（没有条目）') + '</div>' +
    '<div class="pc-desc">' + esc(cut(p.description || '（这个包没写 description）', 150)) + '</div>' +
    '<div class="pc-actions">' + (entries.length ? entries.map((e) => entrySwitch(e, running)).join('') : '') +
    '<button class="btn" data-pdetail="' + esc(p.pkg) + '">详细</button>' +
    '<button class="btn danger" data-del="' + esc(p.pkg) + '">删除</button></div></div></div>';
}
function marketCard(p) {
  const risk = (p.redLines || []).length;
  return '<div class="pcard">' + pfIconHtml(p.name) + '<div class="pc-main">' +
    '<div class="pc-title"><b>' + esc(p.name) + '</b>' + (p.version ? spill('v' + p.version) : '') + spill('★ ' + fmtNum(p.stars)) +
    (p.downloads ? spill('⤓ ' + fmtNum(p.downloads)) : '') + (risk ? spill('⚠ 有风险提示', 'bad') : '') + '</div>' +
    '<div class="pc-sub">' + esc(p.owner) + ' · ' + esc(catName(p.category)) + (p.added ? ' · 收录 ' + esc(p.added) : '') +
    (p.npm ? ' · ' + esc(p.npm) : ' · 走 git/链接安装') + '</div>' +
    '<div class="pc-desc">' + esc(cut(p.zh || p.en, 160)) + '</div>' +
    '<div class="pc-actions">' + (p.installed ? spill('已安装', 'ok')
      : '<button class="btn primary" data-minstall="' + esc(p.name) + '">安装</button>') +
    '<button class="btn" data-mdetail="' + esc(p.name) + '">详细</button></div></div></div>';
}
function wireCards() {
  document.querySelectorAll('#official-cards input[data-toggle], #third-cards input[data-toggle]').forEach((cb) =>
    cb.addEventListener('change', () => pluginToggle(cb.dataset.toggle, !cb.checked)));
  document.querySelectorAll('#official-cards button[data-pdetail], #third-cards button[data-pdetail]').forEach((b) =>
    b.addEventListener('click', () => openPkgDetail(b.dataset.pdetail)));
  document.querySelectorAll('#third-cards button[data-del]').forEach((b) =>
    b.addEventListener('click', () => pluginUninstall(b.dataset.del)));
}

function renderPlugins() {
  const r = PLUG;
  if (!r) return;
  const pn = r.pnpm || {};
  const running = !!r.dshRunning;
  const pnpmCell = pn.ok
    ? '<span class="pill ok">就绪</span> v' + esc(pn.version) + (pn.nodeLinker ? '　<span class="sub">' + esc(pn.nodeLinker) + '</span>' : '')
    : (pn.ours
      ? '<span class="pill bad">不匹配</span> 盘上是 v' + esc(pn.version) + '，这个插件目录是 ' +
        esc(pn.wantVersion || ('pnpm ' + (pn.wantMajor || '?'))) + ' 装的'
      : '<span class="pill warn">未就绪</span> <span class="sub">' + esc(pn.hint || '') + '</span>');
  rows('plug-status', [
    ['pnpm（装卸第三方插件要用）', pnpmCell],
    ['活动槽', '<b>' + esc(r.slot) + '</b>　<span class="sub">dsh ' + esc(r.slotVersion || '?') + '　官方插件在这里</span>'],
    ['第三方插件', '<span class="sub">装在本盘的插件目录里，由盘上的 pnpm 管理</span>'],
    ['dsh 状态', running
      ? '<span class="pill bad">运行中：插件改动会被拒</span>'
      : '<span class="pill ok">已停止（可以改）</span>'],
    ['统计', r.counts.officialCards + ' 张官方卡片（共 ' + r.counts.officialPackages + ' 个自带包）　·　' +
      r.counts.thirdPartyCards + ' 张第三方卡片　·　' + r.counts.entries + ' 个条目' +
      (r.counts.orphan ? '（' + r.counts.orphan + ' 个条目没归到卡片）' : '')],
    ['路径', more('详情', '<span class="ln">第三方插件目录 <code>' + esc(r.profileDir) + '</code></span>' +
      '<span class="ln">活动槽目录 <code>' + esc(r.slot) + '</code></span>')],
  ]);
  el('plug-pnpm-note').innerHTML = pn.ok
    ? '盘上自带（不依赖宿主装没装）' + (pn.storeMissing
      ? '；注意：这个插件目录记录的缓存位置已经不在，装/卸时 pnpm 会重建它'
      : '')
    : esc(pn.hint || '');
  el('btn-pnpm-setup').disabled = !!pn.ok || running;
  el('btn-pnpm-setup').textContent = pn.ok ? '准备 pnpm' : (pn.wantVersion ? '装匹配的 pnpm ' + pn.wantVersion : '准备 pnpm');

  // 官方插件
  const q = OFF_Q.toLowerCase();
  const off = (r.official || []).filter((p) => !q || p.pkg.toLowerCase().indexOf(q) >= 0 ||
    (p.entries || []).some((e) => e.id.toLowerCase().indexOf(q) >= 0));
  el('official-count').textContent = r.counts.officialCards + ' 张卡片';
  el('official-shown').textContent = '显示 ' + Math.min(OFF_LIMIT, off.length) + ' / ' + off.length + ' 张' +
    (r.counts.officialPackages > r.counts.officialCards ? '；另有 ' + (r.counts.officialPackages - r.counts.officialCards) + ' 个自带包没在配置里出现' : '');
  el('official-cards').innerHTML = off.slice(0, OFF_LIMIT).map((p) => officialCard(p, running)).join('') ||
    '<span class="sub">（没有匹配的插件）</span>';
  el('official-more').hidden = off.length <= OFF_LIMIT;
  el('official-more').textContent = '显示更多（还有 ' + Math.max(0, off.length - OFF_LIMIT) + ' 张）';

  // 第三方（已安装）
  const third = r.thirdParty || [];
  el('third-count').textContent = '已装 ' + third.length + ' 个' +
    (r.counts.depPackages ? '（profile 里另有 ' + r.counts.depPackages + ' 个随 dsh 与插件一起装进来的依赖包，不是插件）' : '');
  el('third-cards').innerHTML = third.map((p) => thirdCard(p, running)).join('');
  el('third-empty').textContent = third.length ? ''
    : '还没装第三方插件：切到「插件市场」挑一个，或用下面的「按包名手动安装」。';
  wireCards();
}

/* ---------------------------------------------------------------- 插件市场 */
async function mktSearch(page) {
  if (page) MKT.page = page;
  MKT.q = el('mkt-q').value.trim();
  MKT.cat = el('mkt-cat').value || '';
  MKT.sort = el('mkt-sort').value;
  MKT.risk = el('mkt-risk').checked;
  el('mkt-info').innerHTML = '<span class="sub">读索引中…（第一次会用一次网络把社区索引拉到盘上，约 4 MB）</span>';
  skeleton('mkt-cards', 3);
  el('mkt-pager').innerHTML = '';
  try {
    const r = await api('/api/market?q=' + encodeURIComponent(MKT.q) + '&cat=' + encodeURIComponent(MKT.cat) +
      '&sort=' + encodeURIComponent(MKT.sort) + '&page=' + MKT.page + '&pageSize=24' + (MKT.risk ? '&risk=1' : ''), undefined, 'GET');
    MKT.data = r;
    if (!r.ok) {
      el('mkt-info').innerHTML = '<span class="pill warn">读不到索引</span> <span class="sub">' + esc(r.error || '') + '</span>';
      return;
    }
    el('mkt-cat').innerHTML = '<option value="">全部分类（' + fmtNum(r.source.count) + ' 个插件）</option>' +
      Object.keys(r.categories).map((k) => '<option value="' + esc(k) + '"' + (k === MKT.cat ? ' selected' : '') + '>' +
        esc(r.categories[k]) + '</option>').join('');
    el('mkt-info').innerHTML = '命中 <b>' + fmtNum(r.total) + '</b> 个　第 ' + r.page + ' / ' + r.pages + ' 页　' +
      '<span class="sub">索引来自 ' + esc(r.source.data) + '（' + esc(r.source.updated || '?') + ' 更新，共 ' +
      esc(fmtNum(r.source.count)) + ' 个）</span>';
    el('mkt-cards').innerHTML = r.items.map(marketCard).join('') || '<span class="sub">（没有匹配的插件）</span>';
    el('mkt-pager').innerHTML = '第 ' + r.page + ' / ' + r.pages + ' 页　' +
      (r.page > 1 ? '<button class="btn" data-mpage="' + (r.page - 1) + '">上一页</button> ' : '') +
      (r.page < r.pages ? '<button class="btn" data-mpage="' + (r.page + 1) + '">下一页</button>' : '');
    document.querySelectorAll('#mkt-pager button[data-mpage]').forEach((b) =>
      b.addEventListener('click', () => mktSearch(Number(b.dataset.mpage))));
    document.querySelectorAll('#mkt-cards button[data-minstall]').forEach((b) =>
      b.addEventListener('click', () => mktInstall(b.dataset.minstall)));
    document.querySelectorAll('#mkt-cards button[data-mdetail]').forEach((b) =>
      b.addEventListener('click', () => openMarketDetail(b.dataset.mdetail)));
  } catch (e) {
    el('mkt-info').innerHTML = '<span class="pill warn">读不到索引</span> <span class="sub">' + esc(e.message) + '</span>';
  }
}
function mktInstall(name) {
  if (!window.confirm('安装 ' + name + ' ？会用 profile 目录里的 pnpm 把包装进本盘（dsh 运行时不能装）。')) return;
  runJob('/api/plugins/install', { market: name }, el('btn-plug-refresh'), '安装中…',
    { keepTab: true, log: 'plug-log', out: 'plug-out', jobGrid: 'plug-job' });
}

/* ---------------------------------------------------------------- 详情面板 */
function pdOpen(html) { el('pd-body').innerHTML = html; el('plug-detail').hidden = false; }
function pdClose() { el('plug-detail').hidden = true; el('pd-body').innerHTML = ''; }
function compatTable(res) {
  if (!res || !res.checks || !res.checks.length) return '<p class="sub">（这个插件没有声明对 dsh 内部包的版本要求）</p>';
  return '<table class="mtable" style="margin-top:8px"><thead><tr><th>依赖</th><th>要求</th><th>本槽</th><th></th></tr></thead><tbody>' +
    res.checks.map((c) => '<tr><td class="mono">' + esc(c.dep) + '</td><td class="sub mono">' + esc(cut(c.range, 64)) +
      '</td><td class="mono">' + esc(c.have || '（没装）') + '</td><td>' +
      (c.ok === null ? '<span class="pill warn">?</span>' : c.ok ? '<span class="pill ok">满足</span>' : '<span class="pill bad">不满足</span>') +
      '</td></tr>').join('') + '</tbody></table>';
}
async function openPkgDetail(pkg) {
  const hit = (PLUG.official || []).concat(PLUG.thirdParty || []).find((p) => p.pkg === pkg);
  if (!hit) { pdOpen('<h2>' + esc(pkg) + '</h2><p class="sub">找不到这个包。</p>'); return; }
  let html = '<h2>' + esc(pkg) + ' <span class="sub">' + (hit.kind === 'official' ? '官方（dsh 自带）' : '第三方') + '</span></h2>' +
    '<p class="sub">' + esc(cut(hit.description || '（没有 description）', 420)) + '</p>' +
    '<div class="kv">' + kvRow('版本', hit.version) + kvRow('作者', hit.author) + kvRow('许可', hit.license) +
    kvRowHtml('目录', '<span class="mono">' + esc(hit.dir) + '</span>') +
    (hit.repo ? kvRowHtml('仓库', '<a href="' + esc(hit.repo) + '" target="_blank" rel="noopener">' + esc(hit.repo) + '</a>') : '') +
    (hit.homepage ? kvRowHtml('主页', '<a href="' + esc(hit.homepage) + '" target="_blank" rel="noopener">' + esc(hit.homepage) + '</a>') : '') + '</div>';
  if (hit.kind === 'official') {
    html += '<h2 style="margin-top:14px">适配版本</h2><p class="sub">官方插件随活动槽安装，版本就是 dsh 自己的版本（' +
      esc(PLUG.slotVersion || '?') + '）——<b>不需要也不允许单独装</b>，只能停用条目。</p>';
  } else {
    const res = (hit.compat && hit.compat.result) || null;
    html += '<h2 style="margin-top:14px">适配本槽</h2><div class="kv">' +
      kvRowHtml('结论', esc((hit.compat && hit.compat.verdict && hit.compat.verdict.text) || '未知') +
        (res ? ' <span class="sub">（用 ' + esc(res.how) + ' 判定）</span>' : '')) +
      kvRowHtml('安装命令', '<span class="mono">' + esc(hit.installCommand || '') + '</span>') + '</div>' + compatTable(res);
  }
  const ents = hit.entries || [];
  html += '<h2 style="margin-top:14px">条目（' + ents.length + ' 个）</h2>' +
    (ents.length ? '<div class="row">' + ents.map((e) => entrySwitch(e, PLUG.dshRunning)).join('') + '</div>'
      : '<p class="sub">（没有对应条目：dsh 没有加载这个包）</p>');
  pdOpen(html);
  document.querySelectorAll('#pd-body input[data-toggle]').forEach((cb) =>
    cb.addEventListener('change', () => pluginToggle(cb.dataset.toggle, !cb.checked)));
}
async function openMarketDetail(name) {
  pdOpen('<h2>' + esc(name) + '</h2><p class="sub">读详细信息…</p>');
  try {
    const r = await api('/api/market/item?name=' + encodeURIComponent(name) + '&compat=1', undefined, 'GET');
    if (!r.ok) { pdOpen('<h2>' + esc(name) + '</h2><p class="sub">' + esc(r.error || '读不到') + '</p>'); return; }
    const p = r.item;
    let html = '<h2>' + esc(p.name) + ' ' + (p.version ? spill('v' + p.version) : '') + spill('★ ' + fmtNum(p.stars)) + '</h2>' +
      '<p class="sub">' + esc(p.zh || '（源里没有中文简介）') + '</p>' +
      (p.en ? '<details class="more"><summary>英文原文</summary><div class="body">' + esc(p.en) + '</div></details>' : '') +
      '<div class="kv">' + kvRow('作者', p.owner) + kvRow('分类', catName(p.category)) +
      kvRow('npm', p.npm || '（没有 npm 包，走 git / 链接安装）') +
      kvRow('下载量', fmtNum(p.downloads)) + kvRow('收录', p.added) +
      kvRowHtml('能力', (p.capabilities || []).map((c) => spill(c)).join(' ') || '—') +
      (p.redLines && p.redLines.length ? kvRowHtml('⚠ 风险', p.redLines.map((x) => '<span class="spill bad">' + esc(x) + '</span>').join(' ')) : '') +
      kvRowHtml('页面', '<a href="' + esc(p.page || p.url) + '" target="_blank" rel="noopener">' + esc(p.page || p.url) + '</a>') +
      '</div><h2 style="margin-top:14px">安装</h2><div class="kv">' +
      kvRowHtml('命令', '<span class="mono">' + esc(p.install || '') + '</span>') + '</div>';
    if (r.compat) {
      html += '<h2 style="margin-top:14px">适配本槽</h2><div class="kv">' +
        kvRowHtml('结论', esc(r.compat.verdict.text) + ' <span class="sub">（用 ' + esc(r.compat.result.how) + ' 判定）</span>') +
        '</div>' + compatTable(r.compat.result);
    } else {
      html += '<h2 style="margin-top:14px">适配本槽</h2><p class="sub">' + esc(r.compatNote || '需要联网查 npm 元信息') + '</p>';
    }
    html += '<div class="row" style="margin-top:12px">' + (r.installed ? spill('已安装', 'ok')
      : '<button class="btn primary" data-minstall2="' + esc(p.name) + '">安装</button>') + '</div>';
    pdOpen(html);
    const b2 = document.querySelector('#pd-body button[data-minstall2]');
    if (b2) b2.addEventListener('click', () => mktInstall(b2.dataset.minstall2));
  } catch (e) {
    pdOpen('<h2>' + esc(name) + '</h2><p class="sub">读详细信息失败：' + esc(e.message) + '</p>');
  }
}

async function pluginToggle(id, disabled) {
  clearFlash('plug-toggle-out');
  try {
    const r = await api('/api/plugins/toggle', { id, disabled });
    flash('plug-toggle-out', (disabled ? '已停用 ' : '已启用 ') + id + '。' + (r.note || ''), 'ok');
    await loadPlugins(true);
    await refresh();
  } catch (e) {
    flash('plug-toggle-out', '改动失败：' + e.message, 'err');
    await loadPlugins(true);
  }
}
function pluginInstall() {
  const name = el('plug-name').value.trim();
  if (!name) { flash('plug-out', '先填要装的 npm 包名（也可以先用下面的搜索找包）。', 'err'); return; }
  runJob('/api/plugins/install', { name }, el('btn-plug-install'), '安装中…',
    { keepTab: true, log: 'plug-log', out: 'plug-out', jobGrid: 'plug-job' });
}
function pluginUninstall(name) {
  if (!window.confirm('卸载插件 ' + name + '？（会从 profile 的依赖里移除）')) return;
  runJob('/api/plugins/uninstall', { name }, el('btn-plug-refresh'), '卸载中…',
    { keepTab: true, log: 'plug-log', out: 'plug-out', jobGrid: 'plug-job' });
}
async function pluginSearch() {
  const q = el('plug-q').value.trim();
  if (!q) { flash('plug-out', '请填搜索关键词。', 'err'); return; }
  el('plug-search').innerHTML = '<span class="sub">搜索中…</span>';
  try {
    const r = await api('/api/plugins/search?q=' + encodeURIComponent(q), undefined, 'GET');
    if (!r.ok) { el('plug-search').innerHTML = '<span class="sub">搜不到：' + esc(r.error) + '</span>'; return; }
    el('plug-search').innerHTML = '<div class="sub" style="margin-bottom:4px">npm 上匹配「' + esc(r.query) + '」的 ' + r.count + '/' + r.total
      + ' 个（<b>这不是插件官方索引</b>，请自行确认是 dsh 插件）：</div>' +
      '<table class="mtable"><tbody>' + r.results.map((x) =>
        '<tr data-pick="' + esc(x.name) + '"><td class="mono">' + esc(x.name) + '@' + esc(x.version) + '</td><td class="sub">' +
        esc(x.description || '') + (x.isDshPlugin ? ' <span class="tag">名字里有 dsh</span>' : '') + '</td></tr>').join('')
      + '</tbody></table>';
    el('plug-search').querySelectorAll('tr[data-pick]').forEach((tr) =>
      tr.addEventListener('click', () => { el('plug-name').value = tr.dataset.pick; flash('plug-out', '已填入包名：' + tr.dataset.pick, 'ok'); }));
  } catch (e) {
    el('plug-search').innerHTML = '<span class="sub">搜索失败：' + esc(e.message) + '</span>';
  }
}
/** 把显示开关落到界面上（官方/第三方两块 + 第三方里的两个子页签） */
function applyPrefs() {
  el('show-official').checked = !!PREFS.plugins.showOfficial;
  el('show-third').checked = !!PREFS.plugins.showThird;
  el('block-official').hidden = !PREFS.plugins.showOfficial;
  el('block-third').hidden = !PREFS.plugins.showThird;
  const sub = PREFS.plugins.sub === 'market' ? 'market' : 'installed';
  el('plug-relax').checked = !!PREFS.plugins.relaxReleaseAge;
  el('subtab-installed').setAttribute('aria-selected', String(sub === 'installed'));
  el('subtab-market').setAttribute('aria-selected', String(sub === 'market'));
  el('sub-installed').hidden = sub !== 'installed';
  el('sub-market').hidden = sub !== 'market';
  if (sub === 'market' && !MKT.data) mktSearch(1);
}

/** 放宽「新包冷却」开关的唯一入口（页面勾选 / 失败后「放宽并重试」都走这里） */
function setRelax(on) {
  PREFS.plugins.relaxReleaseAge = !!on;
  el('plug-relax').checked = !!on;
  applyPrefs(); savePrefs();
  flash('plug-out', on
    ? '已放宽 pnpm 的「新包冷却」：之后的装卸/删除会按 minimumReleaseAge=0 跑（能装到刚发布的包）。'
    : '已恢复 pnpm 默认的新包冷却（24 小时内的包会被拒绝）。', on ? 'warn' : 'ok');
}

/** 插件任务失败时，按日志里真实的错误码给一句人话（pnpm 的两种已知拦路虎） */
function jobFailHint() {
  const t = String((el(CUR_LOG || 'plug-log') || {}).textContent || '');
  if (/UNEXPECTED_STORE/.test(t)) return 'pnpm 版本不匹配（这个插件目录是别的 pnpm 装的）：点上面的「装匹配的 pnpm」再试。';
  if (/MINIMUM_RELEASE_AGE/.test(t)) return '被 pnpm 的「新包冷却」拦下（包发布还不到 24 小时）：勾上左侧的「放宽新包冷却」再试。';
  if (PLUG && PLUG.pnpm && !PLUG.pnpm.ok && PLUG.pnpm.hint) return PLUG.pnpm.hint;
  return '';
}

el('btn-plug-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, '读取中…', () => loadPlugins(true)));
el('btn-pnpm-setup').addEventListener('click', () => {
  const pn = (PLUG && PLUG.pnpm) || {};
  const body = { version: (!pn.ok && pn.wantVersion) ? pn.wantVersion : '', profile: (PLUG && PLUG.profile) || 'web' };
  runJob('/api/plugins/pnpm-setup', body, el('btn-pnpm-setup'), '安装中（约 10 MB）…',
    { keepTab: true, log: 'plug-log', out: 'plug-out', jobGrid: 'plug-job' });
});
el('btn-plug-install').addEventListener('click', pluginInstall);
el('btn-plug-search').addEventListener('click', pluginSearch);
el('plug-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') pluginSearch(); });
el('plug-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') pluginInstall(); });

// 显示开关（状态存盘：data/ui-prefs.json，跟盘走）
el('show-official').addEventListener('change', () => { PREFS.plugins.showOfficial = el('show-official').checked; applyPrefs(); savePrefs(); });
el('show-third').addEventListener('change', () => { PREFS.plugins.showThird = el('show-third').checked; applyPrefs(); savePrefs(); });
el('plug-relax').addEventListener('change', () => setRelax(el('plug-relax').checked));
el('subtab-installed').addEventListener('click', () => { PREFS.plugins.sub = 'installed'; applyPrefs(); savePrefs(); });
el('subtab-market').addEventListener('click', () => { PREFS.plugins.sub = 'market'; applyPrefs(); savePrefs(); });

// 官方插件：筛选 / 显示更多
el('official-filter').addEventListener('input', () => { OFF_Q = el('official-filter').value; OFF_LIMIT = 24; renderPlugins(); });
el('official-more').addEventListener('click', () => { OFF_LIMIT += 48; renderPlugins(); });

// 市场
el('btn-mkt-search').addEventListener('click', () => mktSearch(1));
el('mkt-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') mktSearch(1); });
el('mkt-sort').addEventListener('change', () => mktSearch(1));
el('mkt-cat').addEventListener('change', () => mktSearch(1));
el('mkt-risk').addEventListener('change', () => mktSearch(1));
el('btn-mkt-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, '拉取中…', async () => {
  await api('/api/market/refresh', {}, 'POST');
  MKT.data = null;
  await mktSearch(1);
  flash('plug-out', '索引已重新拉取。', 'ok');
}));

// 详情面板
el('btn-pd-close').addEventListener('click', pdClose);
el('plug-detail').addEventListener('click', (e) => { if (e.target === el('plug-detail')) pdClose(); });
el('btn-plug-allow').addEventListener('click', (e) => {
  const spec = el('plug-av-spec').value.trim(), ver = el('plug-av-ver').value.trim();
  clearFlash('plug-av-out');
  if (!spec || !ver) { flash('plug-av-out', '要填「包名@版本」和 dsh 版本（dsh 日志里会给出一整行）。', 'err'); return; }
  if (!window.confirm('接受风险：dsh 会警告这个插件可能与当前版本不兼容（可能崩溃/丢数据）。确定继续？')) return;
  runJob('/api/plugins/allow-version', { spec, dshVersion: ver }, e.currentTarget, '豁免中…',
    { keepTab: true, log: 'plug-log', out: 'plug-av-out', jobGrid: 'plug-job' });
});

/* ---------------------------------------------------------------- 启动 */
(async function boot() {
  // 原生窗口里 URL 不含令牌：先向宿主要（浏览器直接打开时 TOKEN 已有值，不打扰）
  if (!TOKEN) TOKEN = await requestHostToken(4000);
  if (!TOKEN) {
    document.body.innerHTML = '<div style="padding:40px;font:16px/1.7 var(--font-ui, sans-serif)">'
      + '<h2 style="margin:0 0 8px">这个窗口没有拿到访问令牌</h2>'
      + '<p style="color:var(--muted)">请通过启动器（dsh-to-go.exe）打开；或运行 dsh-ui.cmd，用控制台里给出的带令牌地址访问。</p></div>';
    return;
  }
  const s = await refresh();
  if (!s) return;
  el('launcher-log').textContent = s.launcherLog || '（空）';
  el('t-usb').checked = /usb-temp/.test(s.tempRoot || '') || /U 盘/.test(s.tempRoot || '');
  if (!s.loggedIn) {
    const firstRun = !s.key || !s.key.store;
    el('login-ov').hidden = false;
    el('login-title').textContent = firstRun ? '第一次使用：设置口令' : '解锁配置页';
    el('login-first').hidden = !firstRun;
    el('li-pass2-box').hidden = !firstRun;
    el('btn-login').dataset.setup = firstRun ? '1' : '';
    el('btn-login').textContent = firstRun ? '设置口令并解锁' : '解锁';
    el('btn-migrate').hidden = firstRun;
    el('li-pass').focus();
  } else {
    el('login-ov').hidden = true;
  }
  await loadTheme();     // 主题要在首屏渲染前定下来
  await loadSites().catch(() => {});
  loadVersions();      // 版本列表（失败也不影响其它功能，页面会提示改用手动填）
  loadNpmSource();     // 下载源偏好（老服务没有这个接口时静默跳过）
  startPolling();
})().catch((err) => {
  // 启动阶段出错不能静默：把错误显示在最上面，否则用户只看到「正在读取状态…」卡住
  const b = el('banner');
  if (b) {
    b.hidden = false;
    b.className = 'bad';
    b.textContent = '页面启动失败：' + (err && err.message ? err.message : String(err)) + '（详情见窗口日志；可先运行 dsh-ui.cmd 用浏览器打开对照）';
  }
});
