'use strict';
/**
 * portability-audit.js —— 守住"便携"这条线
 *
 * 目的：确保运行期**不依赖宿主机**。做法是扫描代码里所有"宿主机路径 / 系统级副作用"
 * 的写法，只允许白名单里那几处（每处都写明理由），新增一处就失败。
 *
 *   runtime\node\node.exe tests\portability-audit.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_EXT = ['.js'];
const SCAN_DIRS = ['tools', 'src'];
const SCAN_FILES = ['build.cmd', 'dsh-ui.cmd', 'tools/build.ps1'];

// 宿主机痕迹 / 系统级副作用
const PATTERNS = [
  ['homedir', /os\.homedir\s*\(/],
  ['USERPROFILE', /USERPROFILE/],
  ['APPDATA', /(?<![A-Z])APPDATA/],
  ['LOCALAPPDATA', /LOCALAPPDATA/],
  ['ProgramFiles', /Program Files/],
  ['tmpdir', /os\.tmpdir\s*\(/],
  ['registry', /HKEY_|reg\s+add|reg\s+delete|New-ItemProperty|CreateSubKey|SetValue\s*\(/i],
  ['schtasks', /schtasks/i],
  ['netsh', /netsh\s/i],
  ['setx', /\bsetx\b/i],
  ['absDrive', /['"][A-Za-z]:[\\/]/],
];

// 允许的例外：file -> [[pattern, 最多出现次数, 理由]]
const ALLOW = {
  'tools/config.js': [
    ['homedir', 1, '只读检查宿主 ~/.dsh 是否存在（自检报告用，不写入）'],
  ],
  'tools/launch.js': [
    ['tmpdir', 1, '注释里解释 dsh 沙箱为什么默认用宿主临时目录'],
    ['LOCALAPPDATA', 2, 'dsh 子进程的临时目录：Windows ACL 沙箱需要 WRITE_OWNER，宿主 Temp 最稳；可用 runtime\\usb-temp.txt 切回盘内'],
    ['absDrive', 1, 'LOCALAPPDATA 缺失时兜底到 C:\\Windows\\Temp（极老/精简系统）'],
  ],
  'tools/ui-server.js': [
    ['LOCALAPPDATA', 2, 'HOST_TMP 常量：只用于展示临时目录位置与读取拔盘记录（watchdog）'],
    ['absDrive', 1, '仅在 LOCALAPPDATA 缺失时用于文案显示'],
    ['tmpdir', 1, 'LOCALAPPDATA 缺失时的兜底值'],
  ],
  'tools/launcher/make-icon.js': [
    ['ProgramFiles', 3, '构建期调用本机 Edge/Chrome 把 SVG 栅格化（不参与运行期）'],
    ['absDrive', 3, '同上：三个浏览器安装路径'],
    ['tmpdir', 1, '构建期临时目录'],
  ],
};

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.indexOf(path.extname(name)) >= 0) out.push(p);
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
for (const f of SCAN_FILES) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}

const problems = [];
const seen = new Map(); // `${rel}|${pat}` -> count
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  for (const [name, re] of PATTERNS) {
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      const key = rel + '|' + name;
      seen.set(key, (seen.get(key) || 0) + 1);
      const allowed = (ALLOW[rel] || []).find((a) => a[0] === name);
      if (!allowed) {
        problems.push('未登记的宿主机依赖：' + rel + ':' + (i + 1) + ' [' + name + '] ' + line.trim().slice(0, 90));
      }
    });
  }
}

// 次数超限也报（防止"在允许的文件里越写越多"）
for (const [key, count] of seen) {
  const [rel, name] = key.split('|');
  const allowed = (ALLOW[rel] || []).find((a) => a[0] === name);
  if (allowed && count > allowed[1]) {
    problems.push('例外超量：' + rel + ' [' + name + '] 出现 ' + count + ' 次，只允许 ' + allowed[1] + ' 次');
  }
}

// 许可证文件必须齐（分发的第三方组件）
const LICENSE_REQUIRED = [
  ['LICENSE', '本仓库 MIT 许可'],
  ['THIRD-PARTY-NOTICES.md', '第三方组件清单'],
  ['third_party/fluent/LICENSE', 'Fluent UI / FAST（MIT）'],
  ['third_party/webview2/LICENSE.txt', 'WebView2 SDK（BSD-3 风格）'],
  ['third_party/webview2/NOTICE.txt', 'WebView2 SDK 第三方声明'],
  ...(fs.existsSync(path.join(ROOT, 'runtime', 'node'))
    ? [['runtime/node/LICENSE', 'Node.js（含 V8/OpenSSL/ICU 等捆绑依赖声明）']]
    : []),   // runtime/ 不入库：CI 里没有便携 node，就跳过这一条
];
const missing = LICENSE_REQUIRED.filter(([f]) => !fs.existsSync(path.join(ROOT, f)));
for (const [f, why] of missing) problems.push('缺少许可证文件：' + f + '（' + why + '）');

const scanned = files.length;
const allowedCount = [...seen.entries()].reduce((n, [, c]) => n + c, 0);

console.log('  扫描文件：' + scanned + ' 个（tools/ src/ 构建脚本）');
console.log('  命中的宿主机写法：' + allowedCount + ' 处，全部在白名单里：');
const grouped = {};
for (const [key, count] of seen) {
  const [rel, name] = key.split('|');
  grouped[name] = (grouped[name] || 0) + count;
}
for (const name of Object.keys(grouped).sort()) {
  const why = Object.entries(ALLOW)
    .filter(([, list]) => list.some((a) => a[0] === name))
    .map(([rel]) => rel.replace('tools/', ''));
  console.log('    - ' + name.padEnd(14) + grouped[name] + ' 处  (' + why.join(', ') + ')');
}
console.log('  许可证文件：' + (LICENSE_REQUIRED.length - missing.length) + '/' + LICENSE_REQUIRED.length + ' 在位');

if (problems.length) {
  console.log('');
  for (const p of problems) console.log('  FAIL  ' + p);
  console.log('\n  RESULT: FAIL —— 便携性或许可证被破坏');
  process.exit(1);
}
console.log('\n  RESULT: PASS —— 运行期不写宿主、依赖不依赖宿主，许可证齐备');
