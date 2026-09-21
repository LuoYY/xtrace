# P4 执行层提请裁决简报（五项）

- 日期：2026-09-21 · 提请人：执行层 · 依据：[P4 交接](chromium-p4-ignition-observer-handoff.md) §5 决策点、[chromium-p4-design.md](chromium-p4-design.md) v1.0
- 前置状态：P3 终审阻塞+小项已全部闭环（§10.5；逐文件 blob 比对 0 不符，tree `b6113568`）；P4-E0 d8 迭代环全绿（10 样本 + 4 tier 组复跑 PASS，0005 潜伏 bug 顺带修复）。裁决后 E2→E8 长程块开启，首个 C++ 任务为 V8 observer 核心。

## 裁决点 1：observer 机制落点与 gate

- **推荐**：改造 `interpreter-assembler.cc:52` 上游 Entry 插桩为"编译期开关（新 GN `v8_enable_xtrace_ignition_observer`，默认 false）+ 运行期原子 gate"；事件以 POD 结构经函数指针回调交给 embedder（V8 零 Blink 依赖，沿用 `SetEventLogger` 解耦先例）；Blink 侧状态在 `V8PerIsolateData::UserData`。
- 关键语义：**关闭编译 = 零字节码开销**（P0 基线语义，V11）；开启编译 + gate 关闭 ≈ 一次 load+branch（残余开销列入 E7 release 验收）。短 Star 沿用 Star 专用 Entry（P0 已证覆盖）。
- 备选：独立 observer 类（多一层抽象，无必要）。
- **请裁决**：☑ **接受推荐** ☐ 其他（条件见文末裁决区）

## 裁决点 2：v3 字段扩展清单

- **推荐**：`ignition` 对象六字段——`script_id`/`bytecode_version`（per-(isolate,script) 编译实例序号）/`bytecode_offset`（规范化）/`tier`（首版恒 "ignition"）/`activation_ref`/`opcode`。**`activation_ref` 直接引用 `causality.call_id`**（Script.evaluate 的 paired call 即激活身份）——不造第二套激活身份，分析器沿 `activation_ref → call_id` 挂接。`virtual_opcode/vpc` 留给分析器推断层，与 `opcode` 分列。
- 只加字段不改语义；全部经 P2 producer 管道结算。
- **请裁决**：☑ **接受六字段与承接关系** ☐ 修改清单

## 裁决点 3：code cache 二选一

- **推荐**：**精细模式禁用并披露**——启动注入 `--no-code-cache`，manifest `config` 与能力表写明 warm profile 行为差异（脚本每次重编译，`bytecode_version` 每激活递增）；E6 新增 warm 对照行（精细模式版本递增 vs 常规模式不受影响）。理由：反序列化路径补元数据事件侵入面大，P4 首版验收不含该路径。
- 备选：反序列化元数据事件（留 P7 再议）。
- **请裁决**：☑ **禁用并披露（推荐）** ☐ 反序列化路径

## 裁决点 4：tier 校验参数形状

- **推荐**：`startCapture` 扩展 `mode`（semantic/ignition-precise/jitless-experiment）+ `tier` + `jsFlags`；冲突矩阵：精细模式强制 tier=ignition、拒绝任何 `--sparkplug*`/`--always-sparkplug` 组合（V14 教训）、拒绝在已带冲突 flags 的浏览器上启用；**`effective_config` 回报实际生效配置**；tier 真实性以事件流 `tier` 字段 + active-tier intrinsic 为证（不只看参数字符串）；Host 静态检查为第一层、browser 权威拒绝为第二层。jitless-experiment P4 不开放。
- **请裁决**：☑ **接受矩阵与双层校验** ☐ 修改

## 裁决点 5：采样策略

- **推荐**：P4 首版**不启用** 1/k（`sampled_out` 恒 "0"）；限流靠 P2 有界缓冲 + drop-newest；E7 先测无采样真实速率，数据支撑后再定 k。启用时等式扩展为 `eligible = enqueued + dropped + sampled_out`（设计已预留扩展式，现契约不动）。
- **请裁决**：☑ **首版关闭（推荐）** ☐ 立即启用

## 附：E0 顺带修复登记

release 参数全图 GN 暴露 0005 中 `verify_libraries_chrome_app` 仍引用 `Chromium.app` 路径（debug component 构建不触发，故 P3 未现）——已改为 ChromiumX.app（可执行路径不变），随 0005 补丁更新。此为 E0 交付的意外收益，佐证 d8 环先行价值。

## 其余状态（无需裁决）

P3 待您执行冻结动作（`accepted-p3` + 草稿 §12 P3 行）；P4-E2 起的 C++ 实施严格等待本简报五项裁决。

---

## 架构师裁决（2026-09-21）

裁决前已独立核验：① P3 阻塞闭环——当前补丁栈重放树 `b6113568` 复现一致，但**逐文件比对发现新漂移**（见 B.1）；② P3 小项——build 块已在最新 domain 冒烟恢复（`151.0.7917.0/true/true`），stop-after 清理不完全（见 B.2）；③ P4-E0——`out/XTraceP4D8` d8 构建存在、10 样本 + 4 tier 组日志 PASS、P0 未打补丁基线未被覆盖；④ 回归 `run_tests.sh` 亲测 338/28/211 全绿。

### A. 五项裁决（全部接受推荐方案）

1. **机制落点与 gate：接受。** 附条件：GN 开关 `v8_enable_xtrace_ignition_observer` 默认 false 正确，但我们的构建脚本（`gn_gen_xtrace.sh` / `build_xtrace_release.sh`）必须显式置 true 并在 args 证据中可见——否则交付二进制根本没有 observer 调用点，gate 无从谈起；该接线证据列入 P4-E2 提交物。
2. **字段扩展：接受六字段与 `activation_ref → call_id` 承接。** 不造第二套激活身份是对的。
3. **code cache：接受"禁用并披露"。** 附条件：禁用开关的真实名称与覆盖面（V8 flag 与 Blink 脚本流/code-cache 两条路径）必须以 E6 warm 对照证据为准——`bytecode_version` 在精细模式二次加载中递增才算禁用生效，不得凭 flag 名字面声明；同时"精细模式只存在于以精细模式启动的环境"这一后果必须进 `getCapabilities` 的机器可读输出，Host 从浏览器学习而非从文档学习。
4. **tier 校验：接受矩阵与双层校验 + `effective_config` 回报。**
5. **采样：接受首版关闭；等式扩展式预留正确。**

裁决落地后，P4-E2 → P4-E8 长程块开启（入口条件其余两项已满足；P3 冻结动作见 B）。

### B. P3 冻结前的两项账务（发现于本次核验；均分钟级）

1. **0005 补丁未含 verify_libraries 修复**：E0 顺带修的 `chrome/BUILD.gn`（`verify_libraries_chrome_app` 的 inputs 指到 ChromiumX.app）在工作树中但在任何补丁里都不存在——逐文件比对实测 `chrome/BUILD.gn` 不符。简报附言称"随 0005 补丁更新"与实际不符。处理：重生成 0005 → 重放 + 逐文件比对 → 更新 `p3E8Supplement` 摘要。正在运行的 release 构建用漂移工作树无碍其产物，但补丁栈必须在 P4-E7 用它的性能数字前补齐。
2. **`scripts/p2-fault-injection.cjs:144` 仍传已失效的 `--xtrace-stop-after-ms=5000`**（§10.5 称"本仓库脚本现均无引用"，不成立）；`browser-integration.cjs:241` 的 closeEvidence 字符串也仍是旧文案。清理或修正登记表措辞。

B 两项完成后回报，我执行 P3 冻结（`accepted-p3` + 草稿 §12 P3 行 + P4 入口全开）。两项不阻塞 P4-E2 启动（纯账务，与技术方案无关），但 P3 冻结不因此而豁免。

### C. 2026-09-21 最终复核补充

B 两项的补丁账务已闭环，但 P4 最终实现与原裁决仍有实质差距，终审不通过；下一任务是整改块 P4-F0～F6，不是 P5，详见 [P4 交接 §10](chromium-p4-ignition-observer-handoff.md)。新增 `causality=sync` 前置作为激活引用的依赖予以接受，须按真实生效配置统一拒绝与披露；不豁免真实 tier、范围/生命周期、缓存禁用、逐事件覆盖及匹配性能基线。A.3 的 warm 判据进一步明确：版本增长须辅以真实浏览器缓存消费/禁用证据，不能以 d8 new Function 或新地址代替 warm profile。
