'use strict';
// npm 源偏好：存盘格式、模式到候选源的映射、自定义地址校验
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npmsrc-'));
process.env.WZD_DATA_DIR = TMP;
const npmsrc = require('../tools/npmsrc.js');

test('默认是 auto，两个源都在候选里（官方优先）', () => {
  const s = npmsrc.read();
  assert.strictEqual(s.mode, 'auto');
  const list = npmsrc.list();
  assert.strictEqual(list.length, 2);
  assert.match(list[0].url, /registry\.npmjs\.org/);
  assert.match(list[1].url, /npmmirror\.com/);
});

test('选镜像 → 只走镜像；选官方 → 只走官方', () => {
  npmsrc.write({ mode: 'mirror' });
  assert.deepStrictEqual(npmsrc.list().map((r) => r.url), ['https://registry.npmmirror.com']);
  npmsrc.write({ mode: 'official' });
  assert.deepStrictEqual(npmsrc.list().map((r) => r.url), ['https://registry.npmjs.org']);
});

test('自定义源：合法地址保留、结尾斜杠被去掉', () => {
  npmsrc.write({ mode: 'custom', url: 'https://registry.example.com/npm/' });
  const list = npmsrc.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].url, 'https://registry.example.com/npm');
  assert.match(list[0].label, /自定义源/);
});

test('自定义源必须是 http(s)，否则拒写且不改动已存偏好', () => {
  npmsrc.write({ mode: 'custom', url: 'https://ok.example.com' });
  assert.throws(() => npmsrc.write({ mode: 'custom', url: 'file:///c:/x' }), /http/);
  assert.strictEqual(npmsrc.list()[0].url, 'https://ok.example.com');
});

test('坏文件不会让读取崩掉，退回 auto', () => {
  fs.writeFileSync(path.join(TMP, 'npm-source.json'), '{ 坏 json', 'utf8');
  assert.strictEqual(npmsrc.read().mode, 'auto');
  assert.strictEqual(npmsrc.list().length, 2);
});

test('探测超时不会挂住：不可达的地址 4 秒内返回 false', async () => {
  const t0 = Date.now();
  const ok = await npmsrc.reachable({ url: 'http://127.0.0.1:9', label: '黑洞' });
  const ms = Date.now() - t0;
  assert.strictEqual(ok, false);
  assert.ok(ms < 5000, '探测耗时 ' + ms + 'ms，应该远小于 5 秒');
});
