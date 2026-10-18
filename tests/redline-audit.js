#!/usr/bin/env node
'use strict';
/*
 * redline-audit.js — 「启动器不泄露任何密钥/口令」红线审计（可重复运行，零第三方依赖）
 *
 * 用法:
 *   node tests/redline-audit.js --sentinel <哨兵字符串> [--json] [--verbose]
 *                               [--skip-processes] [--max-files N]
 *
 * 做什么:
 *   把 <哨兵字符串> 当成「一旦落盘就是泄露」的标记，在下列位置查找其明文出现:
 *     - data/logs/**            （启动器日志）
 *     - data/*.json / *.yml / *.yaml（data 根下的配置）
 *     - data/.webview/**        （WebView2 用户数据目录）
 *     - data/jobs/**            （补充：作业落盘文件）
 *     - secrets/*               （仅明文文本类文件；*.enc / *.key 等加密件不解密、不误报）
 *     - <repo>/*.exe            （启动器成品二进制，按 utf8 + utf-16le 两种编码找）
 *     - 当前进程表 CommandLine  （PowerShell Get-CimInstance Win32_Process）
 *
 * 退出码: 0 = 干净, 1 = 有命中（红线被踩）, 2 = 用法/环境错误
 *
 * 安全约定:
 *   - 输出里哨兵本身永远被替换为 ***，避免把泄露内容再抄进终端/CI 日志。
 *   - 自身进程与祖先进程会被跳过（否则 `--sentinel X` 自己就会命中自己），跳过数量如实报告。
 *   - 非 UTF-8 内容用 latin1 兜底；二进制里可能的 UTF-16LE 明文会被额外扫一遍；永不因解码抛异常崩掉。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 8 * 1024 * 1024,
  contextChars: 40,
  maxHitsPerFile: 50,
  maxTotalHits: 2000,
  maxFilesListedInJson: 500,
};

// ---- 明文文件白名单（secrets/ 只查这些，绝不尝试解密） ----
const PLAINTEXT_EXTS = new Set([
  '.txt', '.json', '.yml', '.yaml', '.md', '.log', '.csv', '.ini', '.cfg',
  '.conf', '.xml', '.properties', '.env', '', '.bak', '.old',
]);
const ENCRYPTED_EXTS = new Set(['.enc', '.key', '.bin', '.db', '.sqlite', '.pem', '.p12', '.pfx']);

const USAGE = `redline-audit — 密钥/口令泄露红线审计

用法:
  node tests/redline-audit.js --sentinel <哨兵字符串> [选项]

参数:
  --sentinel <s>     必填。要查找的哨兵字符串（真实的 API key / 口令，或等长的假哨兵）。
                     长度至少 4；建议 >= 8 以免误报。哨兵本身不会出现在任何输出里。
  --json             输出机器可读 JSON（供 CI 断言；哨兵只以 sha256 前缀出现）
  --verbose          逐条列出被扫描的文件
  --skip-processes   跳过进程命令行扫描（CI/无 PowerShell 环境用）
  --max-files <N>    扫描文件数上限，默认 ${LIMITS.maxFiles}
  --help, -h         显示本帮助

扫描位置:
  data/logs/**            data/*.json|*.yml|*.yaml     data/.webview/**
  data/jobs/**            secrets/*（仅明文）           <repo>/*.exe
  进程表 CommandLine（PowerShell Get-CimInstance Win32_Process）

限制:
  单文件最多读 ${LIMITS.maxFileBytes / 1024 / 1024}MB，超过则跳过并记入 skipped；最多 ${LIMITS.maxFiles} 个文件。

退出码:
  0 干净    1 有命中（红线被踩）    2 用法/环境错误

示例:
  node tests/redline-audit.js --sentinel SENTINEL-REDLINE-7F3A9B-DO-NOT-SHIP
  node tests/redline-audit.js --sentinel "$KEK" --json > audit.json
`;

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = {
    sentinel: null, json: false, verbose: false, skipProcesses: false,
    maxFiles: LIMITS.maxFiles, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--skip-processes') opts.skipProcesses = true;
    else if (a === '--sentinel') {
      const v = argv[++i];
      if (v === undefined) { opts.error = '--sentinel 缺少取值，用法：--sentinel <哨兵字符串>'; return opts; }
      opts.sentinel = v;
    } else if (a.startsWith('--sentinel=')) {
      opts.sentinel = a.slice('--sentinel='.length);
    } else if (a === '--max-files') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) { opts.error = `--max-files 需要一个正整数，收到: ${JSON.stringify(v)}`; return opts; }
      opts.maxFiles = n;
    } else if (a.startsWith('--max-files=')) {
      const n = Number(a.slice('--max-files='.length));
      if (!Number.isInteger(n) || n <= 0) { opts.error = '--max-files 需要一个正整数'; return opts; }
      opts.maxFiles = n;
    } else {
      opts.error = `未知参数: ${a}`;
      return opts;
    }
  }
  if (opts.help) return opts;
  if (opts.sentinel === null || opts.sentinel === undefined) {
    opts.error = '缺少必填参数 --sentinel <哨兵字符串>';
  } else if (opts.sentinel.length === 0) {
    opts.error = '--sentinel 不能为空字符串（空串会命中一切）';
  } else if (opts.sentinel.length < 4) {
    opts.error = `--sentinel 太短（${opts.sentinel.length} 字符），至少 4 字符以免误报`;
  }
  return opts;
}

// ---------------------------------------------------------------- decode
/**
 * 解码一个 buffer，永不抛异常。
 * 优先严格 UTF-8；失败则 latin1 兜底。若内容看起来像 UTF-16（含 NUL），额外给一份 utf16le 解读。
 */
function decodeVariants(buf) {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  const variants = [];
  let primary;
  try {
    primary = new TextDecoder('utf-8', { fatal: true }).decode(b);
    variants.push({ text: primary, decoder: 'utf8' });
  } catch {
    primary = b.toString('latin1');
    variants.push({ text: primary, decoder: 'latin1' });
  }
  // UTF-16LE 明文（Windows 二进制/日志/资源段常见）单独再扫一遍
  if (b.includes(0x00)) {
    const u16 = b.toString('utf16le');
    if (u16.indexOf('\u0000') === -1 || true) variants.push({ text: u16, decoder: 'utf-16le' });
  }
  return variants;
}

function sanitize(s) {
  // 把不可打印/换行压平成一行，便于终端与 JSON
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '.')
    .replace(/\s+/g, ' ');
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

function makeRedactor(sentinel) {
  const parts = [sentinel];
  if (sentinel.toLowerCase() !== sentinel) parts.push(sentinel.toLowerCase());
  if (sentinel.toUpperCase() !== sentinel) parts.push(sentinel.toUpperCase());
  return (s) => {
    let out = String(s);
    for (const p of parts) out = out.split(p).join('***');
    return out;
  };
}

function findOccurrences(text, sentinel, limit) {
  const out = [];
  let idx = text.indexOf(sentinel);
  while (idx !== -1 && out.length < limit) {
    out.push(idx);
    idx = text.indexOf(sentinel, idx + sentinel.length);
  }
  return out;
}

// ---------------------------------------------------------------- walk
function listFiles(dir, out, stats, depth = 0) {
  if (depth > 24) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { listFiles(full, out, stats, depth + 1); continue; }
    if (!e.isFile()) continue;
    out.push(full);
    if (out.length >= LIMITS.maxFiles) { stats.truncated = true; return; }
  }
}

function listFlat(dir, exts) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (exts && !exts.includes(path.extname(e.name).toLowerCase())) continue;
    out.push(path.join(dir, e.name));
  }
  return out;
}

// ---------------------------------------------------------------- processes
function queryProcesses() {
  const ps = [
    '$ErrorActionPreference="Stop";',
    '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine |',
    'ConvertTo-Json -Compress -Depth 3',
  ].join(' ');
  let raw;
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // 退一步试 wmic（老系统/受限环境）
    try {
      raw = execFileSync('wmic', ['process', 'get', 'ProcessId,ParentProcessId,Name,CommandLine', '/format:csv'], {
        encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      });
      return { ok: true, via: 'wmic', list: parseWmic(raw) };
    } catch (err2) {
      return { ok: false, via: 'none', error: String((err && err.message) || err), list: [] };
    }
  }
  let parsed;
  try { parsed = JSON.parse(raw.trim() || '[]'); }
  catch (e) { return { ok: false, via: 'powershell', error: `JSON 解析失败: ${e.message}`, list: [] }; }
  if (!Array.isArray(parsed)) parsed = parsed ? [parsed] : [];
  return {
    ok: true, via: 'powershell',
    list: parsed.map((p) => ({
      pid: p.ProcessId, ppid: p.ParentProcessId,
      name: p.Name || '', cmd: p.CommandLine || '',
    })),
  };
}

function parseWmic(raw) {
  const lines = String(raw).split(/\r?\n/).filter((l) => l.trim() && !/^Node,/i.test(l));
  const head = String(raw).split(/\r?\n/).find((l) => /^Node,/i.test(l));
  if (!head) return [];
  const cols = head.split(',');
  return lines.map((l) => {
    const parts = l.split(',');
    const o = {};
    cols.forEach((c, i) => { o[c.trim()] = parts[i]; });
    return {
      pid: Number(o.ProcessId), ppid: Number(o.ParentProcessId),
      name: o.Name || '', cmd: parts.slice(cols.length - 1).join(',') || o.CommandLine || '',
    };
  });
}

/** 自身 + 祖先链：这些进程的 CommandLine 里必然带着 `--sentinel X`，跳过否则永远自命中。 */
function selfPidChain(list) {
  const byPid = new Map(list.map((p) => [Number(p.pid), p]));
  const chain = new Set();
  let pid = process.pid;
  for (let i = 0; i < 12; i++) {
    chain.add(pid);
    const p = byPid.get(pid);
    if (!p || !p.ppid || p.ppid === pid) break;
    pid = Number(p.ppid);
  }
  return chain;
}

// ---------------------------------------------------------------- targets
function buildTargets() {
  return [
    { id: 'data/logs/**', kind: 'tree', dir: path.join(ROOT, 'data', 'logs') },
    { id: 'data/*.json|yml', kind: 'flat', dir: path.join(ROOT, 'data'), exts: ['.json', '.yml', '.yaml'] },
    { id: 'data/.webview/**', kind: 'tree', dir: path.join(ROOT, 'data', '.webview') },
    { id: 'data/jobs/**', kind: 'tree', dir: path.join(ROOT, 'data', 'jobs') },
    { id: 'secrets/*(明文)', kind: 'plaintext', dir: path.join(ROOT, 'secrets') },
    { id: '*.exe(根)', kind: 'flat', dir: ROOT, exts: ['.exe'] },
  ];
}

function filesForTarget(t, stats) {
  if (t.kind === 'tree') {
    const out = [];
    listFiles(t.dir, out, stats);
    return out;
  }
  if (t.kind === 'flat') return listFlat(t.dir, t.exts);
  if (t.kind === 'plaintext') {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(t.dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ENCRYPTED_EXTS.has(ext)) continue;           // 加密件：不解密、不误报
      if (!PLAINTEXT_EXTS.has(ext)) continue;          // 未知类型不碰
      out.push(path.join(t.dir, e.name));
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------- main
function main(argv) {
  const opts = parseArgs(argv);

  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.error) {
    process.stderr.write(`redline-audit: ${opts.error}\n\n` + USAGE);
    return 2;
  }

  const started = Date.now();
  const redact = makeRedactor(opts.sentinel);
  const sentinelSha = crypto.createHash('sha256').update(opts.sentinel, 'utf8').digest('hex').slice(0, 12);
  const hits = [];
  const perTarget = [];
  const skipped = [];
  const walkStats = { truncated: false };
  let filesScanned = 0;
  let bytesRead = 0;

  const targets = buildTargets();
  for (const t of targets) {
    const tStat = { target: t.id, dir: path.relative(ROOT, t.dir) || '.', exists: fs.existsSync(t.dir), files: 0, hits: 0, skipped: 0 };
    if (!tStat.exists) { tStat.note = '目录/路径不存在（跳过）'; perTarget.push(tStat); continue; }

    const files = filesForTarget(t, walkStats);
    for (const file of files) {
      if (filesScanned >= opts.maxFiles) { tStat.note = `达到 --max-files 上限 ${opts.maxFiles}`; break; }
      let st;
      try { st = fs.statSync(file); } catch { tStat.skipped++; continue; }
      const rel = path.relative(ROOT, file) || file;
      if (st.size > LIMITS.maxFileBytes) {
        tStat.skipped++;
        skipped.push({ path: rel, reason: `超过 ${LIMITS.maxFileBytes / 1024 / 1024}MB（${st.size} 字节）` });
        continue;
      }
      let buf;
      try { buf = fs.readFileSync(file); } catch (e) {
        tStat.skipped++;
        skipped.push({ path: rel, reason: `读取失败: ${e.code || e.message}` });
        continue;
      }
      filesScanned++;
      bytesRead += buf.length;
      tStat.files++;
      if (opts.verbose) process.stderr.write(`  scan ${rel} (${buf.length}B)\n`);

      let variants;
      try { variants = decodeVariants(buf); } catch { variants = [{ text: buf.toString('latin1'), decoder: 'latin1' }]; }

      const seen = new Set();
      let fileHits = 0;
      for (const v of variants) {
        let idxs;
        try { idxs = findOccurrences(v.text, opts.sentinel, LIMITS.maxHitsPerFile); } catch { continue; }
        if (!idxs.length) continue;
        const starts = lineStartsOf(v.text);
        for (const idx of idxs) {
          if (fileHits >= LIMITS.maxHitsPerFile || hits.length >= LIMITS.maxTotalHits) break;
          const { line, column } = lineColOf(starts, idx);
          const key = `${line}:${column}`;
          if (seen.has(key)) continue;           // 同一位置被多种解码重复命中只报一次
          seen.add(key);
          const from = Math.max(0, idx - LIMITS.contextChars);
          const to = Math.min(v.text.length, idx + opts.sentinel.length + LIMITS.contextChars);
          hits.push({
            source: 'file',
            target: t.id,
            path: rel,
            line,
            column,
            decoder: v.decoder,
            context: redact(sanitize(v.text.slice(from, to))),
          });
          fileHits++;
          tStat.hits++;
        }
      }
    }
    perTarget.push(tStat);
  }

  // ---- 进程命令行 ----
  const procStat = { target: 'process CommandLine', files: 0, hits: 0, skipped: 0, via: null };
  if (opts.skipProcesses) {
    procStat.note = '按 --skip-processes 跳过';
  } else {
    const q = queryProcesses();
    procStat.via = q.via;
    if (!q.ok) {
      procStat.note = `进程表不可读（${q.error}）→ 此位置未覆盖`;
      skipped.push({ path: '<进程表>', reason: procStat.note });
    } else {
      const chain = selfPidChain(q.list);
      for (const p of q.list) {
        if (chain.has(Number(p.pid))) { procStat.skipped++; continue; }
        procStat.files++;
        if (!p.cmd) continue;
        const idxs = findOccurrences(p.cmd, opts.sentinel, 5);
        if (!idxs.length) continue;
        for (const idx of idxs) {
          const from = Math.max(0, idx - LIMITS.contextChars);
          const to = Math.min(p.cmd.length, idx + opts.sentinel.length + LIMITS.contextChars);
          hits.push({
            source: 'process',
            target: 'process CommandLine',
            path: `pid=${p.pid} ${p.name}`,
            line: 1,
            column: idx + 1,
            decoder: 'utf16-in-memory',
            context: redact(sanitize(p.cmd.slice(from, to))),
          });
          procStat.hits++;
        }
      }
    }
  }
  perTarget.push(procStat);

  const ok = hits.length === 0;
  const summary = {
    filesScanned,
    dirsWalked: perTarget.length,
    bytesRead,
    hits: hits.length,
    targetsWithHits: perTarget.filter((t) => t.hits > 0).map((t) => t.target),
    processesScanned: procStat.files,
    processesSkippedSelfChain: procStat.skipped,
    filesSkipped: skipped.length,
    maxFilesCap: opts.maxFiles,
    walkTruncated: walkStats.truncated,
    durationMs: Date.now() - started,
  };

  if (opts.json) {
    const payload = {
      tool: 'redline-audit',
      version: 1,
      ok,
      exitCode: ok ? 0 : 1,
      root: ROOT,
      sentinel: { redacted: true, length: opts.sentinel.length, sha256_12: sentinelSha },
      summary,
      targets: perTarget,
      hits,
      skipped: skipped.slice(0, LIMITS.maxFilesListedInJson),
      node: process.version,
      generatedAt: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    const L = [];
    L.push('== 红线审计 redline-audit ==');
    L.push(`仓库   : ${ROOT}`);
    L.push(`哨兵   : 长度 ${opts.sentinel.length} / sha256:${sentinelSha}（不回显）`);
    L.push(`node   : ${process.version}`);
    L.push('');
    for (const t of perTarget) {
      const tag = t.hits > 0 ? 'FAIL' : (t.target === 'process CommandLine' && t.note ? 'SKIP' : 'ok  ');
      const extra = t.note ? `  ${t.note}` : '';
      L.push(`[${tag}] ${t.target.padEnd(22)} ${String(t.files || 0).padStart(3)} 文件 / ${t.hits} 命中${extra}`);
    }
    if (skipped.length) {
      L.push('');
      L.push(`跳过 ${skipped.length} 项:`);
      for (const s of skipped) L.push(`  - ${s.path} — ${s.reason}`);
    }
    if (hits.length) {
      L.push('');
      L.push(`命中 ${hits.length} 处（红线被踩）:`);
      for (const h of hits) {
        L.push(`  ${h.path}:${h.line}:${h.column}  [${h.decoder}]`);
        L.push(`    …${h.context}…`);
      }
    }
    L.push('');
    L.push(`扫描 ${summary.filesScanned} 文件 / ${(summary.bytesRead / 1024).toFixed(1)}KB / 进程 ${summary.processesScanned}（跳过自身链 ${summary.processesSkippedSelfChain}）/ ${summary.durationMs}ms`);
    L.push(ok ? 'RESULT: PASS — 未发现哨兵明文' : `RESULT: FAIL — ${hits.length} 处哨兵明文泄露`);
    process.stdout.write(L.join('\n') + '\n');
  }

  return ok ? 0 : 1;
}

if (require.main === module) {
  let code = 2;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`redline-audit: 内部错误 ${(err && err.stack) || err}\n`);
    code = 2;
  }
  process.exit(code);
}

module.exports = { main, decodeVariants, findOccurrences, parseArgs };
