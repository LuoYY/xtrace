# P5 交接：Blink WebIDL 生成器插桩（首批接口的 call token 与 scope 观测）

- 文档版本：v1.2（2026-09-24，总架构师独立复审见 §14）。
- **当前裁决：P5 验收重新打开（changes required）。** §13 的项目架构师冻结记录作为历史保留；当前最终产物存在关闭采集时 Fast API 崩溃、错误 outcome 与能力披露缺陷，不能作为 P5.5 的已验证安全基础。先执行 §14.4，P5.5 设计修订与合成测试可并行，不重编译或扩大现场采集。
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

## 14. 总架构师独立复审（2026-09-24，基线 29db301）

### 14.1 范围与结论

复审 `61d218e..29db301` 的 11 个 P5/P5.5 相关提交，核对生成器、生成 C++、scope/logger、覆盖表、验收驱动与原始需求；对当前产物做低负载反例和回归。**未改产品代码、未启动编译、未执行私有挑战语料、未回连第三方站点。**

结论：**P5 重新打开，不以现有冻结记录代替功能正确性。** 双通道、overload 路由、部分 outcome、生成表一致性和重放均有真实成果；但“缓冲拒绝只影响日志、不影响 API”被生成代码破坏，且已经在关闭采集的实际浏览器上复现崩溃，这是必须先修的产品回归。不得以“Fast API 路径难触发”“P5.5 后续会补”降级。

P5.5 的通道复用、Entry 起步、预算和导航生命周期方向可保留；其语义、输入与安全边界必须先按 [P5.5 总审 §13](chromium-p55-value-observation-design.md#13-总架构师设计复审与增强路线2026-09-24) 修订，不能继承未经证明的“P5 静态类型分派即安全”。

### 14.2 独立复核通过与边界

- 五补丁重放：Chromium **130 文件**、V8 **137 文件**，0 不符、0 清单外漂移、双固定 HEAD 匹配；tree 分别为 `233d3cb2dec041077de5656bde62778e8bb6660b`、`c39b04e0d71dd91ebdde2350c66fb6fda719164e`。按文件不相交分层可恢复，保留。
- 本轮亲跑：Python **368**、launcher **28**、GUI 逻辑 **211**、producer C++ **9/9** 全绿。
- 本轮重新找到可用的 `/tmp/xtrace-blink-python311/bin/python`，隔离运行 bindings **57/57** 通过，0 skip/0 fail；§12/§13 的“本机环境已失、待补跑”是此前快照，本轮这笔环境债已关闭。57 项上游单测不覆盖下面生成语义缺陷，不能外推。
- 当前覆盖表成员数为 Element 182、URL 18、Performance 21、Response 20、NADCAttributeTest 1；4 个表/生成代码一致性用例只证明集合一致，不证明所有路径与两种模式语义正确。
- 新证据目录：[p5-chief-review-gwem9w3m](../chromium/src/out/XTraceIntegration/validation/p5-chief-review-gwem9w3m/)，包含补丁/组件与快照摘要、命令、CDP 结果、原始 trace、测试日志。没有重新跑全量长程性能/故障矩阵。

### 14.3 验收阻塞与整改路径

#### P5-R1：NADC 拒绝分支跳过 API 本体，非 void 路径缺返回（最高优先级）

定位：`bindings/scripts/bind_gen/interface.py:2198–2212,2826–2840`；实际生成 `gen/.../core/v8/v8_performance.cc:711–722` 与 `v8_nadc_attribute_test.cc:77–87`。

当前生成逻辑是 `if(TryEnter()){ scope; 原API调用; return value; }else{ MarkNadcPartial(); }`：拒绝时 setter 完全不执行，`Performance.now` 的 double 返回函数走到末尾无返回值。拒绝发生于采集关闭、未收到配置、停止、队列满等正常状态，不能把它解释为合法降采样。

**本轮实际复现**：同一 ChromiumX 关闭采集时，正常 `performance.now()` 返回有限值；使用本地测试 intrinsic 使包装函数优化后调用，CDP 收到 `Inspector.targetCrashed`，evaluate 超时；开启采集的同一优化输入成功，trace 中有 1 条 `nadc-callback`。崩溃现场无完整符号栈，不能声称已符号化每一帧；但生成 C++ 的丢调用/缺返回为静态确定缺陷，必须修。

整改：**计日志的开关只能包住观察逻辑，原始 API 调用和返回必须在所有分支恰好执行一次。** 可采用可失效的 scope/guard，但不能让 capture 决定业务是否执行。无分配是项目额外约束，不是 NoAllocDirectCall 的现代上游语义——固定版本 `IDLExtendedAttributes.md:1258` 明确允许分配、异常和 JS 回调；不要继续以历史名称推导 API 限制。

`TryEnter`/`MarkNadcPartial` 当前会调用 `Current()` 和 `Get()`，它们可能初始化 producer/hub、查环境并分配；`BufferHasRoom` 只检查一条余量，也没为 entry+outcome 和 native 中的重入预留。需明确零初始化预检查与计数策略，允许跳过观测，不允许跳过 API。无采集/已 stop 不应无限新增“partial”到无可结算的 hub；活跃 capture 的拒绝应按对应成员/原因统计。

必过：强制实际 Fast API 的采集关闭/开启、未配置、满队列、stop 后四态；验证返回值/副作用与非插桩对照一致，renderer 无崩溃，拒绝分支确实被执行。现 E2E 保存的两个 partial 报告 `nadc_partial` 汇总均为 0，9/9 producer 单测仅测计数器，不能代替生成回调语义验收。

#### P5-R2：setter 异常被标 ok，TLS 深度溢出把内层错误写到外层（高优先级）

定位：`xtrace_generated_scope.cc:40–56,149–153`、`blink_v8_bridge.py:39–47,921–930`、`interface.py:2321–2324`。

- 本轮 `URL.href = {toString(){throw Error(...)}}` 的 JS 异常被页面捕获、href 保持原值，但配对 outcome 为 **ok**；`Element.id` 的同类测试也为 ok。URL setter 的转换调用未携带标注上下文，Element 的 CEReactions-reflect 优化 helper 绕过普通转换标记。
- 68 层成功 URL 构造，最内层调用一个缺参 API 并自行捕获异常，所有构造正常返回；TLS 64 深度上限后不再 push，`MarkOutcome` 仍写第64层，导致正常的 `URL.constructor` token64 被标 **arg-error**。

整改：将异常标记传到真正执行转换/优化 helper 的路径，不给所有未标注路径默认为“已证明成功”；scope ownership/超深路径必须有明确不可标注状态，绝不能借用外层栈顶。保留业务 JS 重入，不能用全局递归 guard 把用户调用吞掉。为 getter/setter、优化 helper、overload 被选实现、Promise 异常转拒绝分别定义同步 outcome，而不是将 JS rejected Promise 与 native throw 混为一类。

必过：URL href/Element反射 setter 参数转换抛错、reentry 内错已捕获/向外传播、64/65/更深边界、正常深层调用、Promise return/rejection-conversion 与真正 settlement 分别断言；输入页面的真实结果必须进入测试断言。

#### P5-R3：精细 bindings 模式只读开关未控制安装；覆盖能力依赖 cwd（高优先级）

定位：`xtrace_generated_scope.cc:74–82`、`xtrace_handler.cc:269–287`，以及生成 `v8_performance.cc:844–852` 的无条件 CFunction 安装。

`BindingsPreciseMode()` 仅在匿名 namespace 定义，没有消费点；补丁内未见该开关参与 renderer 转发和 Fast API/cached accessor 安装谓词。能力报 true 目前只能证明浏览器启动参数有该名字，不能证明精细模式生效。

覆盖表读取 `gen/xtrace/webidl_coverage.json` 是相对工作目录。本轮同一二进制仓库根 cwd 得不到 `webidlCoverage`，out cwd 可得到；代码注释声称“module directory”与实现不符。生成器捕获 OSError 后忽略，清单碎片也可能沿用旧文件，表不是不可变二进制能力。

整改：按已裁决 DP5 对首批选定路径在模板建立前统一控制**快速入口安装/缓存**并保留正常慢路径语义；开关传递、actual capability、混用矩阵同一来源。将生成清单作为声明的 GN 输出/资源嵌入或固定应用资源路径读取，带版本/摘要，构建缺失或过期要失败，不随 cwd 或手工文件改变能力。

必过：任意 cwd、重定位应用、缺/坏/旧清单、普通与precise两模式、observer独立四组合；用实际进入的 fast/slow/cached路径证明，而非读取开关。

#### P5-R4：覆盖集合一致不能替代成员范围与行为覆盖（验收门）

最初冻结清单是若干具体成员，当前按五个 interface 全部注入，Element 扩到182成员。无论这是有意扩大范围还是生成策略产物，项目架构师必须显式登记成员边界与对应能力，不以修覆盖表扩大 P5 定义。没有实现/验收的 native异常、cache早退、Promise rejection析构顺序、CEReactions重入，不应因“构造处有scope”就标 supported。

建议将表拆为“编译注入事实”和“运行覆盖能力”两个维度：member/entry kind、已覆盖路径、限制、是否经精细模式验证。保留生成集一致性测试，另增加行为fixture矩阵；接口存在、生成有代码、路径可达、语义已验收四者不能混用。

#### P5-R5：记账与验证器还有配对/截断盲区（与P5.5共用基础）

`LogGeneratedEntry` 与 `LogGeneratedOutcome` 各自取得配置/过滤，scope 不记录入口是否成功接纳；更新配置、stop、队列溢出或采集中途进入 scope 可能留下单边 token。当前 TryEnter 只查一条容量，scope 深度上限也没有缺口计数。需对配对事件规定 admission、终止/丢失和过滤变化语义；记录不足写 incomplete/coverage gap，不能为通过validator补造 outcome。

`validate_v3_webidl` 使用集合查两端 token：类型转字符串后对账、未严格核对到达顺序及 `selected_overload < overload_count`，也不能证明 outcome 分类与页面真实结果一致。增强数值类型、相同producer/token唯一、入口先于终态、路由边界和合法未完成capture的负例；不得把v1/v2导入兼容当新采集v3可缺channel的理由。

### 14.4 工程师／项目架构师的下一执行块

| 顺序 | 负责人角色 | 关键路径与验收 |
| --- | --- | --- |
| P5-C0 | 工程师 | 把本轮fast-off、setter-error、scope-overflow、cwd反例迁入受跟踪测试，先红；复用共享CDP驱动，保留脚本与stderr/targetCrashed/退出码，不等待重建才写测试 |
| P5-C1 | 工程师 | 修NADC所有分支必调API/返回，先d8/绑定单目标或可控FastAPI测试，再限流Integration增量；真正强制fast路径与关闭/stop/满队列对照 |
| P5-C2 | 工程师 | 修setter/helper标注与scope溢出归属；补Promise同步边界、CEReactions重入及配置/停止配对矩阵 |
| P5-C3 | 项目架构师定契约，工程师实现 | 明确成员/路径覆盖和precise实际谓词；生成清单进入构建资源闭环，任意cwd能力一致；不要用标partial掩盖业务回归 |
| P5-C4 | 双方联合 | 重新记录最终源/五补丁/生成代码/组件/驱动/coverage摘要；重放、368/28/211+新增、bindings57+新增、producer/targeted浏览器矩阵；总架构师复验后再恢复accepted-p5 |
| P55-D0（可并行） | 项目架构师 | 按P5.5 §13修订原始需求到证据模型、输入清单、预算/身份/序列化/导航契约；用自有合成fixture验证，不依赖P5已安全这一假设 |

继续遵守单构建协调者和资源方案，不用本轮review作为恢复大规模编译的新增授权。项目架构师负责决策与证据层级，工程师负责最小修复和可复现测试，总架构师负责反例复验；不再只给“全绿计数”而省略路径是否真正经过。

### 14.5 本轮证据

[p5-chief-review-gwem9w3m](../chromium/src/out/XTraceIntegration/validation/p5-chief-review-gwem9w3m/) 内：

- `identity.json`、`replay.json`：当前29db301、130/137重放和组件/args/快照/coverage摘要；不声称已提供过历史P5二进制摘要。
- `optimized-now-capture-off/result.json`：CDP targetCrashed；`normal-now-capture-off/result.json` 和 `optimized-now-capture-on/result.json`：同二进制对照；开启采集优化路径确有nadc-callback事件。
- `href-conversion/result.json`、`setter-conversion/result.json`：JS异常与outcome=ok冲突。
- `scope-overflow/result.json`：成功深层构造被误标arg-error。
- `coverage-out-cwd/result.json` 与其他root-cwd结果：覆盖表随cwd变化。
- `nadc-reports.json`：既有E2E partial计数为0的事实；`bindings-python311.log`、`regression.log`、`producer-tests.log`：本轮亲跑通过记录。
- `probes.cjs`、`summary.json`：仅本地安全合成输入、执行清单与复验边界。未运行第三方挑战脚本、未向第三方发送trace或凭据。

---

## 15. 架构师对总审意见的核实与裁定（2026-09-24）

**方法**：每条指控都过了源码现场（生成代码 / bind_gen / scope / handler / validator）与运行证据抽查；不盲从权威，也不护短。结论：**P5-R1～R5 全部属实，P5 重开（范围精确为 WebIDL 插桩层）；P5.5 设计修订绝大部分接受；三处路线钉住。**

### 15.1 五项 P5 指控的独立核验

| 指控 | 架构师独立核验 | 裁定 |
| --- | --- | --- |
| R1 NADC 拒绝分支跳过 API 本体 + 非 void 无返回 | `gen/.../v8_performance.cc:710–722` 实测：`TryEnter()` 为 false 时函数直接走到末尾——`double` 返回函数**无返回语句（UB）**，且 `blink_receiver->now()` 本体在 else 分支根本不执行；`optimized-now-capture-off/result.json` 中 `Inspector.targetCrashed` 复现证据在案（采集关闭 + 优化路径）。bind_gen `interface.py:2198–2212` 的注入形态证实原 API 调用只存在于 if 分支 | **成立**，最高优先级产品回归（观测改变了业务行为——本项目第一原则被违反） |
| R2a TLS 溢出把内层错误写到外层 | `xtrace_generated_scope.cc:36–56` 实测：深度 ≥64 不再 push，但 `MarkOutcome` 仍写 `TopScopeStack()`（第 64 层）——代码注释自称"never a wrong mark"恰好在 68 层场景失效（65–68 层不可标，内层 arg-error 落在无关的第 64 层正常 scope 上） | **成立** |
| R2b setter 异常被标 ok | `gen/.../modules/v8/v8_url.cc:96–99` 实测：setter 转换 `NativeValueTraits<IDLUSVString>::NativeValue(...)` 失败路径为**裸 `return`、无任何标注**——该路径（attribute setter）与已接线的 `make_v8_to_blink_value` 转换族不是同一处，outcome 默认 "ok" 被记。抛错的 `toString` 值 → JS 异常被页面捕获 → outcome=ok | **成立** |
| R3 精细开关无消费点 + 覆盖表依赖 cwd | `BindingsPreciseMode()` 在 blink/content 全树**零消费点**（死开关）；`xtrace_handler.cc:269` 用 cwd 相对路径读 `gen/xtrace/webidl_coverage.json`，且代码注释（"module directory"）与实现自相矛盾 | **成立** |
| R4 成员边界未显式登记 | 首批接口从点名成员扩为 5 接口**全成员**注入（Element 182），未经架构师裁决登记；`supported` 语义被"构造处有 scope"滥用为"行为已验证" | **成立**（过程缺口；处理见 15.3-3） |
| R5 记账/验证器盲区 | `validate_trace.py:2259–2281` 实测：配对为**纯集合差**——无入口先于终态的顺序断言、`selected_overload` 只查十进制形态不查 `< overload_count`（集合配对丢失该对照所需的关联）、对合法中断 capture 的未配对无终态感知 | **成立** |

### 15.2 P5.5 §13 修订：接受的部分（原提案被证过度承诺处）

以下均为我的文档措辞/承诺超出已证事实，接受修订：

1. **accumulator 流 ≠ vPC**。循环头 Entry 读到的值只是**候选**虚拟操作码（也可能是比较值/上次调用结果）；必须引入 `value_role`（unclassified/candidate_pc/candidate_opcode/…）与"读到非空即识别成功"的明确禁令。合成解释器验收（已知 PC/opcode 不同的程序）是正确要求。
2. **"tier 免疫"措辞错误**。它与本仓库既定事实边界 #5 直接冲突（优化器可降低/替换/消除调用，builtin hook 只在调用真实发生时触发）——这是我的表述失误，按 §13.2 改为"以能力矩阵与实际 tier 证据为准"。
3. **T3 的 key 解析依赖不存在的数据**。当前边界头只有 script_id/version/offset/opcode/url，`GetNamedProperty` 的 key 在常量池、需 D1 的编译实例元数据资产才能解析；`GetKeyedProperty` 的 key 多为运行期值，不可普遍恢复。T3 骨架（schema/fixture/分析器）可先行，完整 key 面等元数据——"无需引擎依赖"的表述收缩为此限定。
4. **预算与"首次完整激活"不相容**。N=2000/窗口 512 覆盖不了 10⁴–10⁵ 迭代——预算是**可重现探针计划**（first-K/nth-hit/明确区段），完整由新独立实验补齐；完整性分两轴（传输结算 complete/incomplete × 观测覆盖 full/partial/unknown）。
5. **activation_ref 不是任意函数调用身份**。递归/同函数多调/generator/async 下，把同一脚本激活的全部 tap 串为一个 VM 执行是错误的——需调用/恢复片段身份或明确限制（首期只在单函数激活内串接，跨调用链接标 hypothesis）。
6. **dump 深序列化边界**：own-data slots 等内部安全路径有界拷贝；accessor/Proxy/interceptor/未知 exotic 一律跳过并记原因；**TypedArray 原生地址不写入 trace**（只存类型/offset/长度/资产引用）；预算除阈值外加总量与工作量上限。

### 15.3 钉住的路线（不接受带偏的三处）

1. **值观测方向不动摇**。§13.1 的重排（可定位的运行证据 + 按需探针 + 有界值快照 + 可审查的分析假设）是承诺级别的修正，不是方向之争——与原提案的 T4/T5 本意一致。删除的是"完整虚拟指令流/完整计算图/一次 dump 即还原"的措辞，能力本身保留。
2. **nav_chain 锚点保留**。一阶段 cookie 值在重载 Cookie 头中可定位，是正确的验收锚点；等级从"闭环因果"修正为 **derived 级强证据**（值相等 + 链身份 + 时序），不再称闭环——锚点留、措辞降。
3. **R4 处理为"登记 + 二维分级"，不缩范围**。5 接口全成员注入不违反"不做全量 WebIDL"（接口数未扩），问题在 `supported` 语义滥用。现以架构师身份显式登记：**首批 5 接口全成员注入 = 编译事实级覆盖**；运行已验证成员按行为 fixture 矩阵逐个标记（接口存在/生成有码/路径可达/语义已验收四分）——成员集合不回缩到点名清单。

### 15.4 两条不可妥协与一条自省

- **R1 修复形状写死**：**API 无条件执行、观测有条件执行**（`retval = call(); if (TryEnter()) observe; else MarkNadcPartial(); return retval;`）。任何让 capture 决定业务是否执行的形态都没有讨论空间。附带接受 §14.3-R1 对"无分配"的澄清：`IDLExtendedAttributes.md:1258` 的现代 NADC 语义允许分配/异常/JS 回调——无分配预检查是优化而非正确性要求，修复不必被它捆住。
- **重开范围精确**：P5 重开只覆盖 WebIDL 插桩与覆盖表层（§14.4 的 C0–C4 块）；P2–P4 已冻结底座（管道/契约/observer）不受 R1–R5 影响，不做全栈历史重演。
- **自省**：本次 P5 确认（29db301）我核了对方给出的正例证据，但没有主动反例 NADC 拒绝路径、setter 转换路径与 TLS 溢出——"绿灯但没解决"的模式在架构师侧复发。记入长期纪律：**验收确认必须包含独立反例面，不是验对方给的正例**。

### 15.5 执行块确认（与 §14.4 一致，按本裁定校准）

C0 反例进受跟踪测试先红 → C1 NADC 全分支必调 API/返回（强制 fast API 四态：关/开/未配置/满队列/stop 后）→ C2 setter/helper 标注与 scope 溢出归属（含 Promise 同步边界、CEReactions、配对矩阵）→ C3 覆盖二维分级 + precise 真谓词 + 清单进构建资源闭环（任意 cwd 一致）→ C4 身份重录与全量回归后恢复冻结。bindings 3.11 环境债已被总架构师在本机重新找到并 57/57 通过——该笔关闭。P55-D0 按 §13 修订设计契约先行，不依赖"P5 已安全"假设。

---

## 16. 重开整改执行记录（2026-09-24，C0–C3 完成，提交总架构师复验）

**范围：§14.3 P5-R1～R5 全部整改 + §14.4 C0–C3 执行块完成。** C4（身份重录与全量回归）随本提交交付，待总架构师复验后恢复 accepted-p5（冻结动作归架构师，执行层不再先行标记）。

### 16.1 C0：反例进受跟踪测试（先红后绿）

`scripts/p5-reopen-counterexamples.cjs`（共享 CDP 驱动 + 保留 stderr/targetCrashed/退出码，方法学与总审 probes 一致：`--allow-natives-syntax --no-maglev` + `%OptimizeFunctionOnNextCall` 强制 fast 路径）。**首红已录**（`validation/p5-reopen-mB6PiZ`：fast-off targetCrashed、href/Element setter outcome=ok、68 层 token64 被污染为 arg-error、repo-cwd 无覆盖表）；修复后 **12/12 GREEN**（`validation/p5-reopen-hv7sSN`）：

| 用例 | 断言 |
| --- | --- |
| R1.fast-off-executes-api-and-returns | 采集关 + 优化 fast：API 执行、返回有限单调值、无 targetCrashed |
| R1.fast-on-control-no-crash | 采集开对照：无崩溃 |
| R1.fast-after-stop-executes-api | stopCapture 后优化调用：API 仍执行（stopping 态 TryEnter 拒绝但不拦业务） |
| R1.fast-full-queue-api-and-accounting | 容量 1 + 50 次优化 fast：全部有限单调、无崩溃、**manifest nadc_partial>0**（拒绝分支确实执行且计账） |
| R2b.href/element-id-setter | 转换抛错 → outcome=arg-error（页面侧 caught 与 trace 分类双断言） |
| R2a.deep-nesting | 67 层嵌套成功构造 + 内层已捕获缺参：外层 URL.constructor outcome 全 ok（无污染） |
| R3.precise-suppresses-fast-entries | precise 开：开关为 true、now() 全走慢路（零 nadc-callback、entry_kind=operation）、API 完好 |
| R3.coverage-cwd ×3 | repo-cwd 与 out-cwd 均有 webidlCoverage 且载荷一致 |

"未配置"态说明：与采集关闭同属 ConfigReceived=false（同一代码路径），未单列用例——mid-flight 未配置窗口无法确定性构造，如实记录。

### 16.2 C1：NADC 形态修复（裁定写死形状）

生成代码改为**API 无条件、观测有条件**：`retval = API(); if (TryEnter()) { scope(entry+outcome); } else { MarkNadcPartial(); } return retval;`（setter 同形）。两处注入点（`make_no_alloc_direct_call_callback_def` / `make_attribute_set_nadc_callback_def`）均落地；异常检查先于观测（拒绝观测窗不造事件）。

计账策略（R1 附带要求）：`MarkNadcPartial` 仅在**活跃 capture** 内计数（无采集/已 stop 不再增长不可结算计数）；拒绝路径经 `CurrentIfExists()`（构造器注册的 thread-local 指针）绝不初始化 producer；`BufferHasRoom` 为 entry+outcome 预留 2 条余量。

### 16.3 C2：标注归属与配对语义

- **R2a**：TLS 栈深度计数可超 64；**溢出区显式不可标注**（`TopScopeStack` 返回 nullptr，绝不借用外层栈顶）；溢出丢标与无归属 MarkOutcome 均计 `scope_overflow` 缺口（producer watermark → manifest，未确认 null 纪律）。
- **R2b**：attribute-setter 转换补传 `cg_context`（此前裸 return）；共享 reflect-setter helper（`generated_code_helper.cc` 的 `PerformAttributeSetCEReactionsReflect` 模板）在缺参与转换失败两路径加 `MarkOutcome("arg-error")`（无活跃 scope 时零开销 no-op）。
- **R5 admission**：`LogGeneratedEntry` 返回是否被 producer 接纳（EmitEvent→AcceptEvent 结果经 thread-local 回传）；**未接纳的入口不产生 outcome**（无孤儿终态）；promise 返回入口在 outcome 上标 `sync_exception_becomes:"rejection"`（同步异常→拒绝与普通 throw 不混类）。

### 16.4 C3：precise 真谓词与覆盖资源闭环

- **真安装门控**：`XTraceGeneratedScope::BindingsPreciseMode()` 导出为消费点；生成代码为 NADC 表同时生成 **Slow 变体表**（无 fast CFunction 的完整同成员表），运行时 `if (!Precise()) { install(fast); } else { install(slow); }` —— **成员面永不变化，只有入口路径变化**（修正过程中发现并修掉了"门控即跳过安装导致 API 消失"的中间态缺陷）。`xtrace-bindings-precise` 补入 renderer 转发白名单（此前 renderer 收不到开关、谓词恒假——死开关的根因之一）。
- **清单资源闭环**：覆盖表成为 `generate_bindings_interface` 的**声明输出**，经 bundle_data 装入 `ChromiumX.app/Contents/Resources/xtrace/webidl_coverage.json`；handler 从可执行文件相对路径读取（**与 cwd 无关**），披露 `webidlCoverageStatus`（缺文件=missing 可见失败）与表内 `version`/`generated_at`；构建缺清单即失败（声明输出）。
- **二维分级（R4）**：表 v3 双轴——compile-injection（生成器真派生）与 runtime-verification（受跟踪 fixture `platform/xtrace/webidl_runtime_coverage.json`，按接口存在/生成有码/路径可达/语义已验收四分；未验证成员显式 untested，不因"构造处有 scope"冒充行为已验证）。首批 5 接口全成员注入=编译事实级覆盖（按 §15.3-3 登记，范围不回缩）。

### 16.5 R5：validator 强化

配对从集合差升级为：**顺序**（outcome 必须晚于配对 entry）、**路由上界**（`selected_overload < 配对入口 overload_count`）、**类型**（call_token 十进制串单一形态，事件发射同步改引号）、**终态感知**（complete capture 未配对=错误；合法中断 capture 报 coverage gap 不造 outcome）。7 个新单测进回归（tests/test_validate_trace_v3.py `V3WebidlPairingContractTest`）。

### 16.6 修复后全量门禁（同一最终二进制）

| 门禁 | 结果 |
| --- | --- |
| 反例门 | **12/12 GREEN**（四态矩阵含 partial>0 E2E 可见） |
| 回归 python | 375 OK + launcher 28 OK（含 7 个新配对契约 + 4 个覆盖一致性） |
| bindings 57/57 | **通过**（总审恢复的 /tmp/xtrace-blink-python311 环境，0 skip/0 fail） |
| 契约 | 21/21 |
| 矩阵 off / observer | 12/12 / 12/12 |
| 故障注入 / observer smoke | pass / pass（validator 含新 webidl 契约） |
| producer 单测 | 9/9 |
| 证据驱动 | outcome-evidence PASS（路由 1/0/1）、nadc-partial-evidence PASS |
| 补丁栈 | verify verdict=pass（0 不符、0 漂移）；新增文件入栈：bindings/BUILD.gn、chrome/BUILD.gn（0005）、generated_code_helper.cc、webidl_runtime_coverage.json |

### 16.7 边界如实

- "未配置"四态之一与采集关闭同路径（§16.1 说明）；mid-flight 窗口不可确定性构造。
- outcome 仍只记录同步相位（Promise 结算后置不变）；`sync_exception_becomes` 标注的是同步异常→拒绝的转换语义。
- runtime 轴当前由 fixture 驱动（证据驱动结果人工/后续自动化回填），非运行时自动采集。
- 首启后首个 case 曾因 macOS 签名验证慢而超时（重跑即过，非产品缺陷）。

**申请：§14.3 五项整改经 §16 证据可进入总架构师复验；复验通过后由架构师恢复 accepted-p5（P55-D0 按 P5.5 §13 并行推进）。**
