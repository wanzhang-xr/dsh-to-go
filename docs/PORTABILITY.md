# 便携性说明：运行期到底碰了宿主机的哪些地方

结论先说：**除了 dsh 子进程的临时目录（默认在宿主 `%LOCALAPPDATA%\Temp`，可切回盘内）之外，
运行期的所有读写都落在这块盘上**；不写注册表、不写系统/用户环境变量、不装服务与计划任务、
不建开始菜单/桌面快捷方式、不往 `Program Files` 写东西。

这份文档由 `tests/portability-audit.js` 守着：新增一处"宿主机写法"就会红灯。

## 一、盘内写入点（换台机器拷走这块盘，这些全跟着走）

| 路径 | 内容 | 何时产生 |
|---|---|---|
| `data/ui-prefs.json` | 主题 / 背景 / 主色 / 动效 / 插件视图偏好 | 页面里改外观时 |
| `data/npm-source.json` | npm 下载源偏好（自动 / 官方 / 镜像 / 自定义） | 升级页保存源时 |
| `data/window.json` | 窗口大小与位置 | 关窗时 |
| `data/npmrc` | **盘内 npm 配置**（要私有源/代理写这里；不读宿主 `~/.npmrc`） | 首次调用 npm 时自动生成空文件 |
| `data/sites.json` + `secrets/keys.enc` | 站点与密钥（AES-256-GCM，口令只在服务进程内存里） | 页面里配置站点时 |
| `data/jobs/` | 任务记录与日志（安装 / 升级 / 插件） | 每次跑任务 |
| `data/logs/` | `launcher.log`、`ui-server.log`（只记令牌长度，不记令牌） | 运行期持续 |
| `data/.webview/` | WebView2 用户数据（cookie/缓存/GPU 缓存） | 启动器开窗口时 |
| `data/cache/resources/` | dsh 资源缓存（`DSH_RESOURCE_CACHE`） | dsh 运行时 |
| `backups/*.zip` | 升级前的 `data/` 备份（已排除 `.webview`） | 升级前 |
| `runtime/agent-A\|B/` | 两个槽位里 `npm install` 出来的 dsh | 安装 / 升级 |
| `runtime/npm-cache/` | npm 缓存（可离线重装） | 安装 / 升级 |
| `runtime/npm-global/` | `npm_config_prefix` 指向这里（不碰宿主的全局包） | 安装 / 升级 |
| `runtime/current.txt`、`runtime/port.txt` | 当前活动槽、端口 | 切槽 / 改端口 |
| `runtime/usb-temp.txt` | 存在时表示"临时目录用盘内"（见下） | 手动创建 |

## 二、宿主侧：只读 + 唯一例外

**只读检查（不写）**

- `~/.dsh` 是否存在 —— 只是自检报告里的一句提示（`tools/config.js` doctor）。
- 宿主 `DSH_HOME` / `DSH_AGENTS_HOME` / `npm_config_*` 环境变量 —— 只读，用来警告"机器上的 dsh 会跟着这块盘走"。
- WebView2 运行时版本、磁盘剩余空间 —— 系统查询，不落盘。

**唯一例外：dsh 子进程的临时目录**

`tools/launch.js` 的 `tempRoot()` 默认把 `TEMP`/`TMP` 指向宿主 `%LOCALAPPDATA%\Temp`。
原因不是偷懒：dsh 的 Windows ACL 沙箱会在临时目录里建私有目录并写**完整性标签**，
这一步需要 `WRITE_OWNER`；可移动盘的根目录 ACL 往往只给登录用户 `Modify`，
在那种盘上会以 Win32 5 (ACCESS_DENIED) 失败，直接让整个 workspace-write 策略罢工。

- 想强行用盘内：在盘上建 `runtime\usb-temp.txt`（前提是这块盘的 ACL 给了你 `WRITE_OWNER`）。
  页面「诊断」里会显示当前用的是哪一种，并提示风险。
- 这里产生的只是 dsh 的**临时文件**，进程退出即清理；不含任何持久配置或凭据。

## 三、npm 的隔离

| 项 | 指向 | 为什么要管 |
|---|---|---|
| `npm_config_cache` | `runtime/npm-cache` | 缓存留在盘上，换机可离线重装 |
| `npm_config_prefix` | `runtime/npm-global` | 不往宿主全局目录装包 |
| `npm_config_userconfig` | `data/npmrc` | **不读宿主 `~/.npmrc`**（宿主的 registry/代理/token 不会悄悄生效） |
| `npm_config_store_dir`（pnpm） | 盘内 | 插件安装不进宿主 store |

覆盖到的调用方：`tools/launch.js`（dsh 子进程环境）、`tools/config.js`（升级）、
`tools/install.js`（安装）、`tools/jobs.js`、`tools/plugins.js`（pnpm）、`tools/site.js`。
实现集中在 `tools/npmrc.js`，只有一处，改起来不会漏。

## 四、我们明确"不做"的事（已用扫描守住）

- 写注册表（`HKCU`/`HKLM`、`CreateSubKey`、`New-ItemProperty`）
- `setx` 写用户/系统环境变量
- `schtasks` 计划任务、`netsh` 防火墙规则、系统服务
- 在 `Program Files`、`%APPDATA%`、桌面/开始菜单写任何东西
- 把令牌写进 URL（启动器路径）、窗口标题、命令行参数、日志

## 五、怎么自己验

```bat
:: 1) 便携自检（会逐项列出：盘、node、槽位、缓存、数据、密钥、端口、宿主环境变量、宿主 ~/.dsh）
runtime\node\node.exe tools\config.js doctor

:: 2) 便携性/许可证守卫（新增宿主机写法会 FAIL）
runtime\node\node.exe tests\portability-audit.js
```

换机实测建议：把整块盘拷到另一台机器 → 跑一遍 `doctor`（应全 OK / 无"宿主环境变量泄漏"）
→ 启动 `dsh-to-go.exe` → 关掉后看宿主 `%USERPROFILE%\.dsh`、`%APPDATA%`、`%LOCALAPPDATA%`
里有没有多出 `dsh` 相关目录（预期：没有；只可能有 `%LOCALAPPDATA%\Temp` 下的临时文件）。

## 六、许可证

随盘分发的第三方组件、它们的许可证与我们履行义务的方式，统一列在
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。要点：

- Node.js（MIT，含 V8/OpenSSL/ICU 等声明）—— 原样保留 `runtime/node/LICENSE`
- WebView2 SDK（BSD-3 风格）—— `third_party/webview2/LICENSE.txt` + `NOTICE.txt`
- Fluent UI Web Components / FAST（MIT）—— `third_party/fluent/LICENSE`
- dsh 官方图标（MIT）—— 来源与许可见 `assets/app-icon.svg` 头部注释
- WebView2 **运行时**与 **.NET Framework 4.8** 都是系统组件，**不分发**
