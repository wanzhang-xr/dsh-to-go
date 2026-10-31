# dsh-to-go

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）装成一个**插上就能用、拔下来什么都不留**的便携 Agent：所有状态都在 U 盘/移动硬盘上，跟着盘走，随时能升级、能回滚。

> 非官方项目。dsh 由 DeepSeek AI 开发（MIT），本仓库只提供便携化的外壳与运维工具，不修改、不重打包它的代码——构建时从 npm 官方源现装。

---

## 它解决什么问题

| 直接装在机器上 | dsh-to-go |
|---|---|
| 要先有 Node/npm，装完散落各处 | 盘上自带便携 Node，宿主什么都不用装 |
| 写注册表/PATH，换台机器状态就丢 | 只用**进程内**环境变量，绝不 `setx`，拔盘即走 |
| 会话、工作区、缓存留在宿主家目录 | `DSH_HOME` 指向盘上 `data\`，宿主零残留 |
| 密钥明文放在 YAML 里 | 口令派生密钥 + AES-256-GCM 加密，只在启动时解密进内存 |
| 升级出问题回不去 | **A/B 双槽**：装到空闲槽 → 自检通过 → 才切指针；回滚改一行 |
| 用中转/自建网关要手改上游配置 | 站点配置是**独立覆盖层**，由 `--patch` 加载，不碰上游文件 |
| 命令行配置又长又乱 | 浏览器里的**图形向导**：首次设置口令 → 站点与密钥 → 选版本安装 → 启动，之后五个分区管到底 |

## 快速开始

```bat
git clone https://github.com/wanzhang-xr/dsh-to-go.git
cd dsh-to-go
build.cmd        :: 下载并校验便携 Node，然后自动打开图形向导
```

浏览器打开后是一个本地页面（`127.0.0.1`），按向导走完就行：

1. **设置口令** —— 只存在服务进程内存里，同时用它加密站点密钥
2. **添加站点与密钥** —— 站点地址、协议、模型（可从站点拉取列表），密钥写进盘上密文
3. **选择版本安装** —— 后台装进空闲槽，进度与日志实时显示（第一次约 5～12 分钟）
4. **启动 dsh** —— 页面上直接起停，并给一个打开 dsh 界面的按钮

想跳过向导、一路装到底：`build.cmd -Cli`（命令行把两个槽都装好）。

之后日常只用两个入口：

```bat
dsh-to-go.exe    :: 启动器（推荐）：原生窗口里就是配置页，关窗时会问要不要连 dsh 一起停
dsh-ui.cmd       :: 回退入口：本地服务 + 浏览器（启动器打不开时用它）
build.cmd        :: 一次性构建（第一次插盘时用；顺带编译启动器）
```

**要求**：Windows 10/11 x64；2 GB 空闲空间；构建时需要联网。**运行时不要求宿主装 Node。**

想直接塞进 U 盘：把整个仓库目录拷到盘上再跑 `build.cmd`，或者构建完再拷——路径会跟着盘符自动适配（`subst X:` 换盘符也正常，盘符不作为标识）。

## 目录结构

```
dsh-to-go\
├─ dsh-to-go.exe            启动器（构建产物）：原生窗口 + WebView2，日常就双击它
├─ dsh-ui.cmd               回退入口：本地服务 + 浏览器（向导 + 概览 / 站点和模型 / 升级 / 诊断 / 插件）
├─ build.cmd                一次性构建（无依赖引导，顺带编译启动器）
├─ src\                     配置页源目录（head / legacy.css / fluent-overrides.css / partials\* / app.js）
├─ third_party\webview2\    WebView2 SDK（入库，离线可构建）
├─ third_party\fluent\      Fluent UI Web Components 离线 bundle + 深色主题（入库）
├─ tools\launcher\          启动器源码 + build-launcher.cmd
├─ tools\rescue\            应急脚本（图形页/服务出问题时才用）
│   ├─ dsh.cmd              直接起 dsh 自己的 Web UI（不走我们的服务）
│   ├─ dsh-cli.cmd          命令行 / headless 用法
│   ├─ dsh-config.cmd       终端维护台（菜单）
│   └─ dsh-doctor.cmd       一键自检
├─ runtime\                 构建产物（不进 git）
│   ├─ node\                便携 Node
│   ├─ agent-A\ agent-B\    两个 dsh 槽（各有自己的 node_modules）
│   ├─ pnpm\ pnpm-store\    盘上 pnpm（装卸插件用，按需安装）
│   ├─ npm-cache\           盘内 npm 缓存
│   ├─ current.txt          当前活动槽
│   ├─ port.txt             网页端口
│   └─ .drive-id            拔盘守护的哨兵（别删：删了它分不清「被删」和「盘被拔了」）
├─ data\                    DSH_HOME：会话/工作区/配置（不进 git）
├─ secrets\                 AES 加密的密钥文件（不进 git）
├─ backups\                 槽位备份 zip（不进 git）
├─ tools\                   启动器 / 密钥 / 站点 / 维护台 / 构建器
└─ ui\app.html           图形页（单文件，无外链）
```

## 入口

**根目录只有两个脚本**：日常双击 `dsh-ui.cmd`；第一次插盘（或换盘重建）用 `build.cmd`。
其余命令行工具全部收进 `tools\rescue\`，**只在图形页/服务出问题时才需要**（应急用）。

| 入口 | 用途 |
|---|---|
| `dsh-to-go.exe` | **启动器（日常就用它）**：原生窗口里是配置页；没有地址栏；关窗时问一次要不要连 dsh 一起停 |
| `dsh-ui.cmd` | 回退入口：起本地服务并用浏览器打开配置页（启动器缺 .NET/WebView2 时自动走这条） |
| `build.cmd` | 一次性构建：下便携 Node、装 dsh 到 A/B 槽、初始化配置、编译启动器 |
| `tools\rescue\dsh.cmd` | 应急：直接起 dsh 自己的 Web UI（绕过我们的服务，锁端口那类问题用它对照） |
| `tools\rescue\dsh-cli.cmd` | 不打开界面的用法：`tools\rescue\dsh-cli.cmd --version`、`tools\rescue\dsh-cli.cmd headless "改个 bug"` |
| `tools\rescue\dsh-config.cmd` | 终端维护台：自检 / 升级 / 切槽 / 备份 / 密钥 / 站点配置 / 打开图形页 |
| `tools\rescue\dsh-doctor.cmd` | 一键体检：Node、槽位、端口、密钥、站点、残留进程、宿主污染 |

## U 盘被拔走会怎样（拔盘守护）

进程不会因为你拔了盘就自己停：dsh 还在内存里跑，它并不知道 `data\` 已经没了——会话写不回去、任务白跑，等你把盘插回来，看到的还是盘上那份旧状态。**这才是拔盘最真实的损失。**

所以这个包里带了一个拔盘守护：

1. 启动时在盘上写一个哨兵文件 `runtime\.drive-id`（带随机 id 和盘根路径）。
2. 每 3 秒读一次。读不到（盘没了）或者 id 变了（换成另一块盘）都算异常。
3. **连续 3 次**（约 9 秒）都异常 → 判定盘没了，立刻做三件事：
   - 先把一条丢盘记录写到**宿主的临时目录**（盘都没了，写不回盘上）：`%LOCALAPPDATA%\Temp\dsh-to-go\drive-lost.json`；
   - 停掉正在跑的任务、杀掉 dsh 的进程树；
   - 退出本服务（退出码 4；`launch.js` 那条路是 3——是「盘被拔了」，不是崩溃）。
4. 下次打开页面，「概览」顶部会有一条横幅说明上次是被拔盘打断的，记录可以在「诊断 → 拔盘守护」里清除。

间隔和次数可以用环境变量调（进程内 `WZD_DRIVE_POLL_MS` / `WZD_DRIVE_MISSES`，不会写进系统）。
**注意**：守护只能发现「读不到」，发现不了「盘还在但写入失败」（比如半接触不良）——那种情况 dsh 自己会报错。

## 桌面端（原生窗口）

双击 `dsh-to-go.exe` 就是一个应用窗口：里面**同时嵌了配置页和 dsh 官方 Web UI**，两个标签一键切换，
没有地址栏、没有浏览器工具栏。

- **它是怎么起的**：根目录的 `dsh-to-go.exe` 只是个几百 KB 的外壳（`tools/launcher/Shim.cs`，系统自带 `csc.exe` 编译），
  它拉起 `runtime\electron\dist\electron.exe` 跑桌面壳（`tools/electron/`）。壳自己起本地服务（隐藏控制台）、
  挑空闲端口、从输出里抓本次运行的令牌，开窗后**按请求头**把令牌交给配置页。
  **令牌不进地址栏、不进 URL、不进历史、不进窗口标题、不进日志。**
- **界面就是 dsh 的样子**：视觉全部挂在 dsh 官方 Web UI 的设计 token 上（`third_party/dsh-theme/`，
  钉在上游 commit `ce7073d`），配置页与 dsh 界面共用同一套配色、圆角、动效曲线，深色/浅色/跟随系统三态一致。
- **关窗时**三选一：**完全退出**（默认顺带停掉 dsh，可勾「让 dsh 继续在后台运行」）／**最小化到托盘**／**取消**。
  最小化按钮也是收进托盘（`assets/app.ico` 托盘图标：显示窗口 / 收进托盘 / 打开 dsh 界面 / 退出），任务栏不留条目。
- **自定义背景**：可以放一张自己的图（`data\wallpaper\`），配置页和 dsh 界面用的是**同一张**；
  遮罩与模糊可调。选择存 `data\ui-prefs.json`，换盘带走。
- **不泄露密钥**：口令只在页面里输入、只存在服务进程内存；外壳不保存任何凭据（没有「记住口令」）；
  页面只显示密钥长度占位；开发者工具、右键菜单、浏览器快捷键、密码保存、自动填充全部关闭；
  dsh 界面只允许停留在 `127.0.0.1`，外链导航与 `NewWindowRequested` 一律拦下。验收脚本是 `tests/redline-audit.js`。
- **不碰宿主机**：运行期只往盘内写（`data\`、`runtime\`、`backups\`）；不写注册表、不写环境变量、
  不装服务与计划任务。唯一例外是 dsh 子进程的临时目录（默认宿主 `%LOCALAPPDATA%\Temp`，
  因为 ACL 沙箱要 `WRITE_OWNER`），可用 `runtime\usb-temp.txt` 切回盘内。
  细节见 [`docs/PORTABILITY.md`](docs/PORTABILITY.md)，守卫脚本是 `tests/portability-audit.js`。
- **第三方许可证**：随盘分发的 Node.js、**Electron（含 Chromium，必须保留 `LICENSES.chromium.html`）**、
  Fluent UI/FAST、dsh 设计 token 与图标各自的许可与声明集中在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
- **缺东西时**：没有 `runtime\node` → 窗口里显示「请先跑 build.cmd」；没有 `runtime\electron`
  → `dsh-to-go.exe` 自动改走 `dsh-ui.cmd`，用系统浏览器打开配置页，功能不缺，只是没有原生窗口。

## 密钥是怎么保住的

选的是「**盘上放密文，口令不落盘**」的方案：

1. 首次在图形向导里设置口令（命令行则是 `tools\rescue\dsh-config.cmd → 5) key`）：口令不回显、不落盘，只存在服务进程内存里
2. 用 `scrypt` 从口令派生密钥，`aes-256-gcm` 加密后写入 `secrets\keys.enc`——这是**多站点密钥库**，每个站点一条记录
3. 启动时解密，**只注入当前进程环境变量**（`launch.js` 内 `set`，绝不用 `setx`），不写回 `data\`、不进命令行参数、不进日志
4. 每个站点的密钥对应自己的变量名（默认 `<站点ID>_API_KEY`，可在页面里改）——在官方源和中转之间切换只改站点地址，**密钥不用重新输入**
5. 删站点时可以只删站点、保留密钥；删**整个**密钥库必须显式确认再验一次口令（防误删）
6. 密钥库文件若损坏（截断/被改坏），写入会被**拒绝**而不是用空库覆盖——不留"密钥全没了"的静默故障

**换机器/换人用**：口令不对就是解不开，在页面或 `tools\rescue\dsh-config.cmd → 5` 重设即可。**盘丢了**：密文 + 口令双重门槛，比明文 YAML 强得多；但请自行判断口令强度。

## 站点配置（官方 / 中转 / 自建）

dsh 自己的凭据分层是「启动环境 > `.credentials.yaml` > 项目 `.env` > 家目录 `.env`」。本工具走**最高优先级那层**，并额外解决「非官方网关」的问题：

- 站点 ID、接口地址、协议（`openai-completions` / `openai-responses` / `anthropic-messages`）、模型清单、兼容开关（如拒收 `role: developer`、只认 `max_tokens`）
- 每个模型还可以单独声明**上下文窗口**（`contextWindow`，正整数；留空 = 用 dsh 默认值）与**是否支持图片**（`input: [text, image]`）——这两个字段名以 dsh 自己的 schema 为准，界面里填错会被拦下，不会生成非法配置
- 站点表 `data\sites.json` 是**唯一事实来源**（页面/命令行都写它），`data\site-patch.yml` 是由它生成的覆盖层
- 启动时把覆盖层作为 `dsh --patch <file>` 传入——**上游文件 `data\profiles\web\cordis.patch.yml` 完全归 dsh 与它的 Web UI 所有**，本工具不往里写
- 配完可以点「验收」：跑 `--dump-config` 组合一遍，确认站点 provider 真的进了配置树（注意：这一步只拼配置树，不做深层字段校验）

## 图形向导与主页面

`dsh-ui.cmd` 在 `127.0.0.1` 上起一个本地页面（单文件、零外链，离线可用）：

- **首次使用**：设置口令 → 添加站点与密钥 → 选版本安装（后台任务，日志实时刷新）→ 启动 dsh
- **概览**：dsh 启停与打开、状态统计、槽位与回滚、环境占用、密钥与站点摘要、最近任务；两个槽都没装时顶部出现三步向导
- **站点和模型**：多站点可同时启用，每站点独立密钥（**已有密钥时用星号按长度提示**，留空即不修改）；模型用表单添加——「拉取模型」从站点取列表，「添加模型」可点箭头从列表点选（也能直接手输）、支持输入缩小范围，每个模型可设**上下文**（默认 auto，也可填正整数）与**视觉**开关；**拉取过的模型列表会缓存**（跟盘走），下次加模型直接点选，不必重新拉
- **升级**：**版本从列表里选**（实时从 npm 取，标出 latest/next/alpha 与已装槽位），也可切到手动输入；快速升级（装空闲槽 → 自检 → 切指针）或单独指定 A/B 槽版本，进度与日志实时刷新
- **诊断**：自检（解析成表格）、站点配置验收（`--dump-config`）、备份、网页端口、临时目录、启动器日志
- **插件**：分「官方插件」与「第三方插件」两块，一个插件一张卡片（图标 / 名称 / 作者 / 适配版本 / 简介 / 启用停用 / 详细 / 删除）。
  官方插件是随 dsh 装在活动槽里的自带包，**不能删除**、只能停用条目；第三方插件装在 profile 里，可停用、可删除。两块各有一个**显示开关**（状态存在盘上，换机器也跟着走）。
- **插件市场**：接社区索引 [`awesome-dsh-plugin.com`](https://awesome-dsh-plugin.com)（4000+ 个插件，带分类、star、下载量、中英文简介、能力与风险提示、以及现成的安装命令）。
  支持搜索 / 分类 / 排序（star、下载量、收录时间）/ 分页 / 「只看有风险提示的」，点「安装」就照抄索引里的安装命令装到本盘。第一次打开会把这个索引拉到盘上缓存（约 4 MB，之后 24 小时内不再下载）。
- **装之前就知道会不会被拒**：卡片上的「适配版本」不是装饰——它拿插件声明的 `peerDependencies`（对 dsh 内部包的要求）去比对**本槽实际装的版本**，用的就是 dsh 兼容闸门同一套判定（槽里自带的 semver）。结论是「适配本槽」还是「与本槽不匹配、装它要显式豁免」，点开详细能看到逐条依赖的对照表。

安全姿态（浏览器是共享进程，所以按服务来防）：只绑回环；每次启动生成随机令牌，页面必须带 `?token=` 打开、API 必须带 `x-config-token` 头；带外部 `Origin` 的请求直接 403；不发 CORS 头；口令只留在服务进程内存、页面不保存；密钥只在本地请求体里传，进程内加密，不回显、不落日志；所有写操作（密钥 / 任务 / 启停 / 备份）都要求已解锁。

## 已知坑（替你踩过了）

| 现象 | 原因与处理 |
|---|---|
| 第一次双击 `dsh-to-go.exe` 弹出 SmartScreen「已保护你的电脑」 | 没做代码签名（便携包不带证书）。点「更多信息 → 仍要运行」即可。想要彻底消掉只能买代码签名证书。 |
| 双击 exe 没反应，或窗口一闪就没 | 看 `data\logs\launcher.log`：常见原因是这台机器没有 WebView2 运行时（正常 Win10 带 Edge 就有），或 `runtime\node` 还没构建。前者会自动改走 `dsh-ui.cmd`；后者先跑 `build.cmd`。 |
| `sandbox-local … temp grant materialization failed and its cleanup also failed` | Windows ACL 沙箱要在 `os.tmpdir()` 下建私有临时目录并写安全描述符（含完整性标签），这一步需要目录的 `WRITE_OWNER`。数据盘根目录通常只给登录用户 `Modify`（非提升令牌下 `Administrators:(F)` 是 deny-only），于是 `SetNamedSecurityInfoW` 返回 Win32 5。**启动器默认把临时目录放在宿主 `%LOCALAPPDATA%\Temp`**；确实想放盘上，建 `runtime\usb-temp.txt`，并确保那块盘给足 `WRITE_OWNER`。 |
| `error: --profile <name> is required` | dsh 的参数解析不接受「启动器标记 + 裸命令名」的顺序（`--patch f web` 会被拒）。启动器现在把标记插在 profile/命令之后（`--profile web --patch f …`、`web --patch f …` 均可）。 |
| 中文提示在命令行里变乱码/截断 | `cmd.exe` 用系统 ANSI（中文机器是 GBK）解析 `.bat`，UTF-8 中文会破坏行与括号配对。所以所有 `.cmd` 保持**纯 ASCII**，中文提示放在 `tools\msg\*.txt`（UTF-8）里由 `tools\say.cmd` 打印。 |
| 宿主上也装了 dsh，两边互相打架 | 共享的是端口（宿主默认 3080，本盘用 3180）、浏览器 cookie（类型按 host+port 哈希，所以分端口即分登录）与 PATH/模块解析。启动器对 `DSH_HOME`/`DSH_AGENTS_HOME`/`npm_config_cache` 等**无条件覆盖**，并且从不碰宿主的 `C:\Users\<你>\.agents`。 |
| 端口被占就直接起不来 | 实测 dsh 端口冲突时**不会自动换端口**，直接 `EADDRINUSE` 退出。改端口：图形页「诊断」里改，或 `tools\rescue\dsh-config.cmd → 4`。 |
| 升级后想退回去 | 改 `runtime\current.txt` 一行（或维护台 `3) switch`）。两个槽各自独立，随时互切。 |

## 自己构建时都发生了什么

1. `build.cmd` → `tools\build.ps1`：下载官方 Node win-x64 zip（**校验 SHA-256**，失败则中止）、解压成 `runtime\node`；
   用系统自带 `csc.exe` 把 `tools\launcher\Shim.cs` 编成根目录的 `dsh-to-go.exe`（几百 KB 的入口，拉起 Electron）；
   再下 **Electron 运行时**（npm 包约 15 MB + 镜像二进制约 368 MB，落在 `runtime\electron\`，**不入 git**；失败不阻断，
   那样 `dsh-to-go.exe` 会回退到浏览器入口 `dsh-ui.cmd`）；最后**打开图形向导**（`-Cli` 才在命令行把两个槽一次装好）
2. 向导里的「选择版本安装」→ `tools\jobs.js` 起后台任务 → `tools\install.js`：为槽写 `package.json` 并在槽目录里 `npm install --cache=runtime\npm-cache`，官方源失败自动换 npmmirror；然后写 `current.txt`/`port.txt`/`VERSION.txt`
3. 之后所有启动都走 `tools\launch.js`：解锁密钥 → 组装环境 → 注入站点覆盖层 → 起 dsh

更细的设计取舍与验证记录见 [`docs/DESIGN.md`](docs/DESIGN.md)，日常使用说明见 [`docs/USAGE.md`](docs/USAGE.md)。

## 与上游的关系

- dsh 的所有权与许可是 DeepSeek AI 的（MIT）；本仓库不打包、不改写它的代码，构建时从 npm 现装。
- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>。遇到 dsh 本身的功能/协议问题，请以上游为准。
- 本项目只提供「便携化 + 多站点 + 密钥保护 + 双槽升级 + 图形配置」这些外壳能力。

## 贡献

改这个仓库一律走 PR，不直接推 `main`：

- 从最新的 `main` 开短命分支（`feat/...`、`fix/...`、`docs/...`、`chore/...`），一个分支只做一件事，合完即删；
- 提交信息按 Conventional Commits 写（例：`fix(watchdog): 丢盘判定改成连续 3 次都读不到`），正文说清「为什么」和「怎么验的」；
- PR 描述里写清 改了什么 / 为什么 / **怎么验的**；合并前 `runtime/node/node.exe tests/run-all.js` 必须全绿（改了页面就要跑页面核查，改了守护/槽位/安装/插件就要跑对应的真机 e2e）。

「改了哪些东西必须补哪类验证」的门槛表见 [`AGENTS.md`](AGENTS.md) 第 11 节。

仓库已开分支保护：`main` 不接受直接推送（仓库所有者的例外除外），请从自己的分支提 PR。

## 许可

本仓库代码：[MIT](LICENSE)。你可以自由使用、修改、再分发（保留版权声明即可）。dsh 本体仍是 DeepSeek AI 的 MIT 项目。

## 致谢

- DeepSeek AI —— [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- `hermes-portable` —— 便携化思路的早期参考
