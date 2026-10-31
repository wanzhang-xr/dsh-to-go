'use strict';
/**
 * wallpaper.js —— 自定义背景的接口验收
 *
 *   runtime\node\node.exe tests\wallpaper.js
 *
 * 覆盖：上传（data URL）→ 取回（字节与 mime 一致）→ 偏好里有记录 →
 *       坏输入被拒（非 data URL / 不支持的类型 / 空图）→ 删除后恢复干净。
 *
 * 说明：会临时占用 data/wallpaper 与 data/ui-prefs.json，跑完按原样还原。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const PORT = 3211;
const WALL_DIR = path.join(ROOT, 'data', 'wallpaper');
const PREFS = path.join(ROOT, 'data', 'ui-prefs.json');

const results = [];
const ok = (n, d) => { results.push(true); console.log('  PASS  ' + n + (d ? '  — ' + d : '')); };
const bad = (n, d) => { results.push(false); console.log('  FAIL  ' + n + (d ? '  — ' + d : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, p, body, token, raw) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        token ? { 'x-config-token': token } : {}),
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 二进制就按 buf 说话 */ }
        resolve({ code: res.statusCode, json, buf, mime: String(res.headers['content-type'] || '') });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, json: null, buf: Buffer.alloc(0), mime: '' }); });
    req.on('error', () => resolve({ code: 0, json: null, buf: Buffer.alloc(0), mime: '' }));
    req.end(data);
    void raw;
  });
}

// 1x1 的透明 PNG，够验通路就行
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async function main() {
  if (!fs.existsSync(NODE)) { console.error('缺少 runtime/node/node.exe'); process.exit(2); }

  // 备份现场
  const bakPrefs = fs.existsSync(PREFS) ? fs.readFileSync(PREFS) : null;
  const bakWall = fs.existsSync(path.join(WALL_DIR, 'bg.img')) ? fs.readFileSync(path.join(WALL_DIR, 'bg.img')) : null;

  const child = spawn(NODE, [path.join(ROOT, 'tools', 'ui-server.js'), '--port', String(PORT), '--no-open'], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(out);
    if (m) token = m[1];
    else await sleep(200);
  }
  if (!token) { console.error('ui-server 没起来：\n' + out.slice(0, 400)); child.kill(); process.exit(2); }

  try {
    // 1) 没有背景时 404
    const none = await call('GET', '/api/wallpaper', null, token);
    if (none.code === 404) ok('没有背景时 GET 返回 404');
    else bad('没有背景时 GET 返回 404', '实际 ' + none.code);

    // 2) 上传
    const up = await call('POST', '/api/wallpaper', { dataUrl: PNG, opts: { dim: 40, blur: 6 } }, token);
    if (up.code === 200 && up.json && up.json.ok) ok('上传成功', (up.json.bytes || 0) + ' 字节');
    else bad('上传成功', 'HTTP ' + up.code + ' ' + (up.json && up.json.error || ''));

    // 3) 取回：字节与 mime 一致
    const got = await call('GET', '/api/wallpaper', null, token);
    const orig = Buffer.from(PNG.split(',')[1], 'base64');
    if (got.code === 200 && got.buf.equals(orig)) ok('取回的字节与上传一致', got.mime);
    else bad('取回的字节与上传一致', 'HTTP ' + got.code + ' len=' + got.buf.length + '/' + orig.length);

    // 4) 偏好里留下记录（dim/blur 也在）
    const prefs = await call('GET', '/api/prefs', null, token);
    const w = prefs.json && prefs.json.appearance && prefs.json.appearance.wallpaper;
    if (w && w.dim === 40 && w.blur === 6) ok('偏好里记录了 dim/blur', JSON.stringify(w));
    else bad('偏好里记录了 dim/blur', JSON.stringify(w));

    // 5) 坏输入
    const plain = await call('POST', '/api/wallpaper', { dataUrl: 'http://example.com/a.png' }, token);
    if (plain.code === 400) ok('非 data URL 被拒（400）');
    else bad('非 data URL 被拒（400）', '实际 ' + plain.code);

    const svg = await call('POST', '/api/wallpaper', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, token);
    if (svg.code === 415) ok('不支持的类型被拒（415）');
    else bad('不支持的类型被拒（415）', '实际 ' + svg.code);

    const empty = await call('POST', '/api/wallpaper', { dataUrl: 'data:image/png;base64,' }, token);
    if (empty.code === 400) ok('空图被拒（400）');
    else bad('空图被拒（400）', '实际 ' + empty.code);

    // 6) 删除
    const del = await call('DELETE', '/api/wallpaper', null, token);
    const after = await call('GET', '/api/wallpaper', null, token);
    if (del.code === 200 && after.code === 404) ok('删除后回到 404');
    else bad('删除后回到 404', 'del=' + del.code + ' get=' + after.code);

    const prefs2 = await call('GET', '/api/prefs', null, token);
    const w2 = prefs2.json && prefs2.json.appearance && prefs2.json.appearance.wallpaper;
    if (!w2) ok('删除后偏好里也清掉了');
    else bad('删除后偏好里也清掉了', JSON.stringify(w2));
  } catch (e) {
    bad('意外异常', e && e.message);
  } finally {
    child.kill();
    await sleep(300);
    // 还原现场
    try { if (bakPrefs) fs.writeFileSync(PREFS, bakPrefs); else fs.existsSync(PREFS) && fs.unlinkSync(PREFS); } catch (e) { /* 忽略 */ }
    try {
      if (bakWall) { fs.mkdirSync(WALL_DIR, { recursive: true }); fs.writeFileSync(path.join(WALL_DIR, 'bg.img'), bakWall); }
      else if (fs.existsSync(WALL_DIR)) { fs.rmSync(WALL_DIR, { recursive: true, force: true }); }
    } catch (e) { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log('\n  ' + (results.length - failed) + '/' + results.length + ' 项通过');
  process.exit(failed ? 1 : 0);
})();
