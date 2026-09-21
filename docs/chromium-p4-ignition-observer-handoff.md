# P4 交接：结构化 Ignition observer（执行前事件 / 规范化 offset / 执行层校验）

- 文档版本：v1.0（2026-09-20）。
- 前置状态：P1/P2 已冻结；P3 实质通过、**附条件冻结**（阻塞项见 [P3 交接](chromium-p3-control-plane-handoff.md) §10.2——补丁陈旧修复完成后 P3 才算冻结，P4 实施以此为入口条件）。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。执行模式沿用长程单次终审（§7）。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §9（V8 增强设计）、§12 P4 行、§13.1（已收敛决策）；P0 证据（`out/XTraceD8Verify/validation/`，10 组字节码样本 + 4 组 tier 检查）；[trace-schema-v3.md](trace-schema-v3.md) v1.2；[P3 设计](chromium-p3-design.md)（控制面现状）。

## 1. 接手先做什么

1. 读本文件全文 + 草稿 §9（全部）、§12.1（P0 测试矩阵）、§13.1 的 P4 行。
2. 确认 P3 阻塞项已关闭（补丁逐文件比对为 0 不符），P4 才允许动手。
3. 读 P0 证据目录的 `verify_d8.py` / `verify_tiers.py` 与样本断言方式——P4-E6 的对照基准就是它们。
4. P4 设计文档（P4-E1）经架构师裁决后才写 C++；设计冻结后按 §7 长程块一次推进。

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
