# AGENTS.md —— 给下一位（人或 AI）的交接说明

本文件是这个仓库的**项目级记忆**：记录「已经验证过的事实」「踩过的坑」「约定」，避免下一个人从头摸。
凡是这里写了「实测／已验证」的，都真跑过；写「未验证」的，别当成结论。

---

## 1. 这是什么

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（命令 `dsh`）做成**插上就能用、拔下来什么都不留**的便携 Agent：

- 运行环境（便携 Node）与 dsh 本体都装在盘上，宿主不用装 Node/npm；
- 所有状态（会话、工作区、配置、密钥）都在盘上，跟着盘走；
- 宿主零污染：只用**进程内环境变量**，从不 `setx`，从不写宿主家目录；
- 密钥以密文存盘，口令不落盘、只在启动瞬间进内存；
- A/B 双槽升级：装到空闲槽 → 自检 → 才切指针，随时回滚。

**本项目不是 dsh 的 fork**：不打包、不改写它的代码，构建时从 npm 现装。dsh 的所有权与许可是 DeepSeek AI 的（MIT）；本仓库只提供便携化外壳与运维工具，同样是 MIT。

## 2. 约定（改代码前先读）

1. **网页向导是唯一入口**：`dsh-ui.cmd` 起本地页面（首次向导 + 概览 / 站点和模型 / 升级 / 诊断 / 插件）。
   **根目录只放 `dsh-ui.cmd` 和 `build.cmd`**——其余命令行工具一律进 `tools\rescue\`（应急用），新脚本也别往根目录加。命令行工具保留作备用，但**新功能优先做进页面**。
2. **站点表是唯一事实来源**：`data\sites.json`。`data\site-patch.yml` 是由它生成的覆盖层；`data\site.json` 是旧格式，只在读取时兼容、不再写入。旧的 `/api/site` 接口已下线（返回 410），别加回来。
3. **密钥三条红线**：不明文落盘、不进命令行参数、不进日志。口令只存在服务进程内存（`/api/login` 之后），启动 dsh 时经**子进程环境变量**传给启动器。
4. **上游文件不要碰**：`data\profiles\*\cordis.patch.yml` 永远归 dsh 与其 Web UI 所有；我们的配置一律走自己的覆盖层（`--patch`）。
5. **页面零外链**：单文件 `ui/app.html`，不引 CDN／外链字体（离线盘会挂）。颜色与字体用页面顶部的 CSS 变量。
6. **编码**：`.cmd` 必须纯 ASCII（cmd.exe 用系统 ANSI 解析 .bat，UTF-8 中文会破坏括号配对）；`.ps1` 含中文必须存 **UTF-8 with BOM**（Windows PowerShell 5.1 只认带 BOM 的）。
7. **删除类操作要有前置条件**：删密钥库必须显式确认 + 再验口令；删站点时「是否连密钥一起删」单独问一次。
8. **面向玩家的界面不暴露内部实现**：这条界面全部是给运维/使用者看的，但日志与界面文案要区分开——细节进日志。

## 3. 目录

```
build.cmd / build.ps1     一次性构建：下载并校验便携 Node，然后打开图形向导（-Cli 走命令行双槽安装）
dsh-ui.cmd                图形向导与主页面（本地服务，127.0.0.1）—— 根目录只有它和 build.cmd
tools\rescue\          应急脚本目录（图形页/服务出问题时才用；改这几个脚本要注意它们靠 %~dp0..\.. 找仓库根目录）
  tools\rescue\dsh.cmd                 起 dsh 自己的 Web UI（绕过我们的服务，对照用）
  tools\rescue\dsh-config.cmd          终端维护台（自检/升级/切槽/备份/密钥/站点）
  tools\rescue\dsh-cli.cmd             命令行用法（--version、headless "任务"）
  tools\rescue\dsh-doctor.cmd          一键自检
tools/
  launch.js               启动器：解锁密钥 → 组环境 → 注入覆盖层 → 起 dsh
  sites.js                多站点表 + 覆盖层生成 + /models 探测
  secret.js               密钥层（v2 多站点密钥库 + verifier + 旧格式迁移）
  jobs.js                 后台任务引擎（锁、增量日志、状态机、取消/中断识别）
  install.js              双槽安装器（npm 装、双源回退）
  ui-server.js            本地页面服务（登录会话、dsh 启停、任务、站点、版本列表、模型缓存、插件目录/市场、自检）
  plugins.js              插件层（条目解析与启停、pnpm 环境、已装包、catalog 卡片目录）
  market.js               插件市场数据层（抓取/瘦身/缓存/搜索排序分页）
  compat.js               插件与本槽 dsh 的兼容性判定（peerDependencies 比对本槽实际版本）
  watchdog.js             拔盘守护（哨兵 + 丢盘判定 + 宿主记录）
  config.js / site.js     维护台与旧单站点工具（site.js 仅保留 dump/migrate 等）
ui/app.html               单文件页面（零外链）
tests/                    node --test 单测
docs/                     DESIGN（设计取舍）/ USAGE（使用）/ ROADMAP（计划与审查记录）
runtime/ data/ secrets/ backups/   运行产物，**不进 git**
```

## 4. 已验证的技术事实（别推翻，除非你重新验证）

- **dsh 配置字段**（`llm-pi-ai` 提供方，模型条目）：
  `apiKeyEnv` / `api` / `baseURL` / `compat` / `models: [{ id, input, contextWindow, maxTokens, name, reasoningEfforts, compat }]`。
  - **`input: [text, image]` 才是「支持图片」的正确写法**（不是 `image:`）；
  - **`contextWindow` 必须是 ≥1 的整数**，不写就是用 dsh 默认值（界面里显示为 auto）；
  - 两者都可用 `null`。
  依据：`dsh --dump-config-schema` 打出的官方 schema（`contextWindow`/`maxTokens` = `integer, minimum 1`），以及 headless 实测——写成 `0` 时 dsh 当场报
  `ValidationError: $.providers.<站点>.models[0].contextWindow expected number >= 1 but got 0`。
- **`--dump-config` 只拼配置树、不校验深层字段**（非法值也退出码 0）。要验证字段是否真被识别，必须让它**挂载**，例如
  `dsh --profile headless --patch <file> "你好"`。
- **参数顺序**：`--patch <file>` 必须跟在 profile/命令之后（`--profile web --patch f …`）；裸的 `--patch f web` 会被 dsh 拒绝。
- **端口冲突不会自动换端口**：dsh 直接 `EADDRINUSE` 退出。本盘默认 3180（宿主自装的 dsh 默认 3080，可共存；浏览器 cookie 按 host+port 分，所以别共用端口）。
- **旧密钥格式兼容**：`secrets\model-key.enc`（单密钥）+ `secrets\key-name.txt` 会被自动读；启动器会用旧文件补齐 v2 库里缺的站点，所以**升级工具后现有密钥不会突然失效**。迁移到 v2（多站点）在页面上一键完成，需要用户口令。
- **旧站点配置兼容**：`data\site.json`（单站点）会被读成多站点结构，重新生成的覆盖层里站点不会丢。
- **版本列表**：从 npm registry 取（官方源 → npmmirror 自动回退，5 分钟缓存）。`latest`/`next`/`alpha` 三条标签并存，界面只让用户点选，也留手动输入。
- **目录体积很贵**：遍历整棵 `runtime\` 上万个文件要 2～3 秒（慢盘更久）。已做 60 秒内存缓存 + `runtime\sizes.json` 落盘缓存（首次先用上次的值、后台重算）。别把 `dirSize()` 直接放回热路径。
- **模型列表可缓存**：探测结果按站点存 `data\probe-cache.json`（带 baseURL/协议与时间戳，站点地址或协议改了自动失效），页面打开站点时直接用缓存，不必每次重新拉取。

- **拔盘守护**（`tools\watchdog.js`）：哨兵 `runtime\.drive-id` 存 JSON（id / root / created），
  每 3 秒读一次（`WZD_DRIVE_POLL_MS` 可调），连续 3 次（`WZD_DRIVE_MISSES` 可调）读不到就判定丢盘。
  判定只有三种：读不到、id 变了（换盘）、内容坏了——**坏内容不能当「盘还在」**，宁停不跑。
  丢盘记录只能写宿主临时目录：`lossLogPath()` 会把「落在被监视盘上」的宿主目录改写出去，否则写了等于没写。
  判定后的退出码是约定的：`launch.js` = 3、`ui-server.js` = 4（是「盘没了」，不是崩溃，排障别当异常）。

## 5. 怎么验（每次改完至少跑这些）

```bat
runtime\node\node.exe --test tests\sites.test.js tests\secret.test.js tests\launch.test.js tests\jobs.test.js
```

- 单测覆盖：站点表与覆盖层生成、密钥库（含「损坏库拒写」「缺 verifier 拒重建」「单条坏掉的部分解密」「写锁」）、任务引擎（锁、取消竞态、阶段识别）、安装器参数校验、版本比较器。
- 改页面（`ui/app.html`）后至少确认：无令牌打开 403；带 `?token=` 能开；未登录时写操作 401；自检能出表格；保存站点后覆盖层里能看到 provider；新增模型后填的上下文/视觉确实出现在覆盖层里。
- 改动涉及 dsh 配置字段时，**用真实 dsh 验一遍**（见第 4 节的反向对照），不要只靠「dump 没报错」。
- 真安装 / 真启动是慢验证（首次装一个槽 5～12 分钟），不要把「构建成功」说成「业务跑通」。

## 6. 已知坑（都踩过）

| 现象 | 原因 / 处理 |
|---|---|
| `sandbox-local … temp grant materialization failed` | Windows ACL 沙箱要在 `os.tmpdir()` 下写安全描述符，需要目录的 `WRITE_OWNER`；数据盘根目录通常没有。启动器默认把临时目录放宿主 `%LOCALAPPDATA%\Temp`。 |
| 中文提示乱码 / 截断 | `.cmd` 保持纯 ASCII，中文放 `tools\msg\*.txt`（UTF-8）由 `tools\say.cmd` 打印；`.ps1` 存 UTF-8 with BOM。 |
| 页面卡在「加载中」 | `/api/state` 要算目录体积（上万个文件）。已缓存（见第 4 节）。 |
| 密钥框里出现一串 `*` | 那是「已保存密钥长度」的占位提示，不是真密钥；留空即不修改。服务端也拒绝把纯星号当密钥存。 |
| 首次启动时站点配置不生效 | 启动器必须**先刷新覆盖层、再决定 `--patch` 参数**——顺序反了会导致「站点已配但覆盖层文件还没生成」的那次启动不带 `--patch`。 |
| 宿主上也装了 dsh，互相打架 | 共享端口、浏览器 cookie 与 PATH/模块解析。启动器无条件覆盖 `DSH_HOME`/`DSH_AGENTS_HOME`/`npm_config_cache`，且从不碰宿主的 `~/.agents`。 |

## 7. 还没做的

- 把较重的端到端验收脚本（页面接口 + 运行期 DOM 桩检查 + 插件页的运行时验证）整理进仓库（目前是外部一次性脚本）。
- 上游 dsh 仍是 developer preview：版本之间可能不兼容，所以才有 A/B 双槽；升级流程永远是「装空闲槽 → 校验 → 才切指针」。
- 插件「发现」这一环只能靠 npm 关键词搜索 + 用户自己判断（dsh 没有官方索引；npm 上的 dsh 相关包多数是 dsh 本体的内部包，而不是可独立安装的插件）。

## 8. 插件（启停 / 安装 / 卸载）

图形页「插件」分区是**卡片视图**：一个插件一张卡片（图标 / 名称 / 作者 / 适配版本 / 简介 / 启用停用 / 详细 / 删除），
分「官方插件」（活动槽里的 `@deepseek-ai/*`，不能删，只能停用条目）与「第三方插件」（profile 里的包，可停用可删除）两块，
各有一个显示开关（状态存 `data\ui-prefs.json`，跟盘走）。另有「插件市场」子页签，接社区索引（见本节末尾的事实）。

- **条目启停**：卡片上的开关对应 dsh 配置树里的条目（含官方默认停用的、官方按条件控制的），勾掉即停用。状态写在我们的覆盖层里（`data\site-patch.yml`，随 `--patch` 传给 dsh），**重启 dsh 生效**。
  - ⚠️ 停用错了条目 dsh 会**启动失败**并列出「等待某个服务的插件」（例如停用 `webserver` 会让 web-runtime 等 4 个插件起不来）。页面会提示这一点。
  - ⚠️ `dsh --dump-config` **不体现**覆盖层里的 `disabled` —— 想确认停用是否生效，要看 dsh 的启动输出，别拿 dump 当证据。
- **安装 / 卸载**：按 npm 包名装卸，实际执行 `dsh plugin --profile web add|remove <包名>`（它把参数转给 profile 目录里的 pnpm）。
  - **需要 pnpm**：便携包默认不带。页面上点一次「准备 pnpm」就会装到本盘（`runtime\pnpm`，约几 MB，需要联网；store 也落在盘上，不碰宿主）。
  - ⚠️ **pnpm 要按大版本并存**（踩过：用户报「无法删除插件，退出码 1」）。profile 里 `node_modules\.modules.yaml` 记着**当初是谁装的**（`packageManager: pnpm@12.11.2`）和它的 store 位置；
    pnpm **跨大版本共用 store 会直接拒活**（`ERR_PNPM_UNEXPECTED_STORE`），所有装卸/删除都失败，页面「重新读取」当然也没用（不是读错，是 pnpm 层不干活）。
    所以：盘上按大版本各装一份（`runtime\pnpm` 给默认大版本 10，其他版本用 `runtime\pnpm-<major>`），操作某个 profile 前先用 `profileStore(profile)` 读出它需要的大版本与 store，
    再挑对应那份 pnpm、把 `npm_config_store_dir` 指到它记录的 store **父目录**（`.modules.yaml` 里记的是带 `\v11` 布局后缀的完整路径，环境变量要的是它上一级）。
    大版本的启动方式也不同：pnpm 10 是 `bin/pnpm.cjs`（用 node 跑），pnpm 12 是原生 `pnpm.exe`——用 `pnpmCmd(major)` 拿 {cmd,args}，别写死。
    另外 `.modules.yaml` **名字叫 yaml，内容其实是 JSON**（带缩进、键带引号）——按 JSON 解析，别按行正则。
  - ⚠️ **pnpm 12 默认有「新包冷却」**（`minimumReleaseAge` 24 小时）：lockfile 里只要有 24 小时内发布的包，**连普通删除都会被拦**（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，解析时会核对整份 lockfile）。
    这是供应链安全策略，我们**不偷偷关**：插件页给一个默认关闭的开关，勾上才按 `--config.minimumReleaseAge=0` 跑（存 `ui-prefs.json`）。
    任务失败时页面会读日志里的真实错误码，把这两种拦路虎翻译成人话（见 `jobFailHint()`）。
  - **版本闸门**：插件的 `peerDependencies` 与当前 dsh 版本不匹配时 dsh 直接拒绝安装，并打印一条「接受风险」的命令。想装就得显式豁免（页面「插件」分区里那个折叠起来的危险入口）；dsh 的警告是认真的——可能崩、可能丢数据。
  - **发现**：dsh 没有官方插件索引，npm 上也不带统一标记。页面提供「在 npm 里搜一搜」，搜到后**请自行确认**这个包是不是 dsh 插件。

命令行等价物（不用图形页时）：

```bat
runtime\node\node.exe tools\plugins.js list        :: 列条目（跑一遍 dump，几秒）
runtime\node\node.exe tools\plugins.js installed   :: 列出已装的插件包
runtime\node\node.exe tools\plugins.js search dsh  :: 在 npm 里按关键词搜
runtime\node\node.exe tools\plugins.js setup-pnpm  :: 把 pnpm 装到本盘
```



- **插件市场的数据源**：`https://awesome-dsh-plugin.com/plugins.json`（社区索引，2026-10 时 4489 个、4.69 MB）。
  它给的是**社区插件**：不含 dsh 自带的官方插件，也**没有「适配 dsh 版本」字段**——那一项是我们自己算的（见下）。
  每个条目带现成的 `install` 命令，**照抄它**（有 `github:作者/仓库`、`tgz` 链接的，自己拼不出来）；名字里有 `#` 的是 monorepo 子目录
  （如 `archify#integrations/deepseek-harness`），别当成包名。抓取要用浏览器 UA（无 UA 会被挡），缓存落盘 `data\market.json`（精简后约 3.9 MB，24 小时 TTL）。
- **官方插件 = 活动槽里的 `@deepseek-ai/*`**（299 个包，其中 175 个在配置里有条目）。profile 的 `node_modules` 里只有第三方包；
  profile 的 `package.json` 的 `dsh.profile.bundles` 只有两个基础包，**别拿它当官方插件清单**。
- **「适配版本」怎么算的**：拿插件的 `peerDependencies`（`@deepseek-ai/*` 那些）比对本槽 `node_modules` 里的实际版本，
  用**槽里自带的 semver**（与 dsh 的兼容闸门同一套判定），`{includePrerelease: true}`（生态里区间本身就带 alpha/rc）。
  拿不到 semver 时退回 `tools\compat.js` 的近似匹配，并在结果里标 `how: "approx"`，不假装精确。
  近似匹配有一条容易写错：区间里带预发布时，上界要收成 `<upper>-0`（`^0.1.2-alpha.1` 不接受 `0.2.0-rc.1`）。
- 界面偏好（插件页的显示开关）存 `data\ui-prefs.json`，跟盘走；`GET/POST /api/prefs`，POST 不需要解锁（只存显示开关，不碰密钥）。
- 接口：`/api/plugins/catalog`（175 张官方卡片 + 第三方卡片，30 秒缓存）、`/api/market`（服务端搜索/排序/分页）、
  `/api/market/item?compat=1`（联网查 npm 元信息 + 算适配）、`/api/market/refresh`（要解锁）、`/api/prefs`。
  「安装」从市场点：页面只送插件名，**安装目标由服务端从索引的 `install` 字段解析**（`market.installSpecOf`），再用 `validInstallSpec` 校验。

## 9. 拔盘守护（动这几类文件前必读）

- 守护在 `tools\watchdog.js`，接入点是两处：`launch.js`（dsh 的直接父进程，丢盘时杀子树退出 3）
  与 `ui-server.js`（长命的后端，丢盘时取消任务 + 杀 dsh 子树 + 退出 4）。**新增会持有子进程/长任务的入口时，同样要接一次。**
- 哨兵 `runtime\.drive-id` 跟着盘走（不是 `data\`，也不算用户数据）。删它 = 触发守护。
- 丢盘记录写宿主：`%LOCALAPPDATA%\Temp\dsh-to-go\drive-lost.json`（只留最近 8 条）。
  这是「不碰宿主」规则的一个明确例外——盘都没了，只能写宿主；除此之外仍然不许往宿主写任何东西。
- **一次真拔盘会留下两条记录**：`ui-server` 与 `launch.js` 各自都有守护，谁先判定是竞态（谁先谁后都正常，别当 bug）。
  页面横幅显示的是最后一条，两条的意思一样（都是「盘没了」）。
- 页面上的体现：概览顶部横幅（`#banner`）+ 诊断页「拔盘守护」卡片 + `/api/drive-lost/clear`（要解锁）。

## 10. 界面改动约定（UI 相关改动前先读）

界面是**单文件** `ui\app.html`（样式 + 结构 + 脚本都在一起，零外链）。改之前记住四条：

1. **动效用 token，不要写死时长**：`--t-fast:120ms / --t:180ms / --t-slow:260ms` 配两条曲线
   `--e-out`（进入，减速）/ `--e-in`（离开，加速，比进入快）。动画只动 `transform`/`opacity`，
   不要动 `width`/`height`（会重排）。
2. **加载要有骨架屏**：面板加载时用 `skeleton(id, 行数)` 占住版面并自动标 `aria-busy="true"`，
   读完调 `busyDone(id)`。别只留一行「加载中…」（会让版面跳、也看不出在读什么）。
3. **错误必须给下一步**：失败提示用 `flashAction(id, 文案, 'err'|'warn', {label, fn})` 带一个恢复动作
   （重试 / 装匹配的 pnpm / 放宽并重试…）。只报「退出码 1」等于把问题丢回给用户。
   插件类失败要**读日志里的真实错误码**再翻译（`jobFailHint()`），别猜。
4. ⚠️ **`@media (prefers-reduced-motion: reduce)` 那一行不许当补丁锚点**：它必须留着（尊重系统设置）。
   重构时把它替换掉过一次，现在运行期核查里有断言守着（`page-runtime-check.js`）。
5. **主视图只说人话，实现细节进「详情」折叠**：路径、文件名、`.yml/.json`、内部条目 id（如 `agent-default-model`）、
   pnpm 旗标这类东西，用 `more('详情', '…')` 收进默认收起的 `<details class="more">`（或 HTML 里直接写 `<details class="more">`）。
   面板标题行、卡片正文里不许出现 `runtime\`、`data\`、`C:\…` 这种路径——**运行期核查会拦**。
6. **数字与时间不许各写各的**：数字走 `fmtNum()`（大数加千分位、缺值统一「—」），时间走 `fmtWhen()`
   （主视图给相对时间，绝对时间放 `title`）。别在模板里直接拼裸数字。
7. **术语固定**：站点的「槽」写作槽位/活动槽/空闲槽；第三方插件的目录在文案里叫**插件目录**（不写 `profile`，
   命令示例里的 `--profile web` 是原样照抄，不算）；「条目」= dsh 配置树里的开关，一个插件可能带多个条目。

验证界面改动的最小集：`page-check.js`（静态：语法/元素 id/接口/无外链）+ `page-runtime-check.js`
（真起服务，把内联脚本放进 DOM 桩里跑真实接口数据）+ `tests/run-all.js`。

## 11. 提交约定

**`main` 只接受 PR 合入的提交**，不直接往上推。理由很实际：直接推 main 的次数一多，历史就没法读了——说不清哪个提交对应哪件事，也说不清某个改动当时是怎么验的。

工作流（标准三步）：

1. **从最新的 `main` 开短命分支**，名字用 `<类型>/<一句话>`，一个分支只做一件事，合完即删：
   `feat/plugin-page`、`fix/drive-watch-race`、`docs/commit-convention`、`chore/rescue-dir`
2. **提交信息按 Conventional Commits 写**：一句话标题，正文说「为什么」和「怎么验的」。

   ```
   fix(watchdog): 丢盘判定改成连续 3 次读不到都算

   单次读失败在 USB 上太常见（供电抖动也会），1 次就停会误杀正在跑的会话。
   验收：tests/watchdog.test.js 15 项全绿；drive-pull-e2e 真起 dsh 后删哨兵，
   ui-server 2.6 秒后退出码 4、dsh 端口关闭、无残留进程。
   ```

   类型：`feat` 新功能 · `fix` 修 bug · `docs` 文档 · `refactor` 重构（不改行为）· `test` 测试 · `chore` 杂务（依赖/目录/脚本）· `perf` 性能。
   破坏性变更在类型后加 `!`，正文写 `BREAKING CHANGE: ...`。
   标题与分支名用**英文前缀 + 中文描述**（跟现有历史一致），别混着来。
3. **开 PR 合入 `main`**。PR 描述写清三件事：改了什么 / 为什么 / **怎么验的**（跑了哪些测试、有没有真机验证）。
   小改动用 squash 合并，保持 `main` 线性；合完删分支。

**合并前的最低门槛**（这些必须写进 PR 描述；没跑就别说跑了）：

| 门槛 | 什么时候需要 | 跑法 |
|---|---|---|
| 单测全绿 | 每次都 | `runtime/node/node.exe tests/run-all.js` |
| 页面静态核查 | 动了 `ui/app.html` | 页面核查脚本：内联脚本语法 / 元素 id / 调用的接口是否都存在 |
| 真机端到端 | 动了守护、槽位、安装、插件、密钥 | 对应的 e2e，且必须**真起进程**；不能用「构建成功」代替 |

- **例外只有一种**：纯错别字、链接修正可以直接改 `main`。除此之外一律走 PR——包括我自己改。
- **`main` 已开分支保护**：非管理员必须走 PR 才能合入；仓库所有者保留绕过能力，就是给上面那条「错别字例外」用的。强制推送、删除 `main` 都是关的，并要求线性历史（只收 squash / rebase）。
- 行为变更（改了流程/API/页面/退出码）同步更新 `docs/ROADMAP.md` 的记录表。
- 运行产物（`runtime/`、`data/`、`secrets/`、`backups/`、`*.enc`）已在 `.gitignore` 里，**不要**为了「方便复现」提交它们。
