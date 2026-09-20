# P4 执行层提请裁决简报（五项）

- 日期：2026-09-21 · 提请人：执行层 · 依据：[P4 交接](chromium-p4-ignition-observer-handoff.md) §5 决策点、[chromium-p4-design.md](chromium-p4-design.md) v1.0
- 前置状态：P3 终审阻塞+小项已全部闭环（§10.5；逐文件 blob 比对 0 不符，tree `b6113568`）；P4-E0 d8 迭代环全绿（10 样本 + 4 tier 组复跑 PASS，0005 潜伏 bug 顺带修复）。裁决后 E2→E8 长程块开启，首个 C++ 任务为 V8 observer 核心。

## 裁决点 1：observer 机制落点与 gate

- **推荐**：改造 `interpreter-assembler.cc:52` 上游 Entry 插桩为"编译期开关（新 GN `v8_enable_xtrace_ignition_observer`，默认 false）+ 运行期原子 gate"；事件以 POD 结构经函数指针回调交给 embedder（V8 零 Blink 依赖，沿用 `SetEventLogger` 解耦先例）；Blink 侧状态在 `V8PerIsolateData::UserData`。
- 关键语义：**关闭编译 = 零字节码开销**（P0 基线语义，V11）；开启编译 + gate 关闭 ≈ 一次 load+branch（残余开销列入 E7 release 验收）。短 Star 沿用 Star 专用 Entry（P0 已证覆盖）。
- 备选：独立 observer 类（多一层抽象，无必要）。
- **请裁决**：☐ 接受推荐 ☐ 其他

## 裁决点 2：v3 字段扩展清单

- **推荐**：`ignition` 对象六字段——`script_id`/`bytecode_version`（per-(isolate,script) 编译实例序号）/`bytecode_offset`（规范化）/`tier`（首版恒 "ignition"）/`activation_ref`/`opcode`。**`activation_ref` 直接引用 `causality.call_id`**（Script.evaluate 的 paired call 即激活身份）——不造第二套激活身份，分析器沿 `activation_ref → call_id` 挂接。`virtual_opcode/vpc` 留给分析器推断层，与 `opcode` 分列。
- 只加字段不改语义；全部经 P2 producer 管道结算。
- **请裁决**：☐ 接受六字段与承接关系 ☐ 修改清单（批注）

## 裁决点 3：code cache 二选一

- **推荐**：**精细模式禁用并披露**——启动注入 `--no-code-cache`，manifest `config` 与能力表写明 warm profile 行为差异（脚本每次重编译，`bytecode_version` 每激活递增）；E6 新增 warm 对照行（精细模式版本递增 vs 常规模式不受影响）。理由：反序列化路径补元数据事件侵入面大，P4 首版验收不含该路径。
- 备选：反序列化元数据事件（留 P7 再议）。
- **请裁决**：☐ 禁用并披露（推荐） ☐ 反序列化路径

## 裁决点 4：tier 校验参数形状

- **推荐**：`startCapture` 扩展 `mode`（semantic/ignition-precise/jitless-experiment）+ `tier` + `jsFlags`；冲突矩阵：精细模式强制 tier=ignition、拒绝任何 `--sparkplug*`/`--always-sparkplug` 组合（V14 教训）、拒绝在已带冲突 flags 的浏览器上启用；**`effective_config` 回报实际生效配置**；tier 真实性以事件流 `tier` 字段 + active-tier intrinsic 为证（不只看参数字符串）；Host 静态检查为第一层、browser 权威拒绝为第二层。jitless-experiment P4 不开放。
- **请裁决**：☐ 接受矩阵与双层校验 ☐ 修改（批注）

## 裁决点 5：采样策略

- **推荐**：P4 首版**不启用** 1/k（`sampled_out` 恒 "0"）；限流靠 P2 有界缓冲 + drop-newest；E7 先测无采样真实速率，数据支撑后再定 k。启用时等式扩展为 `eligible = enqueued + dropped + sampled_out`（设计已预留扩展式，现契约不动）。
- **请裁决**：☐ 首版关闭（推荐） ☐ 立即启用（给 k）

## 附：E0 顺带修复登记

release 参数全图 GN 暴露 0005 中 `verify_libraries_chrome_app` 仍引用 `Chromium.app` 路径（debug component 构建不触发，故 P3 未现）——已改为 ChromiumX.app（可执行路径不变），随 0005 补丁更新。此为 E0 交付的意外收益，佐证 d8 环先行价值。

## 其余状态（无需裁决）

P3 待您执行冻结动作（`accepted-p3` + 草稿 §12 P3 行）；P4-E2 起的 C++ 实施严格等待本简报五项裁决。
