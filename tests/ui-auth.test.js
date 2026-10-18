'use strict';
/**
 * 鉴权回归：四个写接口（改站点 / 删站点 / 切活动槽 / 重建覆盖层）必须要求口令登录。
 *
 * 背景：它们此前只受 URL token 保护——token 一旦落到同机别的进程（或页面外泄），
 * 就能绕过登录遮罩直接删站点（可连带删密钥）、切槽、重写覆盖层。
 * 项目红线是「删除类操作要有前置条件」，服务端不能只靠页面遮罩。
 *
 * 做法：真起 ui-server（临时数据目录 + 随机空闲端口），按真实 HTTP 请求验证；
 * 不用文本匹配源码，断言的是真实响应与副作用。
 *
 * 运行：node --test tests/ui-auth.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-auth-'));
const RUNTIME = path.join(ROOT, 'runtime');
const HAD_RUNTIME = fs.existsSync(RUNTIME);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('tools', 'ui-server.js'), '--port', String(port), '--no-open'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { WZD_DATA_DIR: TMP }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { /* 已退出 */ }
      reject(new Error('ui-server 启动超时。输出：\n' + out));
    }, 20000);
    const onData = (b) => {
      out += b.toString('utf8');
      const m = /token=([A-Za-z0-9_-]+)/.exec(out);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, token: m[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('ui-server 提前退出（code ' + code + '）。输出：\n' + out));
    });
  });
}

async function req(port, token, pathname, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-config-token'] = token;
  const r = await fetch('http://127.0.0.1:' + port + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 纯文本响应 */ }
  return { status: r.status, json, text };
}

test('四个写接口未登录一律 401，且不产生副作用', { timeout: 90000 }, async () => {
  const port = await freePort();
  const srv = await startServer(port);
  try {
    // 0) 没有 token：连页面都开不了（原有的第一道门）
    const noToken = await req(port, null, '/api/state');
    assert.strictEqual(noToken.status, 403, '无 token 应该 403');

    // 1) 带 token 但没输入口令：读操作照旧可用
    const st = await req(port, srv.token, '/api/state');
    assert.strictEqual(st.status, 200, 'GET /api/state 带 token 应该 200');
    assert.strictEqual(st.json.loggedIn, false, '此时应为未登录');

    // 2) 四个写接口：401
    const cases = [
      ['/api/sites', { site: { id: 'auth-test', baseURL: 'https://example.invalid/v1', models: [{ id: 'm' }] } }],
      ['/api/sites/delete', { siteId: 'auth-test', removeKey: true }],
      ['/api/slot/switch', { slot: 'agent-B' }],
      ['/api/overlay/rebuild', {}],
    ];
    for (const [p, body] of cases) {
      const r = await req(port, srv.token, p, body);
      assert.strictEqual(r.status, 401, p + ' 未登录应该 401，实际 ' + r.status + '：' + r.text);
      assert.match(String((r.json && r.json.error) || ''), /口令|解锁/, p + ' 的报错要说清为什么');
    }

    // 3) 副作用没发生：站点表仍是空（如果 /api/sites 放行了，这里会多出 auth-test）
    const sites = await req(port, srv.token, '/api/sites');
    assert.strictEqual(sites.status, 200);
    assert.deepStrictEqual(sites.json.sites || [], [], '未登录的请求不能写进站点表');

    // 4) 对照：设计上不需要登录的写接口没被误伤（只存显示开关）
    const prefs = await req(port, srv.token, '/api/prefs', { pluginsOfficial: false });
    assert.strictEqual(prefs.status, 200, 'POST /api/prefs 未登录应仍可用（只存显示开关）');
  } finally {
    try { srv.child.kill(); } catch (e) { /* 已退出 */ }
  }
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
  // ui-server 启动会写 runtime\.drive-id 哨兵；runtime 若是这次测试才出现的，一并收掉，
  // 避免给仓库留下一个「盘还在」的假哨兵。
  if (!HAD_RUNTIME) {
    try { fs.rmSync(RUNTIME, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
  }
});
