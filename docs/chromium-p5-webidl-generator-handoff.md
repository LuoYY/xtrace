# P5 交接：Blink WebIDL 生成器插桩（首批接口的 call token 与 scope 观测）

- 文档版本：v1.0（2026-09-23）。
- 前置状态：**P1–P4 全部冻结**（P4 终审见 [P4 交接](chromium-p4-ignition-observer-handoff.md) §13；§10.5 的"P5 C++ 插桩等待"门槛随 P4 冻结解除）。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。执行模式沿用长程单次终审（§7）。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §10（Blink WebIDL 生成器增强）、§12 P5 行、§13.1；[P4 交接](chromium-p4-ignition-observer-handoff.md) §10.5（P5 进入门）；[trace-schema-v3.md](trace-schema-v3.md) v1.2。

## 1. 接手先做什么

1. 读本文件全文 + 草稿 §10（全部）与 §13.1 的 P5 行。
2. 确认现场：两树为五补丁状态（chromium 124 / v8 137 文件，`verify_patches.py` pass）；P4 交付的 per-isolate gate、统一配置快照、scope selector、两阶段弱回调不得回退。
3. 恢复 bindings 单测环境（隔离 Python 3.11.16；P1 期 `/tmp/xtrace-blink-python311` 若被清理则按草稿 §15.3 重建）。
4. P5 设计文档（P5-E1）经架构师裁决后才写 C++；设计冻结后按 §7 长程块一次推进。

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

## 5. 实施前需架构师裁决的决策点（P5-E1 提交）

1. **scope RAII 形状与注入点**：六类入口的统一/分治；call token 创建规则（普通 JS 入口）与 overload/signature 补充方式。
2. **去重策略**：手写 hook（0001 已覆盖）与生成器事件在同一 API 上的归属规则（禁用一方/合并事件/双通道标注——三选一须论证）。
3. **值捕获边界**：类型分派表；不触发用户代码的判定实现（异常/超时护栏）。
4. **覆盖表格式**：supported/partial/unavailable 的判据与机器可读形状（进 `getCapabilities`）。
5. **精细模式 predicate**：抑制点位置（模板/快照建立前）与环境语义（重启声明、能力表披露）。

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
