# P5 设计：Blink WebIDL 生成器插桩（首批接口的 call token 与 scope 观测）

- 版本：v1.0（2026-09-23）。依据：[P5 交接](chromium-p5-webidl-generator-handoff.md) v1.0 §5 五决策点；草稿 §10；trace-schema-v3 v1.2。
- 状态：**R1 关卡——待总架构师裁决后实施**。每项给推荐与备选；裁决通过后 P5-E2→E7 按 §7 长程块执行。

## 0. 源码事实核对（设计输入，全部已在固定树核验）

| 事实 | 位置/值 |
| --- | --- |
| 六类生成入口 | `bind_gen/interface.py`：getter `make_attribute_get_callback_def:1878`、setter `make_attribute_set_callback_def:2003`、overload dispatcher `make_overload_dispatcher_function_def:2159`、constructor `make_constructor_callback_def:2254`、NADC/Fast callback `make_no_alloc_direct_call_callback_def:2441`、operation `make_operation_callback_def:2623` |
| 共享空 callback 构造器 | `_make_empty_callback_def:1814`——六类入口中四类经它建骨架（getter/setter/overload/constructor），NADC 与 operation 走独立路径 |
| 首批接口 IDL | URL（`core/url/url.idl:37` canParse 静态方法 + constructor）；Element.scroll 双 overload（`core/dom/element.idl:156-157`，**均返回 `Promise<ScrollResult>`**，`CallWith=ScriptState`）；Response.text（`core/fetch/body.idl:16`，`CallWith=ScriptState, NewObject, RaisesException`）；Performance.now（`core/timing/performance.idl`，NoAllocDirectCall operation）；NADCAttributeTest.float64Value（`core/testing/nadc_attribute_test.idl`，`[NoAllocDirectCall=Setter] attribute double`） |
| 既有手写钩子（P1-P4，0001 内） | **位于 DOM 实现层而非 bindings 层**：`dom_url.cc` 51 处（URL.constructor 含 url_object_id 身份与六元组参数）、`url_search_params.cc` 130 处、`response.cc` 44 处、`performance.cc` 1 处；bindings 层手写钩仅 v8_script_runner/v8_code_cache 等基础设施 |
| Promise rejection 转换 | `bindings/core/v8/generated_code_helper.cc:104` |
| E0 基线 | Python 3.11.16 隔离环境 `run_bindings_tests.py -j 1` 57/57 绿（2026-09-23 重建复核） |

## 决策点 1：scope RAII 形状与六类入口注入点 + call token 规则

**推荐：模板头注入统一 scope RAII（`XTraceGeneratedScope`），按回调类型特化构造参数；call token 只在普通 JS 入口创建。**

- 注入点：`_make_empty_callback_def`（四类共享骨架）+ `make_no_alloc_direct_call_callback_def` / `make_operation_callback_def` 各自函数体头部——共三个物理注入点覆盖六类逻辑入口。备选"六处独立注入"重复代码多、维护面大，不推荐。
- 生成代码形状（插入在现有 body 最前，所有 `info` 使用之前）：

```cpp
XTraceGeneratedScope xtrace_scope(
    /*api=*/"URL.constructor",            // 由 IDL 名+入口类型静态拼出
    /*entry=*/XTraceGeneratedScope::kConstructor,
    /*interface=*/"URL", /*member=*/"constructor",
    /*overload_count=*/2,                  // dispatcher/constructor 携带
    /*info=*/info);                        // 各回调类型的 info 形参
```

  - getter/setter/NADC callback：`info` 形参类型各异（`PropertyCallbackInfo<Value>/<Boolean>` 等），scope 构造器取模板参数或重载集适配，不复制 V8 类型到 Blink 头。
- **call token 规则**：普通 JS 入口（六类全部）创建进程内单调 token 并写入 scope；token 不跨 overload dispatcher 与最终选中的 implementation 重复创建——dispatcher 记录"路由前"事实（实际实参个数/类型标签），被选中的具体 overload/constructor 函数**不再创建第二个 token**，只补充 signature 详单（见下）。Fast API/NADC callback：NADC setter 无 JS 可见异常状态且不得分配——**只在日志缓冲预分配路径可容纳时记录**（预检查 `scope.TryEnter()` 无分配协议；不可容纳则该入口记 `unavailable` 到覆盖表，不硬插桩）。Performance.now 为 NoAllocDirectCall operation：同规则。
- **overload/signature 详单**：Element.scroll 双 overload 在 dispatcher 记录选中分支（`overload_index:0|1`）与实参形状（`{x,y}` vs `{options}` 键集），具体实现不再记录入口事实。

**备选方案**：
- A（不推荐）：仅空 callback helper 单点注入——NADC/operation 两类不走该 helper，覆盖不完整。
- B（不推荐）：DOM 实现层再加一层 scope——与既有手写钩子同层冲突，去重问题更复杂。

## 决策点 2：手写 hook 与生成器事件的去重策略（三选一）

**推荐：双通道标注（方案三）——两通道都保留，事件带 `channel` 字段，消费端按 (api, channel) 区分；首个消费场景（P6 工具）默认聚合 `bindings` 通道、按需开 `impl`。**

理由（对照三选项）：

1. **禁用一方**：禁手写钩会丢 impl 层独有的深信息（URL 的 `url_object_id` 身份与解析六元组是 DOM 层才有；URLSearchParams 130 处参数级细节 bindings 层拿不到）；禁生成器则 P5 无交付。均不可取。
2. **合并事件**：跨层合并需要在同一事件里拼两层字段，字段集随接口膨胀，且两层时序上本就先后（bindings 先、impl 后），合并不减少信息只增加耦合。
3. **双通道标注（推荐）**：生成器事件 `channel:"bindings"`，手写钩事件 `channel:"impl"`（默认值 `bindings` 向后兼容存量分析器——impl 事件是少数，显式加字段）。双层各司其职：bindings 层记录**入口事实**（何时、哪个 overload、参数形状、异常路径），impl 层记录**语义详情**（URL 解析结果、SearchParams 操作细节）。

- **计数对照验收**（交接 §6.11）：每个首批接口跑同 API 双通道计数对照——`bindings` 计数 == 页面调用次数、`impl` 计数 == 调用次数（impl 钩全量在首批接口上），无双倍（两通道互不加和）；此对照进 P5-E4 证据。
- 事件字段：v3 envelope 不变；`extra_top_fields` 增 `channel` 与 `entry_kind`（六类之一）、`overload_index`（可选）。手写钩侧：`LogEvent*` 增加可选 channel 参数默认 `"impl"`——改动集中在 logger 签名与 0001 既有调用点的默认值，不逐个改 100 文件。

**备选**：方案一（禁生成器在已有 impl 钩的接口上生效，其余接口生成器事件）——看似省事但"同 API 两规则"让覆盖表变成补丁账本，长期最贵；不推荐除非架构师要求最小扰动。

## 决策点 3：反扰动值捕获边界（类型分派表）

**推荐：静态白名单分派表 + 一律不触发用户代码；越界类型只记类型与长度。**

| 值类别（IDL 类型） | 捕获行为 |
| --- | --- |
| 标量（double/float/long/boolean/byte 等） | 直接值（数值/布尔字面量） |
| USVString/DOMString | 原文（走既有长度上限与截断四元组；超限转 hash-ref，契约同 v3 §5） |
| 枚举 | 字符串值 |
| 对象引用（interface/callback/dictionary） | 不解引用：记 `ref:{fnv1a64}`（identity hash 由 V8 对象地址派生——沿用 v1 时代的 object:N 引用）+ 类型名 |
| ArrayBufferView/TypedArray | 原始数据指针 + byteLength/byteOffset；**只读不解码内容** |
| Promise | 只记 `promise` 类型与 creation 事实；settlement 后置（非目标） |
| callback/函数 | 只记引用与类型，**不调用**（Proxy trap、自定义 toString 一律不触发——分派表在生成器侧静态决定，无运行时反射） |
| record/sequence | 记长度 + 元素类型标签；元素不解引用 |

- 护栏：分派表是**生成期静态查表**（bind_gen 按 IDL 类型选捕获代码路径），不存在"运行时决定要不要调用户代码"的路径——不调用用户代码是构造性保证而非运行时检查。异常/超时护栏因此不需要（没有可抛异常的用户调用）。备选"运行时 try-catch 包裹"引入了本要避免的调用，直接排除。
- receiver：`info.This()` 只记引用与检测到的接口类型；receiver 类型不匹配（TypeError 路径）在异常语义（P5-E3）覆盖。

## 决策点 4：覆盖表格式（supported / partial / unavailable）

**推荐：生成期产出静态 JSON 清单 + `getCapabilities` 运行时汇总；判据固定三条。**

- 判据：`supported` = 六类入口注入且页面可达（JS 可见接口成员）；`partial` = 注入但路径受限（NADC/Fast 入口在无分配协议下记录受预检查约束——`partial` 并注明受限原因）；`unavailable` = 生成器未覆盖或该成员不可从普通页面触达（如 NADCAttributeTest 仅测试接口）。首批之外的全部接口报 `unavailable`（P7 扩员）。
- 形状（`getCapabilities.limits.webidlCoverage`，机器可读）：

```json
{"version": 1, "interfaces": {
  "URL": {"members": {"constructor": "supported", "href": "supported", "canParse": "supported"},
           "handwrittenChannels": ["impl"]},
  "Element": {"members": {"scroll": "supported"}, "notes": "promise-returning overloads; entry facts only"},
  "Response": {"members": {"text": "supported"}},
  "Performance": {"members": {"now": "partial"}, "partialReason": "NoAllocDirectCall: bounded-buffer precheck"},
  "NADCAttributeTest": {"members": {"float64Value": "partial"}, "partialReason": "NADC setter no-alloc protocol; test-only interface"}
}}
```

- 清单由 bind_gen 在生成时随代码产出（`gen/xtrace/webidl_coverage.json`），构建后由 browser 侧读取并入 capabilities——**生成期即冻结**，运行时不重算（与编译产物同源，杜绝运行时自检说谎）。

**备选**：运行时自注册（每接口构造时上报）——启动开销与初始化顺序问题（有的接口懒实例化），且"上报了"不等于"生成器真的注入了"；不推荐。

## 决策点 5：精细模式 predicate 位置与环境语义

**推荐：per-interface-template 建立前的统一 predicate 函数 + 快照/代码缓存联动沿用 P4 F3 门，环境切换需重启并披露。**

- 位置：`V8DOMConfiguration::Install...(install_template)` 家族（`bindings/core/v8/v8_dom_configuration.cc`）入口统一调 `XTrace::PreciseBindingsMode()`：精细模式为 true 时，对首批接口集**跳过 Fast API 属性安装与 cached-property 路径**（跳过=回退常规路径，不是删功能）。模板缓存（`V8PerContextData` 的 interface template 缓存）在精细模式下不写不读该接口（miss 后重建），确保观测环境无缓存差异。
- 常规模式（默认）：predicate 恒 false，Fast API 与缓存路径保持上游行为——P4 F3 的 code-cache 门（`IgnitionBridge::ObserverRequested()`）照旧管脚本缓存，本决策点只管**接口模板/属性级**快速路径。
- 环境语义：精细模式由启动开关 `--xtrace-bindings-precise`（browser/renderer 同步转发，进 capabilities 的 `modes` 与 `preciseModeRequires`——沿用 P4 F3 的 PreciseEnvironment 模型，追加要求项）；**不可热切换**（模板已建立的 context 不回收），capabilities 对未满足环境报 unavailable（复用 B2 修复的权威检查模式）。
- 与 P4 精细模式的关系：`--xtrace-ignition-observer`（字节码层）与 `--xtrace-bindings-precise`（bindings 层）独立开关、可叠加；叠加时 capabilities 分别披露，互不隐含。

**备选**：A）逐接口 extended attribute（IDL 标注）控制——把模式配置散进 IDL，跨接口策略不可见；B）运行时 flag 热切换——模板缓存一致性无法保证。均不推荐。

## 实施风险与验收对照（供裁决参考）

| 风险 | 缓解 |
| --- | --- |
| 生成器改动冲击 bindings 全量构建 | 幂等注入（纯前置语句，不改既有节点）；57/57 单测 + 全量编译是 E5 门槛 |
| NADC/NoAlloc 入口违反无分配约束 | TryEnter 预检查协议；不可容纳→覆盖表 partial，不硬记 |
| CEReactions 析构回调 JS 的重入误判 | scope 析构区分"日志自身递归"（RAII 重入保护，计数不翻倍）与"真实页面重入"（记 reentry 事件）——E3 分路径测试覆盖 |
| 双通道计数漂移 | E4 同 API 计数对照验收（见决策点 2） |
| 生成器升级冲突面 | 注入点固定在三个函数头部，冲突面最小化；后续 frx 更新时重放核对 |

## 请求裁决

请对五个决策点逐项裁决（接受/修改/备选），并确认：①NADC/NoAlloc 的 TryEnter 预检查协议是否满足"不硬插桩"边界；②双通道标注的向后兼容默认值（存量事件 channel 缺省为 bindings）是否可接受；③覆盖表生成期冻结的判据三条是否成立。裁决通过后按交接 §7 启动 P5-E2→E7 长程块。
