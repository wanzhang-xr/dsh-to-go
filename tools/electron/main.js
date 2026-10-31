'use strict';
/**
 * dsh-to-go 桌面壳（Electron）
 *
 * 一个原生窗口里放两样东西：
 *   ① 配置页 —— 本地 ui-server（tools/ui-server.js）提供的单文件页面
 *   ② dsh Web UI —— dsh 自己在 data/dsh-info.json 里登记的地址
 *
 * 与旧版（WinForms + WebView2）保持同一套约定：
 *   - 令牌不进 URL：壳从 ui-server 的 stdout 抓，页面发 {type:'dsh.token.request'} 要
 *   - 页面里那套 window.chrome.webview 桥由 preload 复刻，页面代码一行都不用改
 *   - 关窗语义：dsh 在跑就问一次；壳只杀自己起的 ui-server，不碰 dsh 的子孙
 *   - 所有状态都在盘上（data/electron 是 Chromium 用户数据目录），不写宿主家目录
 */

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, shell, session, nativeTheme, Tray } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA, 'logs');
const LOG = path.join(LOG_DIR, 'electron.log');
const WIN_FILE = path.join(DATA, 'window.json');
const DSH_INFO = path.join(DATA, 'dsh-info.json');
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const UI_SERVER = path.join(ROOT, 'tools', 'ui-server.js');
const SHELL_H = 54;   // 与 tools/electron/shell.html 的 --bar-h 保持一致
const DEV = process.env.DSH_DEV === '1';

// ---------------------------------------------------------------- 盘内路径
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { /* 盘只读就早点报错，由 shim 兜底 */ }

// Chromium 的用户数据（cookie / 缓存 / GPU）必须落在盘上，且要在 ready 之前设置
app.setPath('userData', path.join(DATA, 'electron'));
app.setPath('sessionData', path.join(DATA, 'electron'));

function log(msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg + '\n';
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch (e) { /* 日志写不了不影响运行 */ }
  if (DEV) process.stdout.write(line);
}
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
}
function writeJson(p, v) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
  } catch (e) { log('写 ' + path.basename(p) + ' 失败: ' + e.message); }
}

// ---------------------------------------------------------------- 状态
let win = null;
let shellView = null;
let configView = null;
let dshView = null;
let serverChild = null;
let token = null;
let cfgPort = 0;
let tab = 'config';
let section = 'overview';      // 配置页当前分区（导航搬到了标题栏，由壳记住）
let theme = 'dark';            // 解析后的实际主题（dark/light），三个面共用
let themeMode = 'dark';        // 用户选择：dark / light / auto（自适应跟系统）
let tray = null;
let reallyQuit = false;        // 托盘菜单点「退出」时置位，跳过「隐藏到托盘」那套
let confirmingClose = false;
let keepDsh = false;

// ---------------------------------------------------------------- 工具
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpLocal(method, pathname, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: cfgPort, path: pathname, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        token ? { 'x-config-token': token } : {}),
      timeout: 8000,
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { /* 非 JSON 也算失败 */ }
        resolve({ code: res.statusCode, json, text: out.slice(0, 400) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, json: null, text: '超时' }); });
    req.on('error', (e) => resolve({ code: 0, json: null, text: e.message }));
    req.end(data);
  });
}

// ---------------------------------------------------------------- ui-server
function startUiServer() {
  return new Promise(async (resolve, reject) => {
    if (!fs.existsSync(NODE)) return reject(new Error('缺少 runtime\\node\\node.exe，请先跑 build.cmd'));
    if (!fs.existsSync(UI_SERVER)) return reject(new Error('缺少 tools\\ui-server.js'));

    let port;
    try { port = await freePort(); } catch (e) { return reject(e); }
    cfgPort = port;

    // --no-open：ui-server 默认会自己拉起系统浏览器，桌面壳里必须关掉
    // （否则每次启动都多弹一个浏览器窗口，等于两套 UI 同时开着）
    const child = spawn(NODE, [UI_SERVER, '--port', String(port), '--no-open'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { DSH_LAUNCHER_PID: String(process.pid) }),
    });
    serverChild = child;
    log('starting ui-server on 127.0.0.1:' + port + ' (pid ' + child.pid + ')');

    let buf = '';
    let settled = false;
    const scan = (chunk) => {
      buf += chunk;
      if (!token) {
        const m = buf.match(/[?&]token=([A-Za-z0-9_-]{20,})/);
        if (m) { token = m[1]; log('token captured (length ' + token.length + ')'); }
      }
      if (!settled && token) { settled = true; resolve({ port, token }); }
    };
    child.stdout.on('data', (d) => scan(String(d)));
    child.stderr.on('data', (d) => scan(String(d)));
    child.on('exit', (code) => {
      log('ui-server exited code=' + code);
      if (!settled) { settled = true; reject(new Error('ui-server 启动失败（退出码 ' + code + '）')); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('15 秒内没拿到 ui-server 的令牌')); }
    }, 15000);
  });
}

function stopUiServer() {
  if (!serverChild || serverChild.killed) return;
  try {
    // 只杀 ui-server 自己：dsh 是它的子孙，keep 时不能连坐（与旧版 taskkill 不带 /T 同义）
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/PID', String(serverChild.pid)], { windowsHide: true, timeout: 8000 });
    } else {
      serverChild.kill('SIGKILL');
    }
    log('ui-server stopped (own pid ' + serverChild.pid + (keepDsh ? ', dsh kept alive' : '') + ')');
  } catch (e) {
    log('stop ui-server failed: ' + e.message);
  }
}

// ---------------------------------------------------------------- 视图
function layout() {
  if (!win || !shellView || !configView || !dshView) return;
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height: SHELL_H });
  const body = { x: 0, y: SHELL_H, width, height: Math.max(0, height - SHELL_H) };
  configView.setBounds(body);
  dshView.setBounds(body);
  configView.setVisible(tab === 'config');
  dshView.setVisible(tab === 'web');
  try {
    shellView.webContents.send('shell:state', { tab, section, port: cfgPort });
    shellView.webContents.send(tab === 'web' ? 'shell:tab-active' : 'shell:section-active', tab === 'web' ? 'web' : section);
  } catch (e) { /* 还没加载好 */ }
}

function switchTab(next) {
  if (next !== 'config' && next !== 'web') return;
  tab = next;
  log('tab -> ' + next);
  if (next === 'web') loadDshView();
  layout();
}

/** dsh 的地址由 dsh 自己登记在 data/dsh-info.json（url 里可能自带 token 查询串） */
function dshUrl() {
  const info = readJson(DSH_INFO, null);
  if (!info || !info.url) return null;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(String(info.url))) return null;
  return String(info.url);
}

/** 兜底：直接问 ui-server 要 dsh 的地址（dsh-info.json 可能没写、或上一个服务实例清掉了） */
function dshUrlFromState() {
  return httpLocal('GET', '/api/state').then((r) => {
    const u = r.json && r.json.dsh && r.json.dsh.url;
    if (!u) return null;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(String(u))) return null;
    return String(u);
  }).catch(() => null);
}

async function loadDshView(force) {
  if (!dshView) return;
  const url = dshUrl() || (await dshUrlFromState());
  if (!url) {
    dshView.webContents.loadFile(path.join(__dirname, 'blank-dsh.html')).catch(() => {});
    return;
  }
  const current = dshView.webContents.getURL();
  if (!force && current && current.split('#')[0] === url.split('#')[0]) return;
  dshView.webContents.loadURL(url).catch((e) => log('load dsh ui failed: ' + e.message));
  log('dsh view -> ' + url.replace(/token=[^&]+/, 'token=***'));
}

function createViews() {
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: DEV,
    },
  });
  configView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-config.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: DEV,
    },
  });
  dshView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-web.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: DEV,
      partition: 'persist:dsh',
    },
  });

  win.contentView.addChildView(shellView);
  win.contentView.addChildView(configView);
  win.contentView.addChildView(dshView);

  shellView.webContents.loadFile(path.join(__dirname, 'shell.html'));
  loadDshView();   // 先放占位页：dsh 视图有文档才接得住脚本注入（背景/主题）

  dshView.webContents.on('dom-ready', () => {
    log('dsh view dom-ready');
    applyThemeToDsh();
    applyWallpaperToDsh(true).catch((e) => log('wallpaper error: ' + (e && e.message)));
  });
  dshView.webContents.on('did-finish-load', () => { applyThemeToDsh(); applyWallpaperToDsh(true); });

  // 配置页自己画的标题栏在这儿是多余的（壳已经有顶栏），藏掉它，页面本身一行不改
  configView.webContents.on('dom-ready', () => {
    // 壳已经有顶栏（品牌 + 两个标签 + 窗口按钮），所以把页面里重复的那层去掉：
    // 页面自己的 #titlebar（品牌行 + 窗口按钮）整条藏掉，主题/解锁这些真按钮保留。
    configView.webContents.insertCSS(
      '#titlebar{display:none !important}'
      + '#tb-ctl{display:none !important}'
      // 分区导航搬进壳的标题栏了，页面里那排不必再画一遍
      + 'nav{display:none !important}'
      + 'header{padding-left:20px !important}'
    ).catch(() => {});
  });

  shellView.webContents.on('did-finish-load', async () => {
    try {
      const info = await shellView.webContents.executeJavaScript(
        'JSON.stringify({sheets: document.styleSheets.length, bg: getComputedStyle(document.body).backgroundColor, bar: (document.querySelector(".bar") ? getComputedStyle(document.querySelector(".bar")).backgroundColor : "no-.bar"), dark: document.body.hasAttribute("data-ds-dark-theme"), layer1: getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-layer-1").trim(), barvar: getComputedStyle(document.body).getPropertyValue("--bar-bg").trim()})'
      );
      log('shell theme probe: ' + info);
    } catch (e) { log('shell probe failed: ' + e.message); }
  });

  // 导航白名单：只允许本机回环地址，别的都拦
  const guard = (wc) => {
    wc.on('will-navigate', (e, url) => {
      if (!/^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|file:|about:)/i.test(url)) {
        e.preventDefault();
        log('navigation blocked: ' + url);
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      log('window open blocked: ' + String(url).replace(/token=[^&]+/, 'token=***'));
      return { action: 'deny' };
    });
  };
  [shellView, configView, dshView].forEach((v) => guard(v.webContents));

  win.on('resize', layout);
  win.on('maximize', () => { layout(); sendWinState(); });
  win.on('unmaximize', () => { layout(); sendWinState(); });
}

/** dsh 官方 Web UI 走的是 body[data-ds-dark-theme]（跟它的设计 token 同一套约定） */
function applyThemeToDsh() {
  if (!dshView || dshView.webContents.isDestroyed()) return;
  const js = theme === 'dark'
    ? "document.documentElement.dataset.theme='dark'; if(document.body) document.body.setAttribute('data-ds-dark-theme','');"
    : "document.documentElement.dataset.theme='light'; if(document.body) document.body.removeAttribute('data-ds-dark-theme');";
  try {
    dshView.webContents.executeJavaScript(js).catch(() => { /* 还没加载好，dom-ready 里会再来一次 */ });
  } catch (e) { /* 视图刚建出来 */ }
}

/** 三个面一起换皮：壳顶栏 / 配置页 / dsh 官方 Web UI（顺手把系统主题也带上） */
function applyTheme(mode) {
  themeMode = (mode === 'light' || mode === 'auto') ? mode : 'dark';
  // 自适应：交给 Electron 的 nativeTheme 判断系统当前是深还是浅
  try { nativeTheme.themeSource = themeMode === 'auto' ? 'system' : themeMode; } catch (e) { /* 忽略 */ }
  const effective = themeMode === 'auto' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : themeMode;
  theme = effective;
  const dark = theme === 'dark';
  log('theme -> ' + themeMode + (themeMode === 'auto' ? '（自适应，当前 ' + theme + '）' : ''));
  try { if (win) win.setBackgroundColor(dark ? '#181a20' : '#f3f5f9'); } catch (e) { /* 忽略 */ }
  try { shellView.webContents.send('shell:theme', { theme }); } catch (e) { /* 还没加载好 */ }
  try { shellView.webContents.send('shell:theme-mode', themeMode); } catch (e) { /* 还没加载好 */ }
  try {
    configView.webContents.executeJavaScript(
      'if (typeof applyTheme === "function") applyTheme(' + JSON.stringify(theme) + ', false);'
    ).catch(() => { /* 页面还没好 */ });
  } catch (e) { /* 忽略 */ }
  applyThemeToDsh();
}

/** 取盘上那张背景图（二进制），拼成 data URL —— dsh 界面跟我们不同源，只能这样喂给它 */
let _wallKey = null;       // insertCSS 返回的 key，换图/删图时要先撤掉
let _wallSig = '';         // 当前注入的是哪张（bytes+at），同值不重复注入

function getWallpaperDataUrl() {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: cfgPort, path: '/api/wallpaper', method: 'GET',
      headers: token ? { 'x-config-token': token } : {}, timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const mime = String(res.headers['content-type'] || 'image/webp').split(';')[0];
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return resolve(null);
        resolve({ dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** 把同一张背景图铺到 dsh 官方界面上：两个视图看起来是一整块背景 */
async function applyWallpaperToDsh(force) {
  if (!dshView || dshView.webContents.isDestroyed() || !cfgPort || !token) {
    log('wallpaper: skip (dshView=' + !!dshView + ' cfgPort=' + cfgPort + ' token=' + !!token + ')');
    return;
  }
  const wp = await getWallpaperDataUrl();
  const sig = wp ? (wp.bytes + ':' + wp.dataUrl.length) : 'none';
  if (!force && sig === _wallSig) return;
  _wallSig = sig;

  try {
    if (_wallKey) {
      await dshView.webContents.executeJavaScript(
        '(() => { const el = document.getElementById("dsh-to-go-wallpaper"); if (el) el.remove(); return true; })()'
      );
      _wallKey = null;
    }
  } catch (e) { /* 页面已经换过，忽略 */ }

  if (!wp) { log('wallpaper: dsh 界面已清除自定义背景'); return; }

  const css = [
    'html {',
    '  background-image: url("' + wp.dataUrl + '") !important;',
    '  background-size: cover !important;',
    '  background-position: center center !important;',
    '  background-attachment: fixed !important;',
    '  background-repeat: no-repeat !important;',
    '}',
    /* 官方界面自己的面板是实心的，只把最外层底色让出来，让同一张图从中缝透出来 */
    'body { background-color: transparent !important; }',
  ].join('\n');

  // 用注入 <style> 的方式而不是 insertCSS：insertCSS 在某些页面状态下会一直不 resolve
  const script =
    '(() => {' +
    '  const id = "dsh-to-go-wallpaper";' +
    '  let el = document.getElementById(id);' +
    '  if (!el) { el = document.createElement("style"); el.id = id; (document.head || document.documentElement).appendChild(el); }' +
    '  el.textContent = ' + JSON.stringify(css) + ';' +
    '  return el.textContent.length;' +
    '})()';

  try {
    // 页面还没 ready 时 executeJavaScript 会一直挂着，加超时兜底；dom-ready 后会自动再来一次
    const ok = await Promise.race([
      dshView.webContents.executeJavaScript(script),          // 返回写入的样式字符数
      new Promise((r) => setTimeout(() => r(0), 2500)),
    ]);
    if (!ok) { log('wallpaper: dsh 界面还没就绪，等它加载完再注入'); return; }
    _wallKey = 'style:injected';
    log('wallpaper: 已注入 dsh 界面（' + Math.round(wp.bytes / 1024) + ' KB，样式 ' + ok + ' 字符）');
  } catch (e) {
    log('wallpaper: 注入失败 ' + (e && e.message));
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 托盘：最小化后还找得到人；退出走同一条确认流程 */
function createTray() {
  const icon = path.join(ROOT, 'assets', 'app.ico');
  try {
    tray = new Tray(icon);
  } catch (e) {
    log('tray 创建失败（不影响主窗口）: ' + e.message);
    return;
  }
  tray.setToolTip('DSH to go');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { label: '收进托盘', click: () => { if (win) win.hide(); } },
    { type: 'separator' },
    {
      label: '打开 dsh 界面',
      click: () => { showWindow(); switchTab('web'); },
    },
    { type: 'separator' },
    {
      label: '退出 DSH to go',
      click: () => {
        // 隐藏状态下点退出，要先把窗口显示出来，否则确认框会悬空
        showWindow();
        reallyQuit = false;
        if (win) win.close();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (win && win.isVisible()) win.hide();
    else showWindow();
  });
  tray.on('double-click', () => showWindow());
  log('tray ready');
}

/** 窄窗口时按比例放大配置页：字号写的是 px，只有 zoom 能整体放大而不破坏布局 */
/** 拖动/缩放窗口时：给壳和页面挂 resizing 标记（暂停动画、关过渡），停手 180ms 后再做重活 */
let _resizeTimer = null;
let _resizing = false;

function setResizing(on) {
  if (_resizing === on) return;
  _resizing = on;
  try { shellView.webContents.send('shell:resizing', on); } catch (e) { /* 忽略 */ }
  try {
    configView.webContents.executeJavaScript(
      "document.documentElement.classList." + (on ? 'add' : 'remove') + "('dsh-resizing')"
    ).catch(() => {});
  } catch (e) { /* 忽略 */ }

  // 停手后回读一次，确认页面真的恢复（resizing 标记没粘住）
  if (!on) {
    try {
      configView.webContents.executeJavaScript("document.documentElement.classList.contains('dsh-resizing')")
        .then((still) => log('resize: end, page resizing=' + still))
        .catch(() => {});
    } catch (e) { /* 忽略 */ }
  }
}

function scheduleResize() {
  setResizing(true);
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    setResizing(false);
    applyZoom();          // 缩放只在停手后应用一次
  }, 180);
}

let _zoomTimer = null;
let _lastZoom = 1;

function applyZoom() {
  if (!win || win.isDestroyed() || !configView) return;
  const w = win.getContentBounds().width;
  // 死区：阈值附近 24px 内不换档，否则拖到临界点会来回抖
  const z = w < 1120 - 24 ? 1.14 : w < 1280 - 24 ? 1.08 : w < 1440 - 24 ? 1.02 : 1;
  if (z === _lastZoom) return;
  _lastZoom = z;
  try {
    if (configView.webContents.getZoomFactor() !== z) {
      configView.webContents.setZoomFactor(z);
      log('zoom -> ' + z + '（窗口宽 ' + w + '）');
    }
  } catch (e) { /* 页面还没起来 */ }
}

function sendWinState() {
  if (!win) return;
  try { shellView.webContents.send('shell:winstate', { maximized: win.isMaximized() }); } catch (e) { /* 忽略 */ }
  try { configView.webContents.send('dsh:message', { type: 'dsh.win.state', maximized: win.isMaximized() }); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  const saved = readJson(WIN_FILE, null) || {};
  const width = Number(saved.width) > 400 ? Number(saved.width) : 1200;
  const height = Number(saved.height) > 300 ? Number(saved.height) : 840;

  win = new BrowserWindow({
    width, height,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 1040, minHeight: 700,   // 太小就挤成一团，字体再好也难受
    icon: path.join(ROOT, 'assets', 'app.ico'),   // 任务栏/Alt-Tab 用 dsh 官方图标
    frame: false,
    show: false,
    backgroundColor: '#181a20',
    title: 'DSH to go',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: DEV },
  });

  win.once('ready-to-show', () => {
    win.show();
    log('window shown');
  });

  createViews();
  layout();
  // 窗口内容都在 WebContentsView 里，win.webContents 本身永远不加载东西，
  // 所以 ready-to-show 不一定会触发——直接显示，别让用户以为没启动。
  win.show();
  log('window shown (views: shell/config/dsh)');

  win.on('close', (e) => {
    if (confirmingClose) return;           // 已经在走流程，放行
    e.preventDefault();
    beginCloseFlow();
  });

  const persist = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    writeJson(WIN_FILE, { x: b.x, y: b.y, width: b.width, height: b.height });
  };
  win.on('resize', () => { persist(); scheduleResize(); });
  win.on('move', persist);

  // 最小化 = 收进托盘：任务栏不留条目，随时从托盘点回来
  win.on('minimize', (e) => {
    if (reallyQuit) return;
    e.preventDefault();
    win.hide();
    log('window hidden to tray');
  });
}

async function dshRunning() {
  const r = await httpLocal('GET', '/api/state');
  if (!r.json) return false;
  const st = r.json.dsh || r.json;
  return !!(st && st.running);
}

async function beginCloseFlow() {
  let running = false;
  try { running = await dshRunning(); } catch (e) { log('close: 状态查询失败 ' + e.message); }

  keepDsh = false;

  // 点关闭不是"就问一句要不要退出"，而是让用户在「真的退」和「收进托盘」之间选
  const opts = {
    type: 'question',
    buttons: ['完全退出', '最小化到托盘', '取消'],
    defaultId: 1,          // 默认停在「最小化到托盘」：最不容易误伤
    cancelId: 2,
    noLink: true,
    title: '关闭 DSH to go',
    message: running ? 'dsh 正在运行，要退出还是收进托盘？' : '要退出 DSH to go，还是收进托盘？',
    detail: running
      ? '完全退出：先停掉 dsh 再关窗口（勾选下面的选项则让 dsh 留在后台）。\n'
        + '最小化到托盘：窗口收起来，dsh 与服务照常跑，点托盘图标随时回来。'
      : '完全退出：关掉窗口与服务。\n最小化到托盘：收进托盘，点图标随时回来。',
  };
  if (running) {
    opts.checkboxLabel = '完全退出时让 dsh 继续在后台运行';
    opts.checkboxChecked = false;
  }
  log('close dialog: buttons=[' + opts.buttons.join(' / ') + '] dshRunning=' + running);

  // 自检：DSH_SELFTEST_CLOSE=quit|tray|cancel 时跳过弹窗，直接按这个选择走
  const forced = process.env.DSH_SELFTEST_CLOSE;
  const answer = (forced === 'quit' || forced === 'tray' || forced === 'cancel')
    ? { response: forced === 'quit' ? 0 : forced === 'tray' ? 1 : 2, checkboxChecked: false }
    : await dialog.showMessageBox(win, opts);
  const { response, checkboxChecked } = answer;

  if (response === 1) {              // 最小化到托盘
    log('close: 用户选择最小化到托盘');
    win.hide();
    log('window hidden to tray');
    return;
  }
  if (response !== 0) {              // 取消 / 直接关掉对话框
    log('close: 用户取消');
    return;
  }
  log('close: 用户选择完全退出');

  if (running) {
    keepDsh = !!checkboxChecked;
    if (!keepDsh) {
      const r = await httpLocal('POST', '/api/dsh/stop', {});
      if (r.code === 200) log('close: dsh 已停止');
      else log('close: 停 dsh 失败 code=' + r.code + ' ' + r.text.slice(0, 120));
    } else {
      log('close: 用户选择让 dsh 继续在后台运行');
    }
  }

  confirmingClose = true;
  stopUiServer();
  try { win.destroy(); } catch (e) { /* 已销毁 */ }
  app.quit();
}

// ---------------------------------------------------------------- IPC
function wireIpc() {
  ipcMain.handle('dsh:token', () => token || '');
  ipcMain.handle('dsh:state', () => ({ port: cfgPort, tab, hasToken: !!token }));

  ipcMain.on('dsh:win', (_e, action) => {
    if (!win) return;
    if (action === 'min') win.minimize();
    else if (action === 'max') {
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
      sendWinState();
    } else if (action === 'close') {
      win.close();
    }
  });

  ipcMain.on('dsh:theme', (_e, next) => {
    const t = String(next) === 'light' ? 'light' : 'dark';
    if (t === theme) return;      // 页面 applyTheme 会回报一次，同值直接吞掉，避免来回打
    applyTheme(t);
  });

  // 页面弹层开/关 → 让壳的标题栏一起压暗（视觉上是一整块，不是两层）
  ipcMain.on('dsh:overlay', (_e, open) => {
    try { shellView.webContents.send('shell:overlay', !!open); } catch (e) { /* 忽略 */ }
  });

  // 壳里点主题按钮：深色 → 浅色 → 自适应（并把选择存进 data/ui-prefs.json）
  ipcMain.on('shell:theme-set', async (_e, mode) => {
    const next = (mode === 'light' || mode === 'auto') ? mode : 'dark';
    applyTheme(next);
    const r = await httpLocal('POST', '/api/prefs', { theme: next });
    if (r.code !== 200) log('theme persist failed code=' + r.code);
  });

  // 配置页换/删了背景图 → 同步到 dsh 界面（同一张，看起来是一整块背景）
  ipcMain.on('dsh:wallpaper', () => { applyWallpaperToDsh(true).catch((e) => log('wallpaper error: ' + (e && e.message))); });

  ipcMain.on('shell:tab', (_e, next) => switchTab(next));

  // 标题栏里点分区：先回到配置页，再让页面切到那个分区
  ipcMain.on('shell:section', (_e, name) => {
    const safe = String(name || '').replace(/[^a-z0-9-]/gi, '');
    if (!safe) return;
    if (safe === '__web') { switchTab('web'); return; }
    section = safe;
    log('section -> ' + safe + ' (from titlebar)');
    switchTab('config');
    try { configView.webContents.send('dsh:section', safe); } catch (e) { /* 页面还没好 */ }
    try { shellView.webContents.send('shell:section-active', safe); } catch (e) { /* 忽略 */ }
  });

  // 页面里自己点了分区（或内部跳转），把高亮同步回标题栏
  ipcMain.on('dsh:section-active', (_e, name) => {
    const safe = String(name || '').replace(/[^a-z0-9-]/gi, '');
    if (!safe) return;
    section = safe;
    log('section -> ' + safe + ' (from page)');
    try { shellView.webContents.send('shell:section-active', safe); } catch (e) { /* 忽略 */ }
  });
  ipcMain.on('shell:win', (_e, action) => {
    if (!win) return;
    if (action === 'min') win.minimize();
    else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); sendWinState(); }
    else if (action === 'close') win.close();
  });
  ipcMain.on('shell:reload-web', () => { if (dshView) loadDshView(true); });

  // 配置页上点「打开 dsh 界面」：壳内部切标签 + 加载，不再走 window.open（会被窗口白名单拦掉）
  ipcMain.on('dsh:activate', () => {
    log('activate dsh view (from page)');
    switchTab('web');
    loadDshView(true).catch((e) => log('load dsh view failed: ' + (e && e.message)));
  });
}

// ---------------------------------------------------------------- 生命周期
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  // 任务栏图标/分组认这个 id（不设的话 Windows 按 electron.exe 显示默认图标）
try { app.setAppUserModelId('DeepSeek.Harness.ToGo'); } catch (e) { /* 忽略 */ }

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // 权限只给本机页面，别的全拒
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      const url = (wc && wc.getURL && wc.getURL()) || '';
      const local = /^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|file:)/i.test(url);
      const ok = local && (permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
      log('permission ' + permission + ' ' + (ok ? 'allowed' : 'denied') + ' for ' + url);
      cb(ok);
    });

    createWindow();
    wireIpc();
    createTray();

    try {
      await startUiServer();
      // 令牌不进 URL（红线）。ui-server 连 "/" 都要求令牌，所以照旧壳的做法：
      // 对发往本机 ui-server 的请求统一加一个头（只在内存里，且过滤器只匹配这个 origin，
      // 不可能出现在第三方请求上，也就不会外泄）。
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: ['http://127.0.0.1:' + cfgPort + '/*'] },
        (details, callback) => {
          const headers = Object.assign({}, details.requestHeaders, { 'x-config-token': token || '' });
          callback({ requestHeaders: headers });
        }
      );
      await configView.webContents.loadURL('http://127.0.0.1:' + cfgPort + '/');
      log('config page loaded');
      applyZoom();
      // dsh 界面比令牌先起来，这里补一次：把同一张背景图喂给它
      applyWallpaperToDsh(true).catch((e) => log('wallpaper error: ' + (e && e.message)));

      // 自检：DSH_CSS_PROBE="sel1|sel2" 打印这些选择器的真实计算样式（排查配色）
      if (process.env.DSH_CSS_PROBE) {
        const sels = process.env.DSH_CSS_PROBE.split('|');
        setTimeout(() => {
          const probe = [
            '(function(){',
            'try{',
            '  window.__rules = ' + JSON.stringify(process.env.DSH_CSS_RULES || '') + ';',
            '  var sels = ' + JSON.stringify(sels) + ';',
            '  var out = [];',
            '  for (var i=0;i<sels.length;i++){',
            '    var e = document.querySelector(sels[i]);',
            '    if(!e){ out.push(sels[i]+" :: (missing)"); continue; }',
            '    var c = getComputedStyle(e);',
            '    out.push(sels[i]+" :: bg="+c.backgroundColor+" color="+c.color+" disabled="+(e.disabled===true)+" txt="+String(e.textContent||"").trim().slice(0,50)+" onacc="+c.getPropertyValue("--on-accent").trim()+" fill="+c.getPropertyValue("--brand-fill").trim());',
            '  }',
            '  var b = getComputedStyle(document.body);',
            '  var vars = ["--colorNeutralBackground1","--colorNeutralForeground1","--colorBrandBackground","--dsw-alias-bg-layer-1","--dsw-alias-label-primary","--dsw-alias-brand-primary","--secondary","--accent","--card","--bg","--on-accent","--brand-fill"];',
            '  for (var j=0;j<vars.length;j++){ out.push("var "+vars[j]+" = "+(b.getPropertyValue(vars[j]).trim()||"(empty)")); }',
            '  out.push("body dark attr = "+document.body.hasAttribute("data-ds-dark-theme"));',
            '  out.push("html theme = "+(document.documentElement.dataset.theme||"(none)"));',
            '  if (window.__rules){',
            '    var rules = [];',
            '    for (var si=0; si<document.styleSheets.length; si++){',
            '      var ss = document.styleSheets[si];',
            '      var list; try { list = ss.cssRules; } catch(e){ continue; }',
            '      for (var ri=0; ri<list.length; ri++){',
            '        var r = list[ri];',
            '        if (r.selectorText && r.selectorText.indexOf(window.__rules) >= 0) rules.push(r.cssText.slice(0,400));',
            '      }',
            '    }',
            '    out.push("RULES(" + rules.length + "): " + rules.join(" ~ "));',
            '  }',
            '  return out.join(" || ");',
            '}catch(err){ return "PROBE ERROR: "+err.message; }',
            '})()',
          ].join('\n');
          configView.webContents.executeJavaScript(probe).then((txt) => {
            log('probe ' + String(txt));
          }).catch((e) => log('probe failed: ' + e.message));
        }, 1500);
      }

      // 自检：DSH_SELFTEST_ACTIVATE=1 触发一次"页面点打开界面"的 IPC（走同一条 handler）
      if (process.env.DSH_SELFTEST_ACTIVATE) {
        setTimeout(() => { try { ipcMain.emit('dsh:activate'); } catch (e) { log('selftest activate failed: ' + e.message); } }, 1500);
      }

      // 自检：DSH_SELFTEST_THEME=dark|light|auto 直接切主题，验证解析结果
      if (process.env.DSH_SELFTEST_THEME) {
        setTimeout(() => applyTheme(process.env.DSH_SELFTEST_THEME), 500);
      }

      if (process.env.DSH_SELFTEST_CLOSE) {
        setTimeout(() => { log('selftest close: ' + process.env.DSH_SELFTEST_CLOSE); win.close(); }, 1200);
      }

      // 自检（DSH_SELFTEST=1 时跑）：分别验证「IPC 派发」与「页面自身点击」两条路
      if (process.env.DSH_SELFTEST === '1') {
        setTimeout(async () => {
          const active = '(() => { const b = document.querySelector(\'nav button[aria-selected="true"]\'); return b ? b.dataset.tab : "none"; })()';
          try {
            configView.webContents.send('dsh:section', 'diag');
            await new Promise((r) => setTimeout(r, 600));
            log('selftest via ipc: ' + await configView.webContents.executeJavaScript(active));

            await configView.webContents.executeJavaScript('document.querySelector(\'nav button[data-tab="plugins"]\').click()');
            await new Promise((r) => setTimeout(r, 400));
            log('selftest via click: ' + await configView.webContents.executeJavaScript(active));

            // 深浅色是否三个面一起动
            const shellBg = 'getComputedStyle(document.body).backgroundColor';
            applyTheme('light');
            await new Promise((r) => setTimeout(r, 500));
            log('selftest light: shell=' + await shellView.webContents.executeJavaScript(shellBg)
              + ' config=' + await configView.webContents.executeJavaScript('document.documentElement.dataset.theme')
              + ' shellDark=' + await shellView.webContents.executeJavaScript('document.body.hasAttribute("data-ds-dark-theme")'));
            applyTheme('dark');
            await new Promise((r) => setTimeout(r, 400));
            log('selftest dark: shell=' + await shellView.webContents.executeJavaScript(shellBg));
          } catch (e) {
            log('selftest section failed: ' + e.message);
          }
        }, 900);
      }
      // 页面一加载就会来要令牌；这里再主动送一次，避免时序竞态
      configView.webContents.send('dsh:message', { type: 'dsh.token', token });
    } catch (e) {
      log('startup failed: ' + e.message);
      const html = '<html><body style="font-family:Segoe UI,system-ui;background:#181a20;color:#e6e6e6;padding:32px">'
        + '<h2>启动失败</h2><p>' + String(e.message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p>'
        + '<p style="color:#9aa0a6">可以先用 <code>dsh-ui.cmd</code> 打开配置页。</p></body></html>';
      configView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
    }

    layout();

    // dsh 状态：3 秒一次（轻量：一次 /api/state 查询），失败就显示"未知"
    const pushStatus = async () => {
      if (!token || !cfgPort) return;
      const r = await httpLocal('GET', '/api/state');
      const st = (r.json && r.json.dsh) || {};
      const slot = (r.json && r.json.slot && r.json.slot.active) || '';
      try {
        shellView.webContents.send('shell:status', {
          running: !!st.running,
          slot,
          port: st.port || cfgPort,
          reachable: r.code === 200,
        });
      } catch (e) { /* 壳还没加载好 */ }

      // dsh 起来了，但视图还停在占位页 → 自动接上（以前要点一下标签才加载）
      if (st.running) {
        try {
          const cur = dshView.webContents.getURL() || '';
          if (!cur || cur.indexOf('blank-dsh.html') >= 0) loadDshView().catch(() => {});
        } catch (e) { /* 忽略 */ }
      }
    };
    pushStatus();
    setInterval(pushStatus, 3000).unref();

    // 系统深浅色变化时，自适应模式要跟着变
    try {
      nativeTheme.on('updated', () => { if (themeMode === 'auto') applyTheme('auto'); });
    } catch (e) { /* 忽略 */ }
  });

  app.on('window-all-closed', () => { app.quit(); });
}

app.on('before-quit', () => {
  reallyQuit = true;
  log('app quitting');
  if (tray) { try { tray.destroy(); } catch (e) { /* 忽略 */ } tray = null; }
  if (serverChild) stopUiServer();
});
process.on('uncaughtException', (e) => { log('uncaught: ' + (e && e.stack || e)); });
