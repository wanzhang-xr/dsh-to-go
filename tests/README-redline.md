# 红线审计脚本（tests/redline-audit.js + tests/page-check.js）

两个**只读、可重复运行、零第三方依赖**的脚本，用来给「启动器不泄露任何密钥」这条红线做机器验收。
都不进 `run-all.js`（那个只跑 `*.test.js`），需要单独调用。

用仓库自带 node 跑（不要用系统 node）：

```bash
cd dsh-to-go
./runtime/node/node.exe tests/redline-audit.js --sentinel "$KEK"
./runtime/node/node.exe tests/page-check.js
```

---

## 1. redline-audit.js — 哨兵泄露扫描

```bash
node tests/redline-audit.js --sentinel <哨兵字符串> [--json] [--verbose] [--skip-processes] [--max-files N]
```

把哨兵（真实 key/口令，或等长假哨兵）当成「一落盘就是泄露」的标记，扫这些位置：

| 位置 | 说明 |
|---|---|
| `data/logs/**` | 启动器日志 |
| `data/*.json` `*.yml` `*.yaml` | data 根下配置 |
| `data/.webview/**` | WebView2 用户数据（LevelDB/缓存/History） |
| `data/jobs/**` | 作业落盘（补充覆盖） |
| `secrets/*` | **仅明文文本类**；`*.enc`/`*.key`/`*.db` 跳过，绝不尝试解密 |
| `<repo>/*.exe` | 启动器成品二进制 |
| 进程表 CommandLine | `Get-CimInstance Win32_Process`，失败回退 `wmic` |

**退出码**：`0` 干净 · `1` 有命中 · `2` 用法/环境错误。

行为要点：

- 命中时打印 `路径:行:列` + 前后 40 字符上下文，**哨兵本身一律替换成 `***`**，不会把泄露内容再抄一遍到终端/CI 日志；`--json` 里哨兵只以 `length` + `sha256_12` 出现，可据此比对两次运行是否同一哨兵而不泄露值。
- 跳过的项**如实列出**（超过 8MB、读失败、目录不存在、进程表不可读），不会静默当作「干净」。
- 编码：严格 UTF-8 优先，失败用 latin1 兜底；含 NUL 的文件额外按 UTF-16LE 再扫一遍（Windows 二进制/资源的常见形态），永不因解码抛异常。
- 自身进程 + 祖先进程链被跳过（否则 `--sentinel X` 自己就命中自己），跳过的进程数打在汇总里。

### 自测（每次改脚本后照做一遍）

```bash
S=SENTINEL-REDLINE-7F3A9B-DO-NOT-SHIP
printf 'x api_key=%s y\n' "$S" > data/logs/__probe.log
node tests/redline-audit.js --sentinel "$S"   # 必须 exit=1 且打印 *** 而非哨兵
rm -f data/logs/__probe.log
node tests/redline-audit.js --sentinel "$S"   # 必须 exit=0
```

## 2. page-check.js — 配置页静态核查

```bash
node tests/page-check.js [ui/app.html] [--json] [--strict-url]
```

| 检查项 | 判定 |
|---|---|
| `external-urls` | 只允许 `127.0.0.1` / `localhost` / `[::1]`；**注释里的说明性 URL 也算 FAIL**；`placeholder` 示例文案算 WARN（`--strict-url` 升级为 FAIL）；`xmlns="http://www.w3.org/..."` 属命名空间标识符，永不发请求，仅计数不计入判定 |
| `external-assets` | 字面外部 `<script src>` / `<link rel=stylesheet>` / `<iframe src>` / `@import` / `url()` → FAIL；运行时拼出的 `' + esc(x) + '` → WARN（页面侧无法静态判定，须靠 WebView2 `NavigationStarting` 只放行 `127.0.0.1:<port>` 兜底） |
| `reduced-motion` | 必须存在 `@media (prefers-reduced-motion: reduce)` |
| `skeleton` | 必须存在 `aria-busy` 或 `skeleton(` |
| `token-bridge` | 必须存在 `dsh.token.request` 或 `dsh.token`（缺失 = 令牌桥未落地） |
| `no-cred-persistence` *(adv)* | 用了 `localStorage`/`sessionStorage`/`indexedDB` 就 WARN，要求人工确认不含密钥 |
| `clipboard-scope` *(adv)* | 用了 `navigator.clipboard` 就 WARN，要求人工确认只写命令/地址 |

**退出码**：`0` 全 PASS（WARN 不算失败）· `1` 有 FAIL · `2` 用法/读文件错误。

advisory 项只提示不影响退出码——它们是「页面行为」而非「页面文本」，静态检查只能起提醒作用，真正的边界在 WebView2 设置和宿主。

## 已知未覆盖（写报告时请如实带上）

- 进程**内存**（口令只在 node 服务进程内存里，内存扫描不在本脚本范围）。
- Windows 事件日志、Prefetch、回收站、`%TEMP%` 之外的系统级落盘。
- `secrets/*.enc` 解密后的内容（脚本刻意不解密）。
- `<port>` 的实际取值与 `NavigationStarting` 白名单逻辑（属启动器代码，不在页面）。
- WebView2 用户目录里 > 8MB 的文件（会列进 skipped，不静默放过）。
