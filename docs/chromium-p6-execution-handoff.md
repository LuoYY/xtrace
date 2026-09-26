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
