# ADR 0002：桌面端改用 Electron，替掉 WinForms + WebView2

- 状态：已采纳（2026-10）
- 取代：`docs/adr/0001-launcher-shell.md` 里的宿主选择（其余约定继续有效）
- 相关：`AGENTS.md` 第 12 节、`docs/LAUNCHER.md`（历史蓝图）

## 背景

上一版启动器是 WinForms + WebView2 拼出来的单窗口：一个 `Form` 里放一个 WebView2，
只承载配置页。它解决的是「双击看到界面、不落在浏览器里」这一件事，但有三个绕不过去的限制：

1. **只能有一个视图**。用户要求把 **dsh 官方 Web UI 也嵌进来**，两个界面在同一个窗口里切；
   WebView2 侧要做到这一点要自己管多个控件、自己实现标签与状态同步，代码会立刻膨胀。
2. **宿主依赖**。WebView2 Runtime 的版本、`E_NOINTERFACE` 之类的问题都跟宿主状态有关
   （已踩过：SDK 必须钉 1.0.2903.40）。我们承诺「插上就能用」，不该赌宿主装了什么。
3. **跟上游桌面端差一层**。上游 `deepseek-ai/deepseek-harness/apps/desktop` 是 Electron：
   无边框 + `titleBarOverlay`、40px 标题栏、托盘、单实例、签名更新。想「对齐官方桌面端」，
   继续在 WinForms 里手搓等于逆着走。

## 决定

改用 **Electron 44** 做桌面壳，保留 `dsh-ui.cmd` 作为浏览器回退。

- 自带 Chromium + Node：不依赖宿主 .NET / WebView2 / Node（代价是 `runtime/electron` 约 368 MB，构建期下载，不进 git）。
- 三层结构对齐上游：壳（`tools/electron/main.js`）/ 后端（`tools/ui-server.js` + dsh，不改上游）/ 界面（配置页 + dsh 官方 Web UI 两个 `WebContentsView`）。
- 根目录仍然只有 `dsh-to-go.exe`：它是 `tools/launcher/Shim.cs` 编译出来的几百 KB 外壳，
  找到 Electron 就拉起桌面壳，找不到就回退 `dsh-ui.cmd`。
- 视觉改成挂在 dsh 官方设计 token 上（`third_party/dsh-theme/`，钉上游 commit `ce7073d`），
  配置页与 dsh 界面共用一套配色/圆角/动效曲线，深浅色三态（深 / 浅 / 跟随系统）一次改三面。

## 代价与约束

- **体积**：`runtime/` 合计约 540 MB（Node 115 MB + Electron 368 MB）。都不进 git，由 `build.cmd` 现场下载。
- **许可**：Electron(MIT) 与 Chromium 的 `LICENSE` / `LICENSES.chromium.html` **必须随包保留**，
  已登记进 `THIRD-PARTY-NOTICES.md`，并由 `tests/portability-audit.js` 守着。
- **沙箱**：所有视图都 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`；
  页面通过 preload 暴露的最小接口（`dshHost`）通信，不开放 `chrome`（Chromium 已占该只读属性）。
- **令牌**：仍不进 URL。壳用 `onBeforeSendHeaders` 只对 `127.0.0.1:<cfgPort>/*` 注入 `x-config-token`。
- **旧实现不删**：`tools/launcher/DshLauncher.cs` 与 `third_party/webview2/` 留着，作为历史与回退构建参考；
  但新功能只做进 Electron 壳，别再往 WinForms 里加。

## 已知取舍（写明，别当没说过）

- `ui-server` 的 `insertCSS` 在 dsh 视图某些状态下会不 resolve，所以视觉注入统一走「注入 `<style>` 元素」。
- 未安装 dsh 时 `dshView` 也必须有文档（`blank-dsh.html`），否则没有 renderer，`executeJavaScript` 会挂住。
- 拖动窗口时两颗 `blur(64px)` 背景层会拖慢重绘，拖动期间挂 `html.dsh-resizing` 暂停动画与过渡。
