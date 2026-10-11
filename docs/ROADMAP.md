# dsh-to-go 图形化改造蓝图（v2 界面）

目标：把「一个统一的 Web 入口」做成主要的操作面。首次引导之后，版本安装、站点、密钥、模型、升级、插件、诊断全部在浏览器里完成；`.cmd` 只作为备用入口与真正的冷启动引导。

本文档是**每一棒的自包含交接材料**：任何一棒只读本文档 + 相关源码即可开工。

---

## 0. 已冻结的设计决策

| 决定 | 结论 | 原因 |
|---|---|---|
| 口令模型 | 打开配置页时输入一次，**只存在于服务进程内存**，不落盘 | 盘丢了也解不开密钥；不做「记住口令」 |
| 首次引导 | `build.cmd` 只下载并校验便携 Node → 自动打开浏览器 → 其余全部在网页向导里 | 网页服务本身是 Node 程序，没有 Node 就起不了 |
| 插件维护 | 按 **profile**（`data\profiles\<名>`），不是按 A/B 槽：列条目 + 启停（`disabled` 覆盖）+ 安装/卸载（`dsh plugin … `） | A/B 是两套 dsh 代码，共享同一个 `data\`；插件条目挂在 profile 上 |
| 站点语义 | **多站点可同时启用**，每站点一个 provider；每站点独立密钥；变量名自动 `<站点ID>_API_KEY` | 用户拍板：模型列表多来源可接受 |
| 互斥 | dsh 运行中禁止升级/插件/换槽操作（页面明确提示） | 避免半装状态与文件占用 |
| 所有权边界 | `data\profiles\*\cordis.patch.yml` 永远归 dsh 与其 Web UI；我们的东西一律写到自己的覆盖层 | 已经被坑过一次（受管块被夹进 UI 设置里） |

## 1. 事实基础（实测，勿再猜）

- `dsh --profile web --dump-config` 组合出完整配置树；`--patch <file>` 在其后叠加，**同 `id` 的条目互相覆盖**（patch 的 `config` 是**整块替换**）。
- 条目 schema 含 **`disabled`** 字段（布尔或 `!!js` 表达式）→ 停用插件靠它。**已实测**：从 `--patch` 覆盖层写 `disabled: true` 生效，且能与 `config` 覆盖同时写；`--dump-config` 把它打印在 `config` 之后（看输出时别只截前几行）。
- **基础层没有 `providers:` 段**（`--dump-default-config` 里搜不到）→ provider 全部由我们的覆盖层定义，不存在「覆盖掉官方 provider」的风险。
- 一个覆盖层条目里可以放**多个站点**（`config.providers.<id>`），两个站点并存已实测。
- 插件包 = `@deepseek-ai/*`（当前树里 299 个），基础层来自 `dsh.profile.bundles`（`dsh-base`、`dsh-web-app`），每个 bundle 自带 `cordis.patch.yml`。
- `dsh plugin --profile <name> <pnpm 参数>` 把参数转发给 pnpm，作用目录是 profile 目录。
- 参数顺序坑：启动器标记不能放在裸命令名之前（`--patch f web` → `error: --profile <name> is required`）。
- 密钥注入只走**进程内**环境变量（`set`，绝不 `setx`）。
- `data\` 里的可统计状态：`sessions\<工作区>\session-*`、`storages\`、`logs\`、`profiles\`。
- 沙箱临时目录默认放宿主（盘上 ACL 缺 `WRITE_OWNER` 会让 `workspace-write` 失败）。
- **`secrets\key-name.txt` 这个「全局单名覆盖」在多站点下必须废弃**：它会盖掉每把密钥自己记的变量名，导致旧密钥以错误的变量名注入（实测踩到）。变量名的唯一来源是密钥自身的 `key_name`（回落到站点表的 `keyEnv`）。

## 2. 数据与文件布局

```
data\sites.json          多站点定义（本工具的，不是 dsh 的）
data\site-patch.yml      生成出来的覆盖层（N 个 provider + 默认模型 + 插件启停）
data\jobs\<id>.json      后台任务状态（安装/升级/卸载/插件操作）
data\jobs\<id>.log       后台任务日志（增量读取用）
secrets\keys.enc         多站点密钥（单文件、同一口令加密）+ 口令校验器
runtime\{current.txt,port.txt,npm-cache,agent-A,agent-B,node}
```

### sites.json

```json
{
  "version": 1,
  "default": { "siteId": "ibao", "model": "cn:deepseek-v4.1-flash" },
  "sites": [
    {
      "id": "ibao", "name": "朋友的网关", "baseURL": "https://wb2api.ibax.cn/v1",
      "api": "openai-completions", "enabled": true,
      "keyEnv": "IBAO_API_KEY",
      "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" },
      "models": [ { "id": "cn:deepseek-v4.1-flash", "image": false } ],
      "updated": "…"
    }
  ]
}
```

- `id` 唯一，正则 `^[a-z0-9][a-z0-9-]*$`；`keyEnv` 由 `id` 自动推导（大写、非字母数字转 `_`、数字开头补 `_`），可在界面里手动覆盖。
- 同一站点可有多模型，逐模型 `image` 开关（视觉能力）。

### keys.enc

```json
{
  "version": 2, "algo": "aes-256-gcm", "kdf": "scrypt", "kdf_params": { "N": 16384, "r": 8, "p": 1 },
  "verifier": { "salt": "…", "iv": "…", "tag": "…", "ct": "…" },
  "keys": { "ibao": { "key_name": "IBAO_API_KEY", "salt": "…", "iv": "…", "tag": "…", "ct": "…", "length": 47, "created": "…" } },
  "updated": "…"
}
```

- `verifier` 加密的是固定串 `dsh-to-go:verify`，用它判断口令对不对，**不必解密任何密钥**。
- 兼容旧文件 `secrets\model-key.enc` + `secrets\key-name.txt`：启动器/配置页拿到口令后自动迁移到 v2（迁移前旧文件照常可用）。

## 3. 接口清单（服务端，全部要令牌 + 已登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 首次：设置口令（写 verifier）；之后：校验口令 → 建立会话（服务端内存里保存口令） |
| POST | `/api/logout` | 清掉内存中的口令 |
| GET | `/api/state` | 概览：槽位/版本/运行状态/端口/体积/磁盘/密钥与站点摘要/日志尾部 |
| GET/POST | `/api/sites` | 读全部站点 / 增改站点（含 `enabled`、模型列表、`image` 勾选、`keyEnv`） |
| POST | `/api/sites/delete` | 删除站点（连带其密钥） |
| POST | `/api/sites/probe` | 用给定 `baseURL+key+协议` 探测 `/models`，返回候选模型列表 |
| POST | `/api/models/default` | 设置默认（provider+model） |
| GET/POST | `/api/keys` | 列出站点密钥状态 / 写入某站点密钥（用会话口令加密） |
| POST | `/api/overlay/rebuild` | 重新生成覆盖层并跑 `--dump-config` 验收 |
| POST | `/api/jobs/install` | 后台安装/升级：`{slot, version}` |
| GET | `/api/jobs` | 任务列表与状态（含进度、阶段） |
| GET | `/api/jobs/log` | `?id=…&from=N` 增量日志 |
| POST | `/api/dsh/start` `/api/dsh/stop` | 启动/停止 dsh（口令从服务内存注入，不经命令行） |
| GET | `/api/dsh/status` | dsh 是否在跑、PID、端口、token URL |
| GET | `/api/plugins` | profile 条目列表（id/name/来源层/是否被禁用/是否第三方） |
| POST | `/api/plugins/toggle` | 启停某条目（写 `disabled` 覆盖） |
| POST | `/api/plugins/pnpm` | 安装/卸载（`dsh plugin --profile web add\|remove <pkg>`，走后台任务） |
| POST | `/api/doctor` | 自检（结果结构化返回，供表格渲染） |

## 4. 棒次与验收

补充两条引擎使用约定（棒 2 定下来的）：

- **取消不等于崩溃**：用户取消后 `reconcile()` 可能先看到进程没了，此时必须写成 `cancelled`（消息「被用户取消」）而不是 `interrupted`——否则界面会把用户自己点的取消报成事故。
- **命令行** `node tools/jobs.js run <kind>` 会**等任务跑完**才退出——因为收尾（写状态、清锁）由发起进程负责；命令行提前退出会把任务丢成「没人管」。
- **网页端**用模块的 `spawnJob()`（非阻塞，立刻返回任务 id），由长驻的服务进程负责收尾，界面用 `readLog(id, from)` 增量轮询。
- 日志开头会回显命令行；**密钥永远不进命令行**（这是硬规则），所以回显是安全的。
- 运行中互斥：`createJob` 直接回 `busy` 而不是排队，避免用户以为"点了没反应"。

| 棒 | 范围 | 交付物 | 验收（必须有真实输出） |
|---|---|---|---|
| 1 ✅ | 数据层：`tools/sites.js`（多站点 CRUD + 覆盖层生成 + `/models` 探测）、`tools/secret.js` v2（多密钥 + verifier + 迁移）、启动器多站点注入 | 三个模块 + 3 个测试文件 | **已完成**：27/27 单测；e2e「一次口令注入两个站点（含自定义变量名）」通过；「v2 缺的用旧文件补齐」回归通过；图形页密钥接口 9 项通过 |
| 2 ✅ | 后台任务引擎 `tools/jobs.js`：状态机、增量日志、互斥、失败回滚、取消、中断识别 | 模块 + 测试 | **已完成**：10/10 单测；集成验收 10/10——真安装任务跑通（退出码 0、槽内版本正确）；长任务期间从**别的进程**轮询 6/6 次看到「忙碌」且 status 调用最慢 179ms（不被卡住）、日志按批流式取到 6 个 tick；真失败任务（不存在的版本）退出码 1、正确判定「原本有安装 → 不删现场」 |
| 3 ✅ | 前端骨架 + 概览页（启动/停止/打开 dsh、状态统计、互斥提示） | `ui/app.html`（单文件，零外链）、服务端 dsh 控制接口 | **已完成**：页面静态核查 5/5（内联脚本 508 行语法、61 个元素 id、20 个接口都对得上、设计基线、零外链）；统一页面 e2e **27/27**（真启停、登录门禁、建站点、密钥走会话口令、旧接口 410、自检 11 行可解析）；运行期 **18/18**（Node DOM 桩 + 真实接口数据真跑页面脚本） |
| 3 设计决定 | 网页服务把口令**只在内存里**留着（`/api/login` 之后）；点「启动 dsh」时用 `spawn` 起 `tools/launch.js web`，把口令经**子进程环境变量 `WZD_KEY_PASS`** 传给它（launch.js 已支持，不进命令行、不落盘）。「停止」用 `taskkill /F /T` 杀整棵树并确认端口释放。运行中禁用升级/插件（互斥），并在页面上明确提示。 | | |
| 4 ✅ | 站点与模型页（多站点 CRUD、探测 `/models`、逐模型视觉、启用开关、默认模型） | 同一页面的「站点和模型」分区 | **已完成**：站点增删改、探测（失败优雅 502 而不是崩）、覆盖层生成与验收、默认模型；e2e 里真建了站点并核对覆盖层内容 |
| 5 ✅ | 升级页（快速升级 + A/B 各自版本） | 同一页面的「升级」分区 | **已完成**：快速升级 / 单槽指定版本 / 取消 / 增量日志轮询；真安装任务在棒 2 已实跑（退出码 0、槽内版本正确） |
| 6 ✅ | 诊断页（结构化自检表格） | 同一页面的「诊断」分区 | **已完成**：自检输出解析成表格（11 行，含槽位与端口两项，带 OK/WARN/FAIL 徽标）、`--dump-config` 验收、备份、网页端口、临时目录、启动器日志 |
| 7 | 插件页（列条目 + 启停 + 安装/卸载 + 运行中禁用） | 页面 + 接口 | **未开工**：页面上按「尚未接通」如实标注（不放假功能）；`/api/sites` 已经带回 `disabledPlugins`，字段口子留好了 |
| 8 ✅ | 首启向导 + 视觉收口（Dark OLED）+ 文档 + 推送 | 向导（设置口令 → 站点与密钥 → 选版本安装 → 启动）、`README`/`USAGE`/`DESIGN`/`ROADMAP` 更新、`build.cmd` 改成「只下 Node → 开向导」 | **已完成**：`build.ps1` 的向导交接实跑通过（Node 已就绪 → 起服务 → 端口监听）；文档里旧的 `model-key.enc`/`key-name.txt`/`GATEWAY_API_KEY` 口径已全部清掉 |

每棒都必须：先写测试/先定义验收 → 实现 → 独立审查（找缺陷）→ 父代理实测（真启动或真安装，不看"代码看起来对"）。

## 4.5 独立审查与修复记录（棒 1+2 之后）

独立对抗性审查（子代理，只读）复现并确认了一批缺陷，已全部修掉并补了回归用例：

| 级别 | 问题 | 修法 |
|---|---|---|
| 高 | 执行锁实际不成立：`acquireLock` 抢锁失败后**无条件覆盖锁**；且 `queued` 对 `isBusy` 不可见 → 两个安装可同时写同一个槽（审查已复现「两个任务同时 running」） | 持有者活着就直接失败、绝不覆盖锁；`queued` 也算占用；新增两条回归用例（背靠背创建、并发抢锁） |
| 高 | `/api/key/clear` 缺 `siteId` 时**直接删掉整个密钥库**，无任何前置条件 | 删库必须显式 `confirm: "DELETE_ALL"` + 再验一次口令，否则 400；顺带让会话失效 |
| 中 | 两套站点事实来源（`site.js`/`site.json` vs `sites.js`/`sites.json`），网页里配的站点启动器看不到 | 站点接口全部改走 `sites.js`；旧的 `/api/site` 保留但同样写 `sites.json`（单一写入者） |
| 中 | 新代码仍在写已废弃的全局 `secrets\key-name.txt` | 去掉 `ui-server`/`site.js` 里的 `setKeyName` 调用 |
| 中 | `sites.js probe` 把密钥放在**命令行参数**里 | 改从环境变量 `WZD_PROBE_KEY` 读 |
| 中 | 后台安装会把用户设过的**网页端口悄悄改回 3180**（并覆盖构建记录） | 只在显式 `--port` 或首次时写端口；构建记录改为追加 |
| 中 | `migrateLegacy` 口令不一致时**抛异常**，且会静默覆盖同名站点密钥 | 先校验口令 → 返回 `{ok:false,reason:'badpass'}`；目标已存在 → `{ok:false,reason:'exists'}`（要覆盖得显式 `overwrite`） |
| 中 | 默认站点被停用后仍写出**悬空的** `agent-default-model` | 生成时校验「站点启用且模型存在」，否则跳过并留一行说明；`upsert`/`setDefault` 同步清空/拒绝 |
| 低 | `running` 与 `pid` 分两次落盘 → 中间窗口会被别的进程误判成中断 | spawn 拿到 pid 后**一次性**写 `running+pid` |
| 低 | PID 复用会让 `isBusy` 永远为真 | 加 3 小时兜底：跑太久按异常收掉；取消前用命令行核对 PID 身份 |
| 低 | 日志截断破坏增量偏移、可能切断多字节字符 | 截断对齐行首/字符边界 + 递增 `logEpoch`；`readLog` 越界时明确返回 `reset:true` |
| 低 | `pruneOld` 可能删掉还没跑的 `queued` 任务 | 排队中的永不删，且按实际删除数补足配额 |
| 低 | 停用清单里带我们自己的条目 id 会把 provider 覆盖层整块关掉 | 生成时过滤掉 `llm-pi-ai` / `agent-default-model` |
| 低 | `keyEnvFor` 碰撞（`a-b` 与 `a--b` 都得到 `A_B_API_KEY`） | `upsert` 时校验变量名唯一，撞了就明确报错要求改名 |
| 低 | 启动器回退匹配从变量名反推，含连字符的站点 id 永远对不上 | 改成按站点表的 `id↔keyEnv` 映射匹配 |
| 低 | 中断的安装任务不回滚，半装残留 | `reconcile` 对 interrupt 的安装任务同样触发回滚 |
| 低 | `WZD_ROOT` 不被 `install.js`/`config.js` 认 | 两个脚本统一从 `WZD_ROOT` 解析根目录 |
| 测试 | `tests/launch.test.js` 有一条**恒真的假测试**（名字叫 refreshOverlay，函数体没调用它） | 改成在独立进程 + 独立数据目录里真调用并断言返回 null |
| 测试 | `PATH` 断言用 `||` 几乎恒真 | 改成断言前两项分别是便携 Node 与活动槽的 `.bin` |

审查提出的「未验证假设」里，两条已由本次修复直接消除（悬空默认模型的真实行为、并发安装是否会写坏槽）；其余（PID 复用下 `process.kill(pid,0)` 的具体表现）保留了兜底而不是精确判定。

## 4.6 第二轮审查（OCR，类 PR diff）与修复

OCR（`ocr review --from 2a1217b --to 7caf529`，走用户自有网关；`status=complete`，**7 个文件全部覆盖**，21 条评论，其中 1 条 high / 11 条 medium / 9 条 low）。有两条请求因网关 TLS 超时降级为「保留首轮结论」，已在下面标注实际影响。

它命中的既有问题（与本轮子代理审查重合的）不再重复；**额外新增确认并修掉的**：

| 级别 | 问题 | 修法 |
|---|---|---|
| 中 | `refreshOverlay()` 在构建 `--patch` 参数**之后**才跑 → 「站点表已配置但覆盖层文件还不存在」的**首次启动**不会带上 `--patch`，站点配置被静默忽略到第二次启动 | 把刷新提前到决定参数之前；并加注释说明为什么顺序不能反 |
| 中 | 每次启动都会走 `writeOverlay`，而它只要发现旧文件就先备份 → **backups\ 无限增长**、每次启动都白写一次盘 | `writeOverlay` 先比对内容：没变就直接返回（不写、不备份）；变了才备份 |
| 中 | 密钥库「损坏」与「不存在」被混为一谈（`readStore` 一律返回 null）→ 下一次写入会用**空库覆盖**损坏文件，全部密钥不可逆丢失 | 新增 `storeState()` 区分 missing/ok/corrupt；`ensurePass` 遇到 corrupt 一律拒绝写入 |
| 中 | 有密钥却缺 `verifier` 时 `ensurePass` 会用新口令重建校验器 → 旧密钥永远解不开而校验器宣称新口令「正确」 | 这种状态一律拒绝重建并报错 |
| 中 | `unlockAll` 全有或全无：单条记录损坏会被误报成「口令错误」，整库不可用且难定位 | 逐条解密，能解多少算多少，返回 `failed` 列表；启动器显示哪些站点解不开 |
| 中 | 改用 `setKey()` 后**环境变量名校验丢了**（前端原始输入会被静默写进密钥库） | `setKey` 内校验变量名格式，非法名字当场拒绝 |
| 中 | `install.js` 放宽活动槽判定后，会保留一个**本次未安装/已空**的槽，导致启动到旧槽或直接失败 | 保留活动槽前确认该槽里确实装着 dsh |
| 低 | `compat` 未配置时被强行写成默认兼容修正（替用户改了 dsh 的默认行为） | `undefined` 视为未配置 → 不写 `compat`；UI 里勾选才写 |
| 低 | `spawnJob` 的 `runJob` Promise 无人 `catch`，定时器回调也没有 try/catch → 后台异常可能拖垮长驻的网页服务 | 加 `markJobCrashed()` 兜底并落到任务状态里 |
| 低 | 密钥库写入无锁：UI 与 CLI 并发时会丢更新（刚设的密钥被并发的删除请求吞掉） | 加同目录 `.lock`（wx + 陈旧锁接管）+ `mutateStore()` 包住读改写 |
| 低 | `guessStage` 的阶段模式与子进程**真实文案**对不上（"便携 Node 就绪"只有 build.ps1 会打印）→ 阶段永远不显示 | 按 install.js 的真实输出重写模式，并用真实字符串做单测 |
| 低 | `install.js --version` 单独给会被静默忽略（用户以为装了指定版本） | 参数校验阶段直接报错退出 |
| 低 | `config.js` 里 `SECRET_FILE` 常量已成死代码；提示文案把密钥库路径写死 | 删死代码；文案改用 `secretLib.secretFile()` |
| 低 | 启动器用 `!= null` 松散比较 | 改成显式 `!== undefined && !== null` |

OCR 未覆盖的假设：它只审了「两棒」那次提交的内容，之后我已改过多轮；上表每条都按**当前代码**复核过（不是照单接受）。



## 4.7 第三轮：页面细化（用户提的三条需求）+ 字段纠正

| 需求 | 落地 |
|---|---|
| 站点密钥输入框用星号按长度填充，避免"没配密钥"的误解 | 密钥长度随 `/api/sites` 一起回给页面，输入框占位符渲染成 `*`×长度；旁边写明「已保存 N 位；留空表示不修改」。**服务端拒绝纯星号当密钥提交**（占位符被误提交会把真密钥覆盖成星号，不可逆） |
| 模型改用表单添加：拉取模型 / 添加模型两个按钮；模型输入框可展开列表、边打边筛、点击填充；未拉取时提示「请先获取模型或手动输入模型」；上下文默认 auto 可自定义；视觉为开关 | 页面加模型表格（可编辑/删除）+ 单模型表单；下拉列表用 `mousedown` 取选值避免失焦；上下文留空=auto（不写进覆盖层），填了必须是正整数；视觉写成 `input: [text, image]`。站点表模型结构扩为 `{id, image, contextWindow}` |
| 升级页自动获取版本列表，改为选择而不是手输；向导同样 | 新增 `GET /api/versions`：从 npm 官方源取（失败自动换 npmmirror），5 分钟缓存，带 dist-tags 与「已装 A/B」标记；快速升级 / 单槽安装 / 首次向导三处共用同一个下拉，另留「手动填版本」兜底 |

**顺手纠正的一个真问题**：`contextWindow` 与「视觉」的字段名不是我们原来猜的那样。用 `dsh --dump-config-schema`（官方 schema，29233 行）核对：
`contextWindow`/`maxTokens` = `integer, minimum 1`（可为 null），模型图片支持是 `input: ["text", "image"]`（不是 `image:`）。
并做了**反向对照**：把覆盖层里的上下文改成 `0`，用 `dsh --profile headless --patch <file> "你好"` 拉起，
dsh 当场报 `ValidationError: $.providers.<站点>.models[0].contextWindow expected number >= 1 but got 0` ——
证明字段名、嵌套层级、取值约束都对（顺带发现 `--dump-config` 只拼配置树、不校验深层字段，所以"dump 没报错"不能当字段正确的证据）。

**顺手修的性能问题**：`/api/state` 每次都要遍历整棵 `runtime\`（两个槽 + npm 缓存，上万个文件）算体积，
实测单次 **2.8 秒**（慢 U 盘更久），而页面每个动作后都会刷新状态 → 每次操作都卡一下。
现在 60 秒内存缓存 + 结果落盘 `runtime\sizes.json`（首次打开先用上次的值、后台重算）：冷 2474ms → 热 **111ms**。

验收：单测 **56/56**；统一页面 e2e **34/34**（含上面那条反向对照）；页面静态核查 5/5（688 行内联脚本、82 个元素 id、21 个接口）；页面运行期核查 **36/36**（含星号填充、未拉取提示、搜索筛选、上下文校验、三处版本下拉）。



## 4.8 第四轮：模型列表缓存（用户反馈）

用户反馈：「每次添加模型都要先拉取」。实测确实如此——`PROBED` 在打开编辑器时被清空，缓存只在内存里、刷新页面就没了。

| 改动 | 说明 |
|---|---|
| 探测结果落盘 | `data\probe-cache.json`（跟盘走）。键：优先 `site:<站点ID>`；新建站点还没有 ID 时用 `url:<地址>|<协议>`，**保存站点后自动认领**到站点 ID 下 |
| 打开编辑器直接用缓存 | 页面在 `openEditor()` 里按同一规则查缓存 → 自动填好下拉与上下文预填，并提示「用的是上次拉取的结果（N 个，X 前）；要刷新点「拉取模型」」。站点卡片上也显示「模型列表已缓存：N 个（X 前）」 |
| 安全阀 | ① 站点**地址或协议变了**就不认旧缓存（拿旧网关的模型配新网关会出错）；② 拉到**空列表**不覆盖已有缓存（网关临时抽风不该把列表清空）；③ **删站点**时清掉它的缓存 |

**顺带修掉一个真 bug**：`ui-server.js` 自己的 `DATA` 没像 `sites.js` 那样认 `WZD_DATA_DIR`，
结果测试/多实例场景下探测缓存被写进了仓库真实的 `data\`。两处现在一致。

**可测性**：站点卡片渲染拆成 `renderSiteList()`，状态变化后可以局部重画，也能被验收脚本直接调用。

验收：单测 **57/57**（新增缓存用例：按站点存、地址/协议失效、空结果不覆盖、删除清理）；`ui-sites` e2e 全过（缓存落盘 → 认领 → 清理）；页面静态核查 5/5；页面运行期核查 **43/43**。



## 4.9 第五棒：插件页（棒 7）

**先查清事实，再写代码**——这一棒花了大量时间在只读勘察上，因为 dsh 的插件机制没有任何官方文档页，也没有插件索引：

| 查到的 | 依据 |
|---|---|
| 插件 = **profile 目录**里的 npm 包 + 配置树条目；profile 在 `data\profiles\<名>`（`package.json` 的 `dsh.profile.bundles` 决定哪些包会加载） | `data\profiles\web\` 实际结构；`dsh --profile web --help` |
| 装/卸 = `dsh plugin --profile <名> add\|remove <包>`，它把参数**原样转给 profile 目录里的 pnpm** | `dsh plugin --help`；`lib/plugin-*.js` 源码 |
| **需要 pnpm**，便携包不带 → 必须把 pnpm 装到盘上（`runtime\pnpm`），并在启动子进程时把它的 bin 放进 PATH；store 也要落在盘上（否则默认写盘根或宿主） | dsh 报「pnpm was not found; install pnpm and make it available on PATH」；`pnpm store path` 实测 |
| 装/卸有**版本兼容闸门**：插件的 `peerDependencies` 与当前 dsh 不匹配直接拒绝，并给出 `allow-version ... --accept-risk` 豁免命令 | 实测 `add @deepseek-ai/dsh-tool-todo`：npm 上最新只有 0.0.1-rc.1，与 dsh 0.2.1-alpha.2 不匹配 → rejected |
| 条目启停 = 覆盖层里写 `- id: <条目id>` + `disabled: true`，**运行时生效** | 实测停用 `webserver` → dsh 启动失败：`1 required plugin did not activate`，并列出 4 个等待 `webServer` 的插件 |
| ⚠️ **`dsh --dump-config` 不体现覆盖层给的 `disabled`** | 同一份配置，带不带停用补丁的 dump **逐字节相同**（我先被它骗了两次，其中一次是 grep 窗口太窄把条目末尾的 `disabled` 切掉了） |
| 官方自己也是这么写的 | `@deepseek-ai/dsh-plugin-manager` 的 `writePluginEnabled()`：找同 id 的项改 `disabled`，没找到就 append `{id, disabled}` |

交付：
- `tools/plugins.js`：启停状态（`data\plugins.json`，`disabled`/`enabled` 两个清单）、条目解析（只认行首 `- id:`，缩进的是 config 里的引用）、已装包、pnpm 探测/环境/安装、包名校验、npm 关键词搜索。
- `jobs.js`：`plugin-pnpm` 任务注入 pnpm 环境（PATH + 盘上 store）；新增 `pnpm-setup` 任务。
- `ui-server.js`：`/api/plugins`（清单，dump 缓存 30 秒）、`/api/plugins/toggle`、`/api/plugins/install|uninstall`、`/api/plugins/allow-version`、`/api/plugins/search`、`/api/plugins/pnpm-setup`；写操作要解锁、dsh 运行时 409。
- 页面「插件」分区：状态卡（pnpm / profile / 已装包 / dsh 状态 / 条目数）+ 已装包表格（卸载）+ 安装（包名 + npm 搜索点选）+ 危险区（版本豁免）+ 条目表格（搜索过滤 + 开关）+ 操作日志。

验收：单测 **64/64**（新增 7 条插件用例）；插件 e2e **26/26**（含真跑 `dsh plugin` 与「停用 → 启动失败」的运行时验证）；页面运行期核查 **51/51**；页面静态核查 5/5；统一页面 e2e 无回归。



## 4.10 拔盘守护（U 盘被拔走时自动收摊）

**问题**：进程不会因为盘被拔走就停。dsh 继续在内存里跑，`data\` 的写入落到已经不存在的卷上，
会话回不去、任务白跑——盘插回来看到的还是旧状态。这是便携版最容易「白干一场」的场景。

**做法**：`tools\watchdog.js` + 两处接入（`launch.js` / `ui-server.js`）：

| 环节 | 细节 |
|---|---|
| 哨兵 | 启动时写 `runtime\.drive-id`（id + 盘根 + 创建时间），跟着盘走 |
| 判定 | 每 3 秒读一次；读不到 / id 变了（换盘）/ 内容坏了，连续 3 次 → 丢盘 |
| 收摊顺序 | ① 写宿主记录（盘没了只能写宿主）② 取消在跑的任务 ③ `taskkill /T` 杀 dsh 子树 ④ 退出（launch=3，ui-server=4） |
| 事后可见 | 概览横幅 / 诊断「拔盘守护」卡片 / `/api/drive-lost/clear`；记录在宿主 `%LOCALAPPDATA%\Temp\dsh-to-go\drive-lost.json` |

**刻意的取舍**：
- 连续 3 次才判定（约 9 秒）：USB 会抽一下，1 次就停太容易误杀。可用 `WZD_DRIVE_POLL_MS` / `WZD_DRIVE_MISSES` 调。
- 坏内容按「盘没了」处理（宁停不跑）：反过来的代价更大——dsh 会继续在没有盘的世界里写。
- 守护只判「读不到」，不判「写入失败」（半接触不良那种）；后者由 dsh 自己的报错暴露。
- 两个接入点会各写一条丢盘记录（竞态顺序不定）：这是刻意的——各自保自己的命，不靠别人通知。
- 定时器 `unref()`：它不该拖住进程退出（别让守护自己变成关不掉的尾巴）。

**为什么「删哨兵」是有效的测试手段**：守护分辨不了「文件被删」和「盘被拔」——两者对它是同一件事。
单元测试与端到端测试都用这一招，测试完必须把哨兵放回去（`readState` 的 id 变了也不要紧）。

验收：单测 `tests\watchdog.test.js` 15 项（含「定时器自己发现丢盘」）；全量单测 79/79；
端到端 `drive-pull-e2e`：真起 dsh → 删哨兵 → 断言 dsh 端口关闭、进程树死、ui-server 退出码 4、宿主记录写入、重开后能看到并可清除。

## 4.11 插件页改版：卡片视图 + 插件市场 + 适配版本判定（棒 8）

需求（用户给的）：插件用卡片展示（图标 / 名称 / 作者 / 适配版本 / 简介 / 启用停用 / 详细 / 删除）；分成官方插件与第三方插件，
各用一个开关控制是否显示；插件市场用社区索引 `awesome-dsh-plugin.com`。

**勘察结论（决定了设计）**：

| 问题 | 实测答案 |
|---|---|
| 市场里有官方插件吗 | 没有（0 个 `@deepseek-ai/*`）。官方插件只能来自**活动槽**：`runtime\<槽>\node_modules\@deepseek-ai\`（299 个包，175 个在配置里有条目） |
| 市场里有「适配 dsh 版本」字段吗 | 没有。字段只有 name/owner/url/category/description/npm/version/stars/downloads/capabilities/install/added/screenshots/tarball |
| 那「适配版本」从哪来 | 插件的 `peerDependencies` 声明了对 dsh 内部包的要求，**这就是 dsh 兼容闸门的判定依据** → 用槽里自带的 semver 比对本槽实际版本（实测 `dsh-answer-reviewer` → 「适配本槽」） |
| 图标哪来 | 索引里只有截图没有图标；页面也不该外链图片（离线可用是硬约束）→ 按包名算一个确定颜色的字母图标，纯内联 |
| 4489 个怎么显示 | 服务端搜索/分类/排序/分页（页面只拿当前页 24 个），索引缓存到盘上（约 3.9 MB，24 小时） |
| 安装怎么装 | **照抄索引里的 `install` 命令**（有 `github:作者/仓库`、`tgz` 链接的），服务端从命令里解析目标 + `validInstallSpec` 校验 |

交付：`tools\market.js`（抓取/瘦身/缓存/查询）、`tools\compat.js`（peerDependencies 比对本槽，semver 优先、近似兜底）、
`plugins.js` 增 `catalog()`（官方/第三方分组 + 元信息 + 条目归并 + 兼容结论）、页面插件页整块重写成卡片 + 市场 + 详情面板、
`data\ui-prefs.json` 存显示开关（跟盘走）。

验收：单测 **101/101**（新增 market 13 项、compat 12 项）；页面静态核查 5/5；页面运行期核查**全部通过**（175 张官方卡片、
市场 4489 个 / 188 页、详情面板联网算出「适配本槽」）；接口实测（目录/市场/详情+兼容/偏好存盘/404/401 门禁）。

## 4.12 插件装卸修不了的两道坎：pnpm 大版本 + 新包冷却（用户报「无法删除插件」）

用户报：点「删除」失败、退出码 1，页面「重新读取」也一样。读盘上 `data\jobs\` 的真日志，是**两个各自独立的 pnpm 层问题**：

| 现象 | 真根因 | 处理 |
|---|---|---|
| `ERR_PNPM_UNEXPECTED_STORE` | profile 是 **pnpm 12.11.2** 装的（`node_modules\.modules.yaml` 里 `packageManager` + `storeDir: F:\.pnpm-store\v11`），而盘上只有 pnpm 10（store `runtime\pnpm-store\v10`）。pnpm **跨大版本共用 store 一律拒活**，所以连删除都失败 | 盘上**按大版本并存**：默认大版本 10 用 `runtime\pnpm`，其他用 `runtime\pnpm-<major>`；操作 profile 前用 `profileStore()` 读出它要的大版本与 store，挑对应那份 pnpm + 把 `npm_config_store_dir` 指到 store **父目录**（记录里带 `\v11` 后缀，环境变量要上一级） |
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm 12 默认「新包冷却」24 小时，lockfile 里有刚发布 23 小时的包（`dshmarket@1.66.15`），解析时整份 lockfile 都被核对 → 普通删除也被拦 | **不偷偷关这条安全策略**：页面给一个默认关闭的开关，勾上才按 `--config.minimumReleaseAge=0` 跑（存 `ui-prefs.json`） |

顺带修掉的两处「想当然」：① `.modules.yaml` 名字叫 yaml、**内容其实是 JSON**（带缩进、键带引号）——按 JSON 解析；
② pnpm 大版本的**启动方式也不同**：10 是 `bin/pnpm.cjs`（node 跑），12 是原生 `pnpm.exe` → 用 `pnpmCmd(major)` 取 {cmd,args}，别写死。

验收（都是先复现、后证明修好）：
- **真机复现 + 修复**：造一个 pnpm 12 装的假 profile（真装包）→ 用旧接线（pnpm 10 + 我们的 store）`remove` **复现** `ERR_PNPM_UNEXPECTED_STORE`；
  换新接线（pnpm 12 + profile 记录的 store）同一条 `remove` **成功**，包真从 `node_modules` 消失、`package.json` 也清了，`add` 也能装回去。
- **在用户的 F 盘上、走 dsh 真实链路**（`dsh plugin --profile web install --dry-run`，不改动任何东西）：原样 → 退出码 1 + `MINIMUM_RELEASE_AGE_VIOLATION`；带 `--config.minimumReleaseAge=0` → **退出码 0**。
- 单测 **106/106**（新增 profileStore/pnpmFor 解析、大版本不顶替、relaxArgs/pluginOpArgs 共 3 组）；页面静态 5/5；页面运行期核查 **75/75**（含新断言：pnpm 状态行显示「就绪 v12.11.2」、「放宽新包冷却」开关默认关闭）。
- 页面失败提示改为**读日志里的真实错误码**再翻译成人话（`jobFailHint()`），而不是只说「退出码 1」。

## 4.13 界面重构第一刀：显示逻辑（状态反馈）+ 显示动画（用户第 2 条需求）

用户要求「用 skills 对前端 UI 的显示逻辑、显示内容、显示动画做一次重构」。按 `ui-ux-pro-max` 检索到的判定逐条对照，页面有三处不达标：

| 技能判定 | 页面原状 | 改法 |
|---|---|---|
| 动效要有共享 token，进入用减速 `ease-out`、离开更快，**别把所有过渡写成一个时长** | 全部 `.18s` 一个值 | `--t-fast/--t/--t-slow` + `--e-out/--e-in`；`keyframes rise/pop/pulse/shimmer`；只动 `transform`/`opacity`；卡片列表加 `content-visibility:auto` + `contain-intrinsic-size`（175 张卡不拖累滚动） |
| 加载态用**骨架屏** + `aria-busy`，别让界面冻住、别跳版 | 一行「加载中…」 | `skeleton(id, 行数)` / `busyDone(id)`，接在站点列表、插件目录、插件市场 |
| 错误必须给**恢复路径**，不能只说失败 | 「任务结束：failed 退出码 1」 | `flashAction(id, 文案, kind, {label, fn})`：插件失败按真实错误码给「装匹配的 pnpm」/「放宽并重试」，其它失败给「再试一次」，读状态失败给「重试」 |
| 连续动画只用于加载指示、状态变化要有意义 | 每次轮询都重画任务状态 | 状态**真变化**时才 `pulse` 一次 |

⚠️ 过程中出过一次高危回归：拿 `@media (prefers-reduced-motion: reduce)` 那行当补丁锚点，把它替换掉了（等于丢掉"尊重减少动效"）。已补回（放在新规则之后保证覆盖），并在运行期核查里加了专门守它的断言。

验收：单测 **106/106**；页面静态 5/5（1255 行脚本、125 个 id、29 个接口、无外链）；页面运行期核查 **84/84**（新增 8 条：骨架屏占版面+`aria-busy`、读完撤 `aria-busy`、错误提示带按钮、状态变化脉冲、同状态不脉冲、动效 token 齐、关键帧齐、`.18s` 清零、减少动效守卫仍在）；F 盘只读验收全部通过。

**还没做的（第二刀）**：显示内容那条——文案术语统一、数字/单位统一、把实现细节从面板默认可见处收进「详情」折叠。

## 5. 视觉基线（ui-ux-pro-max 输出，实际采用部分）

- 风格：Dark Mode (OLED)，深色优先；浅色不做默认。
- 色板：底 `#0F172A`、卡片 `#1B2336`、主 `#1E293B`、边框 `#475569`、次要文字 `#94A3B8`、前景 `#F8FAFC`、强调/CTA `#22C55E`、危险 `#EF4444`。
- 字体：界面 `IBM Plex Sans`，代码/ID/日志 `JetBrains Mono`（本地不联网时回落系统等宽）。
- 动效：入场错落 300-450ms（`back.out(1.4)` 风格），必须尊重 `prefers-reduced-motion`。
- 硬要求：图标用 SVG（不用 emoji）、点击元素 `cursor:pointer`、悬停 150-300ms 过渡、键盘焦点可见、对比度 ≥ 4.5:1、375/768/1024/1440 四档可用。
- 弃用：该工具自动推荐的「FAQ 落地页版式」（与控制台无关）。

## 6. 风险与回退

- **装到一半拔盘**：任务状态在 `data\jobs\` 里，重开后可见失败原因；指针未切换即等于没升级。
- **覆盖层写坏**：每次写前备份到 `backups\overlay-<时间>.yml`，并提供「回滚到上一个覆盖层」。
- **口令遗忘**：无法找回（这是设计目标）；界面明确提示，并允许「删除全部密钥重设」。
- **旧包兼容**：`secret.js` 保持读取旧 `model-key.enc` 的能力，直到迁移完成。
