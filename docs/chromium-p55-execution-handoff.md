# P5.5 执行工单：值观测二期（引擎长程块）

- 版本：v1.0（2026-09-24）。前置全部满足：P1–P5 冻结；[设计契约 v2.0](chromium-p55-design-contract.md) 冻结；语料采集步交付（`analysis/corpus-capture/`，本地）。
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
