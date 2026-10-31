'use strict';
/* 顶栏（shell.html）的 preload：分区切换 + 窗口按钮 + 三种订阅。没有文件/进程能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshShell', {
  setTab: (name) => ipcRenderer.send('shell:tab', String(name)),
  section: (name) => ipcRenderer.send('shell:section', String(name)),
  win: (action) => ipcRenderer.send('shell:win', String(action)),
  setTheme: (mode) => ipcRenderer.send('shell:theme-set', String(mode)),
  reloadWeb: () => ipcRenderer.send('shell:reload-web'),
  onState: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:state', (_e, s) => fn(s)); },
  onSection: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:section-active', (_e, s) => fn(s)); },
  onTab: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:tab-active', (_e, s) => fn(s)); },
  onResizing: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:resizing', (_e, on) => fn(!!on)); },
  onStatus: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:status', (_e, s) => fn(s)); },
  onThemeMode: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:theme-mode', (_e, m) => fn(m)); },
  onOverlay: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:overlay', (_e, s) => fn(s)); },
  onTheme: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:theme', (_e, s) => fn(s)); },
  onWinState: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:winstate', (_e, s) => fn(s)); },
});
