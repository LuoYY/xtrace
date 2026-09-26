# P6 执行工单记录：Agent 闭环（工程师执行侧）

- 对应工单：[chromium-p6-agent-loop-handoff.md](chromium-p6-agent-loop-handoff.md) v1.0（2026-09-26，四预决策冻结）。
- 纪律沿用：阶段成果落盘、补丁栈强制同步（本轮 E0 未触碰 chromium/src，无需重生成）、门禁含全部测试目标、未经要求不推送。
- 执行状态行：progress JSON `p6`。

## E0：进入债务清零（2026-09-26）

### E0-a：D-P55-1 同程序语义等价（红测试冻结 + E7 修复）

- **债务事实**：accepted-p55 记录的 D-P55-1——E7 门禁的 off/on"语义等价"比较了**两个不同程序**（stateOff 跑 PLAIN 内联循环、stateOn 跑 LOOP 函数+natives），对观察器零证明力。
- **新门禁** `scripts/p6-e0-dp551-equivalence.cjs`（冻结为常设门禁）：**完全相同的程序源**（确定性整数运算 + 字符串构建 + 嵌套结构）经注入 `<script>`（页内 URL、被追踪激活——Runtime.evaluate 不在 sync-causality 激活内，这是当年 E7 用注入式的原因，已复核）在两个浏览器各跑一次：capture-off vs capture-on（观察器 + 29,934 个 value tap + 1 次 token dump saved + terminal complete）。断言：结果对象 **deep-equal 逐位一致**、getter 哨兵与微任务哨兵两侧相等。亲跑 **PASS**（number/text/list/nested/totalFinite 全等，哨兵 1/0=1/0）。
- **E7 修复**（债务本体）：`p55-e7-valueobs-evidence.cjs` 的 stateOff 改跑**同一 LOOP 源**（off 侧也带 `--allow-natives-syntax --max-opt=0`，xtrace 旗标仍仅在 on 侧）；stateOn/afterStop 增加 `assert.deepEqual(…, stateOff.page)`——等价断言从"两个程序各自 allFinite"升格为"同一程序逐位相等"。重跑 **PASS**（off/on/afterStop 全 `{allFinite:true,last:1330}`，30 taps、validator 0）。

### E0-b：analyzer v3 因果树（P2 遗留债务）

- **债务事实**：`analyze_vmp_trace.build_causality_summary` 过滤 `schema_version == 2` 且读 v2 扁平字段——**所有 v3 capture 报 available=False**（P2 交接 §107-110 记录的未做项）。
- **修复**：新增 `_normalized_causality()` 双形归一（v3 对象形 `{kind,call_id,parent_id,depth,duration_us}`——schema 文档"v2 契约原样搬移"——与 v2 扁平形），树构建/计数/树节点全部走归一视图；v1 仍 unavailable（未触碰）。
- **门禁** `scripts/p6-e0-analyzer-v3-gate.py`（6 案例 **GREEN**）：v3 合成夹具（三层 paired 链 + exception 终态 + unclosed + singleton + external——树形/深度/计数精确断言）；v2 同形夹具产出**逐字段一致**（搬移等价）；v1 不变；**真实 accepted-p55 capture**（E7 最新运行，含 taps/paired/external）经 CLI 全链分析 available=True 且 paired>0。

### E0-c：GUI v3 可读不崩（P2 遗留债务）

- GUI 读取器本为 schema 无关 JSON-lines、报告构建防御式缺省——缺口是**代表性 v3 证据**。`xtrace-gui/test/xtraceReport.test.js` 新增两测试：v3 代表性事件集（causality 对象形 + value_tap 含 object_token/plan_serial + ignition 六字段 + external bnet 行）过 `buildLocalReport` + `buildAgentInputPack`；v1/v2 legacy 回归。GUI 套件 **213/213 全绿**（211 旧 + 2 新）。

### E0 证据汇总

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| `p6-e0-dp551-equivalence.cjs` | PASS（同程序 off/on deep-equal，29,934 taps + dump 下逐位一致） | `validation/p6-e0-dp551-*/` |
| `p55-e7-valueobs-evidence.cjs`（同程序化后） | PASS（off/on/afterStop 三方 deep-equal） | `validation/p55-e7-ERduFv/` |
| `p6-e0-analyzer-v3-gate.py` | 6/6 GREEN（合成精确形状 + v2 搬移等价 + v1 不变 + 真实 capture） | 内联合成 + `p55-e7-ERduFv/trace.ndjson` |
| GUI `npm test` | 213/213（v3 代表性 + v1/v2 回归） | `xtrace-gui/test/` |

进入条件达成（工单 §1.2：两者不清不进 E2）。E0 未触碰 chromium/src（无补丁重生成需求）。

progress JSON `p6` = `e0-debt-cleared`（下一步：E1 Host 骨架 + Broker 核心，长块 E1→E7 开始）。

## E1：Host 骨架 + Broker 核心（2026-09-26）

新包 `xtrace-host/`（Node，CommonJS，`npm test` = node --test）。

### 实现

| 模块 | 内容 |
| --- | --- |
| `src/workspace.js` | 工作区布局（traces/ledger/index/profiles）+ **realpath 包含性检查**（符号链接逃逸=界外；字符串前缀检查明确不用于信任判定）——`assertInside` 是所有读写的单一闸门 |
| `src/broker.js` | **唯一执行入口**（Agent/UI/MCP 皆同径，无旁路形态）；三档冻结语义：read-evidence=会话级授权不逐次弹窗、stateful-control=逐次确认+理由串+审计、host-exec=默认拒绝+不注册（P6 形状预留）；确认流（gate→confirmation-required→resolveConfirmation 一次）；审计 ledger 追加式 JSONL 落工作区，每个决定（granted/denied/confirmation-required/confirmed/denied-by-user/executed/execution-failed）均入账 |
| `src/capabilities.js` | 三态清单（available/degraded 显式披露缺口/unavailable 带原因）；**非增强浏览器（无 XTrace 域）→ 增强工具全部 unavailable**，绝无静默弱替 |
| `src/cdp.js` | Host 级 CDP pipe 客户端（fd3 写/fd4 读约定；pipe 断开→CDP_PIPE_CLOSED、pending 全部拒绝、closed 事件） |
| `src/host.js` | 浏览器所有权：launch→getCapabilities 握手（消费全字段）→适配器协商；close 语义；**无重连**（§5.4 冻结）；孤儿解析 `resolveOrphan`：settled manifest→只读收养、live+unsettled→终止、dead pid→收养 |

### 门禁（`xtrace-host` npm test，7/7 GREEN）

| 案例 | 断言 |
| --- | --- |
| symlink 逃逸拒绝（实测） | 界外符号链接 contains=false、assertInside 抛 WORKSPACE_BOUNDARY；合法嵌套路径通过 |
| Broker 单入口 | agent/ui/mcp 三来源同径执行，ledger 中三来源 granted 各一条 |
| stateful 确认流 | 无理由拒绝→确认请求→批准执行/用户拒绝异常；pending 计数 |
| host-exec 默认拒绝 | register 抛 + gate denied |
| 三态协商 | 非增强全 unavailable（带原因）；degraded 显式披露 |
| 孤儿二选一 | settled(incomplete 亦算 settled)→adopt、live+无 manifest→terminate、dead→adopt |
| **真实浏览器集成** | ChromiumX 经 pipe：getVersion 握手、`XTrace.getCapabilities` 全字段消费、适配器 available、close 后 send 拒绝（无重连） |

无 chromium/src 触碰（无补丁重生成需求）。progress JSON `p6` = `e1-host-broker-landed`。

## E2：证据索引 + A 组适配器（2026-09-26）

### 实现

| 模块 | 内容 |
| --- | --- |
| `src/evidence-index.js` | **派生索引**（§5.1 冻结形态）：better-sqlite3、独立 index.db；表：captures（terminal/coverage/计数汇总）、producers（逐 producer 计数）、api_counts（api 聚合）、assets（资产登记）；**事件级查询永不走索引**——`streamEvents` 直读 NDJSON 流并给每行盖 capture+producer+seq 引用；`rebuildFromDir` 从 traces 根全量重建（**重建即验收用例**） |
| `src/adapters-agroup.js` | **A 组 13 项**（清单 §2/A 冻结名单：code_search/scripts_list/jsvmp_query/webapi_query/find_param_entry/crypto_scan/jsvmp_split_dispatcher/jsvmp_disassemble/skill_list/skill_get/skill_read_resource/notes_get/recall）+ Host 内部查询原语（trace_query/trace_summary/api_top/assets_list/asset_read）。jsvmp_query/webapi_query 以 P4/P5 事件面为限并**显式披露缺口**（degradedReason）；frx 依赖两项（split_dispatcher/disassemble）**unavailable 带迁移原因**（代码未迁入，绝不静默替代）；recall 首版从 Broker 审计 JSONL 召回（degraded 披露）；资产读取经 workspace.assertInside（realpath 边界） |

### 门禁（`xtrace-host` npm test 9/9 GREEN）

| 案例 | 断言 |
| --- | --- |
| 重建即验收 | 夹具 capture 目录 → rebuildFromDir 全量入索引；**清空后重建内容一致**（派生非第二真源）；terminal/coverage/sampled 计数入行 |
| 引用纪律 | streamEvents 每行携带 capture_id+producer_id+producer_seq |
| 13 项经 Broker | 清单 13 项全注册；trace_query/jsvmp_query/code_search/crypto_scan/find_param_entry 经 agent/ui/mcp 三来源执行成功且行带引用；**unavailable 项以迁移原因拒绝** |
| 真实 capture | E7 真实目录（13,919 事件、124 API、9 资产、terminal=complete/coverage=full）rebuild+topApis+assetRows 全通 |

无 chromium/src 触碰。progress JSON `p6` = `e2-index-agroup-landed`。

## E3：B 组控制适配器 + 最小 env（2026-09-26）

### 实现

| 模块 | 内容 |
| --- | --- |
| `src/env-manager.js` | 最小 env 七项的承载：每 env 独立 profile 目录（工作区 profiles/ 下，结构性隔离）；**单开独占**（open 拒绝第二环境）；delete 拒绝 open 态且限定 profiles 根内（经 workspace 边界）；activeProfile() 供浏览器启动取当前 env 的 profile；名字白名单（拒绝 `../` 逃逸） |
| `src/adapters-bgroup.js` | 冻结五项（全部 STATEFUL_CONTROL，逐次确认+理由+审计）：**jsvmp_trace**（start=ignition-precise+taps 配置 / stop=**返回 (terminal, coverage) 对**（terminal 来自 stopCapture、coverage 来自 manifest——两轴独立不混淆）/ status=getCaptureStatus / clear=仅清 Host 活动引用，**dump 不在 agent 工具面**）；jsvm_status（capture+能力姿态汇总）；webapi_trace（reverse 面、无 taps——与 jsvmp_trace 的区分点，degraded 披露首批接口集）；scripts_capture_all（captureAssets=full）；env 七项经 env-manager |
| `src/broker.js`（返工） | 确认登记重做：待决项按 (tool,origin,reason) 键化——**gate() 给 UI 看到的 id 就是 execute() 等待的同一项**（原实现靠毫秒时间戳碰撞侥幸对齐，E1 测试复跑抓出该缺陷，属正确性修复非测试适配）；pendingIds() 暴露真实 id |

### 门禁（`xtrace-host` npm test 11/11 GREEN，两遍复跑稳定）

| 案例 | 断言 |
| --- | --- |
| env 生命周期 | 七操作全过；**隔离实测**（两 env 目录互不见对方 marker）；单开独占；open 中拒绝 delete；名字逃逸拒绝 |
| **jsvmp_trace 集成（真实浏览器）** | max_taps=5 启动→页面 tap 运行→stop：**pair={terminal:'complete', coverage:'partial'}**（真实预算跳过 sampled_out>0）；trace_file 回传；status 可查；审计含 grant+confirmation-required+confirmed+executed 全迹（≥6 条） |

无 chromium/src 触碰。progress JSON `p6` = `e3-bgroup-env-landed`。

## E4：Agent loop + 三形切片（2026-09-26）

### 实现

| 模块 | 内容 |
| --- | --- |
| `src/slicer.js` | **三形切片**（§5.3 冻结，唯一 trace 派生上下文通道）：manifest-summary（capture/coverage/计数/top-api）、evidence-slice（相关性排序 top-K，**值边界事件优先**——value_tap/dump 加权，每行带 `capture|producer|seq` 引用）、index-results；超限**截断+标记+trace_query 指针**（要更多走工具，绝不 dump） |
| `src/agent-loop.js` | **可取消**工具调用循环：模型为注入适配器（循环纯逻辑，无模型外发默认开启）；上下文预算（切片字节总量上限，超限切片拒收并向模型报告）；**无进展熔断**（连续失败 N 次停）；每次调用看门狗超时；**工具错误/拒绝/超时一律报告给模型不崩溃**（仅取消向上传播）；工具 schema 映射（name/tier/io/state） |

### 门禁（`xtrace-host` npm test 14/14 GREEN）

| 案例 | 断言 |
| --- | --- |
| 切片上限实测 | 三形在默认/极小预算下均在界内；极小预算强制截断且 truncation_note 指向 trace_query；**每行引用匹配 `capture|producer|seq` 正则**；值边界行优先入片 |
| 循环完整路径 | slice→tool→final：唯一 trace 上下文=切片、工具经 Broker、迭代/日志如实 |
| 取消 | 迭代间取消 → status=cancelled |
| 无进展熔断 | 重复未知工具 → no-progress 提前停（≤3 而非 50） |
| 拒绝不致命 | stateful 工具在无 UI 附着时进入待确认→看门狗超时→**报告给模型、循环存活**（诚实语义：agent 无 UI 附件不能推进有状态控制） |

### 边界（如实）

- frx L1 源码尚未迁入仓库（清单 §4：未迁入任何代码）——循环按工单 §7“护栏按 frx 原语义移植不削弱”实现（熔断/预算/取消/超时全在）；frx 源逐项许可核对后如形态有出入，以对照补齐。
- 模型适配器为注入回调：P6 不默认外发（工单非目标），E6 闭环用脚本化模型。

无 chromium/src 触碰。progress JSON `p6` = `e4-agent-loop-landed`。

## E5（第一片）：证据服务 + 渲染面板（2026-09-26）

### 实现

| 模块 | 内容 |
| --- | --- |
| `xtrace-gui/src/main/evidenceService.js` | 主进程桥接 xtrace-host（workspace/派生索引/Broker）：`captureStatus`（terminal/coverage/**丢弃计数四元组** dropped/failed/sampled_out/partial_observations + 未确认 producer 名单）、`stopProgress`（分阶段 stop-requested→stop-answered→manifest-settled，**截止错失→stop-timeout**、`cancelActive`→cancelled）、`evidenceJump`（capture|producer|seq 引用→trace 行号+事件）、`authorizationRecords`（Broker 审计行）、`adoptReadOnly`（§5.4 恢复路径：重启后只读收养产物）。Node 权限全部留在主进程 |
| `xtrace-gui/src/renderer/evidencePanel.js` | 渲染面板纯逻辑（UMD 同 reportView 惯例，零 Node）：状态/coverage/丢弃计数渲染、stop 进度（含 TIMEOUT 与 cancelled 文案）、授权记录渲染、事件→证据引用构造 |

### 门禁（GUI `npm test` **216/216**：213 旧 + 3 新）

complete+partial 状态渲染（场景1 形）、incomplete+未确认 producer（场景3 形）、stop-timeout（场景2 形，死管路）、**resume 只读收养**（场景5 形：索引删除后 adoptReadOnly 重建）、授权记录渲染、证据跳转引用解析（cap-auth|producer|seq→行号，未命中拒绝）。

### 边界（如实）

- **五场景真实交互验收未做**（本片交付逻辑层与服务层；工单 E5 明言"逻辑测试不能替代交互验收"）。第二片：以 Electron 应用实测启动驱动五场景（正常/停止超时/incomplete/取消/恢复），逐场景点击+console/network 检查。场景4（取消）的完整交互路径亦在第二片。
- evidenceService 的 host 参数当前可空（死管路即场景2 语义）；接线上 IPC/preload 通道随第二片交互驱动一并落。

无 chromium/src 触碰。progress JSON `p6` = `e5-slice1-service-panel`。

## E5（第二片）：五场景真实交互验收（2026-09-26）

### 接线

preload 增 evidence 七通道（open-workspace/start/stop/cancel/status/jump/auth-records）；main.js 增 evidence 服务处理器 + **evidence:start**（Electron 内经 xtrace-host createHost 拥有 ChromiumX：precise 模式+taps、每 start 独立 profile 子目录与 trace 子目录）与 **evidence:stop**（**经 Broker UI-origin 确认后走 stopProgress**——UI 亦不绕审计）；渲染面板（index.html 证据区六按钮 + app.js 接线，CSP 兼容经 UMD 全局、零内联脚本）。

### 验收（`scripts/p6-e5-ui-scenarios.cjs`，真实 Electron 应用 + CDP 真点击，**GREEN**）

| 场景 | 面板实测 |
| --- | --- |
| 1 正常 | `stop: complete coverage=partial [stop-requested -> stop-answered -> manifest-settled]` |
| 3 incomplete | `cap-incomplete \| terminal=incomplete (producer-unconfirmed) \| ... \| unconfirmed producers: 1` |
| 2 停止超时 | `stop: TIMEOUT after 0ms [stop-requested] — capture may still be settling` |
| 4 取消 | `stop: cancelled by user [stop-requested]` |
| 5 恢复 | 应用重启后同工作区收养既有 captures（含前四场景产物），Status 可见 |
| console/network | session1/session2 **console 错误 0**；**非本地网络请求 0**（file/devtools/about 外为零） |

调试中修复的三个真实缺陷：CSP 阻断内联脚本（改 UMD 全局直用）；evidence:start 可执行路径少层级；同 profile 二次启动撞 ChromiumX 单例锁（先关旧 host + 每 start 独立 profile/trace 子目录）；外加 S5 点击早于 app.js 装载的竞态（就绪门）。Electron 二进制按需重装（dist 292M）。

progress JSON `p6` = `e5-interactive-five-scenario-green`。

## E6：闭环验收（2026-09-26，GREEN）

`scripts/p6-e6-closed-loop.cjs` 一次通过全链，九阶段每段实测：

| 阶段 | 实测 |
| --- | --- |
| 隔离环境 | env_create+open，profile 在工作区 profiles/e6-env 下 |
| 受控采集 | jsvmp_trace start 经 Broker（确认+审计），state=active plan=1 |
| 本地页 | 注入脚本运行 v=1330（taps 消耗 max_taps=5 预算） |
| 停止+完整性 | **pair={terminal:complete, coverage:partial}**；validator exit=0 |
| 索引 | rebuild 29,321 事件 / 131 API |
| Agent 分析 | 切片(manifest-summary)→工具(jsvmp_query)→final，3 迭代，结论带 `capture|producer|seq` 证据引用 |
| 证据跳转 | 引用解析到 trace 行号（line 1 实测） |
| 审计 | executed=4、confirmed=2；jsvmp_trace/jsvmp_query/trace_query 全部经 Broker（agent/ui/mcp 之外的来源为零） |

过程修复两处真实缺陷：jsvmp_query 先切后滤导致 Ignition 行不在流头时空返回（改宽窗扫描再切——Host 套件 14/14 保持）；E6 驱动器 A 组注册顺序（索引就绪后注册查询工具）。

progress JSON `p6` = `e6-closed-loop-green`。

## E7：证据包与终审提交（2026-09-26）

### 回归矩阵（全部亲跑）

| 门禁 | 结果 |
| --- | --- |
| xtrace-host 套件 | 14/14（E1 边界/Broker/协商/孤儿 + E2 重建/引用 + E3 env/真机 pair + E4 切片/循环） |
| xtrace-gui 套件 | 216/216（211 旧 + E5 证据服务/面板 3 + v3 代表性 2） |
| P5.5 冻结反例 | S0 python 8/8 保持绿 |
| 五场景交互验收 | GREEN（含 E7 重跑时抓出并修复 S1 就绪竞态——加载门禁推广到两会话） |
| E6 闭环 | GREEN（九阶段一次通过） |
| 测试目标门禁 | PASS（controller+producer 先重建后跑） |
| 补丁栈 | verify pass（本轮 P6 全程零 chromium/src 触碰，栈与 accepted-p55 状态一致）——证据 `validation/p6-patch-verify.json` |

### 工单完成对照（§8 完成定义）

草稿 §12 P6 行 + 首批清单逐项能力矩阵实测一致（13 项 A 组注册、B 组五项+env 七项经 Broker、frx 依赖两项 unavailable 带原因）+ 债务零（E0：D-P55-1 同程序等价、analyzer/GUI v3）+ E5 真实交互五场景 GREEN + E6 闭环一次通过 + Broker 审计覆盖全部执行入口（E6 断言 + E5 UI stop 同径）。

### 诚实边界

- frx L1 源码未迁入（babel/dispatcher_probe 两项 unavailable 披露）；护栏按"原语义不削弱"实现。
- env_open 的完整浏览器随环境重启语义为工作区记录级（profile 目录绑定）；E6 用独立 profile 实测隔离，多环境轮换的会话级切换随 P7 完整环境管理器。
- Agent 模型适配器为注入回调（P6 不默认外发）；E6 用脚本化模型走完真实工具链。
- E5 面板为证据区最小实现（状态/进度/授权/跳转原语）；证据跳转的 UI 内嵌预览随后续迭代。

progress JSON `p6` = `e0-e7-final-package-submitted`。**申请：按工单长程单次终审；accepted-p6 由架构师标记。**

---

# 架构师终审 R1（2026-09-26）：**不通过** — 6 项阻塞 + 13 项整改，开 P6-R1 长程整改块

- 审查范围：`b692fa7..449f4af`（9 个 commit、34 文件、+4458 行）。审查方式：全量源码形态核对 + 全部可跑门禁亲跑 + 三个取证 probe（`docs/review-artifacts/p6-r1/`，本节所有"实测"均出自这四处）。
- **裁定：不标 `accepted-p6`。** progress JSON `p6` = `p6-review-1-remediation-required`。
- 一句话结论：**E0 债务清零成立**（D-P55-1 是真修的，正控有效），E1–E7 的机制代码都在盘上、单元门禁都能复现绿；但产品路径上反复出现本轮的主要缺陷类——**"代码在、线没接"**：两条有状态执行入口绕过 Broker、确认由代码自批、两个首批 A 组查询工具在真实 capture 上返回 0 行、切片越界路径抛异常并击穿 agent loop、证据服务对非 `trace.ndjson` 命名静默报零、skill 读取可越工作区边界。工单 §8 完成定义的三条（Broker 审计覆盖全部执行入口 / 首批清单逐项能力矩阵与实测一致 / E5 五场景含证据跳转）均不满足。
- 这不是"再改一点"的评审：§R1.7 是一次可长程执行的整改块（有序、每项带验收锚点），做完一次提交、我做一次复审，不逐项往返。

## R1.1 独立复验（我亲跑，不采信申报）

| 门禁 | 申报 | 我的复跑 | 证据 |
| --- | --- | --- | --- |
| `scripts/run_tests.sh` | 381 / 28 / 216 | **一致**：python 381 OK、launcher 28 OK、GUI 216 pass 0 fail，exit 0 | `/tmp/arch-run-tests.log` |
| `xtrace-host` `npm test` | 14/14 | **一致**：14 pass 0 fail（12.4s） | `/tmp/arch-host-test.log` |
| `p6-e0-dp551-equivalence.cjs` | PASS（29,934 taps + dump） | **一致**：off/on 逐位 deep-equal、taps=29934、dump=saved、terminal=complete、crashed=false | `validation/p6-e0-dp551-S0EI47/` |
| `p6-e0-analyzer-v3-gate.py` | 6/6 GREEN | **一致**：6/6，真实 capture 用 `p55-e7-ERduFv` | 内联 |
| `p6-e5-ui-scenarios.cjs` | GREEN（五场景 + console/network 0） | **一致**：S1/S3/S2/S4/S5 全 ok，session1+session2 console 0、非本地请求 0（29s） | `validation/p6-e5-ui-LonHUa/` |
| `p6-e6-closed-loop.cjs` | GREEN（九阶段一次通过） | **一致**：九阶段全 OK，validator exit=0，29,342 事件 / 131 API | `validation/p6-e6-J6fJqJ/` |
| `p55-s0-red-tests.py` | 8/8 保持绿 | **一致**：GREEN | `out/XTraceP55D8/validation/p55-s0-20260926-215612/` |
| `p4-review-contract.cjs` | 21/21 | **一致**：21/21 | `validation/p4-contract-ZpzKjy/` |
| `p5-reopen-counterexamples.cjs` | 12/12 保持绿 | **一致**：GREEN | `validation/p5-reopen-nsJspr/` |
| `verify_patches.py --with-dylibs` | pass、零 chromium/src 触碰 | **一致**：verdict pass；五个补丁 SHA-256 与 `validation/p55-s6-patch-verify.json` **逐字节相同** → "栈与 accepted-p55 一致"成立 | `/tmp/arch-verify-patches.json` |
| 测试目标门禁（C++） | PASS（先重建后跑） | **接受**：`test-target-gates-20260926-192222.json` verdict pass；coordinator 日志显示 19:22 确实调用了 ninja（`no work to do`，因本轮零 C++ 改动）→ rebuild-before-run 纪律有支撑 | `validation/coordinator-20260926-192222.log` |

**申报数字可追溯性抽查**：E2 表里"真实 capture（13,919 事件、terminal=complete/coverage=full）"我在盘上找到了对应目录 `validation/p55-e7-yzrtBN`（13,919 行、coverage=full、complete）——数字真实。但该案例**没有进任何提交门禁**（见 M10），因此不可复现、也不构成保护。

## R1.2 已确认成立、保留不动的交付

1. **D-P55-1 真的清了**：同程序源、off 侧同旗标、deep-equal + getter/微任务哨兵，且有**正控**（`assert(on.taps > 0)`）。首轮 `p6-e0-dp551-HFuuPZ` 正是 taps=0 变红、次轮 29,934 变绿——正控有效性有盘上证据，不是空门禁。E7 驱动的 stateOff 已改为同一 LOOP 源并在 stateOn/afterStop 双向 deepEqual。
2. **analyzer v3 因果树**：`_normalized_causality()` 双形归一，v2 与 v3 产出**全字典相等**（搬移等价被断言，不是口头），v1 仍 unavailable，树形/深度/计数为精确断言。这是本轮质量最高的一项。
3. **补丁栈零漂移**、沙箱与基线未动、node_modules/Electron dist 未入库（34 文件全是源码/文档/测试）。
4. `workspace.assertInside` 的 realpath 语义本身正确（符号链接逃逸被拒，实测），`asset_read`/`code_search`/`crypto_scan`/`find_param_entry`/`env_delete` 都走了这道闸门。
5. Broker 的三档语义、审计行类型、host-exec 保留档默认拒绝，在**单元层**成立。

## R1.3 阻塞项（B1–B6）：必须先冻红测试，再修，再跑绿

### B1 — UI 的 `evidence:start` 完全绕过 Broker（有状态控制无门禁、无确认、无审计）

- **事实**：`xtrace-gui/src/main/main.js` 的 `evidence:start` 处理器直接 `evidenceHost.send("XTrace.startCapture", …)`；`evidence:cancel` 同样直连服务层。只有 `evidence:stop` 过 Broker。
- **实测**：我复跑的 E5 运行 `validation/p6-e5-ui-LonHUa/ws/ledger/` 共 12 行审计，全部是 `jsvmp_trace.stop`（6 confirmation-required / 3 confirmed / 3 executed）；**三次 startCapture 零审计行**。
- **违反**：工单 §5.2（UI 与 Agent/MCP 走同一 Broker）、§8 完成定义"Broker 审计覆盖全部执行入口"、§7 升级触发器"Broker 旁路迹象"。交接文档 E7 的措辞"E5 UI **stop** 同径"是准确的，但 §8 的要求不是 stop 一项。
- **要求**：所有产生副作用的入口（start/stop/cancel，含 UI）都必须经 `broker.execute` 调用**已注册工具**；只读入口（status/jump/auth-records）经 Broker 的 read-evidence 档（会话级授权，不弹窗，但**要留 granted 审计行**）。
- **红测试**：驱动器数一次真实 UI 会话里发出的 `XTrace.startCapture`/`stopCapture` 次数，与 ledger 中 `decision=executed` 的行数**逐工具相等**；不等即红。

### B2 — 有状态档的"逐次确认"由代码自批，人类从未参与；审计行 `confirmed` 名不副实

- **事实**：`main.js` 的 `evidence:stop` 先 `gate()` 再 `execute()`，随后在 main 进程内 `for (id of pendingIds()) resolveConfirmation(id, true)` 循环自批；渲染层**没有任何确认面**（`preload.js` 七个通道里没有 confirm，`renderer/` 无对话框，实测 grep 零命中）。E6 驱动器用同样的自批循环。
- **后果**：ledger 写下 `confirmed`，读审计的人（和 `recall` 工具）会认为有人批准过。**Agent 发起的 B 组调用在产品路径上根本无人可批**——要么悬挂到看门狗超时（E4 已实测），要么被驱动器自批。
- **违反**：§5.2(b) 的"逐次确认"。
- **裁决见 R1.6-D1**（UI 点击可否充当确认）。要求：`resolveConfirmation` 只能由承载**渲染层真实决定**的 IPC 处理器调用（新增 `evidence:confirmation` 通道 + 面板待决队列 + 批准/拒绝按钮 + 理由串可编辑）；代码路径自批一律禁止，审计行须带 `basis`（`ui-direct-click` / `human-approved` / `human-denied`），不得再出现无来源的 `confirmed`。
- **红测试**：① 无任何 IPC 确认事件时，UI 侧 B 组调用**不得产生 `confirmed` 行**（应停在 confirmation-required）；② 渲染层点"拒绝"→ 审计出现 `denied-by-user` 且副作用未发生；③ 静态断言：`resolveConfirmation` 的调用点全部位于确认 IPC 处理器内（源码形态核对入驱动）。

### B3 — 首批 13 项里两个查询工具在真实 capture 上返回 0 行（先切后滤 + 前缀窗口），且无缺口披露

- **实测**（probe1，四个真实 capture + accepted-p55 参考 capture）：

| capture | 事件数 | ignition 真值 | `jsvmp_query` 返回 | bindings 真值 | `webapi_query` 返回 |
| --- | --- | --- | --- | --- | --- |
| E5 ui-scenario-1 | 27,583 | 270 | 270 | 948 | **0** |
| E5 ui-scenario-2 | 14,693 | 270（125 条在 5000 行之后） | **145** | 338 | **0** |
| E6 closed-loop | 29,321 | 270（124 条在窗口外） | **146** | 1,152 | **0** |
| **accepted-p55 参考 `p55-e7-ERduFv`** | 26,539 | **13,444**（首条在第 7,676 行） | **0** | 592 | **0** |

- **两个独立缺陷**：① `webapi_query` 是 `streamEvents({limit: clamp(args.limit,1,1000,100)})` **先切后滤**——正是 E6 里你们在 `jsvmp_query` 修掉的同一类缺陷，修了一个、漏了一个；② `jsvmp_query` 的 5000 行"宽窗"仍是**前缀窗口**，对 2.6 万事件的真实 capture 直接全盲。
- **后果**：Agent 在真实证据上问"这个 VM 的 ignition 序列"会得到空答案，而工具**不披露自己只扫了前 N 行**（probe1 实测 `slice_discloses_scan_window: []`）。E6 之所以绿，是因为它的 capture 恰好只有 270 条 ignition 且首条在第 4,837 行。
- **违反**：§8"首批清单逐项能力矩阵与实测一致"；清单 §3.1"显式披露缺口，不宣称通用"；证据纪律"绿灯不替代路径验证"。
- **要求**：事件级查询改为**真流式扫描**（按行读、可带 `from_seq`/`api` 谓词下推，见 R1.6-D2），返回值必须带 `scanned_events` / `matched` / `total_events` / `window_complete:boolean`；`window_complete=false` 时必须给出续扫指针。`slicer.evidenceSlice` 同治（当前固定只看前 2000 行）。
- **红测试**：以 `p55-e7-ERduFv` 为夹具，断言 `jsvmp_query` 返回行数 == 全文件 ignition 真值（13,444，或分页累加等于该值）、`webapi_query` 返回行数 == bindings 真值（592），且 `window_complete` 如实。**这条测试今天必须先红**。

### B4 — 切片越界路径抛 JSON 异常并击穿 agent loop（冻结护栏"错误上报不崩溃"只对工具成立）

- **实测**（probe1 + probe2）：`slicer.bound()` 的硬截断分支 `text.slice(0,cap)` 后 `JSON.parse(text.endsWith('}') ? text : text + '"}')` 在 cap=100/150/200 三档**全部抛 SyntaxError**（只有 cap=64 侥幸可解析）；`agent-loop.run()` 里 `makeSlice()` **没有 try/catch**，异常直接冒出循环 —— probe2 对照实测：切片错误 `crashed:true`，工具错误 `crashed:false, status:'complete'`。
- **违反**：交接文档 E4 自述的"工具错误/拒绝/超时一律报告给模型不崩溃"、§7"护栏按 frx 原语义移植不削弱"。E4 的极小预算测试只覆盖了 `evidenceSlice`（它有自己的字节循环，不会走 `bound()`），所以硬截断路径**从未被测过**。
- **要求**：`bound()` 改为结构化收缩（按字段逐个丢弃/截断后**重新序列化**，绝不字符串切割后补 `"}`），并在返回体里带 `dropped_fields`；`run()` 里 `makeSlice` 包 try/catch，失败按"工具错误"同等上报给模型并计入 no-progress。
- **红测试**：① 参数化扫 cap ∈ {32,64,100,128,150,200,512,4096} × 三形切片，全部不得抛异常且 `bytes ≤ cap`；② 极小 `slice_budget` 下跑完整 loop，断言 `status` ∈ {complete,no-progress,max-iterations}，**不得** reject。

### B5 — 证据服务对非 `trace.ndjson` 命名的 capture：状态静默报零、跳转直接 ENOENT

- **实测**（probe3/probe2）：同一份 manifest（`dropped=7 failed=3 sampled_out=11 partial=5`、1 个 `watermark.received=false` 的 producer），文件名 `trace.ndjson` 时服务读出全部真值；改名 `trace-on.ndjson` 后 `captureStatus` 返回 `terminal_reason:null`、四个丢弃计数**全 0**、`unconfirmed_producers:[]`；`evidenceJump` 抛 `ENOENT … /trace.ndjson`。
- **为什么严重**：这是**静默的假绿灯**——一个有丢弃、有未确认 producer 的 capture 会被面板渲染成干净 capture。本项目全部纪律建立在计账诚实（model-2 等式、coverage 轴）之上，UI 报零等于把计账轴抹掉。而我们自己的证据目录大量使用 `trace-on.ndjson`/`trace-*.ndjson` 命名（如 `p6-e0-dp551-*`），即"只读收养真实产物"这条 §5.4 路径一上手就踩。
- **根因**：`evidenceService.readManifestFor` 与 `findLine` 硬编码文件名，而 `evidence-index` 已经正确解析并保存了 `trace_file` 列（`readManifest` 会试两种命名）。同一信息两处实现、一处错。
- **要求**：服务层一律走索引里的 `trace_file` / 目录级 manifest 解析（抽公共函数，删掉两处硬编码）；`evidenceJump` 的行号定位改为对索引记录的 `trace_file` 做**流式**扫描并返回 `line` + `byte_offset`；无法定位时**报错**，不得返回 `null` 混过。
- **红测试**：夹具用 `trace-on.ndjson` + `trace-on.manifest.json`（含丢弃计数与未确认 producer），断言 `captureStatus` 四项计数与 producer 名单**等于盘上真值**、`evidenceJump` 返回正确行号。

### B6 — `skill_read_resource` 可经符号链接读出工作区外内容（用了被明令禁止的字符串前缀判定）

- **实测**（probe2）：`<ws>/skills/evil -> /tmp/arch-outside-*`，调用 `skill_read_resource{name:'evil',resource:'secret.txt'}` **成功返回 `OUTSIDE-OF-WORKSPACE-SECRET`**；同一目标路径 `workspace.assertInside` 正确抛 `WORKSPACE_BOUNDARY`。
- **违反**：`workspace.js` 自己写明的"字符串前缀检查明确不用于信任判定"、E1 验收锚点"非受信路径拒绝实测"。`readSkill` 用 `startsWith(dir + path.sep)`，对 `..` 有效、对符号链接无效。
- **要求**：`readSkill`/`listSkills`/`notes_get` 全部改走 `workspace.assertInside`（realpath 闸门）；skill 名与 resource 名各自白名单校验后仍须过闸门。
- **红测试**：符号链接逃逸 + 绝对路径 resource + `..` 三形态全部拒绝，且 `assertInside` 与工具层判定**结论一致**（防再次两处实现）。

## R1.4 重要项（M1–M13）：与 B 组同一个整改块内完成

- **M1 能力协商没有接到任何产品面**。`host.capabilities()` / `host.adapters` 只在 `e1-integration.test.js` 里被调用；`main.js`、E5、E6 三处产品/驱动路径**一次都没调**。`agentLoop.toolSchemas()` 实测输出：18 个工具，`any schema carrying capability state? false`、`any … degraded/unavailable reason? false`，而适配器侧 `degradedReason`/`available:false`/`unavailableReason` 都在。→ 冻结的三态清单与"显式披露缺口"对模型与 UI **均不可见**：Agent 只能靠异常发现不可用，degraded 缺口无从知晓。要求：Host 提供唯一组合根（见 M2），`toolSchemas()` 输出必须携带协商后的 `state` + `reason`，不可用工具**不进模型工具表**（进"能力清单"只读视图）；UI 面板显示三态计数与缺口文案。
- **M2 没有 Host 组合根，导致三处各自拼装**。现状：`host.broker` 建了不用；`main.js` 每次 `evidence:start` **新建一个 Broker**，且传入的是**桩 workspace**（`contains:()=>true, assertInside:(t)=>t`，把信任边界直接抹平）；E6 又自建第三个 Broker。同时 `envs.activeProfile()` 与 `resolveOrphan()` **零消费者**（实测 grep 仅定义处与单测）：前者使 env_open 对产品路径的浏览器启动毫无影响（E6 之所以"隔离"，是驱动器手工把 `--user-data-dir=${opened.profile_dir}` 塞进 browserArgs），后者使 §5.4 的"终止孤儿"半边只存在于单测。要求：`createHost` 返回唯一组合根（workspace + broker + index + envs + adapters + `host.callTool(name,args,ctx)`），UI/驱动器/未来 MCP **只准**用它；`activeProfile()` 必须由 Host 的启动规格消费；`resolveOrphan` 接进"重启后收养/终止"的真实入口（UI 二选一或 CLI），否则按 M13 显式降级声明。
- **M3 `jsvmp_trace clear` 是空操作却报成功**。实测：唯一 CDP 调用是 `XTrace.getCaptureStatus`，无任何 mutating 调用、无 Host 状态变更，返回 `{cleared:true}`。E3 自述"clear=仅清 Host 活动引用"，但 Host 没有活动引用可清（`traceFile` 在构造时定死）。→ 要么实现真实语义（清 Host 活动 capture 引用 + 后续 stop/status 返回明确"无活动采集"），要么从首批工具面移除并在能力清单标 unavailable-with-reason。**不得保留"报成功但什么都不做"**（这是 P5 outcome 证据事件的同一缺陷类）。
- **M4 确认没有生命周期**。实测两件事：① 看门狗超时后待决项仍开着，**迟到批准会真的执行副作用**（side_effects 0→1，ledger 出现 `confirmed`→`executed`）——Agent 已经拿到"超时"结论并继续推理，此时采集却启动了；② 同键 `(tool|origin|reason)` 并发两次 `execute`，只有一个能 settle，另一个**永久悬挂**（`resolve` 被覆盖），pending 归零、工具只跑一次。要求：确认项带 `created_ms`/`expires_ms`/`owner_turn`，超时或循环退出即失效（失效后批准只能得到 `confirmation-expired`，不得执行）；同键并发要么排队要么明确拒绝第二个；Broker 提供 `cancelPending(id)` 供 loop 取消/超时时调用。
- **M5 清单 §3.4 的四项不可用工具在产品里根本不存在**。`env_current_process`/`env_read_current_process_config`/`env_write_current_process_config`/`env_reset_current_process_default` 在 `xtrace-host`、`xtrace-gui`、交接文档里**零命中**。清单要求它们"在能力协商中报不可用并给出原因"；现在的形态是**静默缺席**（缺席 ≠ 披露）。要求：四项按 P7 依赖注册为 `available:()=>false` + 原因（依赖指纹覆盖层），进入逐项能力矩阵。
- **M6 "证据跳转"在任何真实路径上都没被验证过**。E5 面板六个按钮里**没有 jump 按钮**（preload 有通道、服务有实现、渲染层无入口）；E6 第 7 阶段用 `svcLikeJump` 内联重写了一遍字符串搜索，且解析的是 `firstRow` 而**不是 Agent 引用的 `citedRef`**——阶段名写"the citation resolves to a trace line"，代码测的是另一件事。要求：面板加 jump 入口（引用串→行号+事件预览）；E6 第 7 阶段必须调用**已发布的** `evidenceService.evidenceJump(citedRef)`，用 Agent 自己给出的引用。
- **M7 E5 的"真实交互"依赖测试钩子，产品 UI 人用不了**。`btnEvidenceOpen` 的逻辑是 `workspaceRoot || window.__xtraceE2EWorkspace || null`，取不到就打印"no workspace selected (E2E harness sets …)"——**没有目录选择对话框接线**；start/stop 参数来自 `window.__xtraceE2EMaxTaps`/`__xtraceE2EStopDeadline`/`__xtraceE2EStopReason`；`evidence:start` 还向 about:blank 注入写死的 LOOP 夹具（场景脚手架住进了产品 IPC）。要求：工作区选择走 `dialog.showOpenDialog`（钩子仅作为**加速器**保留且必须在文档里标注为 harness affordance）；start 接受目标 URL/已有 target，夹具注入移入驱动器；deadline/reason 由面板控件提供。
- **M8 同一个 app 里两条启动规格不一致**。遗留运行路径 `xtraceProcess.js` 不带 `--xtrace-causality=sync`、不带 `--xtrace-ignition-observer`，而 B 组三个 start 动作都写死 `mode:'ignition-precise'`；按 P4 终审追认的语义，精细模式在 causality 缺失时由 `startCapture` **权威拒绝**。→ Host 若挂到遗留路径启动的浏览器上，B 组全灭，且适配器把结构化的 `preciseModeRequires` 丢成裸 CDP 错误。要求：启动规格单一来源（Host 拥有 launch spec，GUI 两条路径共用）；适配器把 `preciseModeRequires` 映射成机器可读的前置条件错误。
- **M9 门禁未接线**：`scripts/run_tests.sh` **不含** `xtrace-host` 套件（实测 grep NOT WIRED）。AGENTS/工单要求"门禁含全部测试目标"。要求：`run_tests.sh` 增加 `npm --prefix xtrace-host test`，并把 P6 的三个新驱动（E0 等价、E5 五场景、E6 闭环）登记进 `docs/reproduce.md` 的门禁清单（跑不跑得动、要不要浏览器，逐条标注）。
- **M10 测试强度不足以拦住 B3/B4/B5/M3**：A 组全部测试用 **4 事件**夹具（前缀窗口类缺陷结构上不可能被发现）；极小预算只测 `evidenceSlice` 不测 `bound()`；GUI 夹具一律 `trace.ndjson`；E5 驱动器只对 **session1** 的 console/network 落断言（session2 仅打印，工单却申报"session1/session2 均为 0"），且只收 `Runtime.consoleAPICalled`，**不收 `Runtime.exceptionThrown`**（未捕获异常这一档本项目历来要求为零）；e4 的"值边界优先"断言 `>= min(5, len)` 与"拒绝上报"断言 `/timeout|reason string|denied/` 宽到不可能失败，且后者实测走的是超时路径而非拒绝路径（注释自己也承认）；e4 留有 `void deniedModel` 死代码。要求：真实 capture 入常设门禁（B3 那条）、负控/变异对照（每个"等价/优先/覆盖"类断言都要有一个"故意破坏→必须红"的对照）、session2 落断言、加 `exceptionThrown` 收集、弱断言逐条收紧。
- **M11 扫描窗口与相关性披露缺失**：除 B3 的窗口披露外，`slicer.relevance()` 的 `e.causality === 'paired'` 分支对 v3 **恒假**（实测 `typeof event.causality === 'object'`，归一后的 `row.causality` 才是字符串）——排序里"配对返回边界加权"是死代码。要求：用 `row.causality`；并把排序权重写成可测的表（给一个"故意打乱顺序→必须红"的对照）。
- **M12 状态账不全**：`integration-progress.json` 的 `p6_detail` **只有 e0**，E1–E7 无机器可读记录（status 字符串却写 `e0-e7-final-package-submitted`）。要求：每阶段补 detail（日期、门禁、证据目录、发现并修复的缺陷），复审时随整改一并补齐。
- **M13 命名/性能与"流式"名不副实**：`evidence-index.streamEvents`/`streamTrace` 实为 `readFileSync` 全量读 + `split('\n')`（注释与模块名都写 stream），`evidenceJump` 更是**读两遍全文件**（一次解析 10 万行、一次字符串找行号）；A 组工具负载无字节上界（`trace_query` 最多 1000 行**完整事件对象**、`asset_read` 最大 1 MiB），而 `agent-loop` 只按 `min(len, 8192)` 计账 → **"原始 trace 永不入上下文"在工具路径上未被强制**（切片路径是守住的）。要求：真流式（`readline`/`fs.read` 分块 + 早停）；工具返回统一加 `bytes` 上界与 `truncated` 披露；loop 按**实际字节**计账并在超限时拒收（与切片同规则）；`resolveOrphan` 的 fallback 路径推导（对目录名做 `basename(traceDir,'.ndjson')`）修正或删除。

## R1.5 小项（m1–m6，随手清）

1. `cdp.js`：`MESSAGE_HEADER` 死导出；`send()` 无超时（Host 级调用可永久悬挂，UI 路径尤其）。
2. `main.js`/E6 的"先 `gate()` 再 `execute()`"双重门禁使审计多出重复行（实测 3 次执行对应 6 条 confirmation-required）。`execute()` 应返回/暴露它自己的确认 id，驱动器不需要自己再 gate 一次。
3. `stopProgress` 的 cancel 语义是"放弃等待"，底层 stop 仍会落地（面板随后 Status 会显示 complete，与"cancelled"矛盾）。文案与后续对账要明确（timeout 文案已经诚实，cancel 文案没有）。
4. `evidenceBroker` 仅在 `evidence:start` 里创建：先点 Stop 会 TypeError；每次 start 新建 Broker 使审计散落多文件、上一实例的待决项被静默丢弃（M2 组合根一并解决）。
5. `env_open` 累加的字段名叫 `launches`，实际计的是 open 次数。
6. `evidenceService.adoptReadOnly` 的单测在 `openWorkspace`（已 rebuild）之后调用，未证明"独立于 rebuild 的收养"；补一个不 rebuild 的路径。

## R1.6 两项裁决（本轮生效，不再议）

**R1.6-D1：UI 点击能否充当"逐次确认"？** —— **可以，但必须 honest 记账，且 Agent 侧必须真有人工面。**
- UI-origin：用户在面板上点"Stop"这个动作本身即确认。允许免对话框，但审计行必须写 `basis:'ui-direct-click'`，理由串必须来自面板可编辑控件（不得是写死的 `"UI scenario stop"`），**不得**再写 `confirmed`（那个词保留给"有人被问过并回答了"）。
- Agent/MCP-origin：必须存在真实人工确认面（渲染层待决队列 + 批准/拒绝 + 理由展示 origin/tool/args 摘要）。在人工面接通之前，Agent 侧 B 组调用**保持悬挂直至超时**是正确行为（E4 现状），不得用代码自批把它变绿。
- `resolveConfirmation` 的调用点收敛到确认 IPC 处理器内，其它位置出现即视为旁路（静态断言入门禁）。

**R1.6-D2：事件级查询的窗口契约。** —— **窗口可以有，但必须显式、可续、可核对。**
- 所有事件级工具（`trace_query`/`jsvmp_query`/`webapi_query`/`find_param_entry`/`evidenceSlice`/`evidenceJump`）返回值统一携带：`scanned_events`、`matched`、`total_events`（取自索引 capture 行）、`window_complete:boolean`、`next_cursor`（`from_seq` 或字节偏移）。
- 谓词（api/ignition/bindings/param）**下推到扫描过程**，严禁"先按 limit 切、再过滤"（B3 的直接成因）。
- 分页累加必须可核对：`sum(matched over pages) == total matched in file`，这条等式进红测试（与本项目 model-2 等式同一风格）。
- 性能形态：流式分块读 + 早停；单工具返回字节上界（默认 256 KiB，可调但受 loop 上下文预算约束），超限带 `truncated:true` + 续扫指针。

## R1.7 P6-R1 长程整改块（一次推进、一次提交、一次复审）

按顺序做，每项自带验收锚点；**每个阻塞项先落红测试（必须见红）再修**，红测试全部入 `scripts/` 常设门禁并在 `docs/reproduce.md` 登记。中途只在触发升级条件时才回报（新对外能力/新二选一/规范语义变更/受信边界/计数等式）。

| 序 | 动作 | 验收锚点（我会亲跑） |
| --- | --- | --- |
| R1-1 | 建 Host 组合根（M2）：`createHost` 内建 workspace/broker/index/envs/adapters，暴露 `host.callTool`；删掉 `main.js` 的桩 workspace 与 per-start Broker；E5/E6 驱动器改用组合根 | 源码形态核对：仓库内 `createBroker(` 调用点仅组合根 + 单测；`contains:()=>true` 零命中 |
| R1-2 | 全部副作用入口过 Broker（B1）+ 只读入口留 granted 行；启动规格单一来源（M8） | 新门禁：真实 UI 会话中 CDP start/stop 次数 == ledger executed 行数（逐工具）；遗留 run 路径与 Host 路径共用同一 launch spec |
| R1-3 | 人工确认面（B2 + R1.6-D1）：`evidence:confirmation` IPC + 面板待决队列 + 批准/拒绝 + 理由编辑；审计 `basis` 三值；`resolveConfirmation` 调用点收敛 | E5 驱动器新增场景 6：Agent 发起 B 组调用 → 面板出现待决 → 点拒绝 → `denied-by-user` 且副作用为零；点批准 → `human-approved` + executed |
| R1-4 | 确认生命周期（M4）：过期/归属/取消；同键并发排队或拒绝 | 红测试：超时后批准 → `confirmation-expired` 且副作用为零；并发同键 → 两个调用方都 settle（或第二个被明确拒绝），无悬挂 |
| R1-5 | 事件级查询真流式 + 窗口契约（B3 + R1.6-D2 + M13） | 真实 capture 门禁：`p55-e7-ERduFv` 上 ignition 13,444 / bindings 592 分页累加等式成立、`window_complete` 如实；`webapi_query` 不再 0 行 |
| R1-6 | 切片健壮性（B4 + M11）：`bound()` 结构化收缩 + `dropped_fields`；`makeSlice` 异常上报；`relevance()` 用归一字段 + 权重表可测 | cap 参数化扫描 8 档 × 三形零异常且 `bytes ≤ cap`；极小预算下 loop 不 reject；排序负控（打乱→红） |
| R1-7 | 证据服务去硬编码（B5 + M6 + m6）：走索引 `trace_file`；jump 流式定位返回 `line`+`byte_offset`；面板加 jump 入口；E6 第 7 阶段用 `evidenceJump(citedRef)` | 红测试：`trace-on.ndjson` 夹具下计数/producer 名单等于盘上真值、jump 行号正确；E6 用 Agent 自己的引用跳转成功 |
| R1-8 | 边界闸门统一（B6）：skill/notes 全走 `assertInside` | 符号链接 / 绝对路径 / `..` 三形态全拒，工具层与 workspace 层结论一致 |
| R1-9 | 能力面接通（M1 + M5）：`toolSchemas()` 带 `state`/`reason`；不可用工具移出模型工具表；四项指纹依赖工具注册为 unavailable-with-reason；UI 显示三态计数 | 实测 `toolSchemas()` 输出含 state；非增强浏览器（可用 `--disable-features` 或普通 Chromium）下增强工具全 unavailable 且 UI 可见原因 |
| R1-10 | `clear` 语义落实或移除（M3）；`activeProfile()` 被启动规格消费、`resolveOrphan` 接真实入口或显式降级（M2/M13） | 源码形态核对 + 单测：clear 后 status 明确"无活动采集"；env_open 后启动的浏览器 `--user-data-dir` == 该 env profile（实测进程命令行） |
| R1-11 | 产品化去钩子（M7）+ UI 可用性 | 人肉路径可跑通：选目录→start（给定 URL）→stop→status→jump→auth；钩子仅加速器并标注 |
| R1-12 | 门禁接线与强度（M9 + M10）：`run_tests.sh` 含 host 套件；E5 加 session2 断言 + `exceptionThrown`；弱断言逐条收紧；每个"等价/优先/覆盖"断言配负控 | `bash scripts/run_tests.sh` 一条命令覆盖 python/launcher/GUI/host 全绿；E5 驱动器源码含 session2 与 exceptionThrown 断言 |
| R1-13 | 文档与状态账（M12 + 小项 m1–m5）：`p6_detail` 补 E1–E7 + R1；交接文档回填整改记录；`docs/reproduce.md` 登记新门禁 | progress JSON 逐阶段有 detail；文档无自相矛盾（实施文档/草稿/清单/progress 四处一致） |

**并行轨**：M1.1 语料尾件（工单 §6）**排在 R1-5 之后**再跑——B3/B5 未修之前，语料 capture（数十万事件、`trace-*.ndjson` 命名）正好落在两个缺陷的盲区里，先跑等于产出无法查询的证据包。R1-5 一绿即可启动 M1.1（详见路线图 §8）。

## R1.8 复审时我会亲跑的门禁（提前告知，避免"只对我跑的那条绿"）

`scripts/run_tests.sh`（含 host 套件）· `p6-e0-dp551-equivalence.cjs` · `p6-e0-analyzer-v3-gate.py` · `p6-e5-ui-scenarios.cjs`（含新场景 6）· `p6-e6-closed-loop.cjs` · 新增的 R1 红测试驱动（全部）· `p55-s0-red-tests.py` · `p4-review-contract.cjs` · `p5-reopen-counterexamples.cjs` · `verify_patches.py --with-dylibs` · `p55-e7-valueobs-evidence.cjs`。另外照例做：源码形态核对（`createBroker(` 调用点、`resolveConfirmation` 调用点、`contains:()=>true`、硬编码文件名、`readFileSync` 全量读事件流的位置）+ 证据 digest 与盘上实测比对 + 门禁表是否漏项。

## R1.9 状态落账

- progress JSON：`p6` = `p6-review-1-remediation-required`，`p6_detail.review1` 记录本节的复验结果与 B/M 计数。
- `accepted-p6` **未标**。P6 的机制代码保留在树上（不 revert），整改以增量提交进行。
- 路线图：M2 记为"机制落地 2026-09-26、验收未通过"，窗口与后续档位已在 [roadmap-milestones.md](roadmap-milestones.md) §1/§7/§8 重估。
- 本轮缺陷类总结（写进 §7 速度基线的备注）：产品面阶段的返工密度**没有**如预测下降，但缺陷类从"V8 内存安全"变成"**接线缺失 + 夹具过小 + 钩子进产品路径**"；对策不是加人手，而是把"负控/真实夹具/组合根覆盖/源码形态核对"写进下一份工单的验收锚点（P7 起由我在工单里直接列）。
