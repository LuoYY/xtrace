# Firefox-Reverse 66 ��工具逐项能力清单（P6 前置交付物）

- 版本：v1.0（2026-09-19）
- 依据：`firefox-reverse/additions/browser/components/agent-sidebar/modules/Tools.sys.mjs`（66 项 `T(...)` 声明逐项核对）、`Backends.sys.mjs`（backend 组装与 cookies 特权实现）、`docs/chromium-migration-enhancement-draft.md` §5（分组与迁移策略）。
- 性质：静态清单编制（E7，纯文档），不修改代码、不启动浏览器。迁移状态为**预判**，以实现验收为准。
- 用途：P6 启动时按本清单冻结首批 A 组工具范围，不在验收时临时议定。

## 1. 分组定义与统计

分组沿用迁移草稿 §5：

- **A 证据只读**：trace 查询、脚本资产读取、索引检索、报告查看；无副作用。
- **B 实验控制**：环境/实例生命周期、采集 start/stop/status；有状态变更，经 Broker 授权。
- **C 页面调试**：DOM、网络、调试器、截图等页面作用域操作；逐项声明范围与副作用。
- **D 宿主执行**：文件写入、Node/Python 执行、依赖安装等宿主副作用；最后接入，统一策略。

| 分组 | 数量 | 首批冻结建议 |
| --- | --- | --- |
| A | 13 | 全部纳入首批（P6 冻结范围） |
| B | 22 | 首批只取 capture 生命周期最小集（jsvmp_trace/status、webapi_trace/status、scripts_capture_all）＋最小 env 集 |
| C | 16 | 首批不接入；P7 分批，逐项覆盖矩阵 |
| D | 15 | 首批不接入；最后经 Broker 统一策略接入 |

统计口径：66 项 = `Tools.sys.mjs` 中 `toolTable()` 的全部 `T(...)` 声明；`CONFIRM_TOOLS`（23 项）在清单中单独标注，对应 Broker 批准语义。

## 2. 逐项清单

依赖列给出 Firefox 侧 backend / 特权 API；迁移目标列为 Chromium/XTrace 侧的承接机制。迁移状态：**完整**＝语义可在目标栈等价重实现；**部分**＝可迁移但有明确语义缺口（写明）；**不可用**＝依赖 Gecko/SpiderMonkey 特有宿主能力且无首期对应物。

### A 组：证据只读（13 项）

| 工具 | 依赖（Firefox） | 需确认 | 迁移目标 | 状态 | 原因 |
| --- | --- | --- | --- | --- | --- |
| `code_search` | `code` backend（语料文件，纯 JS） | 否 | Node Host 纯逻辑 + XTrace 脚本资产目录（manifest + 资产文件） | 完整 | 纯文本/正则搜索，无引擎依赖；语料来源改为 XTrace 资产管道 |
| `scripts_list` | `scripts` backend（调试 actor scriptParsed） | 否 | CDP `Debugger.scriptParsed`（含 eval/Function/inline；Worker 经 Target auto-attach）+ XTrace 资产 manifest | 完整 | CDP 语义覆盖全部四类脚本来源 |
| `jsvmp_query` | `jsvmp` backend（C++ 落盘 NDJSON） | 否 | P4 结构化 Ignition 事件 + P6 证据索引查询 | 部分 | 查询逻辑可完整平移；`vpc/locals/env` 等字段依赖 P4 后续版本���首版仅执行前事件 |
| `webapi_query` | `webapi` backend（C++ 记录） | 否 | XTrace WebIDL 入口事件 + 聚合器 | 部分 | records/env/flow 聚合为纯逻辑可平移；覆盖面受 P5 首批接口集限制（URL/Body/Element/Performance 等） |
| `find_param_entry` | `find`（net 记录 + 已存语料，纯 JS） | 否 | net 证据（CDP Network 或 XTrace browser-network 事件）+ 脚本语料 | 完整 | 纯交叉检索逻辑 |
| `crypto_scan` | `jsvmp.cryptoScan`（纯分析） | 否 | Node Host 纯逻辑 | 完整 | 公开常量/结构特征识别，站点无关，零引擎依赖 |
| `jsvmp_split_dispatcher` | `jsvmp.splitDispatcher`（babel + AST，离线） | 否 | Node Host 纯逻辑（babel/dispatcher_probe 随迁） | 完整 | 离线静态分析；产出 handlers.json 契约不变 |
| `jsvmp_disassemble` | `jsvmp.disassemble`（离线反汇编） | 否 | Node Host 纯逻辑 | 完整 | 离线工具，依赖 handlers.json + 字节码输入 |
| `skill_list` | `skill` backend（目录扫描） | 否 | Host 文件读取（内置 + 用户/工作区 skill 目录） | 完整 | 纯文件枚举 |
| `skill_get` | `skill` backend | 否 | Host 文件读取（offset/limit 分段沿用） | 完整 | 纯文件读取 |
| `skill_read_resource` | `skill` backend | 否 | Host 文件读取（Skill 内安全相对路径校验沿用） | 完整 | 纯文件读取 |
| `notes_get` | `notes` backend（.frx-notes.ndjson） | 否 | Host 文件读取 | 完整 | 纯读取；按站点过滤逻辑不变 |
| `recall` | `ledger` backend（SQLite） | 否 | LedgerBackend 迁移（SQLite + 工作区隔离） | 完整 | 草稿 §5 明确保留 SQLite；查询语义不变 |

### B 组：实验控制（22 项）

| 工具 | 依赖（Firefox） | 需确认 | 迁移目标 | 状态 | 原因 |
| --- | --- | --- | --- | --- | --- |
| `jsvmp_trace` | `jsvmp` backend（JsvmpTraceCore C++，SpiderMonkey） | 是 | P4 结构化 observer（Ignition 执行前事件、规范化 offset） | 部分 | start/stop/status/clear 语义可承接；`dump`（locals/env/vpc 快照）超出 P4 首版（值观测后置）；scriptUrl 过滤对应按脚本范围启停 |
| `jsvmp_status` | `jsvmp` backend | 否 | `XTrace.getCaptureStatus`（P3） | 部分 | 需 P3 状态查询落地；"trace 文件就绪"改为 producer 终态/计数核对 |
| `webapi_trace` | `webapi` backend（WebApiTraceCore C++，RuyiTrace 模式） | 是 | P5 Blink 生成器插桩（首批接口集）+ capture 过滤 | 部分 | 引擎层不可检测的定位可保留；但"任意接口 filter"首期不可得，仅首批 WebIDL 集合（URL/Body/Element/Performance/NADC），filter 必填的护栏沿用 |
| `scripts_capture_all` | `scripts.captureAll`（调试 actor） | 是 | XTrace 资产通道（capture_assets）或 CDP `getScriptSource` 批量 | 完整 | 外部脚本源码可全量落盘；写入 Host 管理的证据目录 |
| `env_current` | `env` backend | 否 | P6 最小 env 能力（实例登记） | 部分 | 实例归属可查；指纹/代理字段为 null（P7） |
| `env_current_process` | `env` backend（主进程指纹配置） | 否 | 无首期对应物 | 不可用 | 依赖 C++ 指纹覆盖层，显式暂缓至 P7（草稿 §1.1） |
| `env_read_current_process_config` | `env` backend | 否 | 无首期对应物 | 不可用 | 同上；指纹/代理配置文件无消费端 |
| `env_write_current_process_config` | `env` backend | 是 | 无首期对应物 | 不可用 | 同上；且写入不生效会误导，首期直接拒绝 |
| `env_reset_current_process_default` | `env` backend | 是 | 无首期对应物 | 不可用 | 同上 |
| `env_list` | `env` backend（~/.firefox-reverse/environments） | 否 | P6 最小 env（独立 profile 目录 + 登记表） | 部分 | 环境/目录可列；fingerprint/proxy 字段挂载点预留但不生效 |
| `env_status` | `env` backend | 否 | P6 实例生命周期 + 进程状态 | 部分 | 进程运行状态可查；指纹生效状态无 |
| `env_create` | `env` backend | 是 | P6 最小集：目录/profile/登记表创建 | 部分 | 目录结构可建；指纹生成与注入 P7；randomize 等参数暂存挂载点 |
| `env_update` | `env` backend | 是 | P6 最小集：改名 | 完整 | 纯元数据修改 |
| `env_open` | `env` backend（独立进程 + -no-remote + Marionette 端口） | 是 | 专用 Chromium 实例 + 独立 profile + CDP pipe（无端口） | 部分 | 等价语义可达成（草稿 §8.2 首选 pipe）；Marionette 端口概念不迁移；指纹注入 P7 |
| `env_close` | `env` backend | 是 | P6 实例停止（显式 stop 优先，P2 排空契约） | 部分 | 可停进程；"日志完整落盘"依赖 P2 watermark 结算，不承诺断电安全 |
| `env_read_config` | `env` backend | 否 | 挂载点 JSON 读写（仅存储） | 部分 | 文件可管理；内容不改变浏览器行为（P7 才生效） |
| `env_write_config` | `env` backend | 否 | 同上 | 部分 | 同上；结果中必须明示"未生效" |
| `env_generate_fingerprint` | `env` backend（指纹生成纯逻辑） | 是 | 挂载点文件生成 | 部分 | 生成器纯 JS 可平移；但 Chromium 指纹基线（版本/系统配对）需重做，且无消费端（P7） |
| `env_capture_fingerprint` | `env` backend（页面 JS 可见指纹采集） | 否 | CDP `Runtime.evaluate` 采集快照 + XTrace fingerprint 采集类别交叉印证 | 部分 | 只读采集可做（首期不改值原则一致）；与 Firefox 版本的字段面不同，需按 Chromium 指纹面重定义 |
| `env_import_fingerprint` | `env` backend | 否 | 挂载点文件规范化写入 | 部分 | 规范化逻辑可平移；Firefox 指纹 schema 不适用，需 Chromium 版 schema |
| `env_import` | `env` backend | 是 | 环境目录导入 | 部分 | `{env,fingerprint,proxy}` 结构可保留；"只接受 Firefox 指纹"校验改为 Chromium 指纹；生效 P7 |
| `env_delete` | `env` backend（confirm 必填） | 是 | P6 最小集：递归删除已关闭环境 | 完整 | 目录删除 + 确认护栏沿用 |

### C 组：页面调试（16 项）

| 工具 | 依赖（Firefox） | 需确认 | 迁移目标 | 状态 | 原因 |
| --- | --- | --- | --- | --- | --- |
| `page_eval` | `page.eval`（页面 principal 沙箱、wantXrays:false） | 是 | CDP `Runtime.evaluate`（awaitPromise/saveTo 落盘经 Host） | 部分 | 核心执行等价；Firefox XPCOM/Xray 语义无对应物（Chromium 无特权页面包装概念）；`window.X=包装` 全权替换语义可保留 |
| `page_navigate` | `page.navigate` | 是 | CDP `Page.navigate` | 完整 | 语义一一对应 |
| `page_elements` | `page.elements` | 否 | CDP `DOM.getDocument` + `querySelectorAll` + 可视性过滤 | 完整 | 纯只读枚举 |
| `page_click` | `page.click`（滚动到可视区后点击） | 是 | CDP `Input.dispatchMouseEvent`（先行滚动） | 完整 | 输入事件合成语义等价 |
| `page_type` | `page.type`（input/change 事件 + 可选回车） | 是 | CDP `Input.insertText` + key 事件 | 完整 | 事件序列需按 Chromium 期望重建，语义可达成 |
| `page_scroll` | `page.scroll` | 否 | CDP `Input.synthesizeScrollGesture` / `Runtime` 滚动 | 完整 | 四种模式（dy/toBottom/toTop/selector）均可映射 |
| `page_screenshot` | `page.screenshot`（PNG，可视区/整页） | 否 | CDP `Page.captureScreenshot` | 完整 | fullPage 参数对应 |
| `page_info` | `page.info` | 否 | CDP `Target.getTargetInfo` + `Runtime.evaluate` | 完整 | URL/标题/脚本数/UA 均可得 |
| `page_automation_scan` | `page.automationScan`（内容上下文执行扫描 JS） | 否 | 同一扫描 JS 经 CDP evaluate 注入 + saveTo 落盘 | 完整 | 扫描脚本本身站点无关；webdriver/UA-CH/plugins 等探测点在 Chromium 上字段面不同，脚本需按 Chromium 环境面适配（探测项增删，不改"只读扫描"性质） |
| `net_capture` | `net` backend（调试 actor，含 initiatorStack） | 是 | CDP `Network.enable/disable`（initiator 栈由 `requestWillBeSent.initiator` 提供） | 完整 | fetch/XHR/Beacon/WS 的发起栈在 CDP 中可得；fnmatch 过滤在 Host 侧实现 |
| `net_list` | `net` backend | 否 | Host 侧记录缓冲查询 | 完整 | 纯查询 |
| `net_get` | `net` backend | 否 | CDP `Network.getResponseBody` + `requestWillBeSent` postData/headers | 完整 | 请求/响应头、body、initiator 栈可得；大 body 限额需 Host 侧有界化（对应草稿 §6.4 限额契约） |
| `signer_trace` | `page.signerTrace`（引擎级 Debugger 旁观 frame.arguments，跨导航存活） | 是 | P4 observer 扩展（选定脚本的函数入口 + 实参）或 CDP 断点方案 | 部分 | CDP `Debugger` 断点会暂停页面、改变时序，不等价；非暂停的引擎级入参观测需 P4 结构化 observer 扩展（首批不做）；`page_eval` 边界 hook 的轻路径可直接用 |
| `closure_read` | `page.readClosure`（引擎级 Debugger 读 frame.environment） | 是 | P4 值观测扩展（后置） | 部分 | 闭包/局部变量真值读取超出 P4 首版（执行前事件、不含执行后值）；深序列化（S-box/字节码数组整段）依赖后续值观测与有界资产契约 |
| `hook_inject` | `page.hookInject`（document-start 注入，跨刷新存活，内容进程作用域） | 是 | CDP `Page.addScriptToEvaluateOnNewDocument` | 完整 | 语义直接对应（含防重复 guard 约定）；跨进程 frame（OOPIF）需 Target auto-attach 覆盖，作用域差异须在能力表披露 |
| `cookies` | `Backends.sys.mjs` 内联 `Services.cookies`（nsICookieManager，特权） | 是 | CDP `Network.getAllCookies/setCookie/deleteCookies` | 完整 | httpOnly 可管理、跨域可查；作用域为当前 browser context，与 nsICookieManager 全局视图的差异需在结果中标注 |

### D 组：宿主执行（15 项）

| 工具 | 依赖（Firefox） | 需确认 | 迁移目标 | 状态 | 原因 |
| --- | --- | --- | --- | --- | --- |
| `scripts_save` | `scripts.save`（调试 actor 源码 → 语料/工作目录） | 是 | CDP `Debugger.getScriptSource` → Host 落盘（toWorkspace/force 护栏沿用） | 完整 | 源码可得；写入经 Broker 路径策略；完整性护栏（404/残片检测）平移 |
| `fs_list` | `workspace.list`（特权 FS） | 否 | Node Host 文件枚举（Broker 路径边界 + 符号链接解析） | 完整 | 草稿 §5 已列 WorkspaceBackend 重写要求；depth 上限沿用 |
| `fs_read` | `workspace.read` | 否 | Node Host 读取（32KB 截断、offset/limit 切片沿用） | 完整 | 同上 |
| `fs_write` | `workspace.write`（append 分段） | 否 | Node Host 写入（自动建父目录、分段写护栏沿用） | 完整 | 同上 |
| `fs_mkdir` | `workspace.mkdir` | 否 | Node Host 目录创建 | 完整 | 同上 |
| `fs_copy` | `workspace.copy`（服务端拷贝，内容不经模型） | 否 | Node Host 复制 | 完整 | 同上 |
| `run_node` | `workspace.runNode`（特权进程执行） | 否 | Host 子进程执行（超时、输出上限、取消语义按 Broker） | 完整 | 草稿 §5 要求重写宿主与授权入口；`node -e`/file 双入口沿用 |
| `run_python` | `workspace.runPython` | 否 | 同上 | 完整 | 同上 |
| `npm_install` | `workspace.npmInstall` | 否 | Host 子进程 + 显式网络策略 | 完整 | 外网访问为 Broker 显式策略项（草稿 §11.2） |
| `notes_add` | `notes` backend（NDJSON 追加） | 否 | Host 文件追加 | 完整 | 纯落盘；≤600 字与"只记已验证"约定沿用 |
| `remember` | `ledger.append`（SQLite/ledger.md） | 否 | LedgerBackend 迁移 | 完整 | 事实/死路两类条目与每轮注入语义在 Host 侧重实现 |
| `wasm_probe` | `jsvmp.wasmProbe`（Node 装载 glue+wasm，hook wbg import） | 否 | run_node 同构执行（零三方依赖保持） | 完整 | 纯 Node 运行时分析；selectors 喂真值与 signerExpr 工厂语义不变 |
| `wasm_disasm` | `jsvmp.wasmDisasm`（wabt，npm 自动安装） | 否 | run_node + wabt（落盘 WAT、只回摘要的护栏沿用） | 完整 | 纯工具链；npm 安装经策略 |
| `js_trace` | `jsvmp.jsTrace`（acorn AST 插桩 + Node 执行） | 否 | run_node 同构执行 | 完整 | 纯静态插桩 + 本地执行 |
| `whitebox_diff` | `page.whiteboxCoverage`（SpiderMonkey collectCoverageInfo）+ `jsvmp.whiteboxNode/Diff`（node:inspector） | 是 | CDP `Profiler.takePreciseCoverage`（浏览器侧）+ `node:inspector`（Node 侧）+ 对齐器 | 部分 | V8 覆盖为块级/函数级粒度，分支级需 matchBy 容差对齐（offset 模式保留）；wasm import 边界在 Node 侧可用；"零插桩非侵入"定位保留，但覆盖粒度差异须在报告中标注 |

## 3. 首批冻结建议（P6 启动时执行）

1. **A 组 13 项全部纳入首批**，其中 `jsvmp_query`、`webapi_query` 两项以 P4/P5 已落地的事件面为限（首版：Ignition 执行前事件、首批 WebIDL 接口），能力表显式披露缺口，不宣称通用 VMP 还原。
2. **B 组首批仅 5 项**：`jsvmp_trace`（start/stop/status/clear，不含 dump）、`jsvmp_status`、`webapi_trace`（首批接��集内）、`scripts_capture_all`、`env_open`/`env_close`/`env_create`/`env_list`/`env_status`/`env_delete`/`env_update`（最小 env 集，P6 范围）。
3. **C/D 组首批均不接入**；`page_eval`/`fs_*`/`run_node` 作为 Host 内部能力存在，但不注册为 Agent 工具（经 Broker 的 UI 路径使用）。
4. **不可用项（4 项）**：`env_current_process`、`env_read_current_process_config`、`env_write_current_process_config`、`env_reset_current_process_default`——依赖指纹覆盖层（P7），能力协商中报"不可用并给出原因"（草稿 §11.1 三态清单）。

## 4. 许可证与来源

`Tools.sys.mjs` 及关联模块属 Firefox-Reverse 仓库（MPL-2.0）。迁入 XTrace 时逐文件保留来源与许可标注，不得改标 MIT（草稿 §5 许可证要求）。本清单为文档分析，未迁入任何代码。
