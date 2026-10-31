'use strict';
/* 顶栏脚本：分区导航（含 dsh 界面）、窗口按钮、主题与端口显示。没有业务逻辑。 */
(function () {
  var api = window.dshShell;
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var WEB = '__web';

  function select(section, showWeb) {
    tabs.forEach(function (t) {
      var isWeb = t.dataset.section === WEB;
      var on = showWeb ? isWeb : (!isWeb && t.dataset.section === section);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var s = t.dataset.section;
      if (s === WEB) api.setTab('web');
      else api.section(s);
    });
  });

  document.getElementById('btn-min').addEventListener('click', function () { api.win('min'); });
  document.getElementById('btn-max').addEventListener('click', function () { api.win('max'); });
  document.getElementById('btn-close').addEventListener('click', function () { api.win('close'); });

  api.onState(function (s) {
    if (!s) return;
    if (s.tab) select(s.section || 'overview', s.tab === 'web');
    var port = document.getElementById('port');
    if (s.port) { port.textContent = '127.0.0.1:' + s.port; port.hidden = false; }
  });

  // 配置页里自己点了分区（或页面内部跳转），顶栏高亮要跟上
  api.onSection(function (name) {
    if (name) select(name, false);
  });
  api.onTab(function (tab) {
    if (tab === 'web') select(null, true);
  });

  api.onOverlay(function (open) { document.body.classList.toggle('dim', !!open); });

  // 按宽度分档让位，带死区：拖到断点附近不会来回闪
  var LEVELS = [['lv1', 1364], ['lv2', 1244], ['lv3', 1124], ['lv4', 1024], ['lv5', 864]];
  var active = {};
  var relayoutTimer = null;
  function relayout() {
    var w = window.innerWidth;
    LEVELS.forEach(function (p) {
      var name = p[0], th = p[1];
      var on = !!active[name];
      var next = on ? (w < th + 28) : (w < th - 12);
      if (next !== on) { active[name] = next; document.body.classList.toggle(name, next); }
    });
  }
  function scheduleRelayout() {
    if (relayoutTimer) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(relayout, 40);
  }
  window.addEventListener('resize', scheduleRelayout);
  relayout();

  // 拖动/缩放中：关掉一切过渡与动画，避免元素来回跳（停手后自动恢复）
  api.onResizing(function (on) {
    document.body.classList.toggle('resizing', !!on);
    if (!on) relayout();          // 停手后按最终宽度定档
  });

  // dsh 运行状态（壳每 3 秒问一次 /api/state）
  api.onStatus(function (s) {
    if (!s) return;
    var box = document.getElementById('status');
    var text = document.getElementById('status-text');
    var slot = document.getElementById('status-slot');
    box.hidden = false;
    if (box.classList.contains('on') !== !!s.running) box.classList.toggle('on', !!s.running);
    text.textContent = s.running ? 'dsh 运行中' : 'dsh 已停止';
    slot.textContent = s.slot ? '· ' + s.slot : '';
    box.title = (s.running ? 'dsh 运行中' : 'dsh 已停止') + (s.slot ? ' · ' + s.slot : '') + (s.port ? ' · 端口 ' + s.port : '');
  });

  // 主题按钮：深色 → 浅色 → 自适应
  var ORDER = ['dark', 'light', 'auto'];
  var LABEL = { dark: '深色', light: '浅色', auto: '自适应' };
  var mode = 'dark';
  function paintTheme(m) {
    mode = ORDER.indexOf(m) >= 0 ? m : 'dark';
    document.getElementById('theme-label').textContent = LABEL[mode];
  }
  document.getElementById('btn-theme').addEventListener('click', function () {
    var next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    paintTheme(next);
    api.setTheme(next);
  });
  api.onThemeMode(function (m) { if (m) paintTheme(m); });

  api.onTheme(function (s) {
    if (!s) return;
    if (s.theme === 'light') document.body.removeAttribute('data-ds-dark-theme');
    else document.body.setAttribute('data-ds-dark-theme', '');
  });

  api.onWinState(function (s) {
    var btn = document.getElementById('btn-max');
    if (!btn || !s) return;
    btn.setAttribute('aria-label', s.maximized ? '还原' : '最大化');
    btn.innerHTML = s.maximized
      ? '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="3.2" width="4.4" height="4.4"/><path d="M3.6 3.2V2h4.4v4.4H6.6"/></svg>'
      : '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="2.5" width="5" height="5"/></svg>';
  });
})();
