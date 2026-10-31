'use strict';
/* 配置页的 preload：把旧版 WebView2 的 window.chrome.webview 桥原样复刻出来，
   这样 ui/app.html 里的桥接代码一行都不用改。 */
const { contextBridge, ipcRenderer } = require('electron');

const listeners = [];

// 让页面知道"我在桌面壳里"：外观层据此把流体色斑从标题栏下方才开始，避免接缝
try { document.documentElement.classList.add('dsh-shell'); } catch (e) { /* 忽略 */ }

function emit(data) {
  for (const fn of listeners.slice()) {
    try { fn({ data }); } catch (e) { /* 页面自己的异常不该拖垮宿主 */ }
  }
}

function postMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const type = String(msg.type || '');
  if (type === 'dsh.token.request') {
    ipcRenderer.invoke('dsh:token').then((tk) => { if (tk) emit({ type: 'dsh.token', token: tk }); }).catch(() => {});
    return;
  }
  if (type === 'dsh.win.min' || type === 'dsh.win.max' || type === 'dsh.win.close') {
    ipcRenderer.send('dsh:win', type.slice('dsh.win.'.length));
    return;
  }
  if (type === 'dsh.theme') {
    ipcRenderer.send('dsh:theme', msg.theme === 'light' ? 'light' : 'dark');
    return;
  }
  // 页面点「打开 dsh 界面」：交给壳切标签 + 加载（window.open 会被窗口白名单拦掉）
  if (type === 'dsh.activate') {
    ipcRenderer.send('dsh:activate');
    return;
  }
  // 换了/删了自定义背景：让壳把同一张图同步到 dsh 界面
  if (type === 'dsh.wallpaper') {
    ipcRenderer.send('dsh:wallpaper');
    return;
  }
  // dsh.win.drag / dsh.win.hit / dsh.activate：壳里由顶栏负责，忽略即可
}

// ⚠️ 不能叫 window.chrome：Chromium 已经有一个只读的 window.chrome，
// contextBridge.exposeInMainWorld('chrome', …) 会抛异常，把整个 preload 打断
// （症状：令牌拿不到、分区派发也没人接）。所以用独立名字，页面侧走 hostBridge()。
contextBridge.exposeInMainWorld('dshHost', {
  postMessage,
  addEventListener: (type, fn) => {
    if (type === 'message' && typeof fn === 'function') listeners.push(fn);
  },
  removeEventListener: (type, fn) => {
    if (type !== 'message') return;
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  },
});

ipcRenderer.on('dsh:message', (_e, data) => emit(data));

/* ---- 分区导航现在搬到了壳的标题栏（页面里那排 nav 会被隐藏），
        所以壳点分区 = 让页面点一下对应的 tab；页面里点了分区也要回报给壳高亮 ---- */
ipcRenderer.on('dsh:section', (_e, name) => {
  const safe = String(name || '').replace(/[^a-z0-9-]/gi, '');
  const btn = document.querySelector('nav button[data-tab="' + safe + '"]');
  if (btn) btn.click();
});

function reportSection(name) {
  if (name) ipcRenderer.send('dsh:section-active', String(name));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.querySelector('nav');
    if (nav) {
      nav.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-tab]') : null;
        if (btn) reportSection(btn.dataset.tab);
      }, true);
      const active = nav.querySelector('button[aria-selected="true"]');
      if (active) reportSection(active.dataset.tab);
    }
  });
} else {
  const nav = document.querySelector('nav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-tab]') : null;
      if (btn) reportSection(btn.dataset.tab);
    }, true);
  }
}


/* ---- 弹层状态回报：页面里的遮罩只盖住页面 view，盖不到壳的标题栏，
        不一起压暗就会出现"上面亮一条、下面被压黑"的割裂。 ---- */
let lastOverlay = null;
function watchOverlay() {
  const check = () => {
    const ov = document.querySelector('.overlay');
    const open = !!(ov && !ov.hasAttribute('hidden') && getComputedStyle(ov).display !== 'none');
    if (open === lastOverlay) return;
    lastOverlay = open;
    try { ipcRenderer.send('dsh:overlay', open); } catch (e) { /* 忽略 */ }
  };
  const start = () => {
    check();
    if (document.body) {
      new MutationObserver(check).observe(document.body, {
        subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'],
      });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
watchOverlay();
