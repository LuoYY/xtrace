# P2 交接：采集与写入基础（单一 writer / producer 登记 / 计数守恒 / 停止协议 / schema v3）

- 文档版本：v1.2（2026-09-20；v1.1 R1 通过、决策点全部裁决；**P2 于 2026-09-20 通过 R2+R3 合并终审并冻结**——终审记录见 `integration-progress.json` 的 `p2_acceptance`；后续阶段见 [P3 交接文档](chromium-p3-control-plane-handoff.md)）。
- 前置状态：**P1 已冻结**（[P1 架构 review](chromium-p1-architecture-review.md) §8 确认；`integration-progress.json` 状态 `accepted-p1`）。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。本会话不并行启动实施。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §6（协议/身份/证据）、§7（写入/背压/停止）、§6.6（旧缺陷收口）、§12.2（测试宿主与基线）、§13.1（已收敛决策）。本文件把上述设计拆成可执行任务与验收关卡；**设计语义以草稿为准，本文件不重述契约内容，只规定落地顺序与验收方式**。

## 1. 接手先做什么

1. 读本文件全文 + 草稿 §6、§7、§6.6、§13.1，以及 [P1 交接文档](chromium-patched-build-implementation.md) 的 §6（纠偏事项）与 E6.1（缺口清单）。
2. 确认 P1 现场未被动过：`chromium/src` 与 `chromium/src/v8` 工作树仍为四补丁状态（0001 含 V05 修复），`out/XTraceIntegration` 产物不重建、不清理。
3. ~~P2 实施从 P2-E1 开始~~ **P2-E1（规范）与决策点已通过 R1（2026-09-19）**：规范 [trace-schema-v3.md](trace-schema-v3.md) v1.1 冻结，DP2–DP5 裁决见 [chromium-p2-r1-decisions.md](chromium-p2-r1-decisions.md)。实施直接从 **P2-E2（mojom）** 开始，按 §7 的长程模式推进。

## 2. 冻结输入（不得变更的基线）

| 项目 | 值 |
| --- | --- |
| Chromium / V8 | `151.0.7917.0`；`73088b4e50b1dc69eaa0bdb14a8e4592813174fd` / `af6aa2ec5047676cfb3150b46449faac7578be7e` |
| 补丁栈 | 0001（修复后 `76ce5768…`）→ 0003 → 0004 → 0002，顺序与分层不变 |
| 构建基线 | `out/XTraceIntegration` debug component（args.gn 不变）；性能结论另走 `scripts/build_xtrace_release.sh` release 构建 |
| 参考产物 | P1 证据包（`out/XTraceIntegration/validation/`）：12 组矩阵、launcher 冒烟、基线数据（`baseline_metrics`） |
| 现有消费端 | `validate_trace.py`、`analyze_vmp_trace.py`、launcher、GUI、golden fixtures——P2 期间 v1/v2 读取路径不得回退 |

## 3. P2 范围与非目标

### 3.1 范围内（草稿 §12 P2 行展开）

1. schema v3 规范与落地（新事件契约；单 capture 单版本；v1/v2 由导入适配器只读兼容）。
2. producer 登记与全量写入源并轨（草稿 §7.1 清单，**含 browser-network 私有写入路径的拆除**）。
3. 有界批量上报（LogBatch 成为唯一数据路径）与 producer/writer 双侧计数。
4. manifest 与终态裁决（complete / incomplete / failed，计数等式为判据）。
5. 停止协议：browser 下发停止 → producer 原通道 watermark → writer 结算（草稿 §7.3 六步）。
6. §6.6 旧缺陷逐条收口（含 summary 不嵌完整源码、限额真实生效、frame_url/origin 填充、truncation 单形态、result/error 接线或删除）。
7. validator/分析器/GUI 的 v3 适配与契约测试（填充断言而非仅存在断言）。
8. 故障注入验收（溢出、崩溃、磁盘错误、停止超时、browser 崩溃恢复）。

### 3.2 非目标（明确不做，越界即纠偏）

- 不做 CDP XTrace 域、browser target 接入、配置热更新/generation 更新（P3）。P2 的 `config_generation` 恒为启动配置；停止的测试触发用 P2-E7 指定的脚手架，不用 CDP。
- 不做结构化 Ignition observer（P4）、新 WebIDL 接口（P5）、Agent Host / 工具迁移（P6）、Sparkplug（P7）。
- 不做 browser 侧 frame/document crosswalk（草稿 §8.4，P3）；P2 只做 renderer 侧归属字段在 hook 点的填充。
- 不承诺断电持久化；fsync/断电恢复不在 complete 语义内（草稿 §7.3 末段）。
- 不升级 Chromium/V8 基线；不改 0002 的 V8 插桩点（V8 事件计数在 Blink 回调层汇入所属 renderer producer，不动 V8 侧代码）；不退役 arm64 汇编 hooks；不关沙箱。

## 4. 任务分解

### P2-E1：schema v3 规范冻结（纯文档，R1 关卡）

> [x] 完成（R1 通过，v1.2 冻结含 A.3 修订）

产出 `docs/trace-schema-v3.md`，内容至少覆盖：

- 事件 envelope 与身份字段子集：`capture_id`、`producer_id`、`process_epoch`、`producer_seq`、`writer_seq`、`config_generation`（P2 恒为启动配置）、时间对（mono/wall，写明单位与基准）、renderer 归属字段（hook 点可得的 frame/document/worker 身份，缺失写 unresolved 而非空串或 URL 猜测）。
- 值与资产引用形态（有界、原始长度/保存长度/截断状态/摘要四元组）、unknown/unresolved 表示规则、uint64 在 NDJSON 中一律十进制字符串（草稿 §6.2）。
- manifest schema：版本、构建参数、执行模式、过滤范围、产物清单、producer 终态表、计数汇总、终态与原因。
- 终态语义与计数等式（`eligible = enqueued + dropped`、`enqueued = accepted`、`accepted = written + failed`；complete 判定条件）——直接引用草稿 §7.1/§7.2，不在规范里另造一套说法。
- v1/v2 → v3 字段映射表（供导入适配器与旧 golden fixtures 的判读）。
- 明确列出 **P2 不含的 §6.2 字段**（如 browser 侧 target 身份映射）及其所属阶段，防止实施时越界。

验收：架构师 R1 审查通过；规范自洽（字段、等式、终态三者无矛盾）。

### P2-E2：控制与登记通道（mojom）

> [x] 完成——带内端点方案（A.1 追认）；证据：v3 冒烟/故障注入/矩阵中 control endpoint 实测工作

- 设计并落地 producer 登记/注销（进程 + 线程 + producer 身份）、browser→renderer 的停止下发（目标 producer 集合 + 期限）、producer 终止 watermark（最终序号 + 计数 + generation）。数据面 `LogBatch` 成为唯一上报路径；逐条 `Log` 删除或降为低频路径（规范中写明取舍）。
- renderer 侧控制接收按线程归属应用；不跨线程共用 `mojo::Remote`（草稿 §8.3）。
- 通道形状（扩展现有 `XTraceHost` vs 新增控制接口）是第 5 节决策点 2，先定后写。

验收：mojom 编译通过；控制往返有单元测试（注册/停止/watermark）；渲染器沙箱语义不变（renderer 仍不获得任意写文件能力）。

### P2-E3：browser 单一 writer 与 CaptureCoordinator

> [x] 完成——writer/controller/BLOCK_SHUTDOWN/bnet 并轨；等式裁决见故障注入四态（p2-fault-QMS2Gi 等）；content 层单测按 A.2 列为 P3 前欠账

- 单一逻辑 writer 负责序号、manifest 与产物终态；producer registry 按 capture 登记；`writer_seq` 为合并顺序（不表因果）。
- **browser-network 并轨**：拆除 `chrome_content_browser_client.cc:6043` 的 `g_xtrace_browser_network_sequence` 私有计数器与 `:6634` 起的逐事件 `AppendToFile` 私有写路径，改造为 writer 的本地 producer，纳入同一计数守恒。
- 资产通道与动态代码通道纳入计数（归属方式按草稿 §7.1 清单决策写进 manifest）。
- shutdown 排空：`xtrace_host_impl.cc:143–147` 的 `SKIP_ON_SHUTDOWN` 现状改为显式排空方案（task traits 选择是第 5 节决策点 5；参考 `base/task/task_traits.h:94`），正常退出路径必须走完草稿 §7.3 的结算。

验收：计数等式与终态裁决有 `content_unittests`（或等价 browser 侧单测）覆盖，含 producer 中途失联的裁决用例。

### P2-E4：renderer 有界批量与计数

> [x] 完成——producer/hub/drop-newest/Worker 结算（矩阵 worker 案例含 service-worker kind）；blink 单测为 P3 前欠账

- 每线程有界缓冲 + 批量 flush（条数/时间双触发，参数写入 manifest）；溢出按已声明策略丢弃并计数（丢弃策略默认值是第 5 节决策点 3）；`eligible/enqueued/dropped` 在 producer 侧维护。
- 停止时停止接纳新事件、提交剩余批次、在原日志通道提交 watermark。
- Worker 线程生命周期挂接：线程销毁即结算（现有 per-sequence remote 绑定语义保留）；`worker_thread_registry.cc:90` 的广播计数不得当作确认依据（草稿 V09）。
- V8 event_logger 路径（`xtrace:vmp-runtime:` 等前缀）汇入所属线程 producer 的计数与批量通道，不单列 producer。

验收：blink 侧单测 + 集成用例覆盖溢出计数、watermark 提交、Worker 销毁结算。

### P2-E5：§6.6 旧缺陷逐条收口

> [x] 完成——V06（资产行/事件无 source+validator 断言）、result/error 删除、truncation 单形态、attribution 填充；对照证据：tests v3 化 + 矩阵/validator

对照草稿 §6.6 表逐条落地，每条留"修复前/后"对照证据。特别点名：

- summary 资产模式：`xtrace_logger.cc:318–375` 现状在 full 条件外仍向 manifest/event 附完整 source（V06）——迁移时实现与契约同步修改，且**现有断言该内容的测试要同步改**（注意：现有测试断言的是旧行为，改测试预期必须附实现证据，不得反向掩盖）。
- 限额（body/header/value）真实生效并有触发用例；截断状态与摘要随事件/资产记录。
- `result`/`error`：接线或删除二选一，不留恒空字段。
- `frame_url`/`origin`：renderer hook 点填充；确实不可得时写 unresolved。

### P2-E6：消费端升级

> [x] validator --schema-version 3 全项断言（含 v1.2 null 语义）；analyzer/GUI 未适配 v3（见缺口清单，P2 范围仅要求 validator+导入适配器……按 3.1 条 7 “validator/分析器/GUI 的 v3 适配”未全做——如实标注：validator 完成，analyzer/GUI 适配未做，列入待办

- `validate_trace.py --schema-version 3`：存在性 + 按事件类型的填充契约 + manifest 计数等式核对 + 终态一致性；v1/v2 校验行为不回退（旧 golden fixtures 原样通过）。
- v1/v2 导入适配器（只读旧 trace）；`analyze_vmp_trace.py` 读取 v3；GUI 对 v3 文件不报错（完整 v3 UI 归 P6，本期只保证可读不崩）。
- golden fixture 增加 v3 样本。

验收：338/28/211 回归全绿 + 新增契约测试数量如实报告。

### P2-E7：故障注入与集成矩阵

> [x] 五场景+矩阵 12/12（p2-fault-* 三轮、browser-run-dZJY65）；bnet 停止竞态修复后复跑

停止的测试触发：P2 尚无 CDP 域，使用**明确的测试脚手架**（browser 测试钩子或 test-only 开关，如 `--xtrace-stop-after-ms`），在代码与文档中标记为临时设施，P3 由正式域替换。

必过场景（每条附证据，终态不得伪报）：

| 场景 | 预期终态/行为 |
| --- | --- |
| 正常 stop（页面静稳、Worker 在跑） | complete；全部计数等式成立；manifest 终态表完整 |
| 队列溢出（高负载压测页） | incomplete；`dropped>0` 与缺口摘要正确 |
| renderer 崩溃 mid-capture | incomplete；最后已确认序号 + 未知尾部标注；不补造结束事件 |
| 磁盘写失败（只读目录/限额路径） | failed 或 incomplete；诊断可查 |
| stop 超时 | incomplete + 未确认 producer 清单；不自动杀进程 |
| browser 崩溃后恢复 | 已有片段标记中断，不生成正常终态 |
| 12 组矩阵 v3 重跑 | 等价覆盖通过；记录事件数/字节/墙钟/RSS 并与 P1 基线对比 |

进程内测试宿主按草稿 §12.2 分配（writer/计数 → content 层单测；renderer/Worker 生命周期 → content_browsertests；chrome/ 层网络插桩用完整 `chrome` 目标，不用 content_shell）。

### P2-E8：证据包与 review 提交

> [x] 补丁回写+复现校验（f19169a3）+摘要+基线对比+文档同步；本节为终审提交物

沿用 P1 证据纪律：命令与退出码存档、失败首轮证据保留、版本/补丁/二进制摘要（含 dylib 清单，沿用 `postFixSupplement` 口径）、基线数据入 `integration-progress.json`（新字段、注明构建口径）、文档状态同步（草稿 §2.3/§12、本文件）。完成后按第 7 节关卡提交。

## 5. 决策点状态（v1.1：全部已裁决）

| 决策点 | 状态 |
| --- | --- |
| 1. schema v3 规范 | **已冻结**：[trace-schema-v3.md](trace-schema-v3.md) v1.1（R1 通过，并入单调钟基准、producer_id 唯一性（`lseq`）、args 适配包装三处修订） |
| 2. 控制通道形状 | **已裁决**：[chromium-p2-r1-decisions.md](chromium-p2-r1-decisions.md) DP2——数据面 `XTraceHost`（batch-only + watermark 同管道），控制面独立 `XTraceControl`；附 3 条件（绑定路径实证、`Log` 删除的断言同步、V09 注释） |
| 3. 溢出丢弃默认 | **已裁决**：DP3——默认 `drop-newest`，`drop-oldest` 可配置，不做"触发即结束"；manifest `overflow_policy` 为唯一权威声明 |
| 4. 测试期 stop | **已裁决**：DP4——两个 test-only 开关（`--xtrace-stop-after-ms`、`--xtrace-test-capacity`），`XTRACE_TEST_SCAFFOLDING` 标记，launcher 不透传，P3 移除并登记 |
| 5. shutdown 排空 | **已裁决**：DP5——`BLOCK_SHUTDOWN` + 不等待任何远端 + manifest 队尾任务；附关停实证与无跨进程等待的硬性验收条件 |

## 6. 纪律与纠偏事项（沿用 P1，新增第 6–8 条）

1. 补丁分层：P2 改动回写职责对应的受跟踪补丁（写入路径集中在 0001；v3 因果字段如涉及 0003/0004 同步修订）；**每次修订补丁后必须重跑干净索引顺序复验**（命令模板见 [P1 架构 review](chromium-p1-architecture-review.md) §7.1），不得 reset 运行树。
2. 不修改测试预期掩盖真实故障；修复留"复现→根因→最小修复→复测"证据链。
3. renderer 沙箱保持开启；renderer 不新增任意文件写入能力；不引入公网调试端口。
4. 性能数字口径：debug component 数据只作相对比较；任何"开销/速率"结论注明构建口径，release 结论另测。
5. 文档与证据一致：状态表、进度 JSON、原始日志三者互洽；不以摘要绿灯替代原始证据。
6. **新契约不许带病移植**：§6.6 表是 P2 验收的硬清单，v3 producer 不得以"先跑起来"为由带着旧缺陷合入。
7. **计数等式是终态唯一判据**：任何"看起来都写完了"的经验判断不算数；等式不成立即非 complete。
8. 构建效率：增量编译优先；V8 侧不改动则不应触发全量；失败先分类（依赖/工具链/补丁/链接）再处理，不盲目重跑 sync 或清空 out。

## 7. 长程执行模式（v1.1 起；替代分阶段例行审查）

R1 已通过。**P2-E2 → P2-E8 合并为一个连续执行块：中间不设例行审查点**，执行层一次长程推进、一次提交，架构师做 R2+R3 合并终审。

### 7.1 执行块入口条件（已全部满足）

- 规范冻结：[trace-schema-v3.md](trace-schema-v3.md) v1.1。
- 决策冻结：§5 五项全部裁决。
- 基线/补丁/构建口径：§2 不变。

### 7.2 执行动作清单（顺序即依赖序；每步关键要点）

| 序 | 动作 | 关键要点（来自规范/裁决/已知坑） |
| --- | --- | --- |
| 1 | P2-E2 控制与登记通道（mojom） | watermark 与 batch 同管道（保序是结算前提）；描述符随首批携带、注册零往返；`XTraceControl` 绑定路径用单测实证再定；worker 转发停止必须注 V09；逐条 `Log` 删除时同步更新 P1 期断言 |
| 2 | P2-E3 browser 单一 writer + 协调器 | 拆 `chrome_content_browser_client.cc:6043,6634` 的私有计数器与 `AppendToFile`；browser-network 成为进程内本地 producer；`writer_seq` 仅合并序；shutdown 走 DP5 方案（无跨进程等待）；计数裁决进 `content_unittests` |
| 3 | P2-E4 renderer 有界批量与计数 | per-thread 缓冲 + 条数/时间双触发 flush（参数进 manifest）；溢出按 DP3；worker 线程销毁即结算；V8 event_logger 路径并入所属线程 producer，不动 0002 |
| 4 | P2-E5 §6.6 十条收口 | 每条留修复前后对照；summary 模式 `metadata-only` 无 `source`（现有断言旧行为的测试随实现证据同步改，不反向掩盖）；限额触发必须置截断四元组 |
| 5 | P2-E6 消费端升级 | validator `--schema-version 3` 按规范 §12 全项断言；v1/v2 golden fixtures 走旧路径必须原样全绿；v3 golden 入库；GUI 对 v3 不崩即可 |
| 6 | P2-E7 故障注入矩阵 | 两个 test-only 开关均走真实停止路径；七个场景逐条出证据（正常 complete、溢出 incomplete、renderer 崩溃未知尾部、磁盘失败、stop 超时、browser 关停 DP5 实证、12 组 v3 重跑 + 基线对比 P1） |
| 7 | P2-E8 证据包 | 补丁回写 + 干净索引复验（模板见 P1 review §7.1）；dylib 摘要沿用 `postFixSupplement` 口径；文档状态同步 |

### 7.3 自主权（不触发升级，工程师全权）

- 实现细节、模块边界、命名、测试组织、默认值调优（batch 大小、flush 间隔、缓冲容量——以 manifest 自描述为准）。
- bug 修复与重构；编译/测试失败的日常分类处理（§6.8）。
- 进度痕迹：每完成一项即在 §4 对应任务标题前打勾并附一行证据指针（目录/日志/测试名），不写长报告、不逐步汇报。

### 7.4 升级触发器（命中即停，先回报再继续；不得自行绕道）

1. 需要变更基线：Chromium/V8 版本、GN 参数、沙箱、删除或禁用既有 hook。
2. 规范与实现不可调和：需要改 trace-schema-v3.md 的语义（先回规范审查，不先斩后奏）。
3. 正常场景下计数等式无法成立（管道/登记设计有洞）。
4. 需要新增持久化能力、网络端口、对外接口或新 producer 类型（超出 §3 范围）。
5. 规范未覆盖的新二选一，或某项 DP 裁决的前提被证伪。
6. 故障注入暴露设计层问题（如终态伪报的根因在协议而非实现）。

### 7.5 一次性终审提交物（R2+R3 合并）

- 补丁栈（回写后）+ 干净索引顺序复验记录。
- 测试证据：进程内单测清单与结果、P2-E7 七场景逐项证据、12 组矩阵 v3 结果、与 P1 的基线对比表。
- 回归：338/28/211 + 新增测试数量（如实）。
- 文档同步：§4 任务勾选、草稿 §2.3/§12 状态、`integration-progress.json`（新增 P2 段，初始状态 `p2-in-progress`，终审前不得写 accepted）。
- 已知缺口与边界清单（格式沿用 P1 交接 E6.1）。
- 终审只认原始证据，不认摘要绿灯。

## 8. 完成定义

- schema v3 规范冻结且实现与规范一致；单个 capture 单版本；v1/v2 旧 trace 可导入读取。
- 草稿 §7.1 producer 清单全部登记并轨（含 browser-network）；计数等式在所有验收场景成立或如实进入终态裁决。
- 正常停止可核对为 complete；溢出/崩溃/磁盘错误/超时分别产生正确的 incomplete/failed，无伪报。
- §6.6 十条旧缺陷全部有"修复前/后"对照证据并验收通过。
- 回归全绿；12 组矩阵 v3 通过；基线对比记录完成。
- 补丁栈可从干净基线复现；证据包经架构师 R3 核验。

## 9. 源码定位索引（P2 增补；其余见草稿 §14）

| 范围 | 位置 |
| --- | --- |
| renderer logger 与资产（summary 泄漏点） | `chromium/src/third_party/blink/renderer/platform/xtrace/xtrace_logger.cc:318–375` |
| browser 写入端与 SKIP_ON_SHUTDOWN | `chromium/src/content/browser/xtrace/xtrace_host_impl.cc:143–147` |
| browser-network 私有计数器/写文件（待拆） | `chromium/src/chrome/browser/chrome_content_browser_client.cc:6043,6634` |
| 日志 mojom | `chromium/src/third_party/blink/public/mojom/xtrace/xtrace.mojom` |
| shutdown task traits 语义 | `chromium/src/base/task/task_traits.h:94` |
| Worker 广播非 ACK（V09） | `chromium/src/content/renderer/worker/worker_thread_registry.cc:90` |
| 集成驱动与基线采集 | `chromium/src/out/XTraceIntegration/validation/browser-integration.cjs` |
| P1 基线数据 | `integration-progress.json` 的 `baseline_metrics` |
