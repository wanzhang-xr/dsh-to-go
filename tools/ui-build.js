'use strict';
/**
 * ui-build.js —— 把 src/ 合成**单文件** ui/app.html
 *
 *   node tools/ui-build.js [--check]
 *
 * 源：
 *   src/head.html            头（含 <!--{{CSS}}--> 占位）
 *   src/legacy.css           原有视觉层（保留，作为兜底）
 *   src/fluent-overrides.css Fluent 2 覆盖层（把老类名映射到 Fluent 观感）
 *   src/partials/*.html       各分区结构（一个分区一个文件，便于并行维护）
 *   src/app.js               前端逻辑
 *   third_party/fluent/fluent.min.js      Fluent UI Web Components 离线 bundle（可缺）
 *   third_party/fluent/fluent-theme.css   Fluent 2 深色主题变量（可缺）
 *
 * 产物仍然是零外链单文件：所有 CSS/JS 都内联，不新增请求。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'ui', 'app.html');
const FLUENT_DIR = path.join(ROOT, 'third_party', 'fluent');

// 统一换行：源码在 Windows 上常是 CRLF，而 git 入库时会被规范成 LF；
// 如果产物跟着工作区的换行走，--check 在 CI（checkout 出来是 LF）就会假红。
const read = (p, dflt) => {
  try { return fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n'); }
  catch (e) { if (dflt !== undefined) return dflt; throw new Error('缺少文件：' + path.relative(ROOT, p)); }
};
const SECTIONS = ['overview', 'sites', 'upgrade', 'diag', 'plugins', 'launcher'];

/**
 * 内联转义：内联内容里一旦出现 </script> / </style>，HTML 解析器会就地截断文档结构
 * （后面全变成纯文本）。把闭合标签的斜杠转义掉——在 JS 字符串/正则与 CSS 字符串里
 * `<\/` 与 `</` 等价，语义不变。`<!--` 在 <script> 内同样特殊，但没有安全等价写法，
 * 直接判为构建错误，让人改源码，而不是静默产出坏页面。
 */
function inlineSafe(text, kind) {
  if (kind !== 'js') {
    if (text.indexOf('<!--') >= 0) throw new Error('内联的 CSS 里出现 "<!--"，请改源码');
    return text.replace(/<\/(style)/gi, '<\\/$1');
  }
  // JS：</script 与 <!-- 都按字符串/regex 里的等价转义处理（<\/ 、 <\! 在 JS 里都还原成同一个字符），
  // 转完再做一次语法解析，确保没有把代码改坏。
  const escaped = text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  try {
    new (require('vm').Script)(escaped);   // 只解析不执行
  } catch (e) {
    throw new Error('内联 JS 转义后无法解析（' + e.message + '），请检查内联内容');
  }
  return escaped;
}

function build() {
  const head = read(path.join(SRC, 'head.html'));
  const THEME = path.join(ROOT, 'third_party', 'dsh-theme');
  const css = [
    '/* ===== 官方 Web UI 设计 token（third_party/dsh-theme，MIT / DeepSeek）===== */',
    read(path.join(THEME, 'design-platform.css'), ''),
    read(path.join(THEME, 'base.css'), ''),
    read(path.join(THEME, 'corner-shape.css'), ''),
    read(path.join(THEME, 'scrollbar.css'), ''),
    read(path.join(THEME, 'focus.css'), ''),
    '/* ===== 原有视觉层（src/legacy.css）===== */',
    read(path.join(SRC, 'legacy.css')),
    '/* ===== Fluent 2 主题（third_party/fluent/fluent-theme.css）===== */',
    read(path.join(FLUENT_DIR, 'fluent-theme.css'), '/* 未提供主题文件，使用 src/fluent-overrides.css 里的兜底变量 */'),
    '/* ===== Fluent 2 覆盖层（src/fluent-overrides.css）===== */',
    read(path.join(SRC, 'fluent-overrides.css'), ''),
    '/* ===== 外观层（src/appearance.css）：流体背景 / 主色 / 动效 ===== */',
    read(path.join(SRC, 'appearance.css'), ''),
  ].join('\n');

  if (!head.includes('<!--{{CSS}}-->')) throw new Error('src/head.html 缺少 CSS 占位 <!--{{CSS}}-->');
  const headHtml = head.replace('<!--{{CSS}}-->', () => '<style>\n' + inlineSafe(css, 'css') + '\n</style>');
  const html = [headHtml, '', '<body>',
    read(path.join(SRC, 'partials', 'header.html')).trimEnd(), '',
    '<main>',
    ...SECTIONS.map((s) => read(path.join(SRC, 'partials', s + '.html')).trimEnd()),
    '</main>', '',
    read(path.join(SRC, 'partials', 'login.html')).trimEnd(), ''];

  // 对齐层放文档最后：各 partial 里自带 <style>（还有 #id 选择器），
  // 放在 <head> 会被它们盖掉，必须在它们之后才能成为"最后一句话"
  html.push('<style>\n/* ===== 对齐层（src/dsh-align.css）：把老类名挂到官方 token 上 ===== */\n'
    + inlineSafe(read(path.join(SRC, 'dsh-align.css')), 'css') + '\n</style>', '');

  // Fluent 组件库：有就内联（浏览器端 IIFE），没有就跳过（页面仍能跑，只是控件是原生的）
  const fluentJs = read(path.join(FLUENT_DIR, 'fluent.min.js'), '');
  if (fluentJs) html.push('<script>/*{{FLUENT_BUNDLE_BEGIN}}*/' + inlineSafe(fluentJs, 'js') + '/*{{FLUENT_BUNDLE_END}}*/</script>');
  html.push('<script>', inlineSafe(read(path.join(SRC, 'app.js')), 'js'), '</script>', '</body>', '</html>', '');

  const out = '<!-- 生成物：由 tools/ui-build.js 从 src/ 合成，请改 src/ 不要改这里 -->\n' + html.join('\n');
  return out;
}

let out;
try {
  out = build();
} catch (e) {
  console.error('构建失败：' + e.message);
  process.exit(1);
}

// 产物自检：单文件 + 零外链 + 结构完整（必须以 </html> 结尾）
const bad = [];
const ext = /(?:src|href)\s*=\s*["'](https?:|\/\/)/gi;
let m;
while ((m = ext.exec(out))) bad.push(m[0]);
if (/<link[^>]+href=["'](?!data:)/i.test(out)) bad.push('<link> 外链');
if (/<script[^>]+src=/i.test(out)) bad.push('<script src=> 外链');
if (!out.trimEnd().endsWith('</html>')) bad.push('产物没有以 </html> 结尾（内联内容可能被截断）');
if (bad.length) {
  console.error('产物不合格（未写盘）：' + bad.join(', '));   // 先判后写
  process.exit(1);
}

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) { console.error('--check 失败：ui/app.html 不存在，请先跑一次 tools/ui-build.js'); process.exit(1); }
  const disk = fs.readFileSync(OUT, 'utf8');
  if (disk !== out) {
    const a = crypto.createHash('sha256').update(disk).digest('hex').slice(0, 12);
    const b = crypto.createHash('sha256').update(out).digest('hex').slice(0, 12);
    console.error('--check 失败：ui/app.html 与 src/ 不一致（磁盘 ' + a + ' ≠ 期望 ' + b + '，' + disk.length + ' vs ' + out.length + ' 字节）');
    console.error('  改过 src/ 就重新跑一次：node tools/ui-build.js');
    process.exit(1);
  }
  console.log('--check 通过：零外链，产物与 src/ 一致（' + out.length + ' 字节）');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');
const sha = crypto.createHash('sha256').update(out).digest('hex').slice(0, 16);
console.log('已生成 ui/app.html：' + out.length + ' 字节，sha256:' + sha);
console.log('  分区：' + SECTIONS.join(' / ') + '；Fluent bundle：' + (fs.existsSync(path.join(FLUENT_DIR, 'fluent.min.js')) ? '内联' : '未提供（跳过）'));
