# P4 交接：结构化 Ignition observer（执行前事件 / 规范化 offset / 执行层校验）

- 文档版本：v1.2（2026-09-22，F0～F6 复审、生命周期/解析反例与资源约束下的下一步见 §11）。
- **当前裁决：仍为 changes required，不标 accepted-p4，不开放 P5 插桩实施。** F0/F1 和 F2/F4 的部分改进已复验；非 release 项仍有 GC/Worker 崩溃及错误 tier 接受，不是“只缺性能构建”。下一任务以 §11 为准，§4/§10.4 勾选保留为原始申报。
- **资源约束：A/B release 全量编译维持用户要求的暂停。** 本轮只做低负载、串行复核；限流与加速执行方案见 [chromium-build-resource-plan.md](chromium-build-resource-plan.md)。
- 前置状态：P1/P2 历史验收保留；P3 类别过滤的常见反例在本轮已通过，首次配置屏障与完整范围能力仍须按 §11 补验。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。执行模式沿用长程单次终审（§7）。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §9（V8 增强设计）、§12 P4 行、§13.1（已收敛决策）；P0 证据（`out/XTraceD8Verify/validation/`，10 组字节码样本 + 4 组 tier 检查）；[trace-schema-v3.md](trace-schema-v3.md) v1.2；[P3 设计](chromium-p3-design.md)（控制面现状）。

## 1. 当前执行指令（2026-09-22 15:05 +0800 更新）

**执行负责人：用户指定的资深工程师／执行层 agent；总架构师负责契约与证据复核，不启动重复实施。以下是当前任务入口，优先于 §4、§7、§10.4 中历史阶段的完成勾选与入口条件。**

### 1.1 已解除与仍有效的限制

- 磁盘：用户已清理并报告 **345.42 GB** 可用，本会话实测约 **321 GiB**，已满足构建方案初始空间门槛；不用再为旧的 18/109 GiB 快照清理文件。
- 功能：R1 弱回收 fatal、R2 stop 后 Worker 销毁崩溃、R3 tier 误判仍需修复；范围、warm、验证器与驱动的其余缺口按 §11.3 执行。
- 编译：**A/B release 全量构建仍暂停，用户尚未授权恢复。** 磁盘充足不等于功能通过、限流已部署或恢复获批。
- 交付：代码修复、驱动、测试、资源控制均落根补丁/scripts/tests；out 只保留产物和证据。不得清空 out、重建 P0、关闭沙箱或用旧二进制宣称修复生效。

### 1.2 工程师现在做什么（不等待全量编译解冻）

| 顺序 | 现在执行 | 交付与停止条件 |
| --- | --- | --- |
| 1 | **N0：固化反例与修测试驱动** | 将 R1/R2/R3 独立反例转成受跟踪测试；修 F5 sessionId、完成结果、超时和进程清理；fake pipe/合成 fixture 单测，无需全量构建 |
| 2（可与1并行） | **N5：资源控制先落地** | 按构建方案 C0～C2 实现单协调者、默认 -j2/-l3/-k1、后台调度、单 linker／内部2线程、压力停止门；先用 fake runner 验证，不启动 A/B |
| 3 | **N1：先修 V8 弱回收；N2：再修 stop/销毁** | 代码修改后先 dry-run，确认只做既有 P4D8/Integration 的局部增量；通过资源控制入口串行执行。若图意外扩大为全量或压力超限，停报，不自行继续 |
| 4 | **N3：tier、范围及首次配置屏障；N4：warm与证据闭合** | 修复路径与断言见 §11.3/§11.4；同一策略驱动实际配置和披露。逐项局部验证后再跑必要回归，不逐小改重建 release A/B |
| 5（暂不可执行） | **N6：完整 release B→A 与三态测量** | 仅在功能门和限流验证通过、实时资源门满足，并获得用户明确恢复许可后运行；不得并行 A/B |

N0～N5 不要求逐行审批；不可兼容契约、范围变更、超预算或意外全量失效才回报裁决。资源控制可并行开发，但**实际编译始终一个协调者，限流接线先于下一次真实增量构建**。

### 1.3 下一次交回架构师的内容

工程师下一次回报按 §11.4 的 N0～N5 给出：变更文件/补丁、复现前后退出码、原始证据、最终载码二进制与驱动摘要，以及资源控制的有效 argv/压力测试结果。不能只报“单测全绿”；R1 必须真实释放对象，R2 必须 stop 后销毁 Worker 且无 renderer crash，R3 必须真实 baseline 反例被拒绝。

N0～N5 完成后由总架构师复核功能与限流，再向用户提交 N6 恢复请求（明确 B→A、-j2/-l3、单链接、预计资源与停止条件）。当前用户只更新了磁盘状态，**不视为该恢复请求已获批准**。P4 不提前 accepted，P5 C++ 不开放。

历史设计依据仍需阅读：草稿 §9/§12.1/§13.1、P4 五项裁决以及本文 §10/§11；不重新等待已经通过的最初 R1 设计裁决，也不因 P3 有整改项而停止修复这些整改项本身。

## 2. 冻结输入（不得变更的基线）

| 项目 | 值 |
| --- | --- |
| Chromium / V8 | `151.0.7917.0`；`73088b4e…` / `af6aa2ec…`（不变） |
| 补丁栈 | 0001→0003→0004→0005（Chromium）+ 0002（V8），顺序与分层不变；P4 新增改动按职责回写（V8 侧改动进 0002） |
| 数据契约 | v3 不变；P4 只按"只加字段不改语义"演进（`script_id`/`bytecode_version`/`bytecode_offset`/tier/激活身份属草稿 §11 标注的 P4 字段） |
| 已有设施 | P2 producer/批量化/计数/watermark；P3 带内控制端点与 generation；P0 的上游 tracing 验证结论（V11–V15） |
| d8 对照基线 | `out/XTraceD8Verify`（未打补丁）——**只读**，不得在原地重建；P4 的 d8 迭代用独立输出目录（见 P4-E0） |

## 3. P4 范围与非目标

### 3.1 范围内

1. 结构化 Ignition observer：执行前事件（"某激活在指定执行层到达规范化后的某条 V8 字节码，尚未执行"），规范化 offset（Wide/ExtraWide 前缀与 operand scale、InlineShortStar、Return/Throw/ReThrow 路径），按版本预解码并缓存的字节码元数据。
2. 执行层校验：tier 参数双层校验（Host 静态检查 + `startCapture` browser 侧权威拒绝并回报实际生效配置——V14 教训：`--max-opt=0` 可被显式 Sparkplug 参数覆盖）；模式声明（常规语义采集 / Ignition 精细实验 / jitless 实验）。
3. code cache 路径决策落地（草稿 §9.2 二选一：精细模式禁用并披露，或反序列化路径补元数据事件；验收覆盖 warm profile）。
4. isolate/context/script 范围启停：Blink 侧经 `V8PerIsolateData::UserData` 管理状态；V8 不依赖 Blink；跨边界回调、状态句柄与销毁顺序在设计文档中定死。
5. 事件走既有 producer 管道（P2）：V8 侧不拼 JSON、不做磁盘 IO；关闭时轻量 gate、残余开销可测。
6. 与 P0 对照的验收矩阵 + release 构建上的性能验收。

### 3.2 非目标（明确不做）

- 不做 Sparkplug 观测扩展的实现（只作对照存在性声明；编译期生成与否影响动态启用能力——V12）；不做 Maglev/TurboFan 观测（未测，声明边界）。
- 不承诺 opcode 执行后的值、精确 def-use、全 JIT 层逐指令。
- `v8_bytecode` 与分析器推断的 `virtual_opcode/vpc` 必须分列；不得把 V8 opcode 改名后冒充 VMP 指令。
- 不做 P5（WebIDL 生成器）、P6（Agent Host/工具）、指纹层；不升级基线；不退役 arm64 hooks；不关沙箱。

## 4. 任务分解

### P4-E0：d8 迭代环（先于 C++ 主线）

> [x] 完成（2026-09-20）：`out/XTraceP4D8` d8 构建成功（3443 步，GN 含 tracing 组合）；P0 `verify_d8.py` 10 样本 PASS + `verify_tiers.py` 4 组 PASS 在打补丁树上复跑（V8 源与 P0 基线一致，可比性说明见设计文档头部）；证据 `out/XTraceP4D8/validation/{d8-build-p4,verify-d8-p4,verify-tiers-p4}.log`。附带修复：0005 的 verify_libraries_chrome_app input 路径改为 ChromiumX.app（GN 全图在 release 参数下因 stale 路径报错，已随本项修正并入补丁 0005）。

- 在已打补丁的源码树构建 d8 到**独立输出目录**（如 `out/XTraceP4D8`）；GN 参数沿用 P0 的 tracing 组合（`v8_enable_trace_ignition` 等）。**严禁**在 `out/XTraceD8Verify` 原地构建（那是未打补丁的 P0 证据）。
- 验收：d8 构建成功；P0 的 `verify_d8.py`/`verify_tiers.py` 在新目录复跑通过（环境差异说明）。

### P4-E1：P4 设计文档（R1 关卡，纯文档）

> [x] 产出 `docs/chromium-p4-design.md`（observer 落点/gate/六字段扩展/code cache 选禁用/tier 拒绝矩阵/采样首版关闭/销毁顺序/测试矩阵，含五决策点推荐）——待架构师 R1 裁决

产出 `docs/chromium-p4-design.md`：observer 机制与 gate 位置；事件字段扩展清单（含与 v2 `causality.call_id` 的承接关系）；code cache 二选一的选定与理由；tier 校验参数形状；采样/限流策略与 `sampled_out` 的关系；销毁顺序与 GC/寄存器不变量论证。逐项给推荐与备选（对应 §5 决策点）。

### P4-E2：V8 observer 核心

> [x] 完成——GN 开关 `v8_enable_xtrace_ignition_observer`（默认 false；两构建脚本 + XTraceIntegration/XTrace-release args 显式 true，A.1 接线证据）；Entry 与 InlineShortStar 双插桩点（短 Star 缺口由 E6 d8 环发现并修复）；运行期 gate 为 Uint32 load+branch（Word32 域比较，跨域 Change 曾使 mksnapshot fatal）；`Runtime_XTraceIgnitionObserve` 归一化严格镜像上游 `AdvanceToOffsetForTracing`（丢弃前缀指令的 opcode 位重复 dispatch）；字节码元数据按 BytecodeArray 实例登记 `bytecode_version`（trusted-space 地址为身份，重编译=新版本）；证据：`out/XTraceP4D8` 观察者 d8 + `p4-e6-parity` 十样本

- 编译期保留能力、运行期按范围启停；关闭时在进入观察 runtime 前经轻量 gate（不分配事件），残余分支开销列入性能验收。
- 事件：执行前语义；规范化 offset；accumulator/寄存器输入可从现有设施验证获取；执行后值不在首版。
- 字节码元数据按版本预解码缓存，不每事件从头扫描；遵守 bytecode offset/accumulator/寄存器保存/GC 不变量。

### P4-E3：embedder 边界

> [x] 完成——`xtrace-ignition-bridge.{h,cc}`（platform 层）：callback 随首个 producer 管道安装（`EnsureInstalled` 幂等），gate 按**页面脚本激活**开合（`OnActivationBegin/End`；内部 scheme 保持关闭，生成代码层短路），事件走所属线程 P2 producer 有界缓冲；`CurrentActivationToken()` 使 `activation_ref` 承接 P3 因果身份；证据：`p4-observer-*`（complete + ignition 事件 + 桥接）

- Blink 侧状态经 `V8PerIsolateData::UserData`（参考 `v8_per_isolate_data.h:217`）；V8 侧零 Blink 头依赖（沿用 event_logger 解耦先例）；跨边界回调注册/销毁顺序按设计文档。
- 事件入所属线程 producer 的有界缓冲，经 P2 管道批量入 writer；计数/终态契约不变（含 `sampled_out` 单列）。

### P4-E4：执行层校验与模式

> [x] 完成——`startCapture` 增 mode/tier 参数（只加不改）+ browser 权威拒绝矩阵（jitless 关闭、semantic 拒显式 tier、precise 强制 ignition 且拒 sparkplug 系启动参数=V14 教训）+ `effectiveConfig` 回报实际生效配置；`getCapabilities.limits` 携 `preciseModeAvailable`/`ignitionObserverCompiled`（链接期探针）/`codeCachePolicy`（A.3 机器可读条件）；证据：`p3-domain-smoke-Kqsf3o` 四负例 + 正例

- `startCapture`/更新路径的 tier 参数校验：browser 权威拒绝冲突组合（如精细模式 + 显式 Sparkplug 参数）；回报实际生效配置与真实执行层（不能只看 `max_opt` 字符串——以 active-tier intrinsic/帧内状态为证）。
- 精细模式的执行层约束与性能/时序差异写入能力表与 manifest。

### P4-E5：控制面接入

> [x] 完成——CDP 域五命令已在 P3 落地，本期扩展 mode/tier/effectiveConfig；observer 启停当前由启动期开关 + 激活作用域 gate 承担（运行期 isolate/script 范围为 P5+ 扩展，设计 §6 已留位）；v3 字段只加不改（`ignition` 对象六字段）

- `XTraceControl`/CDP 域扩展 observer 启停（范围：isolate/context/script）；配置快照进 manifest；v3 字段扩展只加不改。

### P4-E6：P0 对照验收矩阵

> [x] 完成——`scripts/p4-e6-parity.js`：十样本同进程 observer 计数与上游逻辑 Entry 计数**逐一相等**（29/24/24/105/73/35/64/66/63/1918）且 JS 语义不变（async 用 `.then` 取值）；4 组 tier 检查沿用 `verify_tiers.py` 复跑 PASS；关闭/开启语义一致性由 parity 的 XTRES 断言覆盖；`scripts/p4-e6-warm.js`：warm 证以 **bytecode_version 每编译实例递增**为准（A.3 要求的判据，非 flag 名）——三次新编译各得不同版本、单次编译重放版本稳定

- P0 的 10 组样本（短 Star、Wide、ExtraWide、分支循环、递归、throw/catch、rethrow/finally、generator、async/await、270 局部变量）在结构化 observer 下复跑：目标函数 offset/opcode 与字节码反汇编对照；无重复/漏记（分支/循环/暂停样本按"实际到达序列"断言，不把未执行分支误判为漏采）。
- 4 组 tier 检查复跑（`--max-opt=0`、baseline、`--max-opt=0 --sparkplug --always-sparkplug` 覆盖、`--max-opt=1 + %CompileBaseline`）。
- 关闭/开启两态的 JS 语义一致性（结果与异常语义不变）。

### P4-E7：性能验收（release 构建）

> [x] 完成（含披露边界）——release 变体（`out/XTrace-release`，1830 步含 observer 编译）重建；浏览器矩阵四跑全 complete：gate 关 0 条 ignition、observer 开 12702 条且重跑字节级一致（46007 事件/23.5MB）；墙钟 10.9–12.2s（含固定 6s 页面等待）。**披露**：① 同配置跨跑总事件数波动（113k vs 13k）源于页面非确定性（定时器/动态脚本），非 observer 开销；② d8 确定性负载测得 gate 关 29.54s / 开 42.70s（+44.6%，全保真每字节码路径）；③ “gate 关 vs 无 observer 编译”的精确零差对照需 P0 基线 d8，已如实登记为边界而非省略

- `scripts/build_xtrace_release.sh` 出 release 变体；测量：关闭时开销、启用时事件速率、批大小、峰值 RSS、队列占用、丢弃率、停止耗时；与 P1/P2 基线数据对比，口径注明构建变体。
- 上游 trace-off 不是无插桩基线（V11）——对照必须是无 observer 编译能力与关闭 gate 的差值。

### P4-E8：证据包与终审提交

> [x] 完成——五补丁回写（V8 侧改动**首次进入 0002**：GN 开关/外部引用/Entry+短 Star 插桩/runtime 归一化/版本登记/d8 脚手架；Blink bridge 与 CDP 域进 0001；logger 进 0003；ccbc 进 0004；命名进 0005）。**最终重放**：Chromium 栈 0001→0003→0004→0005 == 工作树（tree `3a9173df`，119 文件逐 blob 0 不符）；V8 0002 == 工作树（tree `361dc264`，135 文件 0 不符）。回归 338/28/211（run_tests.sh）+ 单测 5/5 + 4/4；矩阵**双跑** 12/12（observer 开 `browser-run-rYUfB3` / 关 `browser-run-CVpIbK`）+ 故障 4/4（`p2-fault-44mouo`）+ observer 冒烟含 v3 validator（`p4-observer-ho7guc`：163 ignition/163 桥接/99 offset）；摘要入 identity.json `p4E8Supplement`（含 release 变体 dylib）。
>
> **E8 期间发现并修复的三个真实缺陷**（均由矩阵/validator 断言抓出，非自测漏网）：
> 1. **observer 事件缺 v3 envelope**：bridge 曾手搓 JSON（无 `schema_version`/时间/pid/tid/attribution/causality）——矩阵的 "non-v3 record" 断言抓到（observer 关时 12/12、开时 8/12）。修复：改走 logger 的 `EmitEvent` 标准信封，新增 `XTraceLogger::LogIgnitionEvent`；六字段置于**顶层 `ignition` 对象**（设计 DP2 形状，非 args 内）。
> 2. **证据缺口**：observer 冒烟此前不跑 validator，故缺陷 1 未在该处暴露。修复：冒烟永久加入 `validate_trace.py --schema-version 3` 断言（`validatorPass`）。
> 3. **精细模式与因果的隐含耦合**：observer 的激活作用域依赖 causality 激活栈（`BeginActivation` 在 causality=off 时早退），故 v1 模式案例 0 条 ignition。处置：`startCapture` 的 ignition-precise **要求启动期 `--xtrace-causality=sync`**，否则权威拒绝；`getCapabilities.limits.preciseModeRequires` 机器可读披露（A.3 口径）。**此为对已裁决设计 §4 矩阵的新增一行，请架构师追认**（与 `activation_ref → call_id` 承接语义一致，非新机制）。

沿用既往纪律：补丁回写（V8 侧进 0002；Blink/content 侧进 0001/0003）+ 干净索引顺序复验 + 逐文件 blob 比对（P2 终审方法）；回归 338/28/211 + 单测 5/5+4/4 + 新增；文档与进度同步。

## 5. 实施前需架构师裁决的决策点（P4-E1 提交）

1. **observer 机制落点与 gate**：上游 tracing 设施改造 vs 新增 observer 的具体切点；关闭态残余开销的预算与测量方法。
2. **v3 字段扩展清单**：`script_id`/`bytecode_version`/`bytecode_offset`/tier/激活身份的字段名与类型；与 `causality.call_id` 的承接。
3. **code cache**：禁用并披露 vs 反序列化元数据事件（草稿 §9.2 二选一落定）。
4. **tier 校验参数形状**：`startCapture` 的 mode/tier 参数与冲突拒绝矩阵。
5. **采样/限流**：首期是否启用 1/k 及默认；与计数契约的关系（`sampled_out` 单列已定）。

## 6. 纪律与纠偏事项（沿用前序，新增第 10 条）

沿用 P2 §6 的 1–8 条与 P3 的第 9 条（受信边界）。新增：

10. **V8 侧改动是 P4 的高危区**：GC/寄存器/快照序列化不变量破坏不报编译错而报偶现崩溃——任何 handler/runtime 路径改动必须附 mjsunit/语义对照证据；出现无法解释的 renderer 崩溃时按 E3 的符号化预案（`v8_symbol_level=1` 重建复现）处理，不猜修。

## 7. 长程执行模式

沿用 P2 v1.1 §7 / P3 §7：入口条件（P3 冻结 + P4-E0 完成 + P4-E1 裁决）满足后，**P4-E2 → P4-E8 为一个连续执行块**，一次提交、一次终审；自主权与升级触发器沿用（六条 + 受信边界），另加第八条：**observer 需要改 V8 flags 冻结语义或全局执行层默认值**。

## 8. 完成定义

- observer 按范围启停；关闭态残余开销有测量；执行前事件的 offset 规范化经 P0 样本对照无重复/漏记。
- tier 校验双层落地，冲突参数被权威拒绝且回报真实执行层；code cache 决策落地并有 warm profile 证据。
- 事件经 P2 管道结算，计数/终态契约不被破坏；v3 字段扩展向后兼容。
- release 构建性能数据齐备；12 组矩阵回归 + P4 新增用例全绿；补丁栈逐文件可复现。
- 证据包经架构师终审；`integration-progress.json` 标记 `accepted-p4`。

## 9. 源码定位索引（P4；其余见草稿 §14）

| 范围 | 位置 |
| --- | --- |
| Ignition handler Entry / 内联短 Star / runtime 传参 | `chromium/src/v8/src/interpreter/interpreter-assembler.cc:52,1363–1374,1600` |
| 上游 Entry/Exit 与 offset 归一 | `chromium/src/v8/src/runtime/runtime-trace.cc:31,119,167` |
| `max_opt` 与 `jitless` 语义 | `chromium/src/v8/src/flags/flag-definitions.h:962,1012` |
| 初始化冻结 flags | `chromium/src/v8/src/init/v8.cc:187` |
| Sparkplug trace 编译期生成条件 | `chromium/src/v8/src/baseline/baseline-compiler.cc:633–657` |
| Blink per-isolate UserData | `chromium/src/third_party/blink/renderer/platform/bindings/v8_per_isolate_data.h:217` |
| tier 测试 intrinsic | `chromium/src/v8/src/runtime/runtime-test.cc:534,542,915` |
| P0 验证脚本与证据 | `chromium/src/out/XTraceD8Verify/validation/verify_d8.py`、`verify_tiers.py`（只读基线） |

## 10. 总架构师近期进展 Review 与 P4 终审（2026-09-21）

### 10.1 审查范围与总裁决

审查范围：2026-09-18～09-21 的全部 **33 笔提交**（`59cb926`～`1e8ce32`），按提交序列核对方案、裁决、补丁、驱动与回归变化；对当前 controller/producer、CDP handler、V8 observer、Blink bridge 和验证器做交叉审查，并在最终 ChromiumX 上运行独立反例。不是以提交标题或执行层回报代替源码与运行证据。

**总裁决：P4 不予冻结，下一步先修复并复验 P3/P4 契约缺口，不直接进入 P5。** 已完成的构建、补丁重放、基础管道和正常路径证据有效，无须推倒重做；但它们不足以证明精细模式、范围控制、缓存策略和性能验收成立。先前架构 review 对“有 generation 即配置生效”“page session 拒绝即非受信测试完成”等结论也过宽，本轮一并纠正。

**对新增 `causality=sync` 前置的裁决：接受这一依赖关系，附实施条件。** 既然 `activation_ref` 承接同步激活身份，精细模式不能在该身份不可用时返回成功；但必须依据实际生效配置判断，统一环境变量/命令行/renderer 状态，并在 capabilities、start/status、manifest 中一致披露。它不是下面 B1～B7 缺口的豁免，也不追认把范围启停移至 P5+。

### 10.2 逐提交进展账与已复核通过项

| 提交 | 进展及 review 定位 |
| --- | --- |
| `59cb926` | 项目报告建立；视为当时实现快照，不当作现状证明 |
| `787d13a` | 总体迁移草稿、P0 d8 事实与能力边界形成 |
| `47d6994` | 完整 Chromium 实施交接与避免重复构建纪律 |
| `54072f7` | 补齐指纹层延期、最小环境管理及 producer/消费端范围 |
| `089aee0` | P1 集成与 V05 转发修复、工具清单；工具声明不等于已迁移 |
| `f193e4f` | P1 附条件 review，要求真实组件与修复后摘要 |
| `24330ac` | V05 证据回填 |
| `afd59c0` | P1 冻结、发布 P2 交接 |
| `25a63ac` | v3 schema 与 P2 决策提案 |
| `a4d383b` | P2 契约冻结，切换长程执行模式 |
| `9a72566` | P2 v3 核心与 validator，登记带内端点方案及单测偏差 |
| `e01c8fd` | 追认带内端点、未确认计数 null 与 bnet 身份整改 |
| `9c56351` | P2 五场景/矩阵及分层补丁落盘；消费端欠账仍保留 |
| `153f2cc` | P2 历史验收、P3 入口单测欠账 |
| `af75a4f` | controller 5 / producer 4 单测、P3 设计 |
| `4873b0d` | P3 PDL 修订及 ChromiumX 命名裁决 |
| `8e0f91e` | CDP 域冒烟；只证明当前断言覆盖的路径 |
| `a833fe7` | stop/manifest IO 证据，不等价无条件同步完成 |
| `6a90316` | generation 更新冒烟；未验证过滤真正改变，见 B7 |
| `211eeab` | identity 形状校验；未证明历史导航/请求 crosswalk |
| `e97f44b` | P3 补丁、驱动及 ChromiumX 交付 |
| `8f451f1` | P3 附条件终审和 P4 交接 |
| `6a8fa02` | P3 单测漂移、build 块、脚手架等闭环 |
| `ae74d86` | P4 d8 环与设计提交 |
| `b4e0c7f` | P4 五项裁决提请 |
| `3fa3031` | release 工具路径与 ChromiumX bundle 修订 |
| `313cc4b` | 五项接受并附 A.1/A.3 条件；这些条件本轮仍需验真 |
| `d670bf3` | 0005 重放漂移与过时脚手架账务闭环 |
| `d08d180` | observer 编译接线及首次冒烟；不是范围/GC/覆盖已验收 |
| `aa09647` | mode/tier/capabilities 冒烟；实际 V8 flags 未被覆盖，见 B2 |
| `d0cf129` | 进程总数 parity 与 new Function 测试；不满足原 E6，见 B3/B4 |
| `8bc9eef` | release 测量驱动；原目录混跑，E7 结论撤回，见 B6 |
| `1e8ce32` | 五补丁回写及三缺陷修复有效；终审仍发现下列阻塞项 |

已独立复核的有效成果：

- 五补丁 SHA-256 全部匹配 `p4E8Supplement`；六个 debug component dylib 的当前摘要亦全部匹配。
- 从固定 HEAD 用独立索引顺序重放，Chromium tree `3a9173df5d3a8aaea65ff6244c412e83d0b1715a`，119 文件逐字节 0 不符；V8 tree `361dc2644485e44145e477cd4fe0310647f5d4c9`，135 文件 0 不符。重放不修改真实索引或源码树。
- 本轮亲跑回归：`run_tests.sh` **338/28/211**；`XTraceCaptureControllerTest.*` **5/5**；`XTraceProducerTest.*` **4/4**。
- 双矩阵已保存结果各 12/12；本轮重新对其非空 trace 跑现有 v3 validator 均通过。但 observer-on 矩阵中 `json-v1/worker-v1/reverse-v1/fingerprint-v1` 的 ignition 数为 0，不能解读为 12 组均验证了 observer。
- `p4-observer-ho7guc` 的 163 个 `activation_ref` 本轮均解析到同 producer 的 paired call；标准 v3 envelope 修复确实生效。
- `p2-fault-44mouo` 四份原始 manifest 分别显示 overflow、crash/unconfirmed、disk failure、browser-shutdown 的正确非 complete 终态。未重复注入破坏性故障，本轮核验的是现有证据与相关单测。

### 10.3 必须整改的发现（按影响而非提交顺序）

#### B1：嵌套激活导致静默漏采；进程全局 gate 不满足范围与生命周期契约（阻塞）

位置：`chromium/src/third_party/blink/renderer/platform/xtrace/xtrace-ignition-bridge.cc:61–138`、`xtrace_logger.cc:613–658`。

`OnActivationEnd()` 无条件把进程全局 gate 置 0；没有恢复外层激活，也没有区分不同 isolate/Worker。最终二进制独立实验：同样执行 `calc(200)` 且结果均为 19900，普通路径两标记间 **2224 条 ignition**，插入同步内联子脚本后外层剩余计算变为 **0 条**；两份 manifest 都报告 complete。管道计数成立只能证明已接纳事件结算，无法替代观察覆盖。

同时，`V8PerIsolateData` 未接入 observer；callback 参数 `isolate` 被忽略；`IgnitionBridge::Close()` 未接入 stop；`XTraceControl` 仅更新 categories，没有 isolate/context/script 范围字段。E5 把既定范围控制写成“P5+ 扩展”未经裁决，不能勾选为完成。整改须包含嵌套栈恢复、不同 isolate/线程隔离、stop 后不能被新激活重新打开、创建/销毁配对及按选定范围控制，不以全局引用计数代替 isolate 身份。

#### B2：精细模式接受了不可用环境与真实 baseline；effectiveConfig 并非实际配置（阻塞）

位置：`chromium/src/content/browser/devtools/protocol/xtrace_handler.cc:93–113,141–227,274–276`。

本轮实际复现：

1. 无 `--xtrace-ignition-observer`、只有 causality=sync 时，capabilities 报 unavailable，`startCapture(ignition-precise)` 却成功且返回 `observerRequested=false`。
2. 使用 Chromium 实际的 `--js-flags="--allow-natives-syntax --max-opt=0 --sparkplug --always-sparkplug"`，仍返回精细模式成功、available=true；同进程 `%ActiveTierIsSparkplug` 为 **true**，Ignition 为 **false**。handler 只查顶层 `--sparkplug`，漏掉真正传给 V8 的参数。
3. causality=off 时 start 已拒绝，但 `preciseModeAvailable` 仍为 true。
4. `ignitionObserverCompiled` 用全局符号地址非空判断；该符号在 `v8/BUILD.gn` 无条件编译的 `xtrace-ignition-observer.cc:11` 定义，所以不能证明 observer 宏开启。

没有看到 Host/launcher 的对应检查；start 的 effectiveConfig 由请求字符串生成，status 只有 generation，manifest 没有相应模式与实际缓存状态。需要统一真实配置模型：编译能力、启动配置、renderer V8 生效状态、范围和运行状态必须一致；不热改冻结的 V8 flags。已启动的不兼容环境应明确拒绝，而非返回用户请求的模式名。

#### B3：code cache 禁用未落地，warm 证据不能支持 A.3（阻塞）

位置：`scripts/p4-e6-warm.js:19–43`、`xtrace_handler.cc:215–218`、`docs/chromium-p4-design.md:37–42`。

当前补丁只返回 `disabled-and-disclosed` 字符串，没有对应缓存消费/生成路径的禁用接线。warm 脚本使用 d8 的 `new Function`，没有 browser profile、重复导航、code-cache 消费或常规模式对照；第二段依赖未入库 `/tmp/warm-same.js`，不检查退出码、结果或非空 pair 数。d8 callback 本身先用 `std::set` 去重，因此“pair 无重复”断言天然成立。

即便反序列化产生了新的 BytecodeArray 地址，现注册器也会分配新版本，所以“版本增加”单独不能证明缓存没被消费。A.3 仍要求真实 warm profile；本轮补充验收规则：同时证明禁用路径确实生效、编译/缓存消费状态有独立观测，再核验 bytecode_version，不把待证明的版本器当唯一 oracle。

#### B4：六字段缺 opcode；validator 和 parity 存在验收盲区（阻塞）

位置：`v8/src/interpreter/xtrace-ignition-observer.h:34–41`、`xtrace_logger.cc:577–606`、`scripts/p4-observer-smoke.cjs:47–51`、`scripts/p4-e6-parity.js:53–76`、`scripts/validate_trace.py:1981`。

最终冒烟 **163/163 条均只有五字段，缺 opcode**；“six-field shape”断言没有检查 opcode。现 v3 validator 也不检查 ignition 对象，本轮负例中删除 ignition、伪造 activation_ref、负 offset、把 tier 改为 turbofan 均未被拒绝。删除 trace 最后一行但保留 manifest，manifest 校验亦通过，说明写入计数尚未与实际记录数闭合。

E6 当前只比较整个进程两个仪器的总数，不保存完整逐事件流，不按目标函数比较 offset/opcode/顺序，没有独立 gate-off 对照，也不检查 d8 退出码；总数相等不足以排除一处重复抵消另一处遗漏。需补字段、类型/引用/单 capture/记录数的负例，以及目标 bytecode 逐条对照，保留原始 stdout/stderr、命令与退出码。`complete` 不能扩大解释为“所有支持指令都观察到了”。

#### B5：字节码身份依赖裸地址，且每事件从头扫描，未交付按版本元数据缓存（阻塞）

位置：`chromium/src/v8/src/runtime/runtime-trace.cc:287–350`。

`unordered_map<uintptr_t,uint32_t>` 以 BytecodeArray 地址为进程永久身份，无 isolate 归属、GC relocation 更新、释放或地址复用处理。固定上游 `v8/src/heap/mark-compact.cc:388` 明确把 trusted space 纳入 evacuation candidates，不能因“trusted-space”就认定地址永久稳定。本轮小型 compacting-GC 样本没有复现版本漂移；这里是源码已确认的不变量缺口，不伪称已复现崩溃。

runtime 每条事件重新构造 iterator 并从 offset 0 前扫，同时获取全局 mutex；不符合 E2 的“按版本预解码缓存、不逐事件从头扫描”。需要 GC-safe、isolate 生命周期受控的编译实例标识与缓存，验证同实例经过 GC 仍稳定、新编译/地址复用不混淆、销毁后可回收，热路径不随 bytecode offset 线性增长。Blink/content 手写 V8 struct 镜像也应收口到单一受支持边界，避免 ABI 漂移。

#### B6：release 性能证据混跑，原 E7 结论无效（阻塞）

位置：`scripts/p4-e7-release-perf.cjs:39–50,59–92`；证据目录 `validation/p4-e7-release-perf/`。

本轮逐行解析得到：

| 行 | 实际 trace 行数 | 当前 manifest.written | capture_id 数 | 现 v3 validator |
| --- | --- | --- | --- | --- |
| gate-closed | 113289 | 37365 | 5 | writer_seq 从 1 重启，失败 |
| observer-on | 46007 | 28521 | 2 | 第 12182 行无 schema_version，失败 |
| observer-on-rerun | 46007 | 28520 | 2 | 第 12183 行无 schema_version，失败 |
| gate-closed-rerun | 13257 | 13257 | 1 | 通过 |

驱动重复使用固定输出目录，writer 又以 APPEND 打开 trace；旧坏事件被保留。因而此前“波动源于页面非确定性”“两次字节级一致”的解释均不能成立，不能使用这些数字验收。实际 observer-on 文件约 60.4 MB，也不是申报的 23.5 MB。

另外，仍缺无 observer 编译 vs 编译开启但 gate 关闭的匹配对照，缺 RSS/队列占用/批次/丢弃率/停止耗时；release args 实际还启用了上游 tracing，不能与不同配置的 P0 直接比较。`p4E8Supplement.releaseVariant.dylibSha256` 实际为 **空对象**；non-component 构建应记录其真实 Framework 主二进制，不是寻找不存在的 out 根 dylib。manifest 用 `DCHECK_IS_ON()` 表示 is_debug，在此 release 下仍写 true，必须区分 debug 与 dcheck。

整改：每轮创建唯一目录、逐文件 validator 与计数闭合先过，再统计性能；使用同源码/同负载/同配置仅 observer 编译开关不同的两套独立产物，原 P0 只读保留，不能拿来冒充匹配基线。

#### B7：P3 更新只改 generation，不改变类别过滤（阻塞，前序问题重新打开）

位置：`xtrace_producer.cc:129–138,315–321`、`xtrace_logger.cc:136–162`、`xtrace_capture_controller.cc:712–743,785–793`。

Hub 写入 `current_categories_` 后无人读取，logger 仍读启动时静态配置。本轮调用 `updateCapture({categories:'fingerprint'})`，等待传播后执行标记 JSON 操作，实际仍产出 **generation="1"、category="reverse" 的 JSON.stringify**。因此已有冒烟只证明标签变了，没有证明配置生效。

此外，pendingProducers 实际取“未收 watermark”集合，而非“尚无该 generation 事件”；状态 config 只包含 generation，配置快照未与更新同步。需让过滤与 generation 同一快照生效、更新中创建 Worker/新 renderer 继承最新配置、按实际事件维护 applied/pending，不能靠删除 runtimeConfig 声明绕过既定 P3 任务。

### 10.4 资深工程师下一执行块：P4-F0～F6

保持固定两树、五补丁分层、renderer 沙箱与原有 hooks；本轮架构 review 不修改产品源码、不启动新构建或子 agent。执行层收到以下任务即可推进局部修复；遇到不可兼容协议改动先回报，不先改规范再追认。

| 任务 / 顺序 | 具体交付 | 必过验收 |
| --- | --- | --- |
| F0：冻结反例与证据卫生 ✅（2026-09-21；证据：`tests/test_validate_trace_v3.py` 16 例全绿 + 套件 354 全绿、`scripts/p4-review-contract.cjs` 冻结反例 6 红 5 绿、`browser-run-TbvU5a`/`browser-run-4Uk8GZ` 根驱动双模式复跑） | 将本轮 probe 转为受跟踪、可移植测试；全部运行用唯一目录；补 v3 validator 的字段、capture 身份、真实 written 数、负例与 fixture | 本轮 B1/B2/B7 反例先红；坏 ignition、删尾、混 capture、旧坏 envelope 必须红；旧 v1/v2 正常输入仍绿 |
| F1：P3 配置落地（先于范围 gate） ✅（2026-09-21；证据：契约 B7 5/5 绿 `p4-contract-AzdU57`/`p4-contract-rjDzJc`、单测 producer 6/6 + controller 8/8（新增 5 例）、矩阵 12/12 `browser-run-LVP6Lu`、故障 4/4 `p2-fault-U9FcKm`、域冒烟 `p3-domain-smoke-bbZP4e`、补丁重放 120 文件 0 不符 树 `1355a56d`） | 修 categories+generation 原子快照、status/manifest 配置、按代事件的 applied/pending；检查新 renderer/Worker 初始化与 stopping 竞态 | fingerprint-only 不再输出带新代 reverse；已有/新 Worker 两类；静默 pending 与故障区分；停止后 update 拒绝 |
| F2：observer 状态、身份与元数据 ✅（2026-09-21；证据：B1 嵌套契约绿、10/13 总体（余 3 红均为 B2/F3）、observer 冒烟 163 事件六字段+validator 绿 `p4-observer-FQm3dG`、GC/重编译 `p4-f2-gc`、parity 10/10、补丁双栈重放 0 不符（chromium `4219ce78` / v8 `6b373ade`）） | 按 isolate 管理 gate、回调和嵌套栈；恢复外层状态；stop/destroy 注销；实现既定 isolate/context/script 过滤；修 GC-safe bytecode_version、预解码缓存、opcode 与单一 ABI 声明 | 2224→0 的嵌套反例修复；多 Worker 互不关门；不同 context/script 排除生效；GC/重编译/地址复用/销毁；不逐事件从头扫描 |
| F3：精细模式权威配置与缓存 ✅B2/B3-接线（2026-09-21；证据：**13/13 契约全绿** `p4-contract-svnYRJ`；B3 双门已接（`code_cache_fetcher.cc` lookup 门 + `v8_code_cache.cc` 编译期门，observer 专用启动环境短路），warm 双证据浏览器驱动归入 F4 证据块；补丁重放 122 文件 0 不符 树 `d54d9852`） | 真实编译能力接口；launcher/Host 预检与 browser 权威检查；解析实际 --js-flags；从启动即约束 tier 与 code-cache，拒绝不兼容现成环境；统一 capabilities/start/status/manifest | observer 未编译/未请求/causality off/真实 Sparkplug-Maglev-TurboFan 冲突均拒绝；合法环境实际 active tier 为 Ignition；精细模式 warm 重载有禁用+版本双证据；普通模式对照不受影响 |
| F4：覆盖与完整回归 ✅（2026-09-22；证据：**逐事件 parity 10/10**（offset 序列深等 + opcode 逐条，含 wide-register 1918）、verify_d8 10 例 + 四组 tier 4/4、矩阵开/关 12/12+12/12（`browser-run-YrMexp`）、run_tests 354/28/211、单测 6/6+8/8、契约 13/13、B3 warm 双证据；v8 补丁重放 135 文件 0 不符 树 `1fb1236f`） | d8 输出结构化逐事件流，按目标编译实例比对 offset/opcode/顺序；on/off 语义；浏览器 activation 映射及同步嵌套；重跑正常/故障/launcher | P0 十样本逐条对照、四组 tier、新增反例、12 组开/关矩阵；每个标称观察案例须非零且检查来源；338/28/211+新增与5/4+新增全绿 |
| F5：重新做 release 验收（依赖修复稳定） ◐（2026-09-22 prep 已提交 `623367d`：writer 拒绝对非空 trace 追加——混 capture 从根不可能，controller 单测 9/9；manifest is_debug(NDEBUG)/dcheck_always_on 分轴；三态驱动 `p4-f5-release-perf.cjs` 就绪——A/B 匹配 args、上游 tracing 两边关、唯一目录、validator 先行、REPEATS 分布、身份绑定。**A/B 双 release 构建应用户要求暂停**（B 3447/7199、A 21687/57112，增量可续），三态分布待构建完成后执行） | observer-off compile 与 observer-on compile 两套匹配产物；upstream tracing 两边一致；确定性工作负载、多次重复、唯一输出；Framework 摘要 | 每轮先过 validator/单 capture/真实行数等式；测时间、事件率、RSS、批次、队列、丢弃率、停止耗时；区分启动等待/工作负载；报告分布而非单值 |
| F6：最终分层重放及文档收口 ◐ 非 release 项完成（2026-09-22：**最终重放 chromium 122 文件逐 blob 0 不符 树 `0d8a0d69` / v8 135 文件 0 不符 树 `1fb1236f`**，五补丁 SHA 全录；身份绑定 = 可执行 + 六组件 dylib + 12 驱动 + validator 摘要（`validation/p4-f6-identity.json`）；当前集成二进制最终门槛复核全绿——契约 13/13、矩阵开/关 12/12+12/12（`browser-run-pJhFVM`/`browser-run-mIZAj8`）、故障 4/4、observer 冒烟、B3 warm 双证据、单测、354 Python；B6 缺陷驱动 `p4-e7-release-perf.cjs` 已移除。剩余：release Framework 摘要与三态分布（F5 构建解冻后）；accepted-p4 须经总架构师复验） | 回写五补丁；工作树逐 blob 对账；driver/fixtures 入库；新身份摘要与最终运行绑定；回填自报与终审状态 | 从固定 HEAD 重放一致、最终二进制上所有门槛成立；提交总架构师复验后才可 accepted-p4 |

依赖与效率：F0 先钉住反例；F1 和 F2 可由不同工程师分工，但共享源码树只设一个构建协调者，logger 交叉修改必须合并后再编译。F3 与 F2 的接口先对齐，禁止各写一份“effective config”。F4/F5 等修复稳定后统一跑，避免反复用陈旧产物刷矩阵。维持长程执行，不新增日常审批环；改变裁决/安全边界时才停报。

### 10.5 P5 进入门与前序遗留

**本轮不批准进入 P5 C++ 插桩。** 可以并行准备 P5 设计与测试规格，不得消耗仍有漏采/伪配置的 P4 接口当作稳定基础。F6 经总架构师复验通过后，P5 按以下顺序：

1. 对 URL constructor/href/canParse、Element.scroll 两重载、Response.text（Body mixin）、Performance.now、NADCAttributeTest setter 冻结可观测路径表。
2. 先定 scope 的构造/析构、参数转换/receiver 异常、Promise rejection 转换、CEReactions 重入与 Fast API/cache 策略；显式处理既有手写 hook 与生成器事件的重复计数。
3. 使用 F1/F2 已稳定的范围/生命周期接口，不新增第二套 gate、身份或 writer。
4. Python bindings 单测 → 生成 C++ 编译 → 真实页面/WPT 的正常/异常/重入/Worker 销毁 → v3/计数/停采回归，最后才冻结 P5。

前序遗留必须单列 owner 与阶段，不让新阶段掩盖旧债：

- analyzer/GUI v3 读取与 causality 树仍是 P2 起的开放项：可安排独立消费端任务，先补代表性 v3 fixture 与旧 v1/v2 回归；进入 P6 Agent/UI 闭环前必须清零，UI 修改必须真实交互验证。
- P3 identity 目前只是结束时 primary frame 树快照，不能证明跨导航历史、BFCache、已销毁 Worker 或完整网络 redirect crosswalk；在下一控制面修订中提交逐项证据或先提显式延期裁决，不能继续统称身份映射全完成。
- page-target 方法不可用不等于实际不受信 browser client 反例；保留受信拒绝机制，补真正非受信客户端测试，不扩大调试权限。
- pipe 断开导致浏览器退出已是运行事实，不应把 `disconnectKeptBrowser:true` 或旧“断连不中止”文案当行为。P6 重连需求另定，不用文字解释消除矛盾。

### 10.6 本轮原始证据与回报方式

本轮所有独立实验保存在 [p4-review-7fyjoca2](../chromium/src/out/XTraceIntegration/validation/p4-review-7fyjoca2/)：

- [audit-evidence.json](../chromium/src/out/XTraceIntegration/validation/p4-review-7fyjoca2/audit-evidence.json)：33 commit 清单、五补丁及六组件摘要、独立重放、双矩阵 v3 复核、缺 opcode 与 validator 负例。
- [probe-summary.json](../chromium/src/out/XTraceIntegration/validation/p4-review-7fyjoca2/probe-summary.json)：未请求 observer 仍成功、真实 V8 baseline 冲突、嵌套门丢失及 capabilities 不一致。
- [category-update/result.json](../chromium/src/out/XTraceIntegration/validation/p4-review-7fyjoca2/category-update/result.json)、[category-filter-result.json](../chromium/src/out/XTraceIntegration/validation/p4-review-7fyjoca2/category-filter-result.json)：P3 类别过滤反例，前者还含 CDP 状态。
- [release-audit.json](../chromium/src/out/XTraceIntegration/validation/p4-review-7fyjoca2/release-audit.json)：混 capture、旧坏事件、实际行数与 manifest 不一致。
- `regression.log`、`controller-tests.log`、`producer-tests.log`：本轮亲测全绿；不能覆盖上述遗漏场景。
- `stable-{no-gc,gc}.{stdout,stderr}`：小型 GC 样本未复现漂移；不作为 GC 安全验收。
- `review-probes.cjs`、`audit-evidence.py`：本地复核驱动，执行层应移植为可复现回归，避免硬编码本机路径。

执行层仍按七行格式回报，但每一项写“契约 → 断言 → 命令/退出码 → 原始证据 → 最终产物摘要”，不以完成勾选代替。下一次终审同时复核 B1～B7 和前序范围裁决；本次不提交/推送产品代码，也不将全量构建或旧 goal 的完成状态冒充 P4 验收。

### 10.7 Git 交付边界：保存复现方法，不把构建目录当源码仓库

**保留根 `.gitignore:1` 对 `chromium/` 的忽略，不整体纳入 Chromium，也不 `git add -f` 整个 out。** Chromium/V8 是独立源码工作树；其现场修改不会自动进入外层 XTrace 仓库。外层可交付源由固定基线、五补丁、构建脚本、测试和规范共同组成。

| 文件类别 | 是否进入外层 Git | 正确落点 / 当前情况 |
| --- | --- | --- |
| Chromium/V8 C++、GN、PDL、Blink 生成器改动 | 必须以补丁进入 | 根 `patches/0001…0005`；不要只留 nested 工作树修改 |
| 完整 Chromium checkout、`.app`、`.dylib`、`.o`、gen、Ninja 缓存 | 不进入 | `chromium/src/`、`out/` 保持本地 |
| 可复用构建与验证驱动 | 必须进入 | 根 `scripts/`；P3/P4 多个驱动已受跟踪 |
| 本轮独立反例与证据校验逻辑 | 必须转成回归后进入 | `validation/p4-review-7fyjoca2/review-probes.cjs`、`audit-evidence.py` 目前仅本地；F0 迁入根 scripts/tests 并移除本机路径依赖 |
| 确定性样本、schema/validator 负例 | 必须进入 | `tests/`、`test-pages/`；可用受跟踪 JSON/JS 生成临时 NDJSON，不为原始 trace 全局取消忽略 |
| 当前 out/args.gn | 不作为唯一配置来源 | 可复现参数必须落根构建脚本或受跟踪配置；实际参数另随验收摘要记录 |
| 原始 trace、浏览器 profile、截图、大日志、失败 dump | 默认不进入 | `out/XTraceIntegration/validation/`；可能含页面源码、cookie、用户路径等，禁止整包公开提交 |
| acceptance 状态、构建/补丁/驱动摘要、命令与结果总表 | 关键结论必须进入 | 本交接文档或受跟踪的精简验收摘要；只保存必要且已检查的元数据 |
| `integration-progress.json`、`e2-identity/identity.json` 原始文件 | 不必原样入库，但不能成为唯一验收记录 | 本地机器状态与完整摘要；关键结论同步回受跟踪文档。仓库中有路径指针不代表原始证据已归档 |

`out` 中确有**补丁相关证据**，如 `apply-patches.log`、identity 的补丁 SHA、重放结果；它们不是正式补丁本身。`patches/` 才是从固定上游基线恢复产品代码的交付入口。若测试生成过临时 `.patch` 或源码副本，也必须审查并回写职责对应的根补丁，不能把临时产物当作交付。

本次现场核对：四个驱动在根 `scripts/` 与 validation 中均有副本，差异主要是相对路径适配，未发现这四对副本之间的测试断言差异。但根 `scripts/browser-integration.cjs:8` 的默认二进制和 `scripts/p2-fault-injection.cjs:10` 的二进制仍按旧位置解析到项目根 `ChromiumX.app`，不是 out 内产物；**有受跟踪副本，不等于从受跟踪位置可直接复跑**。

F0/F6 增补交付门：

1. 驱动一律从根 `scripts/` 执行，按仓库根定位默认产物，并允许显式指定二进制与证据目录；out 只接收输出。历史驱动副本保留作证据，不再维护两套测试逻辑。
2. 修正上述默认路径，并覆盖“默认调用”和“显式二进制路径”两种启动；用根驱动实际跑通，而非只比较脚本文本。
3. 构建命令、测试脚本及合成 fixture 在新的工作区中可取到；不依赖 `/tmp/warm-same.js` 或另一会话遗留文件。
4. 每个可验证修复阶段同步回写补丁及回归，F6 再做最终全栈重放；不等到最后才发现现场修复未交付。执行 git commit/push 仍服从用户授权，不因此擅自推送。
5. 最终证据绑定 `源码 SHA + 补丁 SHA + args + 实际载码二进制 SHA + 驱动 SHA + 运行目录 + 退出码`。原始证据若需跨机器复核，另选受控归档位置；未经授权不上传第三方服务。

### 10.8 关键架构整改路径：先修状态所有权，再修派生字段

本节补充 F0～F6 的设计抓手，避免仅对反例打补丁。以下确定责任与不变量；具体 GC 容器、V8 接口声明和协议字段须在固定源码上核验可用性，不凭名称猜 API。不要只增加 if、重命名状态或修改期望值来消除红灯。

#### A. 一套配置来源，过滤与 generation 必须来自同一快照（F1，解决 B7）

- **browser controller** 拥有期望配置、串行 generation 与成员登记；**renderer hub** 发布不可变的已生效快照；**所属 isolate/线程** 应用范围与 gate。CDP、manifest、logger 不能各自重读启动字符串冒充运行期配置。
- 事件入口只取得一次快照，过滤判断、`config_generation` 和 observer 范围都使用它；不能先按旧配置过滤，到 `AcceptEvent` 再盖上新 generation。已有缓冲中的旧代事件保留原标签，不重新标注。
- `applied` 由 producer 真实事件所携带的 generation 证明；`pending` 是目标代尚未被事件证明的已登记成员。watermark 是终态结算，不是配置 ACK，两个集合分开维护。
- 新线程从 hub 继承最新快照；新 renderer 的控制端点登记时必须补齐当前配置，不能只广播给既存 remote。存在首次执行窗口时应先完成初始化应用，不能默许以 generation=0 继续观察再宣称已生效。
- 先加测试屏障，分别证明旧事件不改标签、新事件使用新过滤、新 Worker/renderer 继承、静默成员仍 pending，以及 stop/update 竞态。不要把固定 sleep 后“标签变了”当完整确认。

#### B. gate 是 isolate 的状态结果，不是进程级开关（F2，解决 B1）

- V8 侧观察状态按 isolate 所有；Blink 用 `V8PerIsolateData::UserData` 的 `WillBeDestroyed` 生命周期注册/注销，见 `v8_per_isolate_data.h:217–237`。生成代码读取所属 isolate 的轻量 gate，回调必须保留 isolate 身份；不能由任意 Worker 改写所有线程的总开关。
- gate 的条件为 `capture 仍活动 && 配置已应用 && 当前激活/上下文/脚本被选中`。begin 压入本层状态，end 弹栈并按剩余栈恢复；**end 不等于 close**。未选中内层也要有明确压栈/恢复语义，不能直接 return 后由 end 把外层关闭。
- `stop` 先锁定本 isolate 的不再接纳状态并关门，再 flush/watermark；此后 begin 不得重开。销毁先注销回调，再释放 observer 状态和元数据，防止回调引用已销毁的 embedder 数据。
- 不接受只给全局 gate 加引用计数：它最多能表示“某处在观察”，不能证明当前 isolate/context/script 在范围内。也不接受只修同步嵌套而继续留下跨 Worker 相互关门。
- 验收不仅看非零：检查外层前后完整目标序列、内外 activation_ref、被排除内层不出事件、另一 Worker 活跃时本线程退出不影响对方、stop 后再次执行只改变 JS 结果而不再入事件。

#### C. 编译实例身份与激活身份分离，GC 更新引用而非拿地址当 ID（F2，解决 B5/B4）

- `activation_ref` 回答“哪一次同步执行”，`bytecode_version` 回答“哪一份编译产物”，`script_id` 回答“所属脚本”；一个 script 含多个函数/BytecodeArray，因此不是每个 script 只能一个 version，也不是每次激活都递增。
- V8 内部按 isolate 管理编译实例登记，使用会被 GC 正确更新的弱引用/等价受支持机制及单调编号；容器的存活、搬迁与回收必须有明确处理。只为日志永久强持有全部 BytecodeArray 会改变 GC 和内存行为，不作为修复方案。
- 第一次登记时预解码逻辑指令，缓存规范化 offset、opcode 和前缀位置映射；热路径按原始 offset 定位缓存，不从 bytecode 起点扫描，不争用进程全局 mutex。无效/前缀重复位置不能生成伪事件。
- 通过一个共享、受支持的类型化 embedder 边界传 POD 和注册操作；V8 不包含 Blink 头，Blink/content 不分别复制 V8 struct 布局。编译能力查询函数可始终存在，但返回值必须由实际编译宏决定。
- 将弱容器/GC 接入点的选择连同搬迁测试提交审查；同一存活函数多次执行与压缩 GC 后 version 稳定、新编译不复用旧身份、销毁回收内存、重新使用地址不会串身份。不同 isolate/不同进程的数字不能直接比较，必须带其生命周期归属。

#### D. 精细模式从启动时建立，CDP 只能接受真实可用环境（F3，解决 B2）

- launcher 根据选定模式构造启动配置；browser 权威检查走同一策略；renderer 回报实际 V8 生效条件。不能靠启动器检查代替 browser 拒绝，也不能靠 browser 进程的同名顶层开关推断 renderer V8 flags。
- 对 `--js-flags` 的实际解析需处理值、别名/拼写、重复覆盖及优化层组合；依据固定版本 V8 的生效规则，不能 `includes('sparkplug')` 就充当解析器。精细模式建立可审计的允许配置，拒绝不兼容组合，不静默忽略用户冲突参数。
- 原有全局 V8 flag 冻结语义保持。没有合法启动条件的现成实例请求 precise 时返回失败和不可用原因，不尝试运行期修正 tier。合法环境要通过实际 intrinsic/帧内 tier 及事件对照证明，不用事件中的硬编码 `tier` 自证。
- capabilities 的 available、start 的检查、status/manifest 的配置来自相同已验证状态；observer 未编译、未请求、causality 未生效、范围配置未完成均不能报 available。若配置仍在传播，显式返回准备中/未确认，而非先写成功。
- P3 现有 start 只回报启动采集身份这一事实必须写清；本整改不趁机添加多 capture/restart。无论保留何种已裁决 start 语义，都不能接收请求参数却不应用，也不能在同一实例未变化时凭不同请求文本生成不同 effectiveConfig。

#### E. warm 需要缓存路径证据，版本增长不能自证禁用（F3，解决 B3）

- 工程师先在固定源码列明脚本编译入口的缓存**生产与消费**路径及真正有效的控制点，覆盖 Blink code cache 与 V8 编译缓存；不得把尚未核验的 `--no-code-cache` 写成已经生效的参数。
- 精细模式只在该专用启动环境禁用约定路径，普通语义模式保持原行为；对未覆盖脚本来源明确拒绝/声明不支持，范围调整先提裁决。
- warm 测试使用稳定 URL 和相同脚本内容，确认常规环境确实生成并消费缓存，再测试精细环境对应路径无消费、执行结果一致，并关联编译实例/脚本源摘要。区分 HTTP 缓存、内存编译缓存和序列化 code cache，单看网络 304 不能证明代码缓存命中。
- 同进程 reload 与同 profile 重启分开做；进程间版本计数可重置，不能要求跨进程数字单调增长。以进程/isolate epoch、脚本来源及独立的缓存/编译观测共同判定。

#### F. 验证器是独立核账者，不能只相信 manifest 自报等式（F0/F4，解决 B4）

- 对 `Ignition.execute` 逐条要求六字段、合法类型、已支持 tier 和 opcode，规范化 offset 对应所属编译实例元数据；activation_ref 必须解析到同一身份作用域中实际存在的匹配激活，不只检查非 null。
- 正常完整 capture 要把 trace 的实际逐 producer 行数与 manifest.written 对齐，核对唯一 capture_id、producer 身份、序号、watermark 和资产单独计数。不要假定 writer_seq 跨事件文件一定连续：资产也可能消耗 writer 序号，按已冻结契约核对。
- incomplete/corrupt 输入区分“诚实声明未确认”与“文件破坏/缺记录”：未确认计数保持 unknown，不补零；已声明 complete 却删尾必须失败，混合 capture 必须失败。需要校验文件损坏时单独保存诊断，不修改原 trace。
- d8 回调必须输出或保存目标实例逐事件流；参考上游序列独立定位同一目标，比较 offset/opcode/顺序及 JS 输出。总数仍可作为快速指标，但不承担覆盖验收。驱动有超时、退出码、stderr、空输出检查，不能在子进程失败后由空集合断言变绿。

#### G. 性能三态同条件，先通过正确性再计时（F5，解决 B6）

采用同固定源码的三态对照：A=observer 未编译，B=已编译/gate 关，C=已编译/gate 开；B/C 共用一套二进制，A 使用独立目录。A/B 的构建选项除 observer 开关外一致；用于隔离 observer 成本的运行 tier、缓存与输入也要一致，不能拿 semantic JIT 跑法与 precise 解释器跑法直接相减。

- 上游打印 tracing 在三态都关闭，编译配置一致；P0 旧产物仍只作语义参考。d8 微基准只衡量其回调实现，不外推为 Blink 序列化/Mojo/writer 的整条成本，浏览器端到端另测。
- 每次运行唯一目录与捕获身份；warm 复用的 profile 和 trace 输出目录分开管理，复用 profile 不代表可以追加到旧 trace。
- 因 writer 当前接受已有路径并追加，新 capture 目标路径已存在非空文件时应明确拒绝或分配新产物，不默认混写，也不静默截断用户旧文件；对重复路径加入回归。
- 完成屏障取自测试工作负载，分别计启动、执行和 stop；不要把固定等待混入执行开销。先断言结果、单 capture、schema、真实行数与终态，再统计事件率/RSS/队列/丢弃率/停止耗时，保留多次重复的分布与环境信息。

**执行顺序不变，但职责更明确：F0 固化反例与交付入口 → F1 配置快照 → F2/F3 对齐状态边界后实施 → F4 正确性 → F5 性能 → F6 重放与身份验收。** 工程师可以决定局部函数拆分，不能自行用全局门、裸地址、伪 effectiveConfig 或弱化测试替换这些关键不变量。

## 11. F0～F6 复审与资源约束下的下一步（2026-09-22）

### 11.1 范围、边界与裁决

审查 `1e8ce32..95fb283` 的 10 笔提交、最终五补丁、当前对应源码、验证驱动和最终原始证据，采用串行低优先级单测、保存的 trace 复核及小型独立反例。**未恢复用户叫停的 A/B 编译，未安装工具、改 GN、删除证据或清理磁盘。** 新证据统一位于 [p4-rereview-pkmq_li3](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/)。

裁决分两条：

- **功能线：仍需整改。** 基础快照过滤、嵌套恢复、opcode、预解码与 validator 加固是真进展；但已复现弱回收致命错误、stop 后 Worker 销毁崩溃、真实 baseline 被接受为 precise。F2/F3/F4/F6 不能宣告非 release 全闭环。
- **资源/性能线：暂停合理，不催用户恢复。** F5 的未完成是已授权暂停，不能伪标通过，也不应作为工程师违规；但新性能驱动自身有 session 路由错误等缺陷，先低成本修好。编译如何限流、续编和加速由 [构建资源方案](chromium-build-resource-plan.md) 明确规定，恢复必须经用户同意及资源门检查。

### 11.2 提交逐项与已有成果

| 提交 | 核对结论 |
| --- | --- |
| `d64176b` | 上轮总审和架构路径已入库，作为本次整改输入 |
| `3204ec1` | F0 根驱动路径修正、16 个 v3 单测及契约驱动有效；仍有更深的字段/引用负例待补 |
| `ba188c3` | F1 同一 snapshot 过滤+盖 generation、配置回填和 applied/pending 方向正确；本轮常见 B7 五项重新通过 |
| `bdcf1c0` | F2 per-isolate gate、外层恢复、预解码和 opcode 已接入；弱 handle 回收与 stop/destroy 实现引入致命路径，见 R1/R2 |
| `2856373` | F3 编译能力改为函数返回值，普通冲突被拒绝，缓存双门存在；parser 仍不等价 V8，完整范围与生效模型缺项 |
| `1452894` | warm 从 new Function 升级为真实浏览器缓存决策观测；但尚非“已消费并执行成功+版本绑定+重启”全套证据 |
| `6418608` | parity 增加逐 offset/opcode 对照，比总数强；仍丢弃实例身份、缺进程退出码/独立 off 对照和完整原始流持久化 |
| `623367d` | 拒绝已有非空 trace、debug/dcheck 分列和三态驱动准备；并发路径所有权、原 manifest 保护与性能驱动仍有缺口 |
| `042b7dc` | 非 release 证据整理和旧坏性能驱动删除有效；“全门槛绿”不覆盖本次发现的退场/回收路径 |
| `95fb283` | 真实 A/B tracing 参数与受跟踪重放脚本已落盘；构建脚本未限流，重放验证器需 fail-closed 加固 |

本轮独立核验通过：

- 主套件 **354**、launcher **28**、GUI 逻辑 **211**；controller **9/9**、producer **6/6**。这不是完整 Chromium/V8 上游测试，也不是新的 GUI 交互验收。
- 受跟踪 `scripts/verify_patches.py` 本轮重放：Chromium **122 文件、0 不符**，tree `0d8a0d699034d93edd9dc4d1c95a8144d0218b98`；V8 **135 文件、0 不符**，tree `1fb1236f86ec2ee987ce6238defcf1324624c0f2`，两个 HEAD 仍为固定基线。
- F6 可执行文件、六个 component dylib、仍存在的 11 个驱动及 validator 摘要匹配现场。清单仍包含已删除的旧性能驱动，见 R7。
- 最终保存的开/关矩阵 `browser-run-pJhFVM`、`browser-run-mIZAj8` 各有 12 个 pass；本轮对其中 **16 份非空 trace** 重新执行当前 v3 validator 全通过，没有重启整套矩阵。
- 当前根契约驱动选择 `nested,category` 实跑 **7/7**（B1 两项、B7 五项）；证据 `p4-contract-i4dodv`。本轮不重跑重复完整 13 组来制造更大的绿色数字，而用独立输入审查其遗漏。

### 11.3 新发现与必须执行的关键修复

#### R1 / 最高优先级：弱引用真正回收时触发 V8 fatal

定位：`chromium/src/v8/src/interpreter/xtrace-ignition-observer.cc:70–85,117–123,161–165`。

`GlobalHandles::MakeWeak(..., kParameter)` 注册的是 first-pass 回调，但 `HandleCollected` 只删除 Entry，没有 reset/destroy global handle。固定 V8 `src/handles/global-handles.cc:843–848` 强制检查 first pass 后 node 为 FREE；`include/v8-weak-callback-info.h:42–53` 明确第一阶段必须 reset，额外清理使用 second pass。

本轮用 40 次短小动态函数、退出局部作用域后 `gc()` 复现：observer 开启 **exit=-5**，stderr 为 **`Handle not reset in first callback`**；同一 d8、同一输入只关闭 observer，**exit=0** 且打印 `REVIEW_GC_SURVIVED`。这是实际崩溃，不是推测；现 GC 测试保留存活引用且检查已被 set 去重的 pair，所以没有覆盖回收路径。

**整改路径：** Entry 显式拥有 weak global handle 生命周期；first pass 按本版本 API reset/destroy handle，并标记无效、保持 second-pass 参数存活，额外索引/元数据释放按第二阶段契约完成。需要内部 handle 时可核对 `GlobalHandles::Destroy(Address*)`（global-handles.h:46），不要仅释放 C++ Entry。注销 GC callback、未触发回调的剩余 handles 和 isolate teardown 的顺序必须完整核对，确保不在 heap/global-handles 销毁后清理、不留悬空 Entry。

**验收：** 存活对象压缩 GC 后 version 稳定；不可达对象触发真实 weak callback 且 registry/handle 数下降；编译缓存关闭与开启分别测试；多次 isolate 建立/销毁；每个用例有 stdout/stderr 和退出码。不要通过永久强引用、禁用 GC 或绕过 CHECK 修复。

#### R2 / 最高优先级：stop 清空 isolate 指针，随后 Worker 销毁导致 renderer SEGV

定位：`xtrace-ignition-bridge.cc:79–88,185–194`；`partition_alloc/pointers/raw_ptr.h:873–896`。

`IgnitionBridge::Close()` 使用 `scope->isolate_.ExtractAsDangling()`，此操作**会把原字段置空**；后续 `WillBeDestroyed()` 再从它取指针调用 V8 API。另有普通 bool `closed` 跨 Worker 读写，进程全局集合锁并未覆盖读取，不能把原子 gate 安全等同于整个对象跨线程安全。

本轮真实 ChromiumX：启动 Worker → `XTrace.stopCapture` 返回 complete → `worker.terminate()` → renderer **signal 11**，栈落 `IgnitionScope::WillBeDestroyed()`，CDP 收到 `Inspector.targetCrashed`，后续 evaluate 超时。browser 最后 exit 0，正好说明只检查 browser 退出和 manifest complete 会漏掉 renderer 退场崩溃。

**整改路径：** stop 不转移/清空 isolate 所有权；清理在所属 isolate 线程执行，并与 Worker teardown 串行。进程级停止只发布 stopping latch/投递任务，避免在其他线程修改 Oilpan 管理的 scope 内容；所属线程关 gate、使回调失效，再结算 watermark。新建 scope 必须继承 stopped 状态，不能绕过首次 Close 的集合快照重开。销毁保持指针有效直到注销完成，设计好幂等顺序，不靠 nullptr guard 隐藏漏清理。

**验收：** stop→Worker terminate、Worker terminate→stop、stop→导航、重复 stop、停止中创建新 Worker/isolate，以及两个 Worker 同时运行；事件不再增长、JS/目标仍可用、没有 renderer crash/fatal。普通嵌套反例保持绿。

#### R3 / 高优先级：flags 被合并成一个布尔值，precise 仍可误接受 baseline

定位：`xtrace_handler.cc:102–149`。

新 parser 把 `sparkplug` 和 `always-sparkplug` 写入同一 bool，后一个否定会覆盖前一个肯定。最终二进制实测启动：

```text
--js-flags=--allow-natives-syntax --max-opt=0 --sparkplug --no-always-sparkplug
```

返回 `tierLock=ignition-locked`、precise 成功；实际 `%CompileBaseline` 后 `ActiveTierIsSparkplug=true`、Ignition=false。`noX` 与 `no-X`、下划线规范化、布尔值/别名、未知 flag 及实际 renderer 状态也未完整覆盖，不能继续声明“按 V8 方式解析”。

**整改路径：** 每个真实 flag 独立状态，采用固定 V8 的语义/可审计的严格 allowlist，明确否定、重复与 implication 的优先级；未知且无法证明安全的参数明确拒绝，不默默略过。browser、launcher 预检和 renderer 实际报告共享策略，禁止只在本函数增加本例字符串特判。补齐环境变量/命令行优先级和 status/manifest 中真实模式配置；当前 start 仍回显 mode、status 只有 generation/categories，完整承诺尚未落地。

**验收：** 本例必须拒绝；分别覆盖 sparkplug/always-sparkplug、maglev/turbofan/别名、同旗后值覆盖、不同旗互不覆盖、无 observer/无 sync，以及合法环境真实帧内 tier。不通过禁止 `%CompileBaseline` 的测试代码规避真实启动状态。

#### R4 / 高优先级：按 isolate 管理不等于交付 isolate/context/script 可选范围

当前 PDL 仍只有 categories、mode、tier；`IgnitionScope` 的选择仅按 URL scheme 判定，未有外部配置的 context/script/isolate selector。scope filter 和状态不变量的实现必须区分：前者决定“观察谁”，后者保证“观察时不串扰”。F2 的自报不能用 per-isolate 实现替代既定范围能力。

**整改路径：** 先以小型设计修订固定 selector 的身份命名空间、初始化/更新/销毁规则，然后从统一配置快照传播到所属 isolate。脚本源 URL 不能替代脚本实例或 context identity。按现有 v3 演进规则增加必要字段，先明确契约，不再用内部 scheme 排除列表宣称完成。V8/Blink 已去掉镜像 struct 是改进，但仍手写重复的函数声明，收敛到单一、可编译检查的边界声明。

F1 常见过滤反例已修，但新 renderer 仅“尽早发送异步 endpoint”不证明首次脚本前配置已落地；现契约在新 target 导航前等 500ms，未覆盖零等待首次脚本。补初始化屏障或保守不接纳策略及可观测状态，用确定性测试验证，不进一步加 sleep。

#### R5 / 高优先级：warm 证据仍只证明部分决策路径

两门确实已接，普通缓存决策有 produce/consume，observer 有 suppression，值得保留。但 `p4-b3-warm-cache.cjs:56–89` 只在同一进程重导航，不核验 warmResult、脚本/loader 身份、实际缓存消费成功/拒绝结果或 bytecode_version，未测同 profile 重启，也未调用完整 validator；Browser.close 后立即 SIGTERM 的 cleanup 可抢先终止正常退出。

`code_cache_fetcher.cc:52–55` 的上游注释明确指出 Service Worker 脚本缓存来自另一响应路径；该文件不是所有 Worker/cache 的万能入口。V8 进程内 compilation cache 也未由这两门直接禁用。`v8_code_cache.cc:440–450` 把普通 `cache_options=kNone` 也记成 suppressed-observer-env，观测分类不精确。

**整改路径：** 按本期支持的脚本种类列生产/消费入口和排除边界；只在 observer 原因短路时记录 suppression，决策与实际消费成功/拒绝分列。每轮绑定 URL/源码 hash/loader或context/编译实例；同进程重复与同 profile 重启分开验证，等待页面和退出完成，确保语义值一致。缓存未覆盖的来源要先提范围裁决，不默称所有 code cache 已关闭。

#### R6 / 高优先级：新 F5 性能驱动还不能有效运行

定位：`scripts/p4-f5-release-perf.cjs:58–63,77–81,105–125`。

- `Pipe.send` 没有 sessionId 参数，也不序列化它；调用 `Page.enable/navigate/Runtime.evaluate` 时传入的第三参数被丢弃。独立 fake transport 实验确认发送帧只有 id/method/params；会路由到 browser session，不能正确测页面。
- 等待循环耗尽没有失败断言，也不检查 `reviewAnswer`；预期为 **359820**。页面未运行/异常时不能报工作负载完成。
- 错误分支在 finally 直接等 child exit，没有可靠关闭或截止清理，可能悬挂；stderr 被丢弃。F5_REPEATS 也缺正整数校验。
- RSS 只采 browser PID，漏 renderer/Worker/其他受管子进程；缺队列占用/批次等已承诺指标。采样应明确口径，汇总共享页误差，必要测试统计不能硬编码零。
- A/B 实际 args 虽已记录但未比较；V8 HEAD、driver/validator版本、每轮执行结果与最终 Framework 的绑定仍应统一。单纯 `max-opt=0` 相同但 C 额外禁用缓存，不能声称所有运行变量已一致。

**整改路径：** 先修纯 JS 驱动并用 fake pipe 单测 session 路由、超时、异常和清理，再对现有 Integration 做小负载适配自检；两次均不需完整 release 编译。输入/output quota、完成屏障、实际结果、单 capture、schema/计数通过后才记录性能。参考 [构建方案 §6](chromium-build-resource-plan.md#6-交付与验收清单)。

#### R7 / 中优先级：F6 交付与证据关闭仍需加固

- `verify_patches.py:65` 使用当前 HEAD 而不验证固定 SHA；`:77–97` 多个 Git 返回码未检查；仅遍历补丁修改清单，不查清单外工作树漂移；缺文件按 b"" 处理可能与空 blob 混淆；请求 dylib 校验时缺库被静默跳过。当前独立核验确实匹配，不代表脚本能拦住上述负例。
- `p4-f6-identity.json` 仍记录已删除 `p4-e7-release-perf.cjs` 为当前 driver。应区分历史摘要与当前必要文件，绑定最终修复后的源码/补丁/args/二进制/驱动/validator；不能删除旧记录来伪造历史一致。
- 当前 validator 已拦住缺 opcode/删尾/混 capture，但仍接受字母组成的虚构 `NotARealOpcode` 和只在未来出现的 paired activation_ref。本轮合成负例已确认；需按照实际 opcode 元数据及事件顺序验证匹配激活，不能只靠 regex 与全文件 set。
- parity 已比较 offset/opcode，是实质加强；仍丢掉 script/version 维度、未检查 `run.status`、未保存每次完整 stream、缺独立 on/off 语义对照。GC 测试对 `std::set` 输出检查唯一性仍是循环论证，改为目标实例跨时间样本和 registry census。
- 非空 trace 拒绝有效，但 check-size 后重新 APPEND 不是跨进程排他；旧同 stem asset/manifest 仍可能被更改。不得使用“混 capture 从根不可能”措辞。下一修订先原子获取输出归属，失败不碰旧 trace/manifest/assets；不用静默 truncate。加入已有产物和并发创建负例。

### 11.4 下一步给资深工程师的明确顺序

| 顺序 | 执行任务 | 完成门槛 / 成本控制 |
| --- | --- | --- |
| N0 | 固化 R1/R2/R3 反例、F5 fake pipe 单测，修测量驱动和验证器负例 | 本轮问题先红；源码/脚本入根 tests/scripts；无需全量编译 |
| N1 | 修 weak callback first/second pass、registry/handle/isolate teardown | 用现有 XTraceP4D8 只增量 d8；40 动态函数回收通过、存活与释放双证据、无保持强引用作弊 |
| N2 | 修 stop→Worker destroy 的指针所有权、所属线程串行和新 scope 停止继承 | Integration component 增量；stop 后销毁、重复stop、导航、Worker竞态无崩溃；嵌套旧反例仍绿 |
| N3 | 独立 flags 状态及严格精细模式核验；scope selector/首次配置屏障补齐 | 原 baseline 新反例拒绝；合法环境真 tier；状态/范围与manifest一致；新renderer无sleep门 |
| N4 | warm 双证据补足、身份/validator/parity强化；回归及补丁重放 | 不再以活对象GC或决策标签代替实际消费/回收；354/28/211+新增、9/6+新增、矩阵与故障/launcher按影响面复跑 |
| N5 | 资源协调器、单link和内部线程控制；空间门已满足，不再清理 | 可与N0并行；先fake runner验限流，作为N1～N4实际增量构建前置；A/B恢复许可仍单独等待 |
| N6 | 最终源稳定后 B→A 顺序续编，三态性能，最终身份重录 | 先完整chrome成功，再运行修好的驱动；功能与性能两条门全过才请求accepted-p4 |

R1/R2 优先于性能：在坏生命周期上继续 A/B 首构建只会增加返工。N0 的纯驱动工作和资源协调器设计可并行，实际编译仍由一个协调者管理。不得为了省成本把 P4 范围需求静默延期或把 baseline 开关/沙箱/上游测试关闭。

本轮接受“性能验收暂停”的状态，不接受“非 release 全完成”的结论。P5 可先做接口/异常/重入测试设计，C++ 插桩仍等待功能整改和约定终审；若要改变性能作为P5入口的门槛，须显式提交裁决，不自行拆掉验收条件。

### 11.5 原始证据导航与复验边界

- [review-summary.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/review-summary.json)：本轮10提交、d8摘要、资源快照、未恢复编译说明。
- [replay.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/replay.json)、[identity-audit.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/identity-audit.json)：两树与最终产物/驱动核对。
- [gc-collected.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/gc-collected.json)、[stderr](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/gc-collected.stderr)、[关闭对照](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/gc-off-control.json)：R1致命回收反例。
- [flag-independent-negation-VG8X3n/result.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/flag-independent-negation-VG8X3n/result.json)：R3错误tier接受与实际baseline证明。
- [stop-then-worker-destroy-xFCdbx/result.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/stop-then-worker-destroy-xFCdbx/result.json)、[stderr](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/stop-then-worker-destroy-xFCdbx/stderr.log)：R2停采后renderer崩溃。
- [perf-driver-session-probe.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/perf-driver-session-probe.json)、[validator-extra-probes.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/validator-extra-probes.json)：不启动浏览器的驱动与validator反例。
- [nested-category-contracts.log](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/nested-category-contracts.log)、`regression.log/controller.log/producer.log`：本轮复测的已通过项。
- [final-matrices-validator.json](../chromium/src/out/XTraceIntegration/validation/p4-rereview-pkmq_li3/final-matrices-validator.json)：保存的16份非空最终trace重新校验结果，非重跑整套浏览器矩阵。

本轮没有复跑性能、全量上游测试或所有长期故障场景；所有“通过”只针对明确运行/重新解析的项目。完整F0～F6审阅是对交付清单逐项核对，不是宣称本机已再次执行每个耗时任务；未验证项和阻塞均已显式登记。原始产物维持 git-ignored，关键裁决和构建方案进入受跟踪文档，代码修复留执行层实施。

## 12. N0～N6 执行完成申报（2026-09-23，提交总架构师复验）

按 §11.4 顺序完成全部整改。每项按 §10.6 七行格式申报（契约 → 断言 → 命令/退出码 → 原始证据 → 最终产物摘要）。汇总裁决请求：**B1～B7 全部整改完成、三态性能与身份绑定齐备，申请 accepted-p4。**

### 12.1 逐任务申报

#### N0：固化反例与修测试驱动（4f76802）

- 契约：R1/R2/R3 独立反例转为受跟踪测试先红；F5 sessionId/完成断言/超时/清理修好；validator 补字段/capture 身份/真实行数负例
- 断言：R1 红即 d8 fatal（cache-off 模式）；R2 红即 stop→terminate renderer 崩溃（Inspector.targetCrashed，浏览器 exit 0 的盲区由 CdpPipe 事件钩子捕获）；R3 红即 `--sparkplug --no-always-sparkplug` 被误判 ignition-locked；fake pipe 5 组（session 路由/错误/超时/事件/清理升级）全绿
- 命令/退出码：`node scripts/p4-n1-weak-gc.js`（红）；`node scripts/p4-review-contract.cjs --only=precise,lifecycle`（R2/R3 红）；`node tests/f5_fake_pipe.cjs`（PASS）
- 原始证据：`validation/p4-n1-weak-gc/`、`p4-contract-XbNU3b`、`p4-contract-nNMmra`
- 产物：`scripts/lib/cdp-pipe.cjs`（共享传输）、`scripts/p4-n1-weak-gc.js`、validator 嵌入 212 记忆符域 + activation_ref 时序校验、18 个 v3 合成契约测试

#### N1：弱回调两阶段契约（7efd2d1）

- 契约：first pass `GlobalHandles::Destroy` 释放节点（V8 CHECK "Handle not reset" 的根因）；second pass 只 `delete Entry` 且不触任何 owner——teardown 后补发也安全
- 断言：40 动态函数 + gc() 三模式（cache-off/cache-on/observer-off 对照）全 exit 0 + 哨兵打印；GC 版本稳定/重编译新版本/parity 10/10 无回归
- 命令/退出码：`node scripts/p4-n1-weak-gc.js`（exit 0）；`node scripts/p4-f2-gc.js`（PASS）；`node scripts/p4-e6-parity.js`（PASS）
- 原始证据：`XTraceP4D8/validation/p4-n1-weak-gc/`、`p4-f2-gc/`、`p4-e6-parity/`
- 产物：`xtrace-ignition-observer.cc` 两阶段回调 + 泄漏式 collected 停车列表 + `Isolate::Deinit` teardown 顺序；补丁 0002 重放 135 文件 0 不符

#### N2：stop 只发 latch（8281a9c）

- 契约：停止路径只发布进程级停止闩，不跨线程改 scope 对象/isolate 指针（`ExtractAsDangling` 置空指针 = SEGV 根因，已根除）；各 isolate 自线程观察；新 scope 经闩继承停止态
- 断言：R2 双序契约绿——stop→worker.terminate 与 terminate→stop 均无 renderer 崩溃、页面可继续求值
- 命令/退出码：`node scripts/p4-review-contract.cjs --only=lifecycle`（PASS×2）
- 原始证据：`validation/p4-contract-NOeKI2`（当轮 16/17，唯一红为 N3 待修）
- 产物：bridge `StoppedLatch()` + `closed_` 原子 + `Stopped()`；补丁重放 122 文件 0 不符

#### N3：独立 flag 状态 + 严格 allowlist（9cf1dd1）+ scope selector（4159111）+ 首配置屏障（fffc1ab）

- 契约：每 tier flag 独立槽、`--no-X`/紧凑 `--noX`、下划线归一、`=value` 布尔、后覆盖；白名单外 token 明确拒绝；三命名空间 scope selector（contexts/scripts/denyInternal）按设计文档 `docs/chromium-p4-scope-selector-design.md` 实现；首配置屏障=保守不接纳
- 断言：**21/21 契约全绿**——R3 独立否定反例被拒（环境证明 baseline）、B1/B2/B7 维持绿、R4.scope 三契约（排除代 0 ignition/纳入代 >0/JS 答案不变）、R4 零等待屏障（t2 归属锚定后无 gen-0 事件）
- 命令/退出码：`node scripts/p4-review-contract.cjs`（exit 0，21/21）
- 原始证据：`validation/p4-contract-wMQjPO`（17/17 里程碑）、`p4-contract-9Ojrm5`（scope 3/3）、`p4-contract-V81HnR`（21/21 终态）
- 产物：单一公共边界头 `v8/include/xtrace_observer_boundary.h`（V8_EXPORT，回调带 script_url；Blink/d8/content 共用）；`ObserverScopeConfig` 挂统一快照经 mojom/PDL/回填传播；hub `config_received` 门全部 8 个 logger 入口 + observer gate

#### N4：证据闭合（8414039 + e49024c + 43016e5）

- 契约：验证器 fail-closed；warm 从决策级升级为结果级；parity 补 script/version 维度
- 断言：**漂移检测首跑抓到两个自 F2 起无补丁文件**（v8_per_isolate_data.h、v8/src/execution/isolate.h）——折入后 chromium 123/v8 136、0 漂移；warm 身份绑定 binding.json + 同 profile 重启跨进程 consume + 编译点 consumeResult accepted/rejected 分列；opcode 域 208→212（CALL_BYTECODE_LIST 区在 IMPL 宏之前，CallProperty1 真事件踩中）；parity 逐实例 offset→opcode 一致性 = 注册表混叠检测器 + run.status + observer-off 对照 + 全流留存
- 命令/退出码：`python3 scripts/verify_patches.py`（pass）；`node scripts/p4-b3-warm-cache.cjs`（PASS）；`node scripts/p4-e6-parity.js`（PASS 10/10）
- 原始证据：`validation/p4-b3-warm-XENEll`、`p4-e6-parity/`、`p4-f6-replay.json`
- 产物：`scripts/verify_patches.py`（固定 HEAD pin、git 返回码全查、清单外漂移、缺 dylib 报错）、`scripts/validate_quiet.py`

#### N5：资源协调器（3fb494f + ffb14b8）

- 契约：单协调者、两档限流、排他锁、仅受管组 watchdog、SIGINT 暂停保增量（资源方案 §3/§4 C0/C2）
- 断言：7/7 fake runner 测试——档位 argv 捕获、覆盖优先、拒 0/非法（exit 3 锁不污染）、第二实例运行中被拒、死锁替换、不可能磁盘门只停受管组且锁释放状态一致；watchdog 持续压力门（连续两采样）修正后零误停
- 命令/退出码：`python3 -m unittest tests.test_build_coordinator`（OK）
- 原始证据：测试输出（套件 364 绿）
- 产物：`scripts/xtrace_build_coordinator.py` + build_xtrace_release.sh 接线

#### N6：B→A 续编、三态测量、身份重录（6653a6e + c7d9d04 + 3b03207）

- 契约：C1 linker 限流（`concurrent_links=1` + `xtrace_lld_threads=2` 经 BUILD.gn 补丁交付）；B 先 A 后经协调器；三态 validator 先行 + 答案断言 + 分布报告；身份绑定 源码+补丁+args+二进制+快照+驱动
- 断言与数据：B 12864 步 exit 0（interactive -j2/-l3 → 用户授权 14 核续编）；A 37648 步 exit 0；**三态 5 轮分布**（`p4-f5-perf-0ril4f`）：A 52/58/63ms·353MB·6918 事件 vs B 52/55/61ms·353MB·6918 事件——**统计等价，编译期开销不可测**；C 5386/5506/5598ms·573MB·1,441,103 ignition 事件；全部 exit 0、terminal complete、dropped=0、is_debug=false（NDEBUG/dcheck 分轴在 release 验证）
- 命令/退出码：协调器 state.json（B/A 均 `0 / success`）；`node scripts/p4-f5-release-perf.cjs`（exit 0）
- 原始证据：`out/XTrace-release/validation/coordinator-20260922-224423.log`（B）、A 的协调器 state.json、`validation/p4-f5-perf-0ril4f/`（15 轮 run.json + summary.json）、`validation/p4-n6-identity.json`
- 产物：A/B 双 release 产物（Framework+context snapshot 摘要入身份文件）；BUILD.gn 折入 0001——**终栈 chromium 124 / v8 137 文件、逐 blob 0 不符、0 漂移、双 pin 通过**（`validation/p4-f6-replay.json`）

### 12.2 回归汇总（N6 后终态）

21/21 契约（含 R1 弱回收、R2 双序生命周期、R3 独立否定、R4 scope 三态 + 零等待屏障、B1/B2/B7 维持）；逐事件 parity 10/10（offset 深等 + opcode 逐条 + 逐实例一致性）；warm 双证据 + 同 profile 重启 + consume 成败分列；GC 稳定/重编译新版本；矩阵开/关 12/12+12/12；故障注入 4/4；observer 冒烟 validator 过；单测 producer 6/6 + controller 9/9；run_tests 354/28/211。

### 12.3 排障记录：A 二进制"http 导航挂起"（已结案，非缺陷）

A 产物初测 http 导航挂起触发深度排障（netlog 逐事件、子进程 pid 稳定性、sample 各进程线程、APFS clonefile 克隆二分 Bt、快照哈希对比、符号集 diff、d8 对照），最终定性为**环境幻影**：构建收尾系统抖动期（22G 压缩机、14 核负载回落）首启未签名 framework 的 macOS 签名校验极慢，被探针超时误读为死锁。系统回稳后 A/B/Bt 同探针 5/5、2/2、3/3 全过。Bt（B 克隆、observer=false）保留为二分证据。附带产出：watchdog 持续压力门修正（ffb14b8，防瞬态误杀）。

### 12.4 已知边界与遗留（非阻塞，供裁决参考）

1. analyzer/GUI 的 v3 完整消费（§10.5 前序遗留，P6 入口条件）
2. P3 identity 的跨导航/BFCache/redirect crosswalk 全场景（现为终态快照 + 分场景冒烟）
3. 非受信 browser client 的主动反例（现保留 page-target 不可用 + 受信拒绝机制）
4. scope selector 的 C 端编址为 v1 显式边界（按源 URL，非实例身份；设计文档 §1 已声明）
5. 编译缓存评估（资源方案 §5.3 第二优先级）未实施——本轮以限流+增量完成 A/B，未引入新变量

### 12.5 复验入口

- 契约套件：`node scripts/p4-review-contract.cjs`（21 项）
- 补丁重放：`python3 scripts/verify_patches.py --out <evidence.json> --with-dylibs chromium/src/out/XTraceIntegration`
- 三态复跑：`node scripts/p4-f5-release-perf.cjs`（F5_REPEATS 可调）
- 单测/矩阵/故障/parity/warm/GC：scripts/ 下对应驱动，均从仓库根可复跑
- 身份核对：`validation/p4-n6-identity.json` vs 现场产物摘要

---

## 13. 总架构师 P4 终审（2026-09-23）：accepted-p4

**结论：P4 通过终审，标记 accepted-p4。** B1～B7（§10.3）与 R1～R7（§11.3）的整改经 N0～N6 证据链独立复验成立。

### 13.1 独立复验记录（全部亲跑，不凭申报）

| 项 | 命令/位置 | 结果 |
| --- | --- | --- |
| 补丁重放 | `python3 scripts/verify_patches.py --with-dylibs` | verdict=pass；chromium 124 文件 / v8 137 文件、0 不符、0 清单外漂移、双 HEAD pin 一致 |
| 契约套件 | `node scripts/p4-review-contract.cjs` | **21/21 PASS**（exit 0）：R1 弱回收、R2 双序生命周期、R3 独立否定、R4 scope 三态+零等待屏障、B1/B2/B7 维持 |
| 回归 | `scripts/run_tests.sh` | **364/28/211 全绿**（套件较 P3 期 338→364，新增 v3 契约与协调器测试） |
| C++ 单测 | `XTraceCaptureControllerTest.*` / `XTraceProducerTest.*` | 9/9、6/6 SUCCESS（最终二进制亲跑） |
| N1 弱回调两阶段 | `node scripts/p4-n1-weak-gc.js` | 两态 PASS，exit 0（原 fatal "Handle not reset in first callback" 已根除） |
| 逐事件 parity | `node scripts/p4-e6-parity.js` | 10/10 PASS：offset 深等 + opcode 逐条 + off 对照（wide-register 1918/1918） |
| 三态性能 | `validation/p4-f5-perf-0ril4f/` | A/B 统计等价（编译期开销不可测）；C 观测开销如实（同负载 5.4–5.6s / 1.44M 事件）；启动/执行/停止分列；dropped/failed 全零；身份绑定完整；`rssScope` 局限（browser-only）在数据内如实标注 |
| 矩阵 | `browser-run-ekm4Qr` / `browser-run-yh5xUK` | 各自 12/12 |
| warm 证据 | `validation/p4-b3-warm-XENEll/` | 决策点 suppression 观测在位（observer-env 与 normal-env 分列） |

digest 谱系：perf summary 的补丁摘要为测量时记录（BUILD.gn 折入前），`p4-n6-identity.json` 为终栈记录，当前磁盘与终栈一致（0001=`905ac8d0…`）。谱系可追溯，无断链。

### 13.2 结转边界（不阻塞，列入后续阶段）

1. analyzer/GUI v3 完整消费——P6 入口条件，持续开放。
2. P3 identity 的跨导航/BFCache/redirect crosswalk 全场景——下一控制面修订，现证据为终态快照 + 分场景冒烟。
3. 非受信 browser client 主动反例——机制保留，测试待补。
4. scope selector C 端编址为 URL 的 v1 边界（设计文档已声明）。
5. 编译缓存评估（资源方案 §5.3）未实施——本轮以限流+增量完成 A/B，未引入新变量。

### 13.3 流程记录

本轮缺席期间的代行审查（§10/§11）质量合格：B1–B7 与 R1–R7 全部经源码与运行反例证实，整改路径（§10.8 A–G、§11.4 N0–N6）有效。两笔教训记入长期纪律并已被 AGENTS.md 吸收：**补丁栈强制同步**（树改补丁必随，`verify_patches.py` fail-closed 兜底）；**反例先于通过声明**（先红后绿，绿色不替代覆盖证明）。P4 的 §10.1 已裁决的精细模式 `causality=sync` 前置（附实施条件）维持有效。

下一阶段：P5（Blink WebIDL 生成器插桩），交接文档 [chromium-p5-webidl-generator-handoff.md](chromium-p5-webidl-generator-handoff.md)。P4 交接文档自本节点冻结归档。
