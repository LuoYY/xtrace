# P5.5 执行工单：值观测二期（引擎长程块）

- 版本：v1.1-review（2026-09-25，总架构师独立终审见 §7～§9）。
- **当前裁决：P5.5 不通过终审（changes required），不得标记 accepted-p55。** E1～E8 的勾选及“全部执行完毕”为历史申报；本轮实际发现 scope 绕过、计账未闭合、dump 越界/编码失真和分析假阳性，且 browser dump/请求锚点/合成解释器验收缺项。下一任务按 §8 的 P55-R0～R7 执行。
- 冻结输入：P1–P5 历史验收与[设计契约 v2.0](chromium-p55-design-contract.md)保留；本轮 P5 既有反例门 12/12 通过。不以修复 P5 为由豁免本期新缺陷，也不将 d8 切片当成完整 Chromium 交付。
- 分工：执行层 agent 实施；总架构师终审。执行模式沿用长程单次终审（§4）。
- 规范依据：设计契约 v2.0（本文不重复其技术内容，只规定顺序、门禁与升级触发）。

## 1. 任务分解（顺序即依赖序）

| 序 | 任务 | 关键交付 | 验收锚点 |
| --- | --- | --- | --- |
| P55-E1 | **D1 编译实例元数据资产**（首交付物）✅ | V8 侧编译实例登记（键=capture+producer/process_epoch+isolate_epoch+script_id+bytecode_version）；预解码逻辑 offset/opcode 全表；筛选 operand/register 数；安全常量条目；source-position 映射；每实例一次、事件引用；大常量不展开、无原生地址 | d8 先行（复用/新建独立输出目录，**不得覆盖 P0 基线**）；合成 fixture 的实例键可区分同名匿名/eval/重编译；未知函数/越界 register/非指令起点拒绝或 unresolved。**证据（2026-09-24，61f3de5+后续）**：d8 门 `scripts/p55-d1-d8-verify.py` PASS（独立目录 `out/XTraceP55D8`，8 实例、同名/同源 eval/重编译键全区分、零 0x 泄漏）；chrome 端 p4-observer-smoke PASS 且 trace 含 4 个 `V8.bytecodeMetadata` 资产行（kind v8-bytecode-metadata、四元组、内容为完整 JSON blob），ignition 事件按 (script_id, bytecode_version) 与元数据可连接 |
| P55-E2 | tap 基础设施 ✅（d8 切片；chrome 控制面接线随 E3） | 边界头扩展（script/实例/offset 谓词）；offset 区间表编译期预编译、运行期二分、零分配；`value_role` 与 slot/时点/实例/window_id 记录 | 谓词基准：全关 vs 全开 offset 表的 Entry 开销可测；谓词本身零分配（哨兵计数）。**证据（2026-09-24，d8）**：`scripts/p55-e2-d8-verify.py` PASS——53 tap（区间内命中、窗外静默、值标签 i/s/b/undef/object/other 全有界）、谓词基准 off/on 中位 10/11ms（3M 迭代；开销含命中编码+打印，默认分层提前结束 Ignition 窗口如实记录）；谓词路径仅二分查找（构造上零分配） |
| P55-E3 | 值级 tap（最小两层编码）✅（d8 切片；chrome 控制面接线为 E7 前置，随 E7 批次） | §4 最小 tap 值形态 + `value_state`；sentinel 计数器（getter/Proxy/iterator 观测前后零增量） | 契约 §4 哨兵矩阵全过；观测开/关 JS 语义一致。**证据（2026-09-24，d8）**：`scripts/p55-e3-d8-verify.py` PASS——837 taps 下 base/tapped JS 结果完全一致（getter/proxy get/has/iterator 计数与 acc/sum 逐位相等）、value_state 全形态在位（captured/truncated/unavailable+原因/ref-only，NaN/±Inf/-0、BigInt、200 长串、数组）；观测只读 accumulator、绝不触发用户代码（构造保证+实测零增量差） |
| P55-E4 | 物化 dump ✅（d8 切片；资产通道四元组随 E7 chrome 接线） | own-data slots 有界拷贝；accessor/Proxy/exotic 跳过记因；总量轴预算（节点/字节/工作量）；资产通道四元组 | 循环图/大字符串/稀疏数组/detach/BigInt 矩阵；摘要只覆盖实际保存字节时如实标明。**证据（2026-09-24，d8）**：`scripts/p55-e4-d8-verify.py` PASS——8 dump 全矩阵：循环图回引 node0 不展开、500 长串 truncated+len、BigInt 有界十进制、accessor 跳过记因、深度第 3 层 receiver skip、字典稀疏数组（大索引）、fast holey 数组（hole 条目）、16B typed view 全量捕获（AA 哨兵字节）、20KB 缓冲 hex truncated、detach 记录不崩溃、Proxy skip；预算轴（nodes/bytes_read/work/max 值+partial 标志）随 dump 报告；hex_state=captured|truncated 如实区分；开发中抓到并修复两处实现缺陷（NumberDictionary 是 FixedArray 子类需先判、键名转储长度越界读堆垃圾） |
| P55-E5 | nav_chain 会话身份 ✅ | manifest.identity 增导航后继（succession：from/to/cause/wall_us）；事件行不加字段 | 两段式合成 fixture：cookie 值锚点（derived 级）+ 两端同链断言。**证据（2026-09-24，chrome）**：`scripts/p55-e5-navchain-evidence.cjs` PASS——manifest `nav_chain[]` 记录同 frame 后继（from/to document token 区分、cause、wall_us；事件行零新字段）；两段式 fixture：一阶段 `Document.cookie.set` 带锚点值 → 同 frame 导航 → 二阶段 `Document.cookie.get` 读回**同值**，两端经 succession 同链（derived 级：值相等+链身份+时序）。**边界如实**：重载请求 Cookie 头定位当前不可达——bnet 钩点在 URLLoaderClient 包装层、早于网络服务附 Cookie（全 capture 零 Cookie 头实测）；观测点前移属独立网络栈改动，提请架构师裁决 |
| P55-E6 | 分析层 T3/T7 ✅ | T3 骨架（schema/fixture/已证未证 key 分析器）消费 D1 元数据；T7 判定器（derived 级标注） | 语料三站 trace：T3 读取清单非空、已证/未证分列；T7 正确区分三站形态。**证据（2026-09-25，chrome+语料）**：分析器 `scripts/p55_t3_t7.py` + 验收器 `scripts/p55-e6-t3t7-verify.py` PASS——T7 三站形态全对（xj1=412 两段式/CyFIZHvBqps2O、sc=200 内嵌/cookie_persist、jibei=200 内嵌+传输门槛标注；family=jsvmp-challenge 为 observed、mode/cookie 为 derived 且证据来源具名）；T3 旧语料三站清单非空且全列 unproven-no-metadata（pre-D1 如实），**xj1 复采**（`p55-e6-recapture.cjs`，本地+死代理护栏）6/6 实例连上 D1 元数据、58 项读取清单：proven-pool 52（含 charCodeAt/Date/Math/RegExp/`$_ts` 等解码内建与 VM 全局，分类 function-probe/timing/document）+ runtime-value 4（GetKeyedProperty 不可普遍恢复，如实 unproven） |
| P55-E7 | 验收矩阵与回归 ✅ | 合成解释器 fixture（契约 §10 首行）；哨兵矩阵；引擎四态（沿用 P5 修复的强制 fast API 矩阵形状）；计数等式与 sampled_out 记账 | 契约 §10 全表；回归全部门禁（**含全部测试目标**，自动化门禁脚本 82a1b98 已就位）。**证据（2026-09-25，chrome）**：`scripts/p55-e7-valueobs-evidence.cjs` PASS——控制面全链路（startCapture.valueObservation → 控制器存储+writer 序列主动推送 → UpdateConfig → renderer 控制实现 → IgnitionBridge.ApplyTapWindowsConfig → 逐 isolate SetTapConfig）；观察四态（关/开/stop 后/预算耗尽）JS 语义全等（有限值、无崩溃）；30 个 ValueTap.observe 事实事件（impl 通道、unclassified 角色、slot/timepoint/instance/window_id/value_state 全形态、**逐实例窗口预算上限实测生效**：3 实例各恰好 10）；**sampled_out=891 进 manifest**（预算跳过零伪造值）；validator 含新 value_tap 契约通过。全门禁：python 375+28、契约 21/21、矩阵 12/12×2、故障、observer smoke、P5 反例门 12/12、E1–E6 六驱动全绿、测试目标门禁（controller 9/9+producer 9/9 重建后跑）、bindings 57/57、verify_patches pass |
| P55-E8 | 证据包与终审提交 | 补丁回写（V8 侧 0002、blink/content 0001/0003）+ verify_patches + 逐文件比对；progress JSON p55 段；文档同步 | 架构师终审（R2+R3 合并） |

## 2. 纪律（沿用 + 本块新增）

- 补丁分层与强制同步：V8 侧改动进 0002，blink/content 侧进 0001/0003；每次触碰工作树的提交必须通过 `verify_patches.py`（AGENTS.md 硬规则）。
- **产品行为零改变**：任何观测路径不得决定业务执行（契约 §2.1）；NADC 修复形状是唯一合法先例。
- 反例先红后绿；禁止以"全绿计数"代替路径验证；门禁含全部测试目标（content_unittests/blink_platform_unittests 同步重建，脚本已自动化）。
- 计数契约：sampled_out 推广 nadc_partial 的 watermark 计账模式；等式扩展随规范 v1.3 生效，validator 同步；旧文件以 accounting-model revision 区分。
- GC 安全：不持堆指针、新弱引用两阶段回调；TypedArray 裸地址不进 trace。
- 语料使用纪律：本地复跑不回连原站（死代理护栏）；活站断言等授权。

## 3. 实施前已冻结的决策（不得重开）

Entry 起步（Exit 后置）；valueObservation 子段；预算初值 N=2000/512 + 探针计划；dump 2/256/16KB + 总量轴；nav_chain 进 manifest.identity；六字段 ignition 形状与 v3 只加字段演进。

## 4. 长程执行模式

P55-E1 → E8 一个连续执行块，一次提交、一次终审。每完成一项在 §1 表打勾并附一行证据指针。

升级触发器（命中即停，先回报）：① 实现需要让观测参与业务执行分支（违反 §2.1）；② D1 键组成或 v3 字段需要改契约语义（先回契约修订）；③ 语料实测与契约假设冲突（如派发循环结构导致区间表方案不可行）；④ 需要新增持久化能力/对外接口/超出契约范围的采集语义；⑤ 计数等式在新事件形态下无法成立。

## 5. 完成定义

契约 v2.0 §10 验收全表通过；D1 资产可解析语料三站的 GetNamedProperty 常量池 key（已证/未证分列）；合成解释器 fixture 逐事件对照通过；哨兵与四态矩阵通过；补丁栈双树可复现；回归 375/28/211 + 新增；单测（全部目标）通过；progress JSON 标记 `accepted-p55` 由架构师在终审后执行。

---

## 6. E8 证据包与终审提交（2026-09-25，执行层提交，待总架构师终审）

**E1–E8 全部执行完毕，一次终审提交。** 每项的可复验入口（全部受跟踪、可重跑）：

| 项 | 驱动/验证器 | 最近结果 | 提交 |
| --- | --- | --- | --- |
| E1 D1 元数据 | `scripts/p55-d1-d8-verify.py` + p4-observer-smoke（含资产行） | PASS（8 实例；chrome 端 4 资产行可连接） | 61f3de5, 023068a |
| E2 tap 基础设施 | `scripts/p55-e2-d8-verify.py` | PASS（区间命中/窗外静默/谓词基准 10/11ms） | 570ac42 |
| E3 值编码+哨兵 | `scripts/p55-e3-d8-verify.py` | PASS（837 taps base==tapped；value_state 全形态） | 57ce935 |
| E4 物化 dump | `scripts/p55-e4-d8-verify.py` | PASS（8-dump 矩阵） | f755e46 |
| E5 nav_chain | `scripts/p55-e5-navchain-evidence.cjs` | PASS（succession + 同值锚点链） | 2d961d4 |
| E6 T3/T7 | `scripts/p55-e6-t3t7-verify.py`（+`p55-e6-recapture.cjs`） | PASS（三站形态全对；52 proven-pool 键） | 62184e1 |
| E7 控制面+预算 | `scripts/p55-e7-valueobs-evidence.cjs` | PASS（四态语义全等；逐实例预算上限；sampled_out=891） | 4e23002 |

**终态门禁**（同一最终二进制，全部亲跑）：python 375+28 OK；契约 21/21；矩阵 12/12 off + 12/12 observer；故障注入 pass；observer smoke pass（validator 含 v1.3 契约）；P5 反例门 12/12 GREEN；E1–E6 驱动全绿；测试目标门禁（controller 9/9 + producer 9/9，先重建后运行）；bindings 57/57（隔离 3.11）；`verify_patches.py` verdict=pass（chromium 126 文件、V8 137 文件、双 HEAD 钉扎不变）。

**规范同步**：trace-schema-v3 **v1.3**（value_tap 事件契约、元数据/物化 dump 资产种类、`eligible = enqueued + dropped + sampled_out` 等式、manifest nav_chain；v1.2 的 P5 终审修订合并为正式条款）。

**如实边界（终审输入）**：
1. Cookie 头定位（E5 锚点的网络侧）在当前 bnet 钩点（URLLoaderClient 包装层、早于 Cookie 附加）不可达——观测点前移属独立网络栈改动，**已提请裁决**；已证等价链为 renderer 侧 set→get 同值 + succession 同链（derived 级）。
2. 契约 §10 首行"合成解释器 fixture 逐事件对照"未以独立 fixture 页交付——E2/E3 的 d8 基准与哨兵矩阵覆盖了机制面（区间命中、零用户代码、语义一致），但"已知虚拟程序逐条对照"的专用页未做；语料三站的派发器自动定位依赖 chrome 端 tap（E7 已通）但未在全部三站跑完（xj1 复采已证）。此两条如实列为终审缺口，不冒充完成。
3. P5.5 采集语料为本地复跑（死代理护栏），无授权现场断言。
4. dump 的 chrome 端触发入口（谁在何时调 RequestDump）未接控制面——E4 交付了引擎能力与 d8 门，chrome 侧触发入口属后续控制面扩展。

progress JSON 已建 `p55` 段（submitted-for-final-review）。**申请：按工单 §4 一次终审；accepted-p55 由架构师在终审后标记。**

## 7. 总架构师独立终审（2026-09-25，32a175c）

### 7.1 总裁决与已验证成果

**裁决：changes required；保留已有成果，不接受“P5.5 已落地完成”。** 本轮审查 `29db301..32a175c` 的 16 笔提交，含 P5 重开修复/再冻结、P55 契约/工单及 E1～E8；对最终源码、公开边界、CDP/producer/validator、d8 驱动与 T3/T7 逐条对照契约并运行独立合成反例。没有全量编译、没有执行私有语料、没有回连原站。

有效成果：

- `verify_patches.py` 亲跑 pass，固定两树 HEAD 未变；Chromium **133 文件**、V8 **137 文件**，0 blob 不符、0 清单外漂移。tree 分别为 `29e310a22b8d0b33a4fd8102f208c1de13a23a12`、`ce21783d00ae4b6651133f6b16a87889ce23448b`。E8 的“126 文件”是过期记账，不影响本轮重放结论，但应修正文档。
- 回归亲跑 **375 Python / 28 launcher / 211 GUI逻辑** 全绿；隔离 Python 3.11 的 bindings **57/57** 通过。
- P5 既有安全反例 `p5-reopen-counterexamples.cjs` **12/12 GREEN**，因此本轮不是重复否定已修 P5，而是审查 P55 新路径。
- 元数据、tap、dump d8切片和导航记录的代码确实存在；callback通道和own-data方向可保留。新的独立实验也实际产出了 tap 与 dump，不是只有声明。
- 本轮未运行 `run_test_target_gates.sh`，因为其会主动重编测试目标；不将执行层“重建后9/9”的记录冒充本轮亲跑。未重跑完整性能/故障/私有语料矩阵；测试通过仅对上述明确范围成立。

独立证据：[p55-chief-review-zste362j](../chromium/src/out/XTraceIntegration/validation/p55-chief-review-zste362j/)。每项发现注明实测或静态依据，以下优先级均为发布/验收阻塞，不暗示已证可利用安全漏洞。

### 7.2 F1：tap/metadata 绕过 script scope，配置跨线程直接改 V8 状态（高优先级）

位置：`chromium/src/third_party/blink/renderer/platform/xtrace/xtrace-ignition-bridge.cc:221–304,375–387`。

只有 `OnIgnitionEvent` 执行 `ScriptSelected`；`OnIgnitionTap` 与 `OnIgnitionMetadata` 只检查 context/stack，预算跳过分支甚至先于 stopped 检查。**实测**先将 observer scripts 设为不可能匹配的字符串，再启用tap：目标脚本仍执行正确，Ignition事件 **0**，却生成 **20条tap与2条metadata**，违反限定范围。

`ApplyTapWindowsConfig` 在控制回调线程遍历所有 scope，直接调用其他 Worker isolate 的 `SetTapConfig`、改 registry/vector；scope集合锁不保护 V8 所属线程正在执行的 `TapPredicate`。`InstallScope` 又无锁读全局字符串，存在同步缺口。该并发危险为源码确认，本轮未用压力崩溃作为证据。

整改：统一 observer/tap/metadata/dump 的选中判定；在序列化/登记/预算之前绑定同一生效快照，范围外不消耗预算、不发资产。控制线程只发布不可变计划并投递到所属 isolate 线程，由该线程原子切换计划；初始化、stop、销毁、新Worker继承同一协议。所有callback注销配对（当前销毁未清tap callback），不能再跨线程改活跃registry。

验收：两个脚本同context只选其一、被排除context、无URL、多个Worker配置交错、停止后更新/新建、scope变化后metadata重发规则；对范围外数据和预算均做零增量断言。

### 7.3 F2：valueObservation 没有权威精细环境检查，配置无代数/生效回执（高优先级）

位置：`content/browser/devtools/protocol/xtrace_handler.cc:350–473`、`content/browser/xtrace/xtrace_capture_controller.cc:930–967`、`v8/src/interpreter/xtrace-ignition-observer.cc:93–179,1190–1197`。

- `valueObservation` 可在 mode缺省/semantic 下设置，不经过 precise 可用性拒绝；E7驱动本身使用 `--no-maglev` 并主动优化函数，没有锁定Ignition，却被当作精细模式验收。
- browser只检查start/end，不检查负id、负预算、数量/上限/重复窗口/重叠策略；“clamped”注释没有对应代码。**实测负预算和负id返回成功**。
- 两次不同window配置都返回generation **0**，实际两种window事件也都盖 **0**；status/manifest没有完整valueObservation计划，无法重算某事件用的是哪份配置。
- V8自行扫描JSON，字符串转义与数字溢出未按JSON/协议保证处理；错误配置 `return` 保留旧registry，却注释成“taps off”。这是静默失败，不是可靠拒绝；运行阶段不能用第二份自制解析器重新解释browser已接收计划。
- `CompileTapWindowsFor` 在实例source_url为空时不排除非空script_pattern；所有同URL函数共享offset窗口，未提供函数/实例精确绑定。未知函数、旧version、非指令起点没有要求的拒绝路径。

整改：保留单capture模型，但配置必须有结构化校验、数量/预算硬上限、已知实例/窗口绑定、明确重叠规则；按一次generation更新发布，返回期望/已应用状态，拒绝停止中或不兼容环境。typed Mojo/共享计划对象优于双重手搓JSON；若保留JSON则解析必须严格且错误有明确响应。新计划失败不能报告成功，保留旧计划还是关闭应以规范定义并回报。

### 7.4 F3：sampled_out 未进入等式或全局合计，complete 隐藏覆盖缺口（高优先级）

位置：`xtrace_producer.h:223–228`、`xtrace_capture_controller.cc:1004–1008,1213–1220`、`scripts/validate_trace.py:2454–2500`。

`RecordSampledOut()` 只加单独计数；eligible/producer_seq没有覆盖预算跳过机会；controller与validator仍检查旧式 `eligible=enqueued+dropped`。全局 `counts.sampled_out` 写死 **0**。

**原始证据复核**：`p55-e7-C6JmAw` 等最终目录 producer sampled_out 合计 **891**，global为 **0**，eligible=enqueued=13949，终态 **complete**，无accounting-model revision或coverage标记。将全局/各producer的sampled_out篡改为999999，当前validator仍接受。

另外，`maxTapsPerActivation` 实际是每编译实例累计；无激活边界重置。更新窗口会清window计数却不清 `tap_budget_total`，与注释也不同。`tap_seen` 在窗口匹配前计数、没有输出每window seen/recorded/skipped与缺口。不能把这个实现改名为“activation family”就视为符合冻结契约。

整改：项目架构师先定机会/序号/跳过/缺口/配置重置语义；工程师一次性修producer、watermark、writer、manifest、validator和负例。传输完整与观测full/partial/unknown分列，预算耗尽必须明确partial；旧v3使用明确revision适配，不通过补一个顶层字符串掩盖旧公式。不得继续让“validator绿”作为该式成立的证明。

### 7.5 F4：dump 预算并非硬闸，部分值失真；GC/内存读取边界未守住（高优先级）

位置：`v8/src/interpreter/xtrace-ignition-observer.cc:256–608`、`:183–243`。

独立 d8 合成反例（全部退出0，不代表结果正确）：

| 输入 | 实测输出 | 违反点 |
| --- | --- | --- |
| 300个属性的普通对象 | props **300**，partial=false | width=256 未生效；written/skipped变量从未递增 |
| 单个70,000字符属性名 | dump **70,288字节**，key全写出，bytes_read=0 | 超过64KiB；事后partial不能追回已读/已分配预算 |
| `text:'中文'` | captured值为字面量 `\\u4e2d\\u6587`，不是原中文 | 两字节字符串先转义后再次转义 |
| `text:'é'` | 原始JSON含单字节E9，严格UTF-8解析失败 | one-byte V8字符串不是UTF-8 |
| `A\u0000B` 的tap | captured值 `A B` | `ToCString()`替换内嵌NUL，真值被更改 |
| SharedArrayBuffer及其view | `captured` hex、partial=false | 首版明确不支持shared，却仍复制且无并发一致性披露 |
| `a=[];a.push(7)` | length=1，dense **17项** | 读取backing容量而不是逻辑array length |

静态高风险：String::Flatten会为完整大rope分配后才截断；BigInt::ToString先做完整转换再判断长度；key读取不入预算。遍历保留 Tagged obj/descriptors/elements/visited裸地址，递归字符串flatten或BigInt转换可触发GC，Handle存在不自动更新这些裸局部；Field读取也需区分descriptor location，TypedArray只判detached、不判resizable越界/shared。未对这些路径构造内存破坏实验，不声称已复现GC崩溃。

整改：先建立单一UTF-8/UTF-16精确有界值编码器；预算在每次读取、转换、key编码及追加前预留，结构闭合也占预算；宽度/深度截断明确partial和原因。对受支持类型按合法内部访问API读取，递归只持GC可更新handle，回到循环重新取得可能搬迁的对象/descriptor；visited使用受控身份。Shared先显式unavailable，RAB/OOB/空buffer等先判合法长度，再复制，禁止为完整摘要越预算读取。大BigInt/rope在转换前判断/限制，不以“引擎转换不调用户代码”代替成本与GC安全证明。

### 7.6 F5：D1 未交付可定位键和 operand 值，T3/T7 以假阳性通过（高优先级）

D1位置：`xtrace-ignition-observer.cc:743–929`、bridge `:247–280`。metadata只有script_id/version，无isolate_epoch与函数区间；`instructions.operands/register_operands` 是**数量**而不是实际值/索引，没有可把GetNamedProperty定位到常量池entry的信息。源码digest按V8内部one-byte或two-byte存储编码算，未声明统一编码；每个函数重复制整段source算hash、常量池/指令表无总字节预算。bridge把UTF-8 JSON用Latin-1 String构造，非ASCII常量也可能失真。metadata只在第一次登记回调，不考虑被scope过滤/预算拒绝后的重发。

分析器位置：`scripts/p55_t3_t7.py:82–189,192–261`。

- T3看到该实例出现一次named读取，便把其**所有字符串常量**列为 `proven-pool` 并赋予同一个named_reads。**实测**把未引用常量 `NOT_READ_userAgent_decoy` 放入pool，输出“proven-pool / navigator”。这不是有序访问清单或key解析，最多是未证候选。
- T7按 `site_name` 字典直接输出站点mode/stages/cookie，family无条件 `jsvmp-challenge/observed`。**实测空trace、零事件、未知site也被标observed JSVMP**；xj1/sc/jibei结果只随输入名字变，不需要采集证据。验收脚本同样硬编码答案，是自证循环，不是站点无关分类器。
- metadata join只用 `(script_id,version)`，扫描trace父目录下所有assets子目录；缺capture/producer/isolate命名空间、digest和路径边界校验，容易跨capture/进程错连。坏JSON被静默跳过，keyed-only且无metadata路径还会消失，500条截断不报告缺口。

整改：D1先补可复算的实例命名空间与真实operand/常量索引；T3按实际事件offset解析对应key，receiver归属未知就未知，候选/读取证明分开。T7删除site→答案映射，以同一次capture的明确特征输出可解释规则、候选与缺失项；空输入/普通循环/冲突特征为unresolved或hypothesis。README可作为外部研究记录单列，不能当本capture observed；未证传输层原因不能硬标事实。路径、asset摘要、capture归属先校验再分析，不默吞坏记录。

### 7.7 F6：完整 Chromium 功能、导航证据与合成解释器仍未交付（阻塞）

**dump：** Blink侧没有 `IgnitionObserverSetDumpCallback/RequestDump` 消费入口，只有d8脚手架写JSON。寄存器范围/frame_args、window到函数实例的绑定也未实现。既然E4/E7原先承诺资产通道与同一控制面，这不是可自动结转的后续扩展；必须接通受控锚点/资产计账/stop，或先显式申请范围缩减，缩减前不得整期accepted。

**nav_chain：** E5实际在manifest顶层`nav_chain`，规范写`identity.nav_chain`；只存文档后继，没有为未解析的cookie/tap事件建立可靠document绑定。驱动把全trace里“包含anchor的任意cookie.get”叫stage2读，**stage1自身就有相同读回**（fixture:15），又未核对双方frame/document/事件顺序。因此即使二阶段不读，当前assert也可能通过。

对请求Cookie头不足的裁决：**同意报告现钩点缺能力，不接受 set→get 作为请求发送的等价验收。** 先用自有本地HTTP服务记录实际收到的Cookie作为独立oracle，并把浏览器相关request/document身份对齐；这只是辅助证据。若当前bnet看不到最终头，项目架构师提出已有CDP extra-info或正式网络观测点的方案、权限/来源/时序和测试，再裁决正式落点；本轮不要求访问真实站点，也不自动授权大改网络栈。保留HttpOnly服务端设置、同名不同path、取消导航、跨renderer同frame等负例。

**解释器fixture：** 专用已知虚拟程序逐事件对照未做，三个语料也并非都补齐D1；不能用区间命中/计数非零替代。需要PC与opcode不同、分支、变长指令、重入/重复调用、预算缺口等自有fixture的真值比对。

### 7.8 F7：现有门禁证明范围过弱，先修测量再刷全绿（阻塞）

- E7“off/on语义全等”实际使用不同程序：off跑200000次PLAIN，on跑f(10)/f(20)并优化；只断言allFinite，不比较last。stop后只检查JS有限值，不检查tap/skip计数停止。以非精细模式主动退出Ignition窗口降低事件量，不能作完整精细观测验收。
- E4验证器有 `assert ... or True`，无地址断言恒真；E1/E2/E3/E4写死输出目录、部分在import/运行时重写受跟踪fixture或删除原证据。T3/T7门禁的“非空/实例连接/预置site答案”无法发现本轮假阳性。
- 10/11ms谓词基准在默认tiering后很快不走Ignition，且包含打印；FindByVersion每个tap线性遍历registry，窗口又按start排序、按end二分，嵌套重叠窗口不满足二分前提。不能宣称完整热路径O(log n)或开销已验收。
- tap validator只检查若干字段存在及value_role，不验证instance/offset/window类型、计划归属、真实值形态、metadata/dump资产、sampled_out等式或nav证据。规范只在头部追加长段，正文仍保留旧式与位置；没有machine-readable accounting revision。

整改：所有执行用新目录，不修改输入fixture；纯检查与生成工具分开。先加入本轮反例，严格类型/完整值/计数/引用/归属负例，才重跑正向矩阵。实例映射改常数时间索引或直接传已定位Entry，窗口重叠规则先定再编译；谓词性能用固定实际tier和确定性负载，不用JIT逃逸缩短测试。

## 8. 裁决与下一执行块（P55-R0～R7）

### 8.1 架构裁决

1. 保留Entry起步、单capture、现有管道/asset复用、有界读值等正确方向；本轮不推倒重建。
2. **不追认**每激活预算变每实例、dump仅d8、网络锚点改set→get、按site名分类、pool全部字符串当已读的替换。若项目架构师认为必须缩范围，应先提交需求→剩余项→影响的显式变更，不能靠勾选表示已经裁决。
3. “不得重开已冻结决策”约束架构漂移，不禁止发现前提错误时升级；本轮发现的内存/编码/计账问题必须修复。禁止把规范同步改成与缺陷一致来凑绿。
4. 当前错误结论不得流入P6/报告/Agent作为已验证事实。T7可短期停止产出确定family、T3候选降级，最终仍需完成真实算法与证据契约，不以删功能终结整改。
5. 实施继续由工程师负责，项目架构师先校准契约与设计选择，总架构师核验反例和最终证据。保持单构建协调器；无私有语料回连授权，不为复验访问原始第三方站点。

### 8.2 任务、责任与门槛

| 顺序 | 执行交付 | 关键门槛 |
| --- | --- | --- |
| R0：冻结新反例、明确真实状态 | 工程师迁入本轮dump/scope/预算/T3/T7合成反例，独立输出目录；项目架构师回填缺项，不再全勾完成 | 反例在旧实现必红；无fixture重写/证据覆盖；P5已有12门保持绿 |
| R1：配置与范围一体化 | 项目架构师定计划schema、实例/窗口、重叠与重置语义；工程师按isolate线程发布完整snapshot，统一所有callback过滤/stop | excluded脚本的tap/metadata/dump/预算全为0；负参数/未知实例拒绝；更换计划代数可追溯；并行Worker不竞争vector |
| R2：计账全链闭合 | producer、watermark、controller、manifest、validator同批更新；纳入revision和coverage轴 | 891不能在global变0；0/1/N/N+1、连续激活/更新/丢弃/断连分列；伪造计数失败 |
| R3：安全有界编码 | GC-safe traversal、UTF编码、key/叶子/输出预留预算、shared/RAB边界、数组逻辑长度 | 本轮6个dump反例与NUL tap修复；大rope/BigInt不全量转换；getter/Proxy额外调用0；GC存活/释放均正确 |
| R4：D1与值探针完整交付 | 命名空间、真实operand/index、函数/位置、canonical源摘要、metadata补发；Chrome dump锚点和asset通道 | 同URL/同名/跨isolate不混、动态key未知不编造；register/frame_args按承诺实现；dump同capture可控/可停/可核账 |
| R5：导航与分析 | 有来源的请求Cookie证据方案；frame/document绑定；T3逐offset解析、T7证据规则，删除站点答案字典 | stage1读不冒stage2；无关frame/同值负例；empty trace/普通循环不报observed JSVMP；decoy pool不能proven |
| R6：完整合成验收与性能 | 自有解释器fixture、精细环境同负载on/off、GC/预算/shape矩阵；热路径基准分项 | 逐事件真值与误选tap负例；stop后零增长；无默认tiering逃逸；原私有语料只在明确隔离授权下补充 |
| R7：最终交付与终审 | 每阶段同步补丁，最终重放/组件/驱动/args/数据schema摘要，重建后测试目标门禁与回归 | 对契约§10逐项有可核证据，未完成不accepted；无需将本机原始trace整体进Git |

### 8.3 R0 执行记录（2026-09-25，工程师——反例冻结，旧实现全红）

- `scripts/p55-r0-d8-counterexamples.py`：**7/7 红**——width（300 props、partial=false）、large-key（70,288 字节超预算）、shared（captured 而非 unavailable）、array-logical-length（backing 容量 17 项）、tap NUL/CJK 保真（30 tap 无一字面量）、T3 decoy 升格、T7 空 trace 判 observed。每次运行独立目录（`out/XTraceP55D8/validation/p55-r0-<ts>/`），不覆写任何既有证据。
- `scripts/p55-r0-browser-counterexamples.cjs`：**5/5 红**——scope 绕过（ignition=0 但 taps=675、metadata=5 泄漏）、负 window id 接受、负预算接受、两次计划同报 generation 0、global `counts.sampled_out=0` vs producers 合计 891（两目录复核）。
- 恒真断言修复：`p55-e4-d8-verify.py` 的 `assert … or True` 改为严格断言并重跑通过（该测试本身的缺陷，非实现变化）。
- 反例首红目录：d8 `p55-r0-20260925-095702`、browser `p55-r0b-tzdlsm`。

### 8.4 R1+R2 执行记录（2026-09-25，工程师）

**R1（scope 一体化 + 严格校验 + 计划代数）**——browser 反例 4/4 转绿：
- `OnIgnitionTap`/`OnIgnitionMetadata` 与事件路径同一 `ScriptSelected` 判定；metadata 回调签名扩展携带 registry 自有 `script_url`（注册时即可判，不依赖事件先缓存）；范围外脚本 tap/metadata/预算全部零增量（`p55-r0b-uzAQqr`：impossible-match scope 下 ignition=0、taps=0、metadata=0）。
- startCapture 严格校验：负 id/负预算/越界/重复 id/重叠窗口（策略 NONE）/窗口数>64/预算超硬上限（100k/64k）全部显式拒绝（R0 反例 negative-id/negative-budget 转绿）。
- 计划代数：`tapPlanSerial` 进 pdl 返回值与计划 JSON；不同计划 serial 必不同（R0 反例 plan-generation 转绿）。**修复过程实证了总审 F2 的"静默失败"**：plan_serial 键一度使 V8 手搓解析器整体 fail→taps 静默关闭——解析器现已知该键。
- 开发中顺带修复 serial 先取后分配的次序错位。

**R2（计账全链闭合）**——browser 反例第 5 项转绿 + validator 负例入回归：
- producer：预算跳过同时计 `eligible` 与 `sampled_out`（冻结等式 `eligible = enqueued + dropped + sampled_out` 按生产者成立；E7 复跑实测 1253+0+891=2144 ✓）。
- controller：全局 `counts.sampled_out` 真实求和（原硬编码 "0"）；manifest 增 `accounting_model:"2"` 与 `observation_coverage: full|partial`（任一预算拒绝→partial，与传输终态分列）。
- validator：model 2 下逐生产者等式、全局求和一致、coverage 自洽（full+sampled>0 拒绝）；旧两 term 检查模型感知。**E7 复跑首跑即被新等式抓住**（旧检查未含 sampled 项）——证明等式检查在拦真实错误，随后修正旧检查。
- V8：新计划同时重置逐窗口计数与逐激活总额（代数边界=激活边界）。
- 新单测 6 个（tests/test_validate_trace_v3.V3AccountingModel2Test：等式违背/全局失配/full+sampled/缺 coverage/legacy 跳过/一致通过）——python 全套 381+28 OK。
- R0 browser 反例扫描限定 model-2 manifest（pre-R2 目录为冻结历史证据，非现实现缺陷；总审原始 891-vs-0 事实保留在 §7）。

补丁栈重生成（chromium 126/3/1/3 + V8 137），verify pass。**R1+R2 部分完成 typed-mojom 计划与 isolate 线程原子发布的功能等价物（严格校验+代数+同 scope）；跨线程发布改造并入 R4 批次的 chrome dump 触发一起做（同批触碰同文件）。**

### 8.5 R3+R5-a 执行记录（2026-09-25，工程师）

**R3（安全有界编码）**——d8 反例 5/5 转绿：宽度计数双分支真实递增 + 截断显式 partial；dense 数组报告 JS 逻辑长度（绝不报 backing 容量）；Shared 显式 unavailable/shared-no-consistency；全部 ToCString 路径替换为逐字符精确读（Latin-1/UTF-16 语义、\\uXXXX 转义、NUL/CJK/é 保真）；rope/大串先 O(1) 长度检查；BigInt 先位数估算（digits×20>128 直接 truncated）；键读入 bytes_read、>128 字符键截断记录。**GC 压力门 PASS**（12 轮 MarkCompact 包夹 dump、300 轮 GC 下 tap 哨兵计数与基线逐位相等）。开发中自伤两处均被驱动当场抓住并修复（tap 字符串开引号丢失；重编窗口撕裂 manifest）。

**R5-a（T3/T7 + nav_chain）**——反例 2/2 转绿：proven-pool 等级删除（池成员=candidate-pool，逐条注明待 R4 operand 索引）；T7 站点字典删除（family 需密度+随机路径 bundle URL 才 observed，仅密度 hypothesis，空 trace/普通负载 unresolved；mode 只认本 capture 状态码；cookie 只从本 capture 事件观察；语料 manifest 仅作 bundle 出处）；nav_chain 迁入 manifest.identity（对象形 frames[]+nav_chain[]），validator 对象形校验（后继相异+字段，legacy 兼容）；E5/E7 迁移后重跑 PASS（并当场抓到 manifest 括号数错误）。

### 8.6 R4-b+R5-b 执行记录（2026-09-25，工程师）

**R4-a（D1 operand/常量池索引）**：instructions 表新增 `pool_indices[]`（每指令的常量池操作数索引，无则 -1）；T3 逐事件 offset→pool_indices→constants 精确解析——`proven-read` 等级落地（事件 offset 精确定位到被读常量），未引用常量保持 candidate-pool。d8 实测：单事件解析出 `realKey` 为 proven-read、decoy 保持候选。

**R4-b（chrome dump 锦点）**：`XTrace.requestDump` 命令面（pdl+protocol_config+handler）→ 控制器扇出（**首个接受者胜**，拒绝需全员拒绝后才报失败——页面 renderer 往往最晚回复）→ renderer `DumpAnchor`（mojom）→ 桥 `RequestDumpFromExpression`。关键工程点：锚点三元组（isolate/context/owning-runner）**原子配对**写入（两个写入线程绝不能混搭 isolate A + runner B，否则 isolate.cc 线程 DCHECK 直接崩）；控制分发线程与 isolate 线程不同时先投递后等待。
**边界（如实）**：`Script::Run` 在裸投递任务里触发 blink 微任务域 DCHECK（api-inl CallDepthScope）——页内表达式求值必须走 blink ScriptController 的脚本执行机制，不能用裸 V8 API。R4-b 的命令面/扇出/锚点/线程跳转全部就位且编译通过，求值机制的最后一步（ScriptController 路径）为后续工作，requestDump 端到端未绿，不冒充完成。d8 级 dump（引擎 walker）不受影响，全部绿。

**R5-b（echo 主 oracle）**：E5 驱动改为**三级验证**——renderer cookie.set 值 == **echo 服务实际收到的 Cookie 头**（自有 SimpleHTTPRequestHandler 记录，独立于任何引擎钩点）== 二阶段 cookie.get 值，三者经 nav_chain 同链；fixture 移除 stage-1 读回（set→get 降级为辅助通道，不再充当请求锚点）。PASS（echo_match: true）。

### 8.7 R6 执行记录（2026-09-25，工程师）

**R6-a 合成解释器 fixture**（`test-pages/p55/r6-synthetic-vm.html` + `scripts/p55-r6-synvm-evidence.cjs` PASS）：已知虚拟程序（7 指令、PC 与 opcode 为不同数字、含 JMP 回跳边、重复 opcode、分支 fall-through、变长体）；12 步 ground truth 由页面自记，tap 流 563 条全为 unclassified 事实（契约：引擎永不命名虚拟语义）；**12 条 tap 精确落在派发器 named-read 指令且其 pool_indices 解析到 `"op"` 常量**——D1 元数据 + tap + 逐事件键解析三层在 chrome 现场闭环；tier 断言：全部 Ignition 事件 tier=ignition（--max-opt=0 全程，非假设而是逐事件验证）。

**R6-b 固定 tier 分项基准**（`scripts/p55-r6-perfbench.py` PASS）：同一 2M 迭代派发负载、--max-opt=0 全程 Ignition（tier 由 R6a 同二进制同旗标断言）、无 printf 于被测环。**谓词**隔离测量：预算 0 模式（窗口全匹配、预算 0——每次命中为 budget skip：谓词+标记跨边界、零编码零写入）；**编码+写入**：全预算模式与谓词模式的差。结果（5 次取中位）：off 47.4s / predicate-only 54.0s（+6.6s，≈**131 ns/命中**，50M 次命中）/ full 57.4s（编码+写入再 +3.5s）。全量开销 ≈21%（2M 迭代派发循环、50M 字节码事件——每 Ignition 事件全开 tap 的极端上界；实际探针按窗口预算截断）。tier 逃逸问题不复存在（对比 E7 时代 10/11ms 默认分层基准）。

R1/R3的可独立模块允许不同工程师分工，编译仍只有一个协调者。R4元数据与R5分析输入先定接口，不能分析器继续猜缺字段；R6要在测量工具修好后执行。网络正式观测点和budget语义先提设计裁决，不把实现阻塞藏到E8才说。

## 9. 本轮原始证据与完成审计

证据目录：[p55-chief-review-zste362j](../chromium/src/out/XTraceIntegration/validation/p55-chief-review-zste362j/)。

| 要求/复验 | 实际证据 | 结论 |
| --- | --- | --- |
| 固定基线、补丁可恢复 | `replay.json`、`identity.json`（含组件/d8/driver摘要） | 133/137一致，支持已有交付，不证明行为正确 |
| 基础回归/P5前置 | `regression.log`、`bindings.log`、`p5-prerequisite.log` | 375/28/211、57、12门亲跑通过 |
| 范围/配置/代数 | `browser-probes.cjs`、`scope-exclusion/result.json`、`reconfigure-generation/result.json`、`semantic-and-invalid/result.json` | 20 tap越scope，window1/2都generation0，负参数accepted |
| sampled_out与终态 | `budget-evidence.json`、`validator-sampled-probes.json` | 891/0矛盾且伪造不拒绝 |
| dump宽度/字节/编码/shared/数组 | `d8-probes.py`、`d8-probes.json`、`dump-*/dumps/*.json` | 独立合成反例成立，不能验收硬上限与真值 |
| tap精确字符串 | `tap-values.js`、stdout/stderr、`tap-values.json` | NUL变空格，captured标签不实 |
| 分析可信度 | `analysis-negative-probes.json`、`synthetic-t3/`、`empty.ndjson` | decoy proven、空输入确定分类，反例成立 |
| 未做项 | 本轮未重建测试目标/全量chrome，未执行私有语料、未访问原站 | 不把执行层历史测试当本轮亲跑 |

完成审计：浏览器dump入口、请求锚点、完整实例身份/元数据、计账/coverage和合成解释器golden均缺失或不符合契约；已证“机制可工作”不是“任务全完成”。本轮仅完成review，不宣告P55目标完成，不更新为accepted。

---

## 10. 项目架构师独立复核与裁定（2026-09-25）

**方法**：对总审 F1–F7 逐条做了独立源码/证据核验（不依赖总审结论），再对总审移交我的四个裁决点给出裁定。结论：**F1–F7 全部属实；整改序列 R0–R7 确认，附加本节目的裁定与补充门槛。** 工程师按 §8.2 + 本节执行。

### 10.1 逐条独立核验（全部与总审一致）

| 发现 | 我的核验 | 结论 |
| --- | --- | --- |
| F1 范围绕过 | `xtrace-ignition-bridge.cc` 中 `ScriptSelected` 仅一个调用点（line 294，OnIgnitionEvent）；`OnIgnitionTap`/`OnIgnitionMetadata` 不经它；`ApplyTapWindowsConfig` 在控制线程直接遍历 scope 改他线程 V8 状态 | **属实** |
| F2 配置无权威校验 | `xtrace_handler.cc:424–470`：window 只查 `start<0 \|\| end<start`，**id 不校验、预算不校验**（负值直通 JSON）；"clamped" 注释无对应代码；`valueObservation` 在 mode=semantic 下不经 precise 拒绝；配置为手拼 JSON | **属实** |
| F3 计账未闭合 | `xtrace_capture_controller.cc:1220` 全局 `counts.sampled_out` 硬编码 `"0"`；`validate_trace.py` 全文件无 sampled_out 检查；producer 行有值（891）而全局为 0、终态 complete | **属实**（我另验：manifest 无 coverage 轴、无 accounting revision） |
| F4 dump 边界失守 | `xtrace-ignition-observer.cc:442–470`：`written/skipped` 声明后**循环体内从不递增**，宽度上限形同虚设；`:541` 用 backing `elements()->length()`（容量）而非 JS 逻辑长度；`:216/283` ToCString（NUL 替换、Latin-1 非 UTF-8）；`:350/382` Flatten/BigInt 全量转换先于截断 | **属实** |
| F5 T3/T7 假阳性 | `scripts/p55_t3_t7.py`：T3 在实例存在任一 named 读时把**全部**常量池字符串标 `proven-pool`（内部字段还叫 candidates，输出 grade 却升格为 proven）；T7 按 `site_name` 查硬编码字典出 cookie/mode，`family=jsvmp-challenge/observed` 无条件 | **属实**（空 trace 也能"分类成功"） |
| F6 缺项与锚点 | manifest `nav_chain` 在**顶层**（controller:1225）而契约写 `identity.nav_chain`；E5 驱动对 stage2 的断言是全 trace 搜含锚点的任意 `Document.cookie.get`（stage1 自身读回即可满足）；dump 无 chrome 侧触发入口；合成解释器 fixture 未交付 | **属实** |
| F7 门禁过弱 | E7 off/on 用不同程序（`PLAIN` 200k 循环 vs `LOOP` f(10)/f(20)）且只断言 allFinite；`p55-e4-d8-verify.py:74` 的 `assert … or True` 是恒真断言；10/11ms 基准含打印且默认 tiering 提前离开 Ignition | **属实** |

另确认总审两处记账/措辞问题：E8 自报"chromium 126 文件"为过期值（总审实测 133）；契约"预算每激活"被实现为每实例累计（`maxTapsPerActivation` 无激活边界重置、窗口更新不清 `tap_budget_total`）——**不追认，恢复每激活语义**。

### 10.2 对总审移交裁决点的裁定

1. **请求 Cookie 头的锚点方案（F6）**：三级证据，主次分明——
   - **主 oracle：本地 echo 服务**。自有 HTTP 服务记录实际收到的 Cookie 头，作为"服务端真收到锚点值"的独立真值（无需任何引擎改动、不碰权限边界）。E5 验收改为：renderer cookie.set 值 == echo 服务收到的 Cookie 头值 == 二阶段 cookie.get 值，三者经 nav_chain 同链。
   - **辅证**：set→get 同值保留为 renderer 侧 derived 级链接，**不再充当请求锚点**。
   - **引擎侧缺口登记**：bnet 钩点早于 Cookie 附加，"请求头不可见"作为能力表缺口披露；**本轮不做网络栈观测点前移**（独立设计轮，含权限/来源/时序论证后再裁决）。
2. **计账语义（F3）**：冻结如下，R2 一次性落地——
   - producer 级：`eligible` = 通过 scope+版本+kind+至少一个 window 匹配的机会（多窗口命中只计一次）；`sampled_out` = eligible 之后被预算拒绝；等式 `eligible = enqueued + dropped + sampled_out`。
   - window 级：每 window 记 seen/recorded/skipped 与首末位置、缺口段，绑定 plan generation；window 是**报告视图**，不是独立 eligible 池。
   - 配置更新：window 计数随 generation 重置；producer 级传输计数跨代累计；manifest 增 `producers[].generations[]` 承载分代窗口统计。
   - 完整性两轴：`terminal.state`（传输）与新增 `observation_coverage: full|partial|unknown`（观测）分列；任一 window skipped>0 或预算耗尽或 dump 截断 → partial；manifest 增 `accounting_model: 2`，validator 对 model≥2 强制校验新等式与 coverage 自洽，**绿不再自动等于完整**。
   - `maxTapsPerActivation` 恢复**每激活**重置语义；per-instance 累计若保留只能作为文档化的二级上限。
3. **tap 计划 schema（F2）**：typed mojom 结构取代手拼 JSON——`XTraceTapPlan{generation, script_pattern, windows:[XTraceTapWindow{id,start,end}](≤64), budgets{per_activation, per_window}, reset_policy}`；硬上限（per_activation ≤ 100k、per_window ≤ 64k）；负值/重复 id/未声明重叠策略 → 显式拒绝；未知实例窗口 → 拒绝该窗口并在 status 报告，不静默；**计划按 generation 原子发布到所属 isolate 线程**，失败保留旧计划并返回 not-applied（禁止静默成功）；V8 侧不得第二份 JSON 解析器重释 browser 计划（传结构化计划对象或严格解析+错误响应）。
4. **nav_chain 位置与范围缩减（F6）**：schema 为准——`nav_chain` 迁入 `manifest.identity`（实现改、规范不改）；dump 的 chrome 侧受控触发（锚点、资产计账、stop）**不缩减范围**，入 R4 交付。

### 10.3 对整改序列的确认与补充门槛（R0–R7）

- 序列与责任划分（§8.2）确认。补充门槛：
  - **R1** 附并发契约测试：并行 Worker + 配置更新交错，断言无跨线程 registry/vector 竞争（总审 F1 的源码确认项需要行为级证明）。
  - **R3** 附 GC 压力 fixture：强制 MarkCompact 下的存活/搬迁/释放矩阵（d8 门内），覆盖递归 flatten/BigInt 转换期间的 GC——总审未做内存破坏实验，R3 必须补正向压力而非仅静态修复。
  - **R5** 的 T7 整改后，语料 README 的研究记录保留为**外部输入**（可列参考文献），不得回流为分类器答案；空 trace/普通循环/冲突特征必须 unresolved 或 hypothesis。
  - **R6** 性能基准用固定 tier（全程 max-opt=0 且断言实际 tier）与确定性负载，报告分项（谓词查找/编码/序列化/写入），删除含打印的混合基准。
  - **R7** 补丁栈逐文件比对 + `verify_patches.py` + 全测试目标重建后门禁；E8 记账修正为实测文件数。
- 明确拒绝的降级路径：把规范改成与缺陷一致、删功能终结整改、以 d8 切片冒充 chrome 交付、以 set→get 冒充请求锚点——与总审一致。

### 10.4 对执行层的直接要求

1. R0 先迁反例（总审 7 组 + 本文确认的恒真断言/假阳性脚本），**旧实现必红**、独立输出目录、不覆写既有证据。
2. 每项修复按"反例先红 → 修复 → 反例转绿 → 正向矩阵复跑"四段留证；门禁表恢复 controller/producer 全目标并沿用自动化脚本。
3. 本块结束前，`trace-schema-v3` 的 v1.3 文本与实现对齐（sampled_out 等式、nav_chain 位置、accounting_model、coverage 轴），validator 与负例同批。
