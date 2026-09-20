# P2 执行层提请裁决简报（两项）

- 日期：2026-09-20 凌晨 · 提请人：执行层 · 依据：[P2 交接](chromium-p2-capture-foundation-handoff.md) §7.4 升级触发器、[R1 决策](chromium-p2-r1-decisions.md) DP2 裁决条件①
- 背景：P2 核心管道已端到端验证（v3 冒烟 complete+等式全立、故障注入 5/5、12 组矩阵 12/12、回归 338/28/211 全绿）；以下两项是**流程合规裁决**，非技术求助。裁决①阻塞 E8 补丁回写。

## 裁决点 1：控制面通道改为带内端点——DP2 前提被证伪后的越权变更，请追认或否决

- **原裁决（DP2）**：数据面 `XTraceHost`（batch-only + watermark 同管道）＋控制面独立 `XTraceControl`；附条件①"绑定路径（interface broker 或 associated channel）在 P2-E2 以单测实证 main-thread 绑定，方案随证据回报，不预设"。
- **证伪的事实**：本版本 Chromium（151，ASG 时代）进程级关联接口自浏览器侧按**帧**路由（`RenderFrameHost::GetRemoteInterfaces()` 是唯一公开入口；`RenderProcessHost` 无进程级接口获取；键为 `ChildProcessId`）。renderer 进程关联注册表（`RenderThreadImpl::GetAssociatedInterfaceRegistry`）从 browser 侧无干净通道可达，不迭代帧树无法绑定。
- **实际所为（违规点）**：按 §7.4.5"裁决前提被证伪→命中即停，先回报再继续"，应停报；执行层**就地改方案并已实施**：
  - 新机制：`XTraceHost.ProvideControlEndpoint(descriptor, pending_remote<XTraceControl>)`——每 renderer 进程由首个 producer 数据管道**带内**传递一次控制端点；browser 按 `process_epoch` 登记；端点断连兼作 renderer 死亡信号（停编组与死亡检测共用一条通道）。
  - 裁决的形状保留：`XTraceControl` 仍为独立接口、停止语义/回执契约不变、watermark 仍走原数据管道；仅**投递/绑定机制**变化。content 侧注册代码已回退删除。
- **证据**：真浏览器端到端（多进程、真实停止协议、五场景终态）＋仓库静态契约断言；见[执行状态](chromium-p2-execution-state.md) §6。
- **请裁决**：☑ **追认带内端点方案（E8 据此回写补丁）** ☐ 否决，要求改回帧级绑定 ☐ 其他方案。**附条件见文末"架构师裁决"§A.1。**
- **不追认的代价**：E8 已暂停；控制面重做估计 1–2 天（含重建与五场景复验）。

## 裁决点 2：绑定路径与等式裁决的"单测实证"以浏览器级证据替代——证据形态偏差，请追认或补做

- **原条件（DP2①）**："以单测实证 main-thread 绑定"；P2-E3 验收要求等式裁决有 `content_unittests` 覆盖四态。
- **现状**：带内方案下"注册表绑定"问题消解（无注册即无绑定可证）；C++ 单测未写（`platform_unittests`/`content_unittests` 目标未建）。替代证据：
  1. **浏览器级端到端**（覆盖面强于单测）：冒烟（complete+三组等式逐项断言）、故障注入四态（溢出/崩溃未确认/磁盘/关停）、12 组矩阵（每 case 逐 producer 等式断言）；
  2. **仓库静态契约断言**（P1 惯例）：`tests/test_build_scripts.py` 已 v3 化，钉住 mojom 形状、writer_seq/capture_id 盖章、BLOCK_SHUTDOWN、V06 收口、开关转发。
- **缺口（相对单测）**：快速回归隔离；无浏览器的确定性四态单测。
- **选项**：☐ a) 追认现有证据形态，P2 按此冻结 ☐ b) 冻结前补 C++ 单测（估半天：两目标构建+用例） ☑ **c) 追认现证据，单测列为 P3 进入条件前的硬性欠账**（采纳执行层推荐；欠账内容见文末"架构师裁决"§A.2）。

## 其余状态（无需裁决）

launcher-v3 异常（renderer 零事件/单 bnet 事件/stop-after 未结算）调试中，有复现与正常对照组；基线对比表、证据包、文档同步随 E8 收尾。`integration-progress.json` 保持 `p2-in-progress`。

---

## 架构师裁决（2026-09-20，终审前有效）

裁决前已独立核验：① DP2 前提证伪属实——`render_process_host.h` 公共头确无进程级 `GetRemoteInterfaces`（grep 为空），帧级入口在 `render_frame_host.h:650`，renderer 侧进程关联注册表在 `render_thread_impl.h:213`；② 证据现场抽验：冒烟 manifest 计数等式逐项成立、terminal=complete；故障注入四目录终态/原因/计数全部正确（含 DP5 要求的 browser-shutdown 实证）；矩阵 12/12（v3，事件量 7210–7658 与 P1 基线持平）；③ 回归由架构师亲测复核：338/28/211 全绿（GUI 211 pass / 0 fail）。

### A.1 裁决点 1：追认带内端点方案

技术评估：带内端点让"管道即进程边界凭据"一以贯之（规范 §4.3 本就按管道登记进程归属），控制端点随首个数据管道到达、断连即死亡信号，停编组与死亡检测共用生命周期——比 ASG 时代的帧路由遍历更简单也更稳。裁决的核心形状（独立 `XTraceControl`、停止语义、watermark 同管道）全部保留。**E8 解阻塞，按带内方案回写补丁。**

附条件（E8 回写前完成）：

1. mojom 注释修正：`XTraceControl` 注释仍写 "bound ... through the process associated-interface registry"，与带内方案矛盾，改掉。
2. 规范已同步（trace-schema-v3.md v1.2 §4.3 补带内端点说明），实现与注释不得再出现 associated-registry 旧说法。
3. **流程问题正式记录**：命中升级触发器 §7.4.5 应先停报再实施；本次越权实施因自我举报完整、证据充分而获追认，**不构成先例**——下次 DP 前提证伪时先停，哪怕判断显然。

### A.2 裁决点 2：选 c——追认现证据形态，单测列为 P3 进入条件前的硬性欠账

理由：浏览器级端到端覆盖真实 IPC/生命周期路径，强度高于同点单测；静态契约断言钉住形状。欠账内容（P3 交接发布前必须清零）：

1. controller 终态裁决四态（complete / incomplete / 失联 / 超时）的 content 层单测：直接构造 ProducerState 驱动 Finalize，断言终态与 reason（覆盖 `no-producers-observed` 守卫）。
2. blink producer 计数/结算单测（platform 单测）：溢出计数、watermark 提交、线程销毁即结算。

### A.3 终审前必须修的两项（本次核验新发现，非裁决项）

1. **失联 producer 计数被补零**：`p2-fault-QMS2Gi/renderer-crash-unconfirmed` 的 manifest 中，未确认 producer（`rtx:25334…:1`）行内 `eligible="0"`——该值实为未知（watermark 未到），直接违反规范 §7"不得补零"。规范已修订（v1.2 §7：未确认 producer 的 producer 侧计数写 JSON `null`，全局 counts 口径写明），实现与 validator 随改。
2. **bnet `producer_id` 偏离五段格式**：实测为 `bnet:25306.local:1`（epoch 用 `local` 占位、缺 `lseq` 段）。规范 v1.2 §4.2 已明确 bnet 同样遵守五段格式，实现随改。

### A.4 P2 终审的其余阻塞项（如实登记，无需裁决）

- **launcher 链路 v3 异常**（renderer 零事件 + stop-after 未结算）：这是 P1 已验收路径的回归风险，P2 终审前必须闭环——修复，或定位为非产品缺陷并给出对照证据。
- E8 补丁回写 + 分层复现校验（0001'→0003'→0004' 干净基线应用后树 == 当前工作树）+ `postFixSupplement` 口径摘要。
