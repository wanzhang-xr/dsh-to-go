// 兼容性判定单测：版本比较、区间匹配（含预发布）、|| 与多条件、缺包、结论文案
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require(path.join(__dirname, '..', 'tools', 'compat.js'));

// 假造一个「槽」和「profile」，放几个包进去
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-compat-'));
const slot = path.join(sandbox, 'agent-A');
const profile = path.join(sandbox, 'profiles', 'web');
fs.mkdirSync(path.join(slot, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true });
fs.mkdirSync(path.join(slot, 'node_modules', '@deepseek-ai', 'dsh-session'), { recursive: true });
fs.mkdirSync(path.join(slot, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true });
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
const put = (dir, name, version) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8');
put(path.join(slot, 'node_modules', '@deepseek-ai', 'dsh-llm'), '@deepseek-ai/dsh-llm', '0.2.1-alpha.2');
put(path.join(slot, 'node_modules', '@deepseek-ai', 'dsh-session'), '@deepseek-ai/dsh-session', '0.2.1-alpha.2');
put(path.join(slot, 'node_modules', '@deepseek-ai', 'cordis'), '@deepseek-ai/cordis', '4.0.5-alpha.1');
fs.mkdirSync(path.join(profile, 'node_modules', 'only-in-profile'), { recursive: true });
put(path.join(profile, 'node_modules', 'only-in-profile'), 'only-in-profile', '1.2.3');
const O = { slotDir: slot, profileDir: profile, semverDir: null };   // semverDir: null → 走近似匹配

test('parseVersion / compare：正式版大于同号预发布，预发布之间按段比', () => {
  assert.strictEqual(C.compare('1.0.0', '1.0.0-alpha'), 1);
  assert.strictEqual(C.compare('0.2.0-rc.1', '0.2.0'), -1);
  assert.strictEqual(C.compare('1.0.10', '1.0.9'), 1);
  assert.strictEqual(C.compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1, '数字段按数值比，不是字典序');
  assert.strictEqual(C.compare('1.0.0', '1.0.0'), 0);
  assert.strictEqual(C.compare('乱码', '1.0.0'), null);
  assert.strictEqual(C.parseVersion('v1.2.3-beta.1').main.join('.'), '1.2.3');
});

test('近似匹配：^ 在 0.x 上只放开次版本（这条最容易写错）', () => {
  assert.strictEqual(C.approxSatisfies('^0.1.2-alpha.1', '0.1.7-alpha.1'), true);
  assert.strictEqual(C.approxSatisfies('^0.1.2-alpha.1', '0.2.0-rc.1'), false, '0.x 的 ^ 不该放到 0.2');
  assert.strictEqual(C.approxSatisfies('^4.0.1', '4.0.5-alpha.1'), true);
  assert.strictEqual(C.approxSatisfies('^4.0.1', '5.0.0'), false);
  assert.strictEqual(C.approxSatisfies('^1.2.3', '2.0.0'), false);
});

test('近似匹配：~ 只放开补丁号；>= <= < > 与精确匹配', () => {
  assert.strictEqual(C.approxSatisfies('~1.0.6-alpha.1', '1.0.10-alpha.1'), true);
  assert.strictEqual(C.approxSatisfies('~1.0.6-alpha.1', '1.1.0'), false);
  assert.strictEqual(C.approxSatisfies('>=1.0.0', '1.0.0'), true);
  assert.strictEqual(C.approxSatisfies('<2.0.0', '2.0.0'), false);
  assert.strictEqual(C.approxSatisfies('1.2.3', '1.2.3'), true);
  assert.strictEqual(C.approxSatisfies('1.2.3', '1.2.4'), false);
  assert.strictEqual(C.approxSatisfies('*', '9.9.9'), true);
});

test('近似匹配：|| 并联、空格并联的多条件', () => {
  const r = '^0.1.2-alpha.1 || ^0.1.3-alpha.1 || ^0.2.0-rc.1';
  assert.strictEqual(C.approxSatisfies(r, '0.1.3-alpha.1'), true);
  assert.strictEqual(C.approxSatisfies(r, '0.2.0-rc.1'), true);
  // 含预发布判定下，^0.1.3-alpha.1 是接受 0.1.5-rc.1 的（实测与槽里的 semver 一致）
  assert.strictEqual(C.approxSatisfies(r, '0.1.5-rc.1'), true);
  assert.strictEqual(C.approxSatisfies(r, '0.3.0'), false, '超出所有区间就不满足');
  assert.strictEqual(C.approxSatisfies('>=1.0.0 <2.0.0', '1.5.0'), true);
  assert.strictEqual(C.approxSatisfies('>=1.0.0 <2.0.0', '2.0.0'), false);
});

test('check：全部满足 → ok，缺包单列（不算失败）', () => {
  const res = C.check({
    '@deepseek-ai/dsh-llm': '^0.2.1-alpha.2',
    '@deepseek-ai/cordis': '^4.0.1',
    '完全不存在的包': '^1.0.0',
  }, O);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.checked, 3);
  assert.strictEqual(res.fails.length, 0);
  assert.strictEqual(res.unresolved.length, 1);
  assert.strictEqual(res.how, 'approx');
});

test('check：有一条不满足 → ok=false 并指明是谁（对应 dsh 的「需要豁免」）', () => {
  const res = C.check({ '@deepseek-ai/dsh-llm': '^0.1.2-alpha.1' }, O);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.fails.length, 1);
  assert.strictEqual(res.fails[0].dep, '@deepseek-ai/dsh-llm');
  assert.strictEqual(res.fails[0].have, '0.2.1-alpha.2');
  const v = C.verdict(res, '0.2.1-alpha.2');
  assert.strictEqual(v.level, 'need-exempt');
  assert.match(v.text, /不匹配/);
  assert.match(v.text, /dsh-llm/);
});

test('check：没有声明任何依赖 → ok=null（页面显示「没声明要求」，不冒充适配）', () => {
  const res = C.check({}, O);
  assert.strictEqual(res.ok, null);
  assert.strictEqual(res.checked, 0);
  assert.strictEqual(C.verdict(res).level, 'none');
});

test('check：声明了但一个都找不到 → ok=null（不冒充适配）', () => {
  const res = C.check({ 'nope-a': '^1.0.0', 'nope-b': '^2.0.0' }, O);
  assert.strictEqual(res.ok, null);
  assert.strictEqual(res.unresolved.length, 2);
  assert.strictEqual(C.verdict(res).level, 'unknown');
});

test('check：profile 里装的包也能解析到（不只看槽里）', () => {
  const res = C.check({ 'only-in-profile': '^1.2.0' }, O);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.checks[0].have, '1.2.3');
});

test('checkPackage：直接读一个包目录，顺带把包名与版本带出来', () => {
  const dir = path.join(profile, 'node_modules', 'only-in-profile');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'only-in-profile', version: '1.2.3', peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
  }), 'utf8');
  const res = C.checkPackage(dir, O);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.pkg, 'only-in-profile');
  assert.strictEqual(res.version, '1.2.3');
});

test('verdict：适配时给出本槽版本，好让人知道它是跟谁比出来的', () => {
  const res = C.check({ '@deepseek-ai/cordis': '^4.0.1' }, O);
  const v = C.verdict(res, '0.2.1-alpha.2');
  assert.strictEqual(v.level, 'ok');
  assert.match(v.text, /适配本槽/);
  assert.match(v.text, /0\.2\.1-alpha\.2/);
});

test.after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } });
