# 第三方组件与许可证（THIRD-PARTY NOTICES）

本仓库自身的代码以 MIT 发布（见 `LICENSE`）。下面列出随发行盘一起分发的第三方组件、
它们的许可证，以及我们履行署名/声明义务的方式。

> 判断口径：**只列"我们分发的东西"**。运行时由用户自己 `npm install` 装进来的
> 包（dsh 及其依赖）不是我们分发的，它们的 `LICENSE` 文件由 npm 原样放进
> `node_modules/<pkg>/LICENSE`，随包保留。

## 一、随盘分发的组件

| 组件 | 版本 | 许可证 | 我们分发什么 | 义务与履行方式 |
|---|---|---|---|---|
| **Node.js** | v26.7.0 | MIT（详见其自带 `LICENSE`，含 V8 / OpenSSL / ICU / zlib 等捆绑依赖的许可与版权声明） | `runtime/node/node.exe` + `npm`（**不入 git**，`.gitignore` 里的 `runtime/`） | 原样保留 `runtime/node/LICENSE`（Node 官方文件，已随盘）；不从二进制里剥离任何声明 |
| **Microsoft Edge WebView2 SDK** | 1.0.2903.40 | BSD-3-Clause 风格（Microsoft） | `third_party/webview2/*.dll`（Core / WinForms / WebView2Loader） | 已随仓库保存 `third_party/webview2/LICENSE.txt` 与 `NOTICE.txt`（NuGet 包原文件）；二进制形式再分发时在文档中复现版权与免责声明——即本文件 |
| **WebView2 Runtime** | 系统自带（如 155.x） | Microsoft 专有，随 Windows/Edge 分发 | **不分发** | 只做"检测 + 启动"，不打包、不改动；缺失时回退 `dsh-ui.cmd` |
| **Fluent UI Web Components** | 3.1.3 | MIT | `third_party/fluent/fluent.min.js`（IIFE bundle） | 见 `third_party/fluent/LICENSE`（打包时用 `--legal-comments=none`，许可证注释不在 bundle 内，因此在该文件里复现） |
| **@microsoft/fast-element** | 3.1.2 | MIT | 同上（已打进去） | 同上 |
| **@fluentui/tokens** | 1.0.0-alpha.24 | MIT | `third_party/fluent/fluent-theme.css`（仅令牌取值，不含源码） | 同上 |
| **dsh 官方图标** | — | MIT（deepseek-ai/deepseek-harness） | `assets/app-icon.svg`、`assets/app.ico` | 来源与许可写在 `assets/app-icon.svg` 头部注释；来源仓库 <https://github.com/deepseek-ai/deepseek-harness> |
| **.NET Framework 4.8** | 系统组件 | Microsoft 专有 | **不分发** | 只用系统自带 `csc.exe` 编译、运行时用系统自带 4.8；缺则回退 `dsh-ui.cmd` |

## 二、只在构建期使用（不随盘分发）

| 工具 | 许可证 | 用途 |
|---|---|---|
| esbuild 0.25.10 | MIT | 打包 Fluent bundle（产物已入库，工具本身不随盘） |
| Microsoft Edge / Chrome（无头） | 各自许可 | `tools/launcher/make-icon.js` 把 SVG 栅格化成 ICO（构建期调用本机浏览器） |

## 三、运行期由用户安装、不由我们分发

- `@deepseek-ai/dsh` 及其 npm 依赖树：由 `npm install` 装进 `runtime/agent-A|B/node_modules`。
  每个包自带 `LICENSE`，npm 原样保留；我们不再单独复制或改写。
- pnpm / 插件包（`plugins.js` 走本地 `--prefix` 安装）：同上，许可证随包保留。

## 四、字体

配置页的 `font-family` 只**引用系统已安装字体名**（Segoe UI、微软雅黑、IBM Plex Sans 等），
**没有内嵌任何字体文件**，因此不涉及字体授权分发问题；系统缺字体时自动回退到 `system-ui`。

## 五、更新这份清单的时机

- 升级 WebView2 SDK → 同步替换 `third_party/webview2/LICENSE.txt`、`NOTICE.txt` 与 `VERSION.txt`；
- 重新打 Fluent bundle（改版本）→ 更新 `third_party/fluent/VERSION.txt` 与本表版本号；
- 更换图标来源 → 同步 `assets/app-icon.svg` 头部注释与本表。
