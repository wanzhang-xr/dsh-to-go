# third_party/dsh-theme —— 官方 Web UI 的设计 token 层

这里放的是 **DeepSeek Harness 官方 Web UI 的设计变量（design tokens）**，原样复制、未作修改，
目的是让本项目的配置页与桌面壳外观**和官方 Web UI 完全一致**（同一套灰阶、蓝色、圆角、动效曲线）。

## 出处

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/deepseek-ai/deepseek-harness> |
| 提交 | `ce7073d51254c26cd63b22a60835b8f948deb447`（见 `SOURCE.json`） |
| 目录 | `packages/client/ui-theme/src/styles/` |
| 许可 | **MIT**，`Copyright (c) 2026 DeepSeek`（全文见同目录 `LICENSE`） |

## 文件

| 文件 | 作用 |
|---|---|
| `design-platform.css` | 静态调色板（`--dsw-static-*`）+ 语义层（`--dsw-alias-*`）；深色在 `body[data-ds-dark-theme]` 下覆盖 |
| `base.css` | 字体栈、圆角刻度（4/8/12/16/20/28）、动效时长与曲线、代码字体 |
| `corner-shape.css` | 圆角"超椭圆"系数：`--dsw-corner-shape: superellipse(1.5)`（squircle 观感） |
| `scrollbar.css` | 滚动条外观（与官方 Web UI 一致） |
| `focus.css` | 键盘焦点环 |

## 我们怎么用它

`tools/ui-build.js` 按 `design-platform → base → corner-shape → scrollbar → focus` 的顺序内联进
`ui/app.html`，再由 `src/dsh-align.css` 把本项目既有的类名映射到这些变量上；
桌面壳（`tools/electron/shell.html`）引用同一批文件，所以**两处观感同源**。

## 我们**没有**复制什么（避免版权问题）

- **没有**复制任何 React 组件 / TS 源码（`client-ui-*` 的 `.tsx`、`.module.css` 一行都没拿，
  只取变量定义这一层）。
- **没有**打包 Montserrat 字体文件（上游 `brand-font.css` + 3 个 `.woff2`）。
  我们只在品牌字样上**引用字体名**，机器上没装就回退到系统字体——字体本身属于 SIL OFL，
  真要随包分发得连 `Montserrat-OFL.txt` 一起带，本项目暂时不需要。
- **没有**复制图标 sprite / 插画资源。

## 更新方式

上游改了 design token 就照抄一遍，并更新 `SOURCE.json` 里的 `commit` 与 `fetchedAt`，
同时在根目录 `THIRD-PARTY-NOTICES.md` 里改版本号。
