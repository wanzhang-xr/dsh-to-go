'use strict';
/* dsh 官方 Web UI 的 preload：不注入任何能力，只挡掉「把文件拖进窗口导致导航离开本机页面」。 */
window.addEventListener('dragover', (e) => { e.preventDefault(); }, true);
window.addEventListener('drop', (e) => { e.preventDefault(); }, true);
