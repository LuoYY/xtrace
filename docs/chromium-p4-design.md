# P4 设计文档：结构化 Ignition observer

- 版本：v1.0（P4-E1 产出，R1 审查对象）。依据：[P4 交接](chromium-p4-ignition-observer-handoff.md)、[迁移草稿](chromium-migration-enhancement-draft.md) §9/§12.1/§13.1、[trace-schema-v3.md](trace-schema-v3.md) v1.2、P0 证据（V11–V15）与 P4-E0 复跑基线。
- P4-E0 已完成：`out/XTraceP4D8` d8 构建成功（3443 步），P0 `verify_d8.py`（10 样本 PASS）与 `verify_tiers.py`（4 组 PASS）在打补丁树上复跑通过——环境差异说明：P0 基线构建于未打补丁树；P4-E0 在已应用 0001/0003/0004/0005 的树上构建，V8 侧 0002 未包含（d8 目标不链接 Blink/content 层补丁文件；V8 自身源与 P0 基线一致，结论可比）。

## 1. observer 机制落点与 gate（决策点 1）

**推荐：改造上游 `interpreter-assembler.cc` 的 Entry 附近插桩为编译期可关的结构化调用点，Blink 侧经 `V8PerIsolateData::UserData` 持状态；不做新的独立 observer 类。**

- 落点：`interpreter-assembler.cc:52`（handler Entry 构造处）。上游 tracing 在此处编译进 `Runtime_TraceUnoptimizedBytecodeEntry` 调用（`runtime-trace.cc:119`），已具备"执行前、规范化 offset、accumulator/寄存器可达"的全部语义（P0 十样本证明）。P4 将其从"无条件调用 + runtime 内 flag 检查"改造为"编译期保留 + 采集状态 gate 前置"：
  - `--xtrace-enable-ignition-observer`（新 V8 GN 参数 `v8_enable_xtrace_ignition_observer`，默认 false）：控制 handler 内调用点的编译进/出。**关闭编译时零字节码开销**——这正是 P0 基线（V11）的语义，性能对照以此为准。
  - 开启编译但采集关闭：进入 handler 后经一个 thread-local/isolate-local 原子 gate 检查（约一次 load+branch），不分配事件。残余开销列入 P4-E7 验收。
- 短 Star（`interpreter-assembler.cc:1363–1374`）：`InlineShortStar` 不进独立 handler，现有 tracing 在 Star 专用 Entry 处覆盖（P0 短 Star 样本 5/5 Entry 断言通过）；observer 沿用该路径。
- **V8 侧不拼 JSON、不做磁盘 IO**：observer 只构造一个 POD 事件结构（见 §2 字段），经函数指针回调交给 embedder。V8 头文件零 Blink 依赖（沿用 `SetEventLogger` 解耦先例）；回调注册/销毁在 `V8PerIsolateData` 构造/析构（顺序：isolate 创建后注册、isolate 销毁前注销——observer 生命周期严格内嵌于 isolate）。

## 2. v3 字段扩展清单（决策点 2）

只加字段不改语义；全部经既有 producer 管道结算。

```json
"ignition": {
  "script_id": "<v8:NumberToString(script id)>",   // 十进制字符串
  "bytecode_version": "<SharedFunctionInfo age/serial>",  // 见下
  "bytecode_offset": "123",                        // 规范化（无前缀计数）
  "tier": "ignition",                              // 本首版恒为 ignition
  "activation_ref": "<causality.call_id>"          // 承接关系：指向同线程当前
                                                    // 激活的 call_id（与 v2 因果
                                                    // 链同源，Script.evaluate
                                                    // 的 call 即激活身份）
}
```

- **`bytecode_version` 语义**：标识"这份字节码是哪次编译的产物"。P4 首版取 `SharedFunctionInfo` 的 script id + 一个 per-(isolate,script) 的编译实例序号（isolate 内原子计数）。code cache 反序列化路径（若决策点 3 选禁用）不产生新实例，版本恒定，可判别 warm 复用。
- **与 `causality.call_id` 的承接**：`activation_ref` 直接引用当前激活的 `call_id`（Script.evaluate 的 paired call）。分析器沿 `activation_ref → call_id` 就能把字节码事件挂到脚本激活上；不新造第二套激活身份。
- `v8_bytecode`（opcode 名）字段：保留为分析器可读的 `opcode` 字符串；`virtual_opcode/vpc` 属于分析器推断层，与本字段分列（交接 §3.2 硬约束）。

## 3. code cache 决策（决策点 3）

**推荐：精细模式禁用 code cache 并披露（草稿 §9.2 二选一的第一项）。**

- 理由：反序列化路径补元数据事件需要 hook `CodeSerializer/Deserializer`，侵入面大且 P4 首版验收不含该路径；禁用只需在精细模式启动参数注入 `--no-code-cache`（或 `--disable-code-cache`），并在 manifest `config` 与能力表披露"精细模式下 warm profile 行为差异：脚本每次重新编译，`bytecode_version` 每激活递增"。
- 验收：warm profile 场景（同脚本二次加载）下精细模式 `bytecode_version` 递增 + 常规模式不受影响的对照证据（P4-E6 矩阵新增一行）。

## 4. tier 校验参数形状（决策点 4）

`startCapture` 扩展（只加参数）：

```json
{ "mode": "semantic | ignition-precise | jitless-experiment",   // 默认 semantic
  "tier": "none | ignition",                                     // 精细模式强制 ignition
  "jsFlags": ["--no-code-cache"] }                               // 精细模式隐式注入
```

冲突拒绝矩阵（browser 权威）：

| 组合 | 结果 |
| --- | --- |
| `mode=semantic` + 任意 js_flags | 拒绝（语义模式不开运行期 JS flag） |
| `mode=ignition-precise` + `tier!=ignition` | 拒绝 |
| `mode=ignition-precise` + `--sparkplug*`/`--always-sparkplug` | 拒绝（V14：显式参数可覆盖 max_opt 弱 implication） |
| 已带冲突 flags 启动的浏览器上请求精细模式 | 拒绝并回报实际生效 flags |
| `mode=jitless-experiment` | P4 首版不开放（声明边界，P7 再议） |

- **生效回报**：`startCapture`/`getCaptureStatus` 回报 `effective_config`（mode + 实际 js flags + code cache 状态）；tier 真实性以事件流中的 `tier: "ignition"` 与（对照时）active-tier intrinsic 证据为准，不只看参数字符串。
- Host 侧静态检查（第一层）：launcher/Host 在构造参数时先做同样的矩阵检查，减少无效 IPC；browser 拒绝是权威。

## 5. 采样/限流（决策点 5）

**推荐：P4 首版不启用 1/k 采样（`sampled_out` 计数字段已定，恒为 "0"）；限流依赖 P2 既有有界缓冲 + drop-newest。**

- 理由：精细模式本身就是"选定脚本范围的受控实验"；先测无采样下的真实速率（P4-E7），数据支撑后再决定默认 k。启用时事件在 gate 后经 `seq % k` 判定，被排除事件计入 `sampled_out`（生产者侧三等式扩展为 `eligible = enqueued + dropped + sampled_out`，manifest 计数同步扩展——本设计预留该式，不改现契约直到启用）。

## 6. 销毁顺序与不变量

1. isolate 创建 → `V8PerIsolateData` 构造 → 注册 observer 回调（函数指针 + POD 分配器）。
2. 采集停止：renderer 侧 gate 置 false（watermark 前完成）；在途 POD 事件已在 producer 缓冲，正常结算。
3. isolate 销毁：`V8PerIsolateData` 析构先于 isolate 内部 teardown → 注销回调；producer（线程 local）的 Settle 语义不变。
4. GC/寄存器不变量：observer 调用点在 handler Entry、accumulator/寄存器尚未破坏处（P0 语义对照 10/10 通过即为该位置安全性的证据）；POD 事件不持 V8 堆指针（script id/offset 为数值），无需 handle scope。任何 handler 改动附 mjsunit 对照（交接纪律 §6.10）。

## 7. P4 测试矩阵（P4-E6 展开）

在 P0 十样本 + 4 tier 组之外新增：

| 用例 | 断言 |
| --- | --- |
| offset-规范化 | Wide/ExtraWide 前缀不双计；InlineShortStar 记录；与 P0 Entry 数对照 |
| activation-承接 | ignition.activation_ref 解析到当次 Script.evaluate 的 call_id |
| code-cache-warm | 精细模式二次加载 bytecode_version 递增；常规模式不受影响 |
| tier-权威拒绝 | 精细+sparkplug 组合被拒；生效回报与事件 tier 一致 |
| 关闭开销 | observer 编译关闭 vs 开启+gate 关闭：release 构建事件速率/RSS 对照 |
| 计数契约 | 精细模式事件经 P2 管道：三等式成立、complete 终态 |

## 8. 决策点建议汇总

| # | 推荐 | 备选 |
| --- | --- | --- |
| 1 机制/门 | 上游 Entry 插桩改造 + 编译期开关 + 运行期 gate；POD 回调解耦 | 新 observer 类（多一层无必要抽象） |
| 2 字段 | §2 六字段（script_id/bytecode_version/bytecode_offset/tier/activation_ref/opcode），activation_ref 承接 call_id | 新激活身份（两套身份是缺陷） |
| 3 code cache | 精细模式禁用并披露 | 反序列化元数据事件（侵入大，P7 再议） |
| 4 tier 校验 | §4 拒绝矩阵 + effective_config 回报；双层（Host 静态 + browser 权威） | 仅 browser 侧（多一跳无效 IPC） |
| 5 采样 | 首版不启用；等式扩展式预留 | 立即启用（无数据支撑） |
