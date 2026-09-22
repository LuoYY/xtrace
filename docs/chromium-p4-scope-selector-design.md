# P4 scope selector 设计修订 + 首次配置屏障（N3-part2）

- 版本：v1.0（2026-09-22）。依据：P4 交接 §11.3 R4、F1 遗留（首执行窗口）；总架构师指示"先以小型设计修订固定 selector 的身份命名空间、初始化/更新/销毁规则，然后从统一配置快照传播到所属 isolate"。
- 状态：设计冻结后实施；本文即实施依据。

## 1. 身份命名空间（v1）

观察范围用**三个互不替代的命名空间**表达，全部挂在 F1 的统一配置快照 `EffectiveCaptureConfig` 上（与 categories/generation 同一不可变对象、同一传播通道）：

| 命名空间 | 身份是什么 | 匹配方式 | 承载字段 |
| --- | --- | --- | --- |
| `contexts` | 激活发生地的上下文身份：主线程激活 = frame 文档 URL；Worker/Worklet 激活 = worker scope URL | 子串模式列表（空 = 全部选中） | `observer_scope.context_patterns` |
| `scripts` | 被观察脚本的**源 URL**（编译实例的来源；不是 script_id 数字，也不冒充 context） | 子串模式列表（空 = 全部选中） | `observer_scope.script_patterns`；script_id→URL 由 V8 注册表在首次登记时解析缓存 |
| isolate | 进程内 isolate 本身 | **v1 不单独编址**：所有 isolate 共享同一 selector；per-isolate gate（F2）保留为安全不变量（互不串扰、嵌套恢复），不是选择机制 | 无 |

明确边界（不做的事）：

- `scripts` 按**源 URL**选择，不按 script_id 或编译实例身份编址（运行期动态分配，控制面无法先验声明）；URL 相同的多次编译实例都命中——这是 v1 的显式声明，不是遗漏。
- `contexts` 用文档/scope URL，不引入 context token/内存身份。
- `denyInternal`（默认 true）把原先硬编码的内部 scheme 排除（chrome://、devtools:// 等）变为**显式配置规则**：不再有隐藏排除列表；置 false 时由 patterns 自行决定。

## 2. 初始化 / 更新 / 销毁规则

- **初始化**：selector 随 `EffectiveCaptureConfig` 的初始快照建立（默认 contexts=[]、scripts=[]、denyInternal=true，即等价现行行为但显式化）。
- **更新**：`updateCapture` 增加可选 `observerScope`；浏览器串行分配新 generation 时将其写入快照一并经 `XTraceControl.UpdateConfig` 下发；晚注册 renderer 经启动期控制端点回填继承（F1 机制）。事件入口一次快照同时决定类别过滤、generation 与 observer 范围（§10.8-A 不变量不变）。
- **销毁**：selector 是不可变快照的字段，随快照替换而消亡；stop latch（N2）关闭一切；isolate 销毁按 WillBeDestroyed 注销。无独立生命周期。
- **评估点**：`contexts` 在激活 begin 时对 frame_url 匹配（选中才压 selected 栈）；`scripts` 在事件回调时对注册表缓存的脚本源 URL 匹配（未选中丢弃，不产事件）。

## 3. 首次配置屏障（零等待确定性）

- 每个进程的 hub 增加 `config_received` 标志；**precise 环境下 gate 打开必要条件追加 `config_received==true`**。renderer 启动期注册控制端点时，浏览器**无条件回填当前配置（含 generation 0 初始快照）**——回填到达即置位屏障。
- 语义：回填前的新 renderer **保守不接纳**（gate 关闭，无事件），fail-closed；对应可观测状态为 status 的 pendingProducers（尚无目标代事件的已登记成员）。
- 因此可做**零 sleep 确定性测试**：更新后新建 renderer 立即导航——该 renderer 的任何事件要么带新 generation，要么因屏障不存在；**绝不允许出现 generation 0 的旧配置事件**。结算用 bounded poll（status appliedProducers），不用固定等待。

## 4. 契约与披露

- v3 事件字段**不变**（范围是采集配置，不是事件属性）；`getCaptureStatus.config` 与 manifest `effective_config` 增加 `observerScope` 披露。
- 单一边界声明：V8 侧新增公开头 `v8/include/xtrace_observer_boundary.h`（纯原始类型签名），Blink bridge、content handler、d8 一律 include 该头，删除各自手写重复声明（可编译检查，防 ABI 漂移）。
- 回调签名扩展：`(isolate, script_id, version, offset, opcode, const char* script_url)`；URL 指针仅在回调期内有效，embedder 需要即拷贝。

## 5. 验收

1. scope 契约：`contexts` 排除页面 URL → 该页零 ignition（另一选中页非零）；`scripts` 选中某脚本 URL → 仅其事件、同 URL 其他脚本不选时为零；denyInternal 行为显式可配。
2. 屏障契约：更新 → 新 renderer **零等待**导航 → 无 generation 0 事件；bounded poll 内 appliedProducers 收敛。
3. 回归：17/17 契约、双矩阵、故障、单测、run_tests 不回退；按 AGENTS.md 规范同步补丁并 verify。
