// 插件层单测：dump 解析、启停状态、pnpm 环境、包名校验
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../tools/plugins.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-plugins-'));
process.env.WZD_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.WZD_DATA_DIR, { recursive: true });
P.setRoots({ data: process.env.WZD_DATA_DIR });   // 本文件所有用例都指向临时数据目录（不要碰仓库真实的 data\）

// 真实 dump 的片段（含：官方默认停用、!!js 条件控制、嵌套的 - id:、bundle 分段注释）
const FIXTURE = [
  '# == @deepseek-ai/dsh-base',
  '- id: tool-plugin-manager',
  "  name: '@deepseek-ai/dsh-plugin-manager/tools'",
  '  disabled: true',
  '- id: plugin-manager',
  "  name: '@deepseek-ai/dsh-plugin-manager'",
  "  disabled: !!js '!ctx.get(''profileContext'')'",
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '- id: tool-web',
  "  name: '@deepseek-ai/dsh-tool-web'",
  '  config:',
  '    fetch: true',
  '- id: preset',
  '  config:',
  '    tools:',
  '      - id: tool-web',
  "        name: '@deepseek-ai/dsh-tool-web'",
  '# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
  '- id: webserver',
  "  name: '@deepseek-ai/dsh-host-webserver'",
].join('\n');

test('parseEntries：只认行首的条目，缩进的 - id: 是配置里的引用不算条目', () => {
  const es = P.parseEntries(FIXTURE);
  assert.deepStrictEqual(es.map((e) => e.id), ['tool-plugin-manager', 'plugin-manager', 'timer', 'tool-web', 'preset', 'webserver'],
    '嵌套的 tool-web（缩进 6 空格）不能算成第 7 个条目');
  const byId = Object.fromEntries(es.map((e) => [e.id, e]));
  assert.strictEqual(byId['tool-plugin-manager'].disabledShipped, true, '官方默认停用要认出来');
  assert.match(byId['plugin-manager'].disabledExpr, /!!js/, '!!js 条件控制要单独标记');
  assert.strictEqual(byId.timer.disabledShipped, false);
  assert.strictEqual(byId['tool-web'].name, '@deepseek-ai/dsh-tool-web');
  assert.strictEqual(byId.webserver.section, '@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app', '要记住条目属于哪一段');
});

test('启停状态：读写往返、去掉我们自己的 id、disabled 优先于 enabled', () => {
  const written = P.writeState({ disabled: ['tool-web', 'tool-web', 'llm-pi-ai', ''], enabled: ['hmr', 'tool-web'] });
  assert.deepStrictEqual(written.disabled, ['tool-web'], '去重 + 不许出现我们自己的条目 id');
  assert.deepStrictEqual(written.enabled, ['hmr'], '两个清单冲突时以 disabled 为准');
  const back = P.readState();
  assert.deepStrictEqual(back, { disabled: ['tool-web'], enabled: ['hmr'] });
  assert.strictEqual(P.ourChoice(back, 'tool-web'), 'disabled');
  assert.strictEqual(P.ourChoice(back, 'hmr'), 'enabled');
  assert.strictEqual(P.ourChoice(back, 'timer'), null, '没表态就跟随官方默认');
  P.writeState({ disabled: [], enabled: [] });
});

test('包名校验：合法/非法都要判对（会被当参数传给 pnpm）', () => {
  for (const ok of ['foo', 'foo-bar', '@scope/name', 'a.b_c', '@a/b-c.d']) assert.ok(P.validPackageName(ok), ok + ' 应当合法');
  for (const bad of ['', '  ', 'Foo', '@scope', '@scope/', '/name', '.hidden', '_x', 'a b', 'a;rm -rf /', 'x'.repeat(300)]) {
    assert.ok(!P.validPackageName(bad), JSON.stringify(bad) + ' 应当被拒');
  }
});

test('pnpmEnv：把盘上的 pnpm 放到 PATH 最前，并把 store 落在盘上', () => {
  const env = P.pnpmEnv({ PATH: 'C:\\Windows' });
  assert.ok(env.PATH.startsWith(P.pnpmBinDir()), '盘上的 pnpm 目录要在 PATH 最前：' + env.PATH.slice(0, 60));
  assert.ok(env.PATH.includes('C:\\Windows'), '原有 PATH 要保留');
  assert.strictEqual(env.npm_config_store_dir, P.PNPM_STORE, 'store 必须在盘上（否则会写到宿主或盘根）');
  const fresh = P.pnpmEnv({});
  assert.ok(fresh.PATH.includes(P.pnpmBinDir()));
});

test('pnpmInfo：如实报告盘上有没有 pnpm（有就带版本）', () => {
  const i = P.pnpmInfo();
  assert.strictEqual(typeof i.ok, 'boolean');
  assert.strictEqual(i.store, P.PNPM_STORE);
  if (i.ok) assert.match(i.version, /^\d+\.\d+/);
  else assert.ok(i.hint, '没装时要有可操作提示');
});

test('listInstalled：profile 没初始化时不报错、如实说没有', () => {
  const r = P.listInstalled('nope-not-here');
  assert.strictEqual(r.exists, false);
  assert.deepStrictEqual(r.installed, []);
  assert.ok(r.dir.includes('profiles'));
});

test('installedPackages：只认 package.json 的 dependencies，传递依赖不算插件', () => {
  const pdir = path.join(process.env.WZD_DATA_DIR, 'profiles', 'web');
  fs.mkdirSync(path.join(pdir, 'node_modules', 'dsh-better-sidebar'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'node_modules', 'semver'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { 'dsh-better-sidebar': '^0.25.0', 'dsh-at-file': 'github:FSMargoo/dsh-at-file#abc123' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-better-sidebar', 'dsh-at-file'] } },
  }), 'utf8');
  fs.writeFileSync(path.join(pdir, 'node_modules', 'dsh-better-sidebar', 'package.json'),
    JSON.stringify({ name: 'dsh-better-sidebar', version: '0.25.0', description: '侧栏', peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }), 'utf8');

  const list = P.installedPackages('web');
  assert.deepStrictEqual(list.map((x) => x.pkg).sort(), ['dsh-at-file', 'dsh-better-sidebar']);
  const sb = list.find((x) => x.pkg === 'dsh-better-sidebar');
  assert.strictEqual(sb.version, '0.25.0');
  assert.strictEqual(sb.spec, '^0.25.0', '装的时候用的范围要带出来');
  assert.strictEqual(sb.kind, 'third-party');
  assert.ok(!list.some((x) => x.pkg === 'semver'), '传递依赖不能被当成插件（更不能给删除按钮）');
  assert.ok(!list.some((x) => x.pkg === '@deepseek-ai/dsh-base'), '官方 bundle 也不是第三方插件');
  assert.strictEqual(P.profileNodeModulesCount('web'), 3, 'node_modules 里是 3 个（含传递依赖）');
});

test('installedPackages：profile 没装过东西时返回空数组（不抛异常）', () => {
  const pdir = path.join(process.env.WZD_DATA_DIR, 'profiles', 'empty');
  fs.mkdirSync(pdir, { recursive: true });
  assert.deepStrictEqual(P.installedPackages('empty'), []);
  assert.strictEqual(P.profileNodeModulesCount('empty'), 0);
});

test('CLI：setup-pnpm / list / installed 三个子命令都能跑（退出码正确）', () => {
  const { spawnSync } = require('child_process');
  const node = process.execPath;
  const cli = path.join(__dirname, '..', 'tools', 'plugins.js');
  const r1 = spawnSync(node, [cli, 'installed'], { encoding: 'utf8', env: Object.assign({}, process.env, { WZD_DATA_DIR: process.env.WZD_DATA_DIR }) });
  assert.strictEqual(r1.status, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /已装包/);
  const r2 = spawnSync(node, [cli], { encoding: 'utf8' });
  assert.strictEqual(r2.status, 2, '不给子命令时打印用法并返回 2');
  assert.match(r2.stdout, /用法/);
});
