#!/usr/bin/env node
'use strict';
/*
 * page-check.js — 配置页静态核查（零第三方依赖，只读文件，不改任何源文件）
 *
 * 用法:
 *   node tests/page-check.js [文件路径] [--json] [--strict-url] [--help]
 *   默认文件: ui/app.html
 *
 * 断言（失败→退出码 1）:
 *   1. external-urls      页面里没有 http(s)/ws(s)/ftp 外链；只允许 127.0.0.1 / localhost / [::1]
 *                          （输入框 placeholder 里的「示例文案 URL」默认降级为 WARN，--strict-url 可升级为 FAIL）
 *   2. external-assets    <script src= / <link rel="stylesheet" href= / <iframe src= / @import / url(...)
 *                          不指向仓库外（相对路径、data:、blob: 允许）
 *   3. reduced-motion     存在 @media (prefers-reduced-motion: reduce)（现有设计约定，不许被删）
 *   4. skeleton           存在 aria-busy 或 skeleton( 调用（骨架屏约定）
 *   5. token-bridge       存在宿主令牌桥契约字符串 dsh.token.request 或 dsh.token
 *                          未实现时 FAIL，并在结论里写「等待地基棒实现」
 *
 * 附加（advisory，只提示、不影响退出码）:
 *   A. 不落盘凭据:  没有 localStorage/sessionStorage/indexedDB 写入口令/密钥
 *   B. 剪贴板收敛:  navigator.clipboard 只用于复制命令/地址，不复制密钥
 *
 * 退出码: 0 全 PASS（WARN 不算失败）, 1 有 FAIL, 2 用法/读取错误
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const USAGE = `page-check — 配置页静态核查（零外链 / UI 约定 / 令牌桥契约）

用法:
  node tests/page-check.js [文件路径] [--json] [--strict-url]

参数:
  <文件路径>      要检查的 HTML，默认 ui/app.html
  --json          输出机器可读 JSON
  --strict-url    把「placeholder 里的示例 URL」从 WARN 升级为 FAIL
  --help, -h      显示本帮助

检查项:
  external-urls    无 http(s)/ws(s)/ftp 外链（仅允许 127.0.0.1 / localhost / [::1]）
  external-assets  无外部 <script src> / <link rel=stylesheet> / <iframe src> / @import / url(...)
  reduced-motion   保留 @media (prefers-reduced-motion: reduce)
  skeleton         保留 aria-busy / skeleton( 骨架屏
  token-bridge     存在 dsh.token.request 或 dsh.token 契约串
  附: no-cred-persistence / clipboard-scope（advisory，不影响退出码）

退出码: 0 PASS    1 FAIL    2 用法/读取错误
`;

const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/i;
const SCHEME = /(?:https?|wss?|ftps?|sftp):\/\//i;
// XML 命名空间是标识符，不是可导航地址，浏览器永不发起请求 → 仅记 INFO，不参与判定
const NAMESPACE_URL = /^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/(xhtml|xlink|xmlns)|XML\/1998\/namespace)$/i;

function parseArgs(argv) {
  const opts = { file: null, json: false, strictUrl: false, help: false, error: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--strict-url') opts.strictUrl = true;
    else if (a.startsWith('-')) { opts.error = `未知参数: ${a}`; return opts; }
    else if (!opts.file) opts.file = a;
    else { opts.error = `只接受一个文件路径，多给了: ${a}`; return opts; }
  }
  return opts;
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineColOf(starts, idx) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= idx) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { line: ans + 1, column: idx - starts[ans] + 1 };
}

function snippet(line, max = 160) {
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 判断某个 URL 出现处是否位于 placeholder="..." 属性值内（示例文案，不产生请求）。 */
function inPlaceholder(line, colIdx) {
  const before = line.slice(0, colIdx);
  const at = before.lastIndexOf('placeholder');
  if (at === -1) return false;
  const between = before.slice(at);
  if (!/^placeholder\s*=\s*["']/.test(between)) return false;
  // 值里不能已经闭合
  return !/["']/.test(between.replace(/^placeholder\s*=\s*["']/, ''));
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('<!--') || t.startsWith('*') || t.startsWith('/*');
}

// ---------------------------------------------------------------- checks
function checkExternalUrls(text, lines, starts, strict) {
  const items = [];
  // 内联的第三方库（Fluent UI bundle）里带自己的 issue 链接注释——那不是我们的外链，
  // 也不会产生请求。ui-build.js 用这两个标记把它圈出来，这里按「库内部注释」跳过。
  const tpBegin = text.indexOf('/*{{FLUENT_BUNDLE_BEGIN}}*/');
  const tpEnd = text.indexOf('/*{{FLUENT_BUNDLE_END}}*/');
  const inThirdParty = (i) => tpBegin >= 0 && tpEnd > tpBegin && i > tpBegin && i < tpEnd;
  const re = new RegExp(SCHEME.source + '([^\\s"\'<>()`]+)', 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    const { line, column } = lineColOf(starts, idx);
    const raw = m[0];
    const host = m[1].replace(/^\/\//, '').split(/[/?#:]/)[0];
    if (ALLOWED_HOST.test(host)) continue;              // 127.0.0.1 / localhost 允许
    const ln = lines[line - 1] || '';
    const ns = NAMESPACE_URL.test(raw.split(/["'\s]/)[0]);
    const comment = isComment(ln);
    const placeholder = inPlaceholder(ln, idx - starts[line - 1]);
    let kind = 'live-reference';
    if (inThirdParty(idx)) kind = 'third-party-internal';
    else if (ns) kind = 'xml-namespace';
    else if (comment) kind = 'comment-text';
    else if (placeholder) kind = 'placeholder-text';
    items.push({
      line, column,
      url: raw.length > 120 ? raw.slice(0, 120) + '…' : raw,
      host, kind,
      snippet: snippet(ln),
    });
  }
  const count = (k) => items.filter((i) => i.kind === k).length;
  const live = count('live-reference');
  const commented = count('comment-text');
  const placeheld = count('placeholder-text');
  const namespaced = count('xml-namespace');
  const thirdParty = count('third-party-internal');
  // 注释里的说明性 URL 按验收口径一律算 FAIL（明确要求「报出来让人看」，不放行）
  let status = 'PASS';
  if (live || commented) status = 'FAIL';
  else if (placeheld) status = strict ? 'FAIL' : 'WARN';
  const bits = [];
  if (live) bits.push(`可导航 ${live}`);
  if (commented) bits.push(`注释说明性 ${commented}`);
  if (placeheld) bits.push(`placeholder 示例 ${placeheld}`);
  if (namespaced) bits.push(`XML 命名空间(不计) ${namespaced}`);
  if (thirdParty) bits.push(`第三方库内部注释(不计) ${thirdParty}`);
  return {
    id: 'external-urls',
    title: '无 http(s)/ws(s)/ftp 外链（仅 127.0.0.1 / localhost）',
    status,
    detail: items.length === 0
      ? '零处外部 URL 字面量'
      : `${items.length} 处外部 URL 字面量：${bits.join(' / ')}`,
    items: items.filter((i) => i.kind !== 'xml-namespace' && i.kind !== 'third-party-internal'),
    namespaces: items.filter((i) => i.kind === 'xml-namespace'),
    note: placeheld && !strict
      ? `placeholder 里的示例文案不产生请求，但按「零外链」口径仍建议清成 127.0.0.1 形式；--strict-url 可升级为 FAIL`
      : null,
  };
}

function checkExternalAssets(text, lines, starts) {
  const items = [];
  const tagRe = /<(script|link|iframe|img|form|source|video|audio|embed|object|a|use|image)\b([^>]*)>/gi;
  const attrRe = /\b(src|href|action|formaction|data|poster|xlink:href)\s*=\s*(["'])(.*?)\2/gi;
  let t;
  while ((t = tagRe.exec(text)) !== null) {
    const tagName = t[1].toLowerCase();
    const attrs = t[2] || '';
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(attrs)) !== null) {
      const val = (a[3] || '').trim();
      if (!val) continue;
      const isRel = val.startsWith('./') || val.startsWith('../') || val.startsWith('/')
        || /^[a-z0-9_.\-]+$/i.test(val) || /^[a-z0-9_\-./]+\.(js|css|html|svg|png|json)$/i.test(val);
      const isInline = /^(data:|blob:|about:blank|#|javascript:void)/i.test(val);
      if (isRel || isInline) continue;
      // 运行时由数据拼出的地址（'…' + esc(x) + '…' / ${x} / 函数调用）不是字面外链：
      // 归为 dynamic-href，提示需要宿主导航白名单兜底，不单独判 FAIL。
      const isDynamic = /['"`]\s*\+|\+\s*['"`]|\$\{|\b[a-zA-Z_$][\w$]*\s*\(/.test(val);
      if (SCHEME.test(val)) {
        const host = val.replace(SCHEME, '').split(/[/?#:]/)[0];
        if (ALLOWED_HOST.test(host)) continue;
      }
      const { line, column } = lineColOf(starts, t.index + 1);
      items.push({
        line, column,
        tag: `<${tagName} ${a[1].toLowerCase()}>`,
        kind: isDynamic ? 'dynamic-href' : 'literal-external',
        value: val.length > 120 ? val.slice(0, 120) + '…' : val,
        snippet: snippet(lines[line - 1] || ''),
      });
    }
  }

  // CSS @import 与 url(...) 里的外链
  const cssRe = /@import\s+(?:url\()?["']?([^"');\s]+)|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let c;
  while ((c = cssRe.exec(text)) !== null) {
    const val = (c[1] || c[2] || '').trim();
    if (!val || !SCHEME.test(val)) continue;
    const host = val.replace(SCHEME, '').split(/[/?#:]/)[0];
    if (ALLOWED_HOST.test(host)) continue;
    const { line, column } = lineColOf(starts, c.index);
    items.push({
      line, column, tag: '@import/url()', kind: 'literal-external', value: val,
      snippet: snippet(lines[line - 1] || ''),
    });
  }

  const literal = items.filter((i) => i.kind !== 'dynamic-href');
  const dynamic = items.filter((i) => i.kind === 'dynamic-href');
  return {
    id: 'external-assets',
    title: '无外部 <script src> / <link rel=stylesheet> / iframe / @import',
    status: literal.length ? 'FAIL' : (dynamic.length ? 'WARN' : 'PASS'),
    detail: (literal.length || dynamic.length)
      ? `字面外链 ${literal.length} 处 / 运行时拼出的地址 ${dynamic.length} 处`
      : '所有资源引用均为相对路径或 inline',
    note: dynamic.length
      ? 'dynamic-href 由后端数据拼出（如市场仓库/主页链接），页面侧无法静态判定 → 必须靠 WebView2 NavigationStarting 只放行 127.0.0.1:<port> 兜底'
      : null,
    items,
  };
}

function presenceCheck(text, id, title, test, hint) {
  const found = test(text);
  return {
    id, title,
    status: found ? 'PASS' : 'FAIL',
    detail: found ? (found.detail || '存在') : (hint || '缺失'),
    items: found && found.items ? found.items : [],
  };
}

function checkReducedMotion(text, starts, lines) {
  const re = /@media[^{]*prefers-reduced-motion\s*:\s*reduce/i;
  const m = re.exec(text);
  if (!m) return { id: 'reduced-motion', title: '保留 @media (prefers-reduced-motion: reduce)',
    status: 'FAIL', detail: '未找到 prefers-reduced-motion 媒体查询（现有无障碍约定被删？）', items: [] };
  const { line } = lineColOf(starts, m.index);
  return { id: 'reduced-motion', title: '保留 @media (prefers-reduced-motion: reduce)',
    status: 'PASS', detail: `存在（第 ${line} 行）`, items: [{ line, snippet: snippet(lines[line - 1] || '') }] };
}

function checkSkeleton(text, starts, lines) {
  const re = /aria-busy|skeleton\s*\(/;
  const m = re.exec(text);
  if (!m) return { id: 'skeleton', title: '保留骨架屏（aria-busy / skeleton()）',
    status: 'FAIL', detail: '未找到 aria-busy 或 skeleton( 调用', items: [] };
  const hasBusy = /aria-busy/.test(text);
  const hasFn = /skeleton\s*\(/.test(text);
  const { line } = lineColOf(starts, m.index);
  return { id: 'skeleton', title: '保留骨架屏（aria-busy / skeleton()）',
    status: 'PASS', detail: `存在（aria-busy: ${hasBusy ? '是' : '否'} / skeleton(): ${hasFn ? '是' : '否'}，首见第 ${line} 行）`,
    items: [{ line, snippet: snippet(lines[line - 1] || '') }] };
}


function checkBridgePayload(text, starts, lines) {
  // 桌面壳的 preload 只接受对象（字符串会被 JSON.parse 兜住，但旧代码里传字符串
  // 曾经是"点了没反应"的根因：postMessage 静默 return）。这里静态拦住这种写法。
  const re = /postMessage\s*\(\s*JSON\.stringify/g;
  const items = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const { line, column } = lineColOf(starts, m.index);
    items.push({ line, column, snippet: snippet(lines[line - 1] || '') });
  }
  return {
    id: 'bridge-payload',
    title: '宿主桥的载荷直接传对象（不要把 JSON.stringify 的结果喂给 postMessage）',
    status: items.length ? 'FAIL' : 'PASS',
    detail: items.length
      ? `有 ${items.length} 处 postMessage(JSON.stringify(...))：壳的 preload 只认对象，字符串会被丢弃 → 用户看到"点了没反应"`
      : '没有 JSON.stringify 包裹的桥调用',
    items,
  };
}

function checkTokenBridge(text, starts, lines) {
  const re = /dsh\.token(?:\.request)?\b/g;
  const items = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    const { line, column } = lineColOf(starts, m.index);
    items.push({ token: m[0], line, column, snippet: snippet(lines[line - 1] || '') });
  }
  const hasRequest = /dsh\.token\.request\b/.test(text);
  const hasBase = /dsh\.token\b/.test(text);
  if (!hasRequest && !hasBase) {
    return {
      id: 'token-bridge',
      title: '宿主令牌桥契约串（dsh.token.request / dsh.token）',
      status: 'FAIL',
      detail: '页面里没有 dsh.token.request 也没有 dsh.token —— 等待地基棒实现（宿主令牌桥尚未落地）',
      items: [],
    };
  }
  return {
    id: 'token-bridge',
    title: '宿主令牌桥契约串（dsh.token.request / dsh.token）',
    status: 'PASS',
    detail: `找到 ${items.map((i) => i.token).join(', ')}${hasRequest ? '（含 request 端）' : '（仅基名，未见 .request 端）'}`,
    items,
  };
}

function advisories(text, lines, starts) {
  const out = [];
  // A. 不落盘凭据
  const storeRe = /(localStorage|sessionStorage|indexedDB)\s*\.\s*(setItem|put|open)?/g;
  const storeHits = [];
  let m;
  while ((m = storeRe.exec(text)) !== null) {
    const { line } = lineColOf(starts, m.index);
    storeHits.push({ line, snippet: snippet(lines[line - 1] || '') });
  }
  out.push({
    id: 'no-cred-persistence',
    title: '[adv] 不在浏览器存储里留口令/密钥',
    status: storeHits.length ? 'WARN' : 'PASS',
    detail: storeHits.length ? `${storeHits.length} 处 localStorage/sessionStorage/indexedDB 调用，需人工确认不含密钥` : '页面未使用任何浏览器持久化存储',
    items: storeHits,
  });

  // B. 剪贴板收敛
  const clipRe = /navigator\.clipboard\.[a-zA-Z]+/g;
  const clipHits = [];
  while ((m = clipRe.exec(text)) !== null) {
    const { line } = lineColOf(starts, m.index);
    clipHits.push({ line, snippet: snippet(lines[line - 1] || '') });
  }
  out.push({
    id: 'clipboard-scope',
    title: '[adv] 剪贴板只复制命令/地址',
    status: clipHits.length ? 'WARN' : 'PASS',
    detail: clipHits.length ? `${clipHits.length} 处 navigator.clipboard 调用，需人工确认只写命令/地址` : '页面未使用 navigator.clipboard',
    items: clipHits,
  });
  return out;
}

// ---------------------------------------------------------------- main
function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.error) { process.stderr.write(`page-check: ${opts.error}\n\n${USAGE}`); return 2; }

  const target = opts.file ? path.resolve(process.cwd(), opts.file) : path.join(ROOT, 'ui', 'app.html');
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (e) {
    process.stderr.write(`page-check: 读不到文件 ${target}（${e.code || e.message}）\n`);
    return 2;
  }
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const starts = lineStartsOf(text);

  const checks = [
    checkExternalUrls(text, lines, starts, opts.strictUrl),
    checkExternalAssets(text, lines, starts),
    checkReducedMotion(text, starts, lines),
    checkSkeleton(text, starts, lines),
    checkTokenBridge(text, starts, lines),
    checkBridgePayload(text, starts, lines),
    ...advisories(text, lines, starts),
  ];

  const fails = checks.filter((c) => c.status === 'FAIL');
  const warns = checks.filter((c) => c.status === 'WARN');
  const ok = fails.length === 0;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      tool: 'page-check', version: 1, ok, exitCode: ok ? 0 : 1,
      file: path.relative(ROOT, target) || target,
      absolutePath: target,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: lines.length,
      strictUrl: opts.strictUrl,
      summary: { pass: checks.filter((c) => c.status === 'PASS').length, warn: warns.length, fail: fails.length },
      checks,
      generatedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } else {
    const L = [];
    L.push('== 配置页静态核查 page-check ==');
    L.push(`文件: ${path.relative(ROOT, target) || target}  (${lines.length} 行, ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)}KB)`);
    if (opts.strictUrl) L.push('模式: --strict-url（placeholder 示例 URL 也算 FAIL）');
    L.push('');
    for (const c of checks) {
      L.push(`[${c.status.padEnd(4)}] ${c.id.padEnd(20)} ${c.title}`);
      L.push(`         ${c.detail}`);
      if (c.note) L.push(`         note: ${c.note}`);
      for (const it of c.items.slice(0, 8)) {
        const where = it.line ? `:${it.line}${it.column ? ':' + it.column : ''}` : '';
        const tag = it.url ? ` ${it.url}` : (it.value ? ` ${it.value}` : (it.token ? ` ${it.token}` : ''));
        L.push(`         → ${path.basename(target)}${where}${tag}`);
        if (it.snippet) L.push(`           ${it.snippet}`);
      }
      if (c.items.length > 8) L.push(`         … 另有 ${c.items.length - 8} 处`);
    }
    L.push('');
    L.push(`PASS ${checks.filter((c) => c.status === 'PASS').length} / WARN ${warns.length} / FAIL ${fails.length}`);
    L.push(ok
      ? 'RESULT: PASS — 页面保持零外链且既有 UI 约定在位'
      : `RESULT: FAIL — ${fails.map((f) => f.id).join(', ')}`);
    process.stdout.write(L.join('\n') + '\n');
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  let code = 2;
  try { code = main(process.argv.slice(2)); }
  catch (err) {
    process.stderr.write(`page-check: 内部错误 ${(err && err.stack) || err}\n`);
    code = 2;
  }
  process.exit(code);
}

module.exports = { main, checkExternalUrls, checkExternalAssets, checkTokenBridge };
