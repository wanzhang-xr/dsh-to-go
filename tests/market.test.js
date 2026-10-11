// 市场数据层单测：查询/筛选/排序/分页、取单条、安装目标解析、缓存读写的健壮性
// 注意：这里**不联网**——写一份假缓存直接测查询逻辑（网络那条路由 e2e 覆盖）。
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// market.js 在加载时就读 WZD_DATA_DIR，所以先设好再 require
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-market-'));
process.env.WZD_DATA_DIR = sandbox;
const M = require(path.join(__dirname, '..', 'tools', 'market.js'));

const CACHE = path.join(sandbox, 'market.json');
function writeFixture(plugins) {
  fs.writeFileSync(CACHE, JSON.stringify({
    source: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin',
    url: 'https://awesome-dsh-plugin.com',
    updated: '2026-10-10',
    fetchedAt: new Date().toISOString(),
    declaredCount: plugins.length,
    count: plugins.length,
    categories: { memory: '记忆', ui: 'UI 增强' },
    // 真实缓存是 load() 里 reduce() 过的形状，测试也照这个来（不然字段名对不上）
    plugins: plugins.map(M.reduce),
  }), 'utf8');
}
const RAW = [
  { name: 'dsh-memory', owner: 'FuRongJun-1999', url: 'u1', page: 'p1', category: 'memory', npm: '@furongjun1999/dsh-memory', version: '0.8.1', stars: 331, downloads: 25839, install: 'dsh plugin --profile web add @furongjun1999/dsh-memory', added: '2026-08-14', capabilities: ['fs-read'], capabilityRedLines: [], description: { zh: '白箱AGI架构探索：元认知、持续学习', en: 'White-box AGI architecture' }, screenshots: ['a', 'b', 'c', 'd'] },
  { name: 'dsh-hud', owner: 'a903067276-rgb', url: 'u2', page: 'p2', category: 'ui', npm: null, version: null, stars: 8, downloads: null, install: 'dsh plugin --profile web add github:a903067276-rgb/dsh-hud', added: '2026-08-14', capabilities: ['fs-read', 'network', 'credentials'], capabilityRedLines: ['reads credentials/secrets AND has network access'], description: { zh: 'HUD 状态面板', en: 'HUD status panel' }, screenshots: ['x'] },
  { name: 'dsh-better-display', owner: 'aa2246740', url: 'u3', page: 'p3', category: 'ui', npm: 'dsh-better-display', version: '0.3.6', stars: 81, downloads: 2761, install: 'dsh plugin --profile web add dsh-better-display', added: '2026-09-18', capabilities: [], capabilityRedLines: [], description: { zh: 'X'.repeat(900), en: 'calmer reading view' }, screenshots: [] },
];

test('readCache：没有缓存时返回 null（页面据此提示要先拉一次）', () => {
  fs.rmSync(CACHE, { force: true });
  assert.strictEqual(M.readCache(), null);
  const r = M.query({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /还没缓存/);
  assert.deepStrictEqual(r.items, []);
});

test('stats：报出是否缓存、条数、来源日期、过期与否', () => {
  writeFixture(RAW);
  const s = M.stats();
  assert.strictEqual(s.cached, true);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.updated, '2026-10-10');
  assert.strictEqual(s.stale, false);
  assert.ok(s.sizeBytes > 0);
});

test('query：默认按 star 排序、分页、返回页数', () => {
  writeFixture(RAW);
  const r = M.query({ pageSize: 2 });
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.pages, 2);
  assert.deepStrictEqual(r.items.map((p) => p.name), ['dsh-memory', 'dsh-better-display']);
  const r2 = M.query({ pageSize: 2, page: 2 });
  assert.deepStrictEqual(r2.items.map((p) => p.name), ['dsh-hud']);
});

test('query：按下载量、收录时间、名称排序', () => {
  writeFixture(RAW);
  assert.deepStrictEqual(M.query({ sort: 'downloads' }).items.map((p) => p.name), ['dsh-memory', 'dsh-better-display', 'dsh-hud']);
  assert.deepStrictEqual(M.query({ sort: 'name' }).items.map((p) => p.name), ['dsh-better-display', 'dsh-hud', 'dsh-memory']);
  assert.deepStrictEqual(M.query({ sort: 'added' }).items[0].name, 'dsh-better-display');
});

test('query：关键词能命中名称/作者/包名/中英文简介', () => {
  writeFixture(RAW);
  assert.strictEqual(M.query({ q: 'memory' }).total, 1);
  assert.strictEqual(M.query({ q: 'a903067276' }).items[0].name, 'dsh-hud');
  assert.strictEqual(M.query({ q: 'better-display' }).total, 1);
  assert.strictEqual(M.query({ q: '状态面板' }).items[0].name, 'dsh-hud');
  assert.strictEqual(M.query({ q: 'calmer' }).items[0].name, 'dsh-better-display');
  assert.strictEqual(M.query({ q: '没有这种东西' }).total, 0);
});

test('query：分类筛选与「只看有风险提示」', () => {
  writeFixture(RAW);
  assert.strictEqual(M.query({ category: 'ui' }).total, 2);
  assert.strictEqual(M.query({ category: 'memory' }).total, 1);
  assert.strictEqual(M.query({ riskOnly: true }).total, 1);
  assert.strictEqual(M.query({ riskOnly: true }).items[0].name, 'dsh-hud');
  assert.strictEqual(M.query({ category: 'ui', riskOnly: true }).total, 1);
});

test('query：已装的包会被标出来（按插件名或 npm 包名都能对上）', () => {
  writeFixture(RAW);
  const r = M.query({ installedSet: new Set(['dsh-hud', '@furongjun1999/dsh-memory']) });
  assert.strictEqual(r.items.find((p) => p.name === 'dsh-hud').installed, true);
  assert.strictEqual(r.items.find((p) => p.name === 'dsh-memory').installed, true);
  assert.strictEqual(r.items.find((p) => p.name === 'dsh-better-display').installed, false);
});

test('find：按插件名或 npm 包名都能取到单条；找不到返回 null', () => {
  writeFixture(RAW);
  assert.strictEqual(M.find('dsh-hud').owner, 'a903067276-rgb');
  assert.strictEqual(M.find('dsh-memory').owner, 'FuRongJun-1999');
  assert.strictEqual(M.find('@furongjun1999/dsh-memory').name, 'dsh-memory');
  assert.strictEqual(M.find('nope'), null);
});

test('reduce：超长简介会被截断，字段缺失不会炸；screenshots 只留 3 张', () => {
  const p = M.reduce(RAW[2]);
  assert.ok(p.zh.length <= 320, '中文简介应被截断，实际 ' + p.zh.length);
  assert.strictEqual(p.zh.slice(-1), '…');
  assert.strictEqual(p.owner, 'aa2246740');
  assert.strictEqual(M.reduce(RAW[0]).screenshots.length, 3, '只留 3 张截图');
  const empty = M.reduce({ name: 'x' });
  assert.deepStrictEqual(empty.capabilities, []);
  assert.deepStrictEqual(empty.redLines, []);
  assert.strictEqual(empty.stars, 0);
  assert.strictEqual(empty.npm, null);
});

test('installSpecOf：从市场给的命令里抠出安装目标（npm / github / tgz / 带引号）', () => {
  assert.strictEqual(M.installSpecOf('dsh plugin --profile web add dsh-hud'), 'dsh-hud');
  assert.strictEqual(M.installSpecOf('dsh plugin --profile web add @scope/name'), '@scope/name');
  assert.strictEqual(M.installSpecOf('dsh plugin --profile web add github:CAI-MH/dsh-quality-review'), 'github:CAI-MH/dsh-quality-review');
  assert.strictEqual(M.installSpecOf('dsh plugin --profile web add "https://github.com/x/y/releases/download/v0.1.2/a-b-0.1.2.tgz"'), 'https://github.com/x/y/releases/download/v0.1.2/a-b-0.1.2.tgz');
  assert.strictEqual(M.installSpecOf('dsh plugin --profile work add dsh-x'), 'dsh-x');
  assert.strictEqual(M.installSpecOf('dsh plugin --profile web list'), '', '不是 add 子命令就抠不出来');
  assert.strictEqual(M.installSpecOf('这条命令里没有安装动作'), '');
  assert.strictEqual(M.installSpecOf(null), '');
});

test('缓存文件写坏了：query 报「没缓存」而不是抛异常', () => {
  fs.writeFileSync(CACHE, '{ 这不是 JSON', 'utf8');
  const r = M.query({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(M.readCache(), null);
  assert.strictEqual(M.find('dsh-hud'), null);
});

test.after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } });
