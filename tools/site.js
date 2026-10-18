'use strict';
/**
 * Configure a non-official (third-party / relay / self-hosted gateway) model site
 * for the portable DeepSeek Harness.
 *
 * Where the config lives: an overlay document this tool owns completely,
 *
 *   data\site-patch.yml          (one `- id: llm-pi-ai` entry)
 *
 * which the launcher passes to dsh as `--patch <file>`. dsh documents `--patch` as
 * "an extra patch-list overlay applied after the profile layer", so the provider
 * lands in the composed tree while `data\profiles\web\cordis.patch.yml` stays
 * entirely owned by dsh and its Web UI.
 *
 * Earlier versions wrote a marked block *into* the profile patch. That was fragile:
 * dsh appends its own entries to the end of that array, i.e. before any trailing
 * comment, so a later re-run would have swallowed the Web UI's settings as part of
 * the managed region. stripFromProfilePatch() removes that legacy block (and only
 * that block) so this file can be adopted without losing anything else.
 *
 *   node tools/site.js set      interactive setup
 *   node tools/site.js show     print the current site config
 *   node tools/site.js clear    remove it (overlay + legacy block)
 *   node tools/site.js dump     run `dsh --patch <overlay> --dump-config` and show the provider
 *   node tools/site.js migrate  rewrite the overlay from data\site.json and clean the legacy block
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const secretLib = require('./secret.js');
const { ask, close: closeRL } = require('./ask.js');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PROFILE = 'web';
const OVERLAY = path.join(DATA, 'site-patch.yml');
const PROFILE_PATCH = path.join(DATA, 'profiles', PROFILE, 'cordis.patch.yml');
const STATE = path.join(DATA, 'site.json');
const NODE_EXE = path.join(ROOT, 'runtime', 'node', 'node.exe');

// Legacy markers: migration only, never written any more.
const MARK_START = '# ==== site:start （由 tools/site.js 管理：块内手动修改会被覆盖） ====';
const MARK_END = '# ==== site:end ====';
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return null; }
}

function buildOverlay(s) {
  const L = [];
  L.push('# 站点覆盖层：整份文件归 tools/site.js（或图形配置页）所有。');
  L.push('# 启动器会把它作为 --patch 传给 dsh，优先级高于 profile patch。');
  L.push('# 要改内容请用维护台 7) 站点/模型，或 8) 站点查看 → c 清除后重配。');
  L.push('- id: llm-pi-ai');
  L.push('  config:');
  L.push('    providers:');
  L.push('      ' + s.id + ':');
  L.push('        apiKeyEnv: ' + s.keyEnv);
  L.push('        api: ' + s.api);
  L.push('        baseURL: ' + s.baseURL);
  if (s.compat) {
    L.push('        compat:');
    if (s.compat.supportsDeveloperRole === false) L.push('          supportsDeveloperRole: false');
    if (s.compat.maxTokensField) L.push('          maxTokensField: ' + s.compat.maxTokensField);
  }
  if (s.reasoning) L.push('        reasoning: ' + s.reasoning);
  L.push('        models:');
  for (const m of s.models) {
    L.push('          - id: ' + m.id);
    if (m.image) L.push('            input: [text, image]');
  }
  return L.join('\n') + '\n';
}

/** Split a patch document into top-level blocks; a new block starts at a `- id:` line. */
function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^- id:/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      blocks.push([line]);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Remove the legacy marked comment lines and any `llm-pi-ai` entry carrying our
 * provider id from the profile patch, keeping every other entry verbatim (the Web
 * UI's ui-settings-general / agent-default-model / ui-theme included).
 * @returns how many lines were dropped
 */
function stripFromProfilePatch(providerId) {
  if (!fs.existsSync(PROFILE_PATCH)) return 0;
  const before = fs.readFileSync(PROFILE_PATCH, 'utf8');
  let dropped = 0;
  const kept = [];
  for (const block of splitBlocks(before)) {
    // Marker comment lines are removed in place. They must never take a
    // neighbouring entry down with them: dsh appends its own entries to the end
    // of the array, i.e. just above a trailing comment, so that comment can end
    // up inside the block of a real entry.
    const filtered = block.filter((l) => {
      const t = l.trim();
      if (t === MARK_START || t === MARK_END) { dropped++; return false; }
      return true;
    });
    if (!filtered.length) continue;
    if (filtered[0].trim() === '- id: llm-pi-ai') {
      const text = filtered.join('\n');
      const ours = providerId ? text.includes('\n      ' + providerId + ':') : text.includes('providers:');
      if (ours) { dropped += filtered.length; continue; }
    }
    kept.push(...filtered);
  }
  if (!dropped) return 0;
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  fs.writeFileSync(PROFILE_PATCH, out.endsWith('\n') ? out : out + '\n', 'utf8');
  return dropped;
}

function writeOverlay(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OVERLAY, buildOverlay(s), 'utf8');
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', 'utf8');
  return stripFromProfilePatch(s.id);
}

function clearBlock() {
  let removed = 0;
  if (fs.existsSync(OVERLAY)) { fs.unlinkSync(OVERLAY); removed++; }
  const st = readState();
  const cleaned = stripFromProfilePatch(st ? st.id : undefined);
  try { fs.unlinkSync(STATE); } catch (e) { /* nothing to remove */ }
  if (!removed && !cleaned) { console.log('  没有站点配置需要清除。'); return 0; }
  console.log('  已清除站点配置：覆盖文件' + (removed ? '已删除' : '本来就没有') +
    (cleaned ? '，profile patch 里清理了 ' + cleaned + ' 行旧块' : '') + '。');
  console.log('  你的 Web UI 设置（主题／默认模型等）不受影响。');
  return 0;
}

function dshArgs(extra) {
  const slot = fs.readFileSync(path.join(ROOT, 'runtime', 'current.txt'), 'utf8').trim();
  const bin = path.join(ROOT, 'runtime', slot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const args = [bin, '--profile', PROFILE];
  if (fs.existsSync(OVERLAY)) args.push('--patch', OVERLAY);
  return args.concat(extra || []);
}

function dumpConfig() {
  const args = dshArgs(['--dump-config']);
  if (!fs.existsSync(args[0])) { console.log('  活动槽里没有 dsh：' + args[0]); return 1; }
  const r = spawnSync(NODE_EXE, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      DSH_HOME: DATA,
      DSH_AGENTS_HOME: path.join(DATA, 'agents'),
      npm_config_cache: path.join(ROOT, 'runtime', 'npm-cache'),
      ...require('./npmrc.js').apply({}),
    }),
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0) {
    console.log('  dsh --dump-config 失败（退出码 ' + r.status + '）：');
    console.log(out.split('\n').slice(0, 25).join('\n'));
    return 1;
  }
  const st = readState();
  const needle = st ? st.id : null;
  const lines = out.split('\n');
  console.log('  dsh --dump-config 组合成功，共 ' + lines.length + ' 行。');
  if (needle) {
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => l.includes(needle) || l.includes('baseURL'));
    const first = hits.length ? Math.max(0, hits[0][1] - 2) : 0;
    console.log('  与本站点相关的行：');
    console.log(lines.slice(first, first + 18).map((l) => '    ' + l).join('\n'));
  }
  return 0;
}

async function cmdSet() {
  console.log('');
  console.log('  配置非官方站点（中转站 / 网关 / 自建服务）');
  console.log('  只写端点与模型清单，落在 data\\site-patch.yml；密钥请用 5) key 单独存。');
  console.log('');

  const prev = readState();
  const id = await ask('  站点 ID（小写字母/数字/连字符，例如 my-gateway）' + (prev ? ' [' + prev.id + ']' : '') + ': ') || (prev ? prev.id : '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { console.log('  站点 ID 不合法，已取消。'); return 1; }

  const baseURL = await ask('  接口地址（含 /v1，例如 https://api.example.com/v1）' + (prev ? ' [' + prev.baseURL + ']' : '') + ': ') || (prev ? prev.baseURL : '');
  if (!/^https?:\/\//.test(baseURL)) { console.log('  地址必须以 http:// 或 https:// 开头，已取消。'); return 1; }

  const p = await ask('  协议 1) OpenAI Chat Completions  2) OpenAI Responses  3) Anthropic Messages  [1]: ');
  const api = PROTOCOLS[['', '1', '2', '3'].indexOf(p) - 1] || (prev ? prev.api : 'openai-completions');

  const keyEnv = await ask('  密钥环境变量名（要与 5) key 里存的一致）[' + (prev ? prev.keyEnv : 'GATEWAY_API_KEY') + ']: ') || (prev ? prev.keyEnv : 'GATEWAY_API_KEY');

  const modelsRaw = await ask('  模型 ID，逗号分隔（图片模型写成 名字?image）' + (prev ? ' [' + prev.models.map((m) => m.id + (m.image ? '?image' : '')).join(', ') + ']' : '') + ': ')
    || (prev ? prev.models.map((m) => m.id + (m.image ? '?image' : '')).join(', ') : '');
  const models = modelsRaw.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [mid, flag] = x.split('?');
    return { id: mid.trim(), image: (flag || '').trim() === 'image' };
  });
  if (!models.length) { console.log('  至少要写一个模型 ID，已取消。'); return 1; }

  const compatAns = await ask('  网关要求兼容修正吗？（拒绝 role:developer / 只认 max_tokens）推荐 Y [Y/n]: ');
  const compat = /^n/i.test(compatAns) ? null : { supportsDeveloperRole: false, maxTokensField: 'max_tokens' };

  const state = { id, baseURL, api, keyEnv, models, compat, updated: new Date().toISOString() };
  const cleaned = writeOverlay(state);

  console.log('');
  console.log('  覆盖文件已写入：' + OVERLAY);
  if (cleaned) console.log('  顺手清理了旧版写在 profile patch 里的块（' + cleaned + ' 行），你的 UI 设置保留。');
  console.log('  密钥变量名（以站点表 keyEnv 为准，不再写全局 key-name.txt）：' + keyEnv + '（secrets\\key-name.txt）');
  if (fs.existsSync(secretLib.secretFile())) {
    console.log('  已存在加密密钥：不用重新输入，启动时会按新变量名 ' + keyEnv + ' 注入。');
  } else {
    console.log('  还没有存密钥：先按下面第 1 步存一次，变量名会自动用 ' + keyEnv + '。');
  }
  console.log('');
  console.log('  下一步：');
  console.log('   1) 维护台 5) key 存密钥（已有密钥可跳过）');
  console.log('   2) 验收：node tools\\site.js dump');
  console.log('   3) 启动 dsh.cmd → 设置 → 模型，选中 ' + (models[0] ? models[0].id : '刚才的模型 ID'));
  console.log('');
  return 0;
}

function cmdShow() {
  const s = readState();
  console.log('');
  console.log('  覆盖文件     ：' + OVERLAY + (fs.existsSync(OVERLAY) ? '' : '（不存在 → 站点未配置）'));
  console.log('  profile patch：' + PROFILE_PATCH + (fs.existsSync(PROFILE_PATCH) ? '（归 dsh/UI 所有，本工具不再写入）' : '（尚未生成）'));
  if (s) {
    console.log('');
    console.log('  站点 ID  ：' + s.id);
    console.log('  接口地址 ：' + s.baseURL);
    console.log('  协议     ：' + s.api);
    console.log('  密钥变量 ：' + s.keyEnv);
    console.log('  模型     ：' + s.models.map((m) => m.id + (m.image ? '（含图片）' : '')).join(', '));
    console.log('  兼容修正 ：' + (s.compat ? 'supportsDeveloperRole=false, maxTokensField=max_tokens' : '未设置'));
    console.log('  更新时间 ：' + s.updated);
    if (fs.existsSync(OVERLAY)) {
      console.log('');
      console.log('  --- 覆盖文件内容 ---');
      console.log(fs.readFileSync(OVERLAY, 'utf8').split('\n').map((l) => '  ' + l).join('\n'));
    }
  } else {
    console.log('  还没有配置过站点（data\\site.json 不存在）。');
  }
  console.log('');
  return 0;
}

function cmdMigrate() {
  const s = readState();
  if (!s) { console.log('  data\\site.json 不存在，没什么可迁移的。'); return 1; }
  const cleaned = writeOverlay(s);
  console.log('  已按 data\\site.json 重写覆盖文件：' + OVERLAY);
  console.log('  profile patch 清理行数：' + cleaned);
  return 0;
}

async function main() {
  const cmd = (process.argv[2] || 'show').toLowerCase();
  let rc = 0;
  if (cmd === 'set') rc = await cmdSet();
  else if (cmd === 'show') rc = cmdShow();
  else if (cmd === 'clear') rc = clearBlock();
  else if (cmd === 'dump') rc = dumpConfig();
  else if (cmd === 'migrate') rc = cmdMigrate();
  else { console.log('用法：node tools/site.js <set|show|clear|dump|migrate>'); rc = 2; }
  closeRL();
  process.exit(rc);
}

module.exports = {
  cmdSet, cmdShow, clearBlock, dumpConfig, cmdMigrate,
  buildOverlay, writeOverlay, stripFromProfilePatch, splitBlocks,
  OVERLAY, PROFILE_PATCH, STATE, MARK_START, MARK_END,
};
if (require.main === module) main().catch((e) => { console.error('站点配置错误：' + e.message); process.exit(1); });
