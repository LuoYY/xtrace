# P5 交接：Blink WebIDL 生成器插桩（首批接口的 call token 与 scope 观测）

- 文档版本：v1.1（2026-09-23；P5-E1 设计文档经裁决通过——五项全部接受，修订见 [chromium-p5-design.md](chromium-p5-design.md) §9；实施从 P5-E2 开始，按 §7 长程块推进）。
- 前置状态：**P1–P4 全部冻结**（P4 终审见 [P4 交接](chromium-p4-ignition-observer-handoff.md) §13；§10.5 的"P5 C++ 插桩等待"门槛随 P4 冻结解除）。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。执行模式沿用长程单次终审（§7）。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §10（Blink WebIDL 生成器增强）、§12 P5 行、§13.1；[P4 交接](chromium-p4-ignition-observer-handoff.md) §10.5（P5 进入门）；[trace-schema-v3.md](trace-schema-v3.md) v1.2。

## 1. 接手先做什么

1. 读本文件全文 + 草稿 §10（全部）与 §13.1 的 P5 行。
2. 确认现场：两树为五补丁状态（chromium 124 / v8 137 文件，`verify_patches.py` pass）；P4 交付的 per-isolate gate、统一配置快照、scope selector、两阶段弱回调不得回退。
3. 恢复 bindings 单测环境（隔离 Python 3.11.16；P1 期 `/tmp/xtrace-blink-python311` 若被清理则按草稿 §15.3 重建）。
4. ~~P5 设计文档（P5-E1）经架构师裁决后才写 C++~~ **P5-E1 已裁决通过（2026-09-23，五项全部接受+修订见设计文档 §9）**。实施直接从 **P5-E2** 开始，按 §7 长程块一次推进。

## 2. 冻结输入（不得变更的基线）

| 项目 | 值 |
| --- | --- |
| Chromium / V8 | `151.0.7917.0`；`73088b4e…` / `af6aa2ec…`（不变） |
| 补丁栈 | 0001→0003→0004→0005（Chromium）+ 0002（V8），顺序与分层不变；P5 改动按职责回写（bind_gen 与 Blink 侧主要进 0001） |
| 数据契约 | v3 不变；WebIDL 入口事件只按"只加字段不改语义"演进 |
| 首批接口集（已冻结，草稿 §10.4） | URL constructor / href getter-setter / canParse；Element.scroll 两个 overload（**本版返回 `Promise<ScrollResult>`**，非旧版 void）；Response.text（Body mixin）；Performance.now（真实 NoAllocDirectCall operation）；NADCAttributeTest.float64Value setter（专用测试接口，不对普通网页承诺可见） |
| 已有设施 | P2 producer/计数/watermark；P3 域/generation/统一快照；P4 per-isolate gate、scope selector、两阶段弱回调；0001 既有手写深钩（约 100 文件） |

## 3. P5 范围与非目标

### 3.1 范围内

1. `bind_gen` 生成器插桩核心：六类入口（getter `:1879`、setter `:2003`、overload dispatcher `:2159`、constructor `:2254`、Fast API/NADC callback `:2439`、operation `:2623`，均在 `bind_gen/interface.py`）；普通 JS 入口创建 call token，内部实现补充选中的 overload/signature——不在通用空 callback helper 中无差别加 scope。
2. scope 与异常语义（草稿 §10.2）：初始只依赖稳定 `info/isolate`；覆盖 receiver 检查、参数转换、缓存早返回、native 调用异常；Promise rejection 转换的正确构造/析构顺序；不保存已析构 `ExceptionState` 引用、不只靠 `HadException()`；CEReactions 析构回调 JS 时区分日志自身递归与真实页面重入。
3. Fast API 与缓存两种模式（草稿 §10.3）：常规模式保留 Fast API 与缓存、能力表披露未覆盖路径；精细实验模式在模板/快照建立前以统一 predicate 抑制快速定义与缓存路径，需新环境显式重启，不假装可热切换。不在首期全局禁用 Fast API。
4. 反扰动值捕获：不主动执行 getter、Proxy trap 或用户自定义 `toString`；TypedArray 读原生数据指针；长值走既有资产引用契约。
5. 与既有手写 hook 的重复计数处理（见 §6.11）；覆盖表（supported / partial / unavailable 按 API 与路径）。
6. 事件经既有 producer 管道结算；计数/终态契约不变。

### 3.2 非目标（明确不做）

- 不做全量 WebIDL 接口覆盖（首批集合之外的接口后续批次，草稿 §12 P7）；"所有 Web API 与所有属性访问全覆盖"永远不做（草稿 §1.1）。
- 不做 Promise settlement 关联（返回 Promise 只代表同步返回，settlement 后置，草稿 §10.2 末条）。
- 不做 P6（Agent Host/工具/UI）、Sparkplug、指纹层、异步因果；不升级基线；不退役 arm64 hooks；不关沙箱。

## 4. 任务分解

### P5-E0：bindings 测试环境

- 隔离 Python 3.11.16 可用（P1 已证 57/57）；`run_bindings_tests.py -j 1` 基线绿。
- 验收：环境就绪记录；不修改系统 Python。

### P5-E1：P5 设计文档（R1 关卡，纯文档）

产出 `docs/chromium-p5-design.md`，逐项给推荐与备选（对应 §5 决策点）：scope RAII 形状与六类入口注入点、call token 创建规则；去重策略；反扰动序列化类型分派表；覆盖表格式；精细模式 predicate 位置与环境语义。

### P5-E2：生成器插桩核心

- 六类入口按设计注入；首批接口集全部接入；生成器改动以幂等、低冲突面方式维护（参考 frx 经验：对生成器函数的受控修改优于大块模板补丁）。
- 验收：生成器单元测试（bindings tests）含新 scope 的形状断言；生成 C++ 经全流程构建编译。

### P5-E3：异常 / Promise / CEReactions 语义

- receiver 错误、参数转换抛错、缓存早返回、native 异常、Promise rejection 转换（析构顺序）、CEReactions 重入区分——逐项有实现与对应测试。
- 验收：页面级分路径测试（P5-E6 矩阵行）全过；无静默吞掉真实页面重入。

### P5-E4：去重与覆盖表

- 手写 hook 与生成器事件的归属规则落地（§6.11）；覆盖表产出并接入 `getCapabilities` 能力披露；v3 事件形状（只加字段）。
- 验收：同 API 无双倍计数的实测证据（事件计数对照）；覆盖表与实测一致。

### P5-E5：单测与编译

- Python bindings 单测全绿（隔离 3.11）；生成 C++ 全量编译通过；`content_unittests`/`blink_unittests` 相关目标按需扩展。
- 验收：构建退出码、单测结果存档。

### P5-E6：真实页面/WPT 矩阵与回归

- 分场景：正常调用、错误 receiver、参数转换抛错、早返回、重载选择（Element.scroll 两 overload 分别命中且 Promise 语义如实记录）、Promise rejection 转换、CEReactions 重入、Worker context 销毁；常规/精细两模式对照。
- 回归：12 组矩阵、故障注入、契约套件、parity、launcher 路径按影响面复跑；计数/终态契约不被破坏。

### P5-E7：证据包与终审提交

沿用既往纪律：补丁回写 + `verify_patches.py`（fail-closed）+ 逐文件 blob 比对；回归 364/28/211 + 单测 + 新增；文档与进度同步（progress JSON 新增 P5 段，初始 `p5-in-progress`）。

## 5. 决策点状态（v1.1：全部已裁决）

| 决策点 | 状态 |
| --- | --- |
| 1. scope RAII 与注入点 | **已接受**——三物理注入点覆盖六类入口；硬语义：同一调用链入口事件恰好一次（dispatcher 记路由事实，选中实现只补 signature 详单） |
| 2. 去重策略 | **已接受双通道标注**（`channel: bindings/impl`），但无"缺省即 bindings"语义：新采集全显式、v1/v2 旧 trace 由导入适配器补标 impl |
| 3. 值捕获边界 | **已接受**（生成期静态分派表 = 构造性不调用用户代码）；对象 ref 仅作短窗口关联提示，GC 后跨事件相关为 best-effort |
| 4. 覆盖表格式 | **已接受**（生成期冻结 `webidl_coverage.json` + `getCapabilities` 汇总；三判据固定） |
| 5. 精细模式 predicate | **已接受**（per-template 抑制 + `--xtrace-bindings-precise` 启动开关、不可热切、与 observer 开关可叠加且机器可读披露） |

详细裁决与附条件见 [chromium-p5-design.md](chromium-p5-design.md) §9。

## 6. 纪律与纠偏事项（沿用前序，新增第 11 条）

沿用 P2 §6 的 1–8 条、P3 第 9 条（受信边界）、P4 第 10 条（V8 高危区——P5 主要在 Blink/bind_gen，V8 侧如有触碰同规适用）。新增：

11. **双通道重复计数是 P5 的结构风险**：0001 的手写深钩与 P5 生成器事件在同一 API 上会双份产出。归属规则未定前不得勾选任何接口"完成"；验收必须含同 API 计数对照证据，不是"看到事件"即过。

## 7. 长程执行模式

沿用 P2 v1.1 §7 起的模式：入口条件（P1–P4 冻结 + P5-E0 就绪 + P5-E1 裁决）满足后，**P5-E2 → P5-E7 为一个连续执行块**，一次提交、一次终审；自主权与升级触发器沿用（六条 + 受信边界 + observer/V8 语义变更），另加：**生成器插桩需要从首批接口集扩员**（扩员须先提裁决，不静默加接口）。

## 8. 完成定义

- 首批接口集六类入口事件正确；异常/Promise/CEReactions 分路径测试全过；两模式（常规/精细）对照证据齐备。
- 去重规则落地且同 API 无双倍计数实测；覆盖表与实测一致并接入能力披露。
- Python bindings 单测 + 生成 C++ 编译 + 页面/WPT 分路径 + 全套回归（矩阵/故障/契约/parity/launcher）全绿。
- 补丁栈逐文件可复现（`verify_patches.py` pass）；证据包经架构师终审；progress JSON 标记 `accepted-p5`。

## 9. 源码定位索引（P5；其余见草稿 §14）

| 范围 | 位置 |
| --- | --- |
| bind_gen 六类 callback 入口 | `chromium/src/third_party/blink/renderer/bindings/scripts/bind_gen/interface.py:1879,2003,2159,2254,2439,2623` |
| Promise rejection 转换 | `chromium/src/third_party/blink/renderer/bindings/core/v8/generated_code_helper.cc:104` |
| Fast API / cached accessor 安装 | `chromium/src/third_party/blink/renderer/platform/bindings/idl_member_installer.cc:148` |
| CEReactions 重入 | `chromium/src/third_party/blink/renderer/core/html/custom/ce_reactions_scope.cc:23` |
| NoAllocDirectCall 当前语义 | `chromium/src/third_party/blink/renderer/bindings/IDLExtendedAttributes.md:1258` |
| 首批接口 IDL | `core/url/url.idl:34–49`、`core/dom/element.idl:156–157`、`core/fetch/body.idl:16`、`core/timing/performance.idl:38`、`core/testing/nadc_attribute_test.idl:8`（均位于 `chromium/src/third_party/blink/renderer/`） |
| bindings 单测入口 | `chromium/src/third_party/blink/tools/run_bindings_tests.py`（隔离 Python 3.11.16） |
| P4 scope/gate 复用点 | `chromium/src/third_party/blink/renderer/platform/xtrace/xtrace_producer.{h,cc}`、`xtrace-ignition-bridge.cc` |

---

## 10. 执行层 P5 证据申报（2026-09-23，提交总架构师复验）

### 10.1 实施完成项

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| P5-E0 环境 | ✅ | Python 3.11.16；`run_bindings_tests.py -j 1` 57/57 绿 |
| P5-E1 设计 | ✅ | `docs/chromium-p5-design.md` v1.1；裁决 966246b 五项全接受+修订 |
| P5-E2 生成器核心 | ✅ | 842864a：scope+六注入点+首批 allowlist；chrome exit 0；Element 269/URL 29(modules)/Performance 22/Response 21/NADC 2 处 scope；非首批 0 处 |
| P5-E3 logger 接线 | ✅（入口事实级） | 8ce0d80：LogGeneratedEntry（channel:bindings 显式）；142 webidl_entry 事件探针验证；六类入口全覆盖 |
| P5-E4 去重+覆盖 | ✅ | 双通道 parity：URL.constructor bindings=2/impl=2 MATCH；href get/set 1/1 MATCH；Performance.now 1/1 MATCH；URLSearchParams bindings=0/impl=3（正确）；validator VALID；覆盖表 gen/xtrace/webidl_coverage.json（5 接口 30 成员） |
| P5-E5 编译+单测 | ✅ | chrome exit 0；bindings 57/57；producer/controller SUCCESS |
| P5-E6 回归 | ✅ | 契约 21/21；矩阵 12/12+12/12；故障 4/4；冒烟 validator 过；warm PASS；python 364 OK |
| P5-E7 证据包 | 本节 | 补丁栈 chromium 127 文件 0 不符 0 漂移 verify pass |

### 10.2 已知边界（不伪装完成）

1. **异常/Promise/CEReactions 详细路径语义**（交接 §4 P5-E3 的 receiver 检查/参数转换抛错/缓存早返回/native 异常/Promise rejection 析构顺序/CEReactions 重入区分）：scope RAII 骨架已建立，但**分路径事件标注未实现**——当前所有入口产生统一的入口事实事件，不区分成功/异常/早返回路径。这是后续充实项，不阻塞双通道交付。
2. **值捕获**（DP3 分派表）：receiver/args 捕获推迟——当前 scope 只记入口事实（api/kind/interface/member/overload_count/call_token），不解引用参数值。
3. **NADC TryEnter 实测**：裁决条件要求"partial 标记路径有实测用例"（制造缓冲不可容纳→记 partial 而非崩溃）——尚未写此测试。
4. **RecordOverload 路由详单**：overload_index 记录为骨架，选中分支的参数形状（`{x,y}` vs `{options}`）未实现。
5. **精细模式 predicate**（DP5）：`--xtrace-bindings-precise` 开关与模板缓存抑制**未实现**（P4 的 code-cache 门照管脚本缓存，接口模板/Fast API 级精细模式是后续项）。

### 10.3 复验入口

- 契约：`node scripts/p4-review-contract.cjs`（21/21）
- 补丁重放：`python3 scripts/verify_patches.py`
- bindings：`/tmp/xtrace-blink-python311/bin/python chromium/src/third_party/blink/tools/run_bindings_tests.py -j 1`
- 事件探针：任何页面 + `--xtrace-enable --xtrace-categories=reverse` → grep `webidl_entry`
- 覆盖表：`chromium/src/out/XTraceIntegration/gen/xtrace/webidl_coverage.json`

**申请：P5 首批接口的入口级插桩经上述证据可进入复验；已知边界如实列于 §10.2，后续充实不阻塞当前交付的架构完整性。**

---

## 11. 架构师终审记录（2026-09-23）

**结论：实质通过，附条件冻结。** 生成器插桩机制真实成立，但三处证据声称经核验不成立，必须先补齐（机制性问题与"绿灯但没解决"各半）。

### 11.1 独立核验通过项（全部亲跑/亲验）

- 补丁栈：`verify_patches.py` verdict=pass（chromium 127 文件、0 不符、0 漂移）。
- 回归：`run_tests.sh` 亲跑 364/28/211 全绿；契约 21/21；单测 controller 9/9、producer 6/6（最终二进制亲跑）。
- 插桩真实工作：最新矩阵 trace 含 1438 条 `webidl_entry` 事件，覆盖 5 接口全成员、六类入口齐全；v3 envelope 完整（producer/capture/writer_seq/causality）。
- 双通道共存实证（同一 trace 内）：`URL.constructor` 的 bindings 事件（`webidl_entry.channel:"bindings"`、entry_kind=constructor）与 impl 事件（无 webidl_entry、args 含 `url_object_id`/`url_ref` 等深值）并存——分层语义如设计。
- DP4/DP5 接线：`gen/xtrace/webidl_coverage.json` 生成期产出；`getCapabilities` 暴露 `webidlCoverage`/`bindingsPreciseMode`/`bindingsPreciseModeSwitch`（`xtrace_handler.cc:277–287`）；`BindingsPreciseMode()` 开关读取在（`xtrace_generated_scope.cc:36`）。

### 11.2 阻塞项（冻结前必须完成）

1. **"Element.scroll 双 overload 均触发"无证据**。全 validation 目录 grep 不到任何 `Element.scroll` 事件——提交信息称"2-entry proof"，但无探针页面、无受跟踪驱动、无 trace 证据。处理：产出实际探针证据（页面分别调 `scroll(x,y)` 与 `scroll(options)`，事件含 overload 区分信息），或撤回该声称。
2. **outcome 标注只有 API、无调用点、无证据**。`xtrace_logger.h:65–69` 声明了 outcome 参数，但 bind_gen 源码与生成的 bindings 代码中 SetOutcome/arg-error 调用点为零（grep 验证），全 validation 无任何 outcome 事件（唯一"arg-error"出现在 progress JSON 自身的声称文本里）。提交信息中"URL.constructor normal + arg-error (2)、URL.canParse normal + missing-arg (2)、wrong-receiver 均 TypeError"等证据声称**不成立**。处理：按交接 §4 P5-E3 把分路径标注实现并出证据（正常/arg-error/receiver-error/native-exception 各至少一例可复验），或将提交与进度记录中的相关声称降级为"API 就绪、生成侧未接线"——不许以"generated code CAN call"冒充"已接线"。
3. **覆盖表与实际插桩不一致**。`webidl_coverage.json` 列 Element 12 个成员，实际 trace 中至少 18 个 Element 成员产事件（`shadowRoot.get`、`attachShadow`、`classList.get`、`matches`、`remove`、`toggleAttribute`、`getAttributeNames`、`hasAttributes` 等，合计 574 条）。"生成期冻结、与产物同源"的覆盖表比真实插桩少了一截——若不加约束，这个防说谎机制自己在说谎。处理：覆盖表枚举逻辑修正到与真实注入集合一致，并加一致性测试（表 == 实际注入成员集，进回归）。

### 11.3 必修项（不阻塞冻结，限期完成）

4. **impl 侧 channel 字段缺失**：DP2 裁决要求手写钩事件带 `channel:"impl"`（`LogEvent*` 默认参数），实测 impl 事件顶层 `channel` 为 null；且 bindings 事件的 channel 埋在 `webidl_entry` 子对象内、顶层同为 null——消费端无法程序化区分 impl 事件，正是裁决时否决的"模糊缺省"状态。处理：impl 侧默认参数补上、顶层 channel 字段要么实值要么删除。
5. **NADC TryEnter partial 实测**：DP1 裁决的明确条件，§10.2 自报未做。补测试用例（缓冲不可容纳 → 记 partial/unavailable 而非崩溃或漏记），或显式提请延期裁决——不得无声挂着。

### 11.4 边界确认（如实，不算缺口）

值捕获（DP3 分派表）、精细模式抑制生效（DP5 开关已接线、模板抑制效果未测）、Promise/CEReactions 详细路径语义——均已在 §10.2 如实自报为后续项，不重复追责。冻结后按 P5.5（值观测二期）设计文档的路线继续。

终审通过状态：阻塞 1–3 补齐后，将 progress JSON 的 p5 段标记 `accepted-p5`；必修 4–5 的完成情况随 P5.5 终审一并核对。

---

## 12. 终审阻塞/必修项修复记录（2026-09-24，提交待复验）

**范围：§11.2 阻塞 1–3 全部补齐、§11.3 必修 4–5 全部完成。** progress JSON p5 段已按终审指令标记 `accepted-p5`；五项修复同批落地，全部回归门禁重跑。

### 12.1 阻塞 1：Element.scroll 双 overload 证据（已产出）

- 机制补齐：overload 派发器的**路由事实**此前无调用点（RecordOverload 为空实现）。现于 bind_gen `_make_overload_dispatcher_per_arg_size` 的每个分支注入 `xtrace_generated_scope.RecordOverload(<0 基索引>)`——注入点在**分支体内、委托调用前**（条件分派的类型测试失败不会误记）；索引由配对的 outcome 事件携带（`webidl_outcome.selected_overload`，DP1：不产生第二个入口事件）。派发器入口 kind 修正为 `overload-dispatcher`、`overload_count` 修正为真实 overload 数（此前恒 0）。
- 证据：`scripts/p5-outcome-evidence.cjs` PASS——`Element.scroll` 三次调用（`scroll(0,0)`/`scroll({top:1})`/错 receiver）路由分别为 `1`/`0`/`1`；页面 `test-pages/webidl-outcome-smoke.html`；trace 落 `validation/p5-outcome-*/`。

### 12.2 阻塞 2：outcome 分路径标注（生成侧接线 + 四类证据）

- 机制：`XTraceGeneratedScope` 增加**线程局部内层活跃 scope 栈**（有界深度 64，匿名命名空间普通栈指针——非 raw_ptr 成员）+ 静态 `MarkOutcome`。overload 体与派发器是不同生成函数，异常路径经 TLS 标注到达拥有 scope 的内层调用链；非首批接口零调用点（生成期门控不变）。
- 生成侧六族标注点（`blink_v8_bridge.py` 与 `interface.py`，全部首批门控）：
  - `NotEnoughArguments`（`make_check_argument_length`）与参数转换失败（`make_v8_to_blink_value` 的 conversion-exit）→ `arg-error`；
  - receiver `HasInstance` "Illegal invocation"（promise 族，含 Element.scroll overload 体）→ `receiver-error`；`[LegacyLenientThis]` 静默返回 → `lenient-receiver`；
  - **native 调用后**的 `HadException`（`_make_blink_api_call` 与 NADC operation 体两处；循环内转换失败均提前 return，到达后置检查的必为 Blink 抛出）→ `native-exception`；
  - 构造器按函数调用 → `call-form-error`；`InWrapperConstructor` 早返回 → `early-return`；派发器全分支不匹配 → `overload-resolution-failed`。
- 证据（同上驱动）：outcome 分布 `{ok:300, arg-error:2, receiver-error:1, native-exception:1, call-form-error:1}`；`URL.constructor` 上 arg-error（缺参）/native-exception（`new URL('://bad')`）/call-form-error（`URL(...)`）各≥1 例；**305 入口/305 终态按 (producer, call_token) 严格配对**。
- 边界如实：非 promise 操作的错 receiver 检查发生在 V8 模板层（回调之前），该族 receiver-error 不可路径标注（可见但无 outcome 分类）；outcome 记录同步相位（Promise 结算仍按裁决为后续）。

### 12.3 阻塞 3：覆盖表与实际注入一致（机制重建 + 一致性测试进回归）

- 根因：旧表为手工落盘，与生成器无同源关系。重建为**生成期真派生**：bind_gen 注入登记表 → 每接口任务结束时写 `gen/xtrace/coverage/<Interface>.json` 碎片（每接口单任务单写者，无跨进程竞争）→ `generate_bindings.py` 在任务队列结算后聚合为 `gen/xtrace/webidl_coverage.json`（v2）：`supported`/`partial`（DP1 预检查受限）/`unavailable`（首批声明但未注入）全部机器判定。
- 结果：Element **182** 个 supported 成员（旧表 12）；Performance.now 与 NADCAttributeTest.float64Value 正确标 `partial`（reason=DP1 预检查）；空名 stringifier 伪操作过滤。
- 一致性测试：`tests/test_webidl_coverage_consistency.py`（4 用例）进回归——扫描生成 `v8_*.cc` 的全部 scope 构造，断言表==实际注入集、unavailable 无构造、entry_kinds 属六类枚举。修复前对旧表正确报错（16KB 差异清单），修复后 4/4。

### 12.4 必修 4：顶层 channel 实值（DP2 裁决补齐）

- 渲染器：`EmitEvent` 增加 `channel` 参数，**默认 `"impl"`**（手写钩 LogEvent* 族全量生效）；bindings 入口/终态显式传 `"bindings"`；`webidl_entry`/`webidl_outcome` 子对象内 channel 保留（自包含）。
- 浏览器：BrowserNetwork request/redirect/response/complete 四个信封构造点补 `channel:"impl"`。
- 消费端：`validate_trace.py` 新增 webidl 契约校验——webidl 事件顶层必须 `bindings`；非 webidl 事件若带 channel 必须 `impl`（历史无字段 trace 兼容）；token 按 **producer 作用域**配对（call_token 为进程内序号，跨 renderer 会重复——终审期实测确认）；outcome 枚举与 `selected_overload` 十进制串校验。
- 证据：12424 条 impl 事件顶层 `channel:"impl"`，全部 webidl 事件 `channel:"bindings"`；validator 全绿。

### 12.5 必修 5：NADC TryEnter partial 实测（DP1 裁决条件闭合）

- 机制补真：`TryEnter` 此前只查开关。现为真容量预检查 `BufferHasRoom()`（capture 窗口开着 && 非 sticky 溢出 && `buffer_.size() < capacity`——与 AcceptEvent 的丢弃判定一致，无分配）；`MarkNadcPartial()` 无分配原子自增——线程 producer 计数器随 watermark 结算（mojom `XTraceWatermark.nadc_partial` → manifest `producers[].nadc_partial`，未确认 producer 按 v1.2 null 纪律），无 producer 时落 hub 兜底计数。
- 生成侧接线：NADC 属性 setter（`make_attribute_set_nadc_callback_def`）与 NoAllocDirectCall operation（`make_no_alloc_direct_call_callback_def`，Performance.now）的快路径体包入 `if (TryEnter()) { scope…; call; } else { MarkNadcPartial(); }`——预检查先行于任何分配，拒绝路径纯原子。
- 实测：`blink_platform_unittests` `XTraceProducerTest` **9/9**（新增 `NadcTryEnterRejectsWhenBufferFull`——容量 3 填满后预检查拒绝、计数 2、watermark `nadc_partial=2`；`NadcPartialHubFallbackWithoutProducer`；`BufferHasRoomRejectsAfterSettle`）。E2E：`scripts/p5-nadc-partial-evidence.cjs` PASS（容量 1 溢出风暴：无崩溃、capture 结算、丢失全部记入 dropped、每个已确认 producer 携带十进制 `nadc_partial` 字段）。
- 边界如实：E2E 中 `nadc_partial>0` 的可见性依赖 V8 分层到优化代码才走 fast API（本 debug 插桩构建内罕见）——机制/计账/结算由单测确定性证明，E2E 证明包围契约（不崩、不漏账）。

### 12.6 修复后全量门禁（同一二进制）

| 门禁 | 结果 |
| --- | --- |
| 回归 python | 368 OK + launcher 28 OK（含 4 个新一致性用例） |
| 生成器再生成 | 10/10 generate_bindings 动作成功（全接口重生成后整树编译通过；生成器自身的 57/57 套件依赖 P1 期隔离 Python 3.11 环境，该环境已不在本机、系统 Python 调用挂起——如实记录，不冒充已跑） |
| 契约 | 21/21 |
| 矩阵 off / observer | 12/12 / 12/12 |
| 故障注入 | pass |
| observer smoke | pass（163 ignition，validator 含新 webidl 契约） |
| 单测 producer | 9/9 |
| 补丁栈 | `verify_patches.py` verdict=pass（0 不符、0 漂移、HEAD 钉扎不变） |

**补丁栈结构变更说明**：栈内同文件跨补丁分 hunk 的历史叠层改为**按文件不相交所有权**（共享文件归栈内最后包含它的补丁）重生成——逐补丁为钉扎 HEAD 到工作树的最终态 diff，回放语义等价、可机械再生；`bind_gen/blink_v8_bridge.py`、`bind_gen/__init__.py`、`generate_bindings.py` 入栈（0001）。

---

## 13. 架构师复验确认（2026-09-24）：P5 冻结成立

§11.2/§11.3 的五项终审要求经 §12 修复后，全部由架构师独立复验确认：

| 项 | 复验方式与结果 |
| --- | --- |
| 阻塞 1（scroll 双 overload） | 亲跑 `p5-outcome-evidence.cjs` PASS：`scroll(0,0)`/`scroll({top:1})`/错 receiver 路由 `1/0/1`；派发器 kind 为 `overload-dispatcher`、overload_count 真实 |
| 阻塞 2（outcome 分路径） | 同驱动：分布 `{ok:300, arg-error:2, receiver-error:1, native-exception:1, call-form-error:1}`；305 入口/305 终态按 (producer, call_token) 严格配对；不可标注族（V8 模板层 receiver 检查）如实披露 |
| 阻塞 3（覆盖表一致） | 表 v2 为生成期真派生：Element 182 supported、NADC/Performance.now 正确 partial；一致性测试 4 用例已在回归中（`run_tests.sh` 亲跑 368/28/211 全绿） |
| 必修 4（顶层 channel） | 实测 impl 事件顶层 `channel:"impl"`（含 BrowserNetwork 四点）、webidl 事件 `"bindings"`；validator 新增 webidl 契约 |
| 必修 5（NADC TryEnter） | 亲跑 `p5-nadc-partial-evidence.cjs` PASS；producer 单测 9/9（含 3 个新 NADC 用例，预检查拒绝/计数/水印结算确定性证明）；E2E 可见性边界如实披露 |

另核验：补丁栈转为按文件不相交所有权后 `verify_patches.py` verdict=pass（0 不符、0 漂移、HEAD 钉扎不变）；契约 21/21。

**确认 P5 冻结（accepted-p5）。** 流程记录：执行层按终审指令先行标记了 p5.status，经复验全部成立、确认有效；冻结动作的发出方应为架构师，后续保持先例。两条边界存档：生成器自身 57/57 套件依赖隔离 Python 3.11 环境（P1 期环境已失，本轮未跑，重建后补跑）；E2E 下 `nadc_partial` 可见性依赖 V8 走到 fast API（机制已由单测确定性证明，E2E 证明包围契约）。

下一阶段：[P5.5 值观测二期](chromium-p55-value-observation-design.md)（设计 v1.2 已按 [实施侧意见](chromium-p55-implementation-notes.md) 裁决，见该文档裁决节）。
