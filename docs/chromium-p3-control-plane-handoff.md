# P3 交接：控制面（browser-only XTrace CDP 域 / 配置 generation / 身份映射）

- 文档版本：v1.0（2026-09-20）。
- 前置状态：**P2 已冻结**（`integration-progress.json` 状态 `accepted-p2`，终审记录见其 `p2_acceptance`）。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。执行模式沿用 P2 的**长程单次终审**（§7）。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §8（控制面）、§12（阶段表）、§13.1（已收敛决策）；[trace-schema-v3.md](trace-schema-v3.md) v1.2（现行数据契约）；[P2 交接](chromium-p2-capture-foundation-handoff.md)（已完成范式）。设计语义以草稿为准，本文件规定落地顺序与验收方式。

## 1. 接手先做什么

1. 读本文件全文 + 草稿 §8、§13.1 的 P3 行、[R1 决策](chromium-p2-r1-decisions.md)（DP4 脚手架移除约定）。
2. **先清 P3-E0 的硬性欠账**（A.2 裁决：C++ 单测），不清零不进入 CDP 域实施。
3. 确认现场：两棵树仍为四补丁状态（0001/0003/0004 为 P2-E8 再生版，0002 未动）；`out/XTraceIntegration` 产物不重建、不清理。
4. P3 设计文档（P3-E1）经架构师裁决后才写 C++；设计冻结后按 §7 长程块一次推进。

## 2. 冻结输入（不得变更的基线）

| 项目 | 值 |
| --- | --- |
| Chromium / V8 | `151.0.7917.0`；`73088b4e…` / `af6aa2ec…`（与 P1/P2 相同） |
| 补丁栈 | 0001（E8 后 `ae2626a6…`）→ 0003（`15867f67…`）→ 0004（`4234303d…`）→ 0002（`796bd362…`），顺序与分层不变 |
| 数据契约 | [trace-schema-v3.md](trace-schema-v3.md) v1.2；P2 已交付：单一 writer、producer 登记、计数守恒、watermark 停止协议、带内控制端点（`XTraceControl`） |
| 构建基线 | `out/XTraceIntegration` debug component；性能结论仍须 release 另测 |
| 参考产物 | P1/P2 证据包（`out/XTraceIntegration/validation/`）；12 组矩阵驱动 `browser-integration.cjs`（v3 化，可扩展 P3 用例） |

## 3. P3 范围与非目标

### 3.1 范围内（草稿 §12 P3 行展开）

0. **A.2 单测欠账清零**（硬性进入条件，见 P3-E0）。
1. browser-only XTrace CDP 域：PDL 定义、协议生成、handler、browser target 注册；仅受信会话（非受信拒绝并有实测）。
2. capture 生命周期接口：`getCapabilities / startCapture / updateCapture / getCaptureStatus / stopCapture`；产物经 IO stream 读取；不把高频事件逐条广播为 CDP 通知。
3. 配置 generation 更新：启动快照 + 运行期更新；browser 串行分配；worker/SW 覆盖与逐一确认；混合代合法；stopping 拒绝 update；不伪造 applied ACK。
4. browser 侧身份映射：target/frame/document/worker 分层关联；`attribution.document` 开填；网络优先 `devtools_request_id`、保留底层请求 ID 与 redirect hop；缺失时带来源的 crosswalk，允许 unresolved；禁止 method+URL 哈希合并。
5. P2 测试脚手架移除：按 `XTRACE_TEST_SCAFFOLDING` 标记 grep 移除并登记；正式域接管停止触发。
6. Host 通信规则落地：专用实例 CDP pipe（FD 3/4、NUL framing）、断连/重连/请求取消语义；不引入 HTTP 调试端口与 `--remote-allow-origins=*`。

### 3.2 非目标（明确不做，越界即纠偏）

- 不做结构化 Ignition observer（P4）、Blink 生成器插桩（P5）、Agent Host / 66 工具 / sidePanel / Native Messaging 常驻宿主（P6）、指纹伪装层（P7）、Sparkplug（P7）、跨平台（P7）。
- 不改变启动期开关配置路径：launch-time 配置仍是"首次脚本前确定"的权威模式（草稿 §8.3 末段）；对已运行 target 的 startCapture 只声明从确认生效时刻起的覆盖。
- 不升级 Chromium/V8 基线；不动 0002 V8 插桩点；不退役 arm64 hooks；不关沙箱；不承诺断电持久化。
- 不做异步因果（Promise/timer/microtask 关联 token 属后续阶段）；schema 版本保持 v3，字段演进只按 v3 规范流程修订。

## 4. 任务分解

### P3-E0：C++ 单测欠账清零（硬性进入条件）

- controller 终态裁决四态（complete / incomplete / 失联 / 超时）content 层单测：构造 ProducerState 直接驱动 Finalize，断言终态与 reason（含 `no-producers-observed` 守卫、未确认 producer 计数为 null 的 v1.2 规则）。
- blink producer 计数/结算 platform 单测：溢出计数、watermark 提交、线程销毁即结算、`--xtrace-test-capacity` 触发路径。
- 验收：两目标构建通过、用例全绿；用例名与数量如实报告。

### P3-E1：P3 设计文档（R1 关卡，纯文档）

产出 `docs/chromium-p3-design.md`，覆盖：CDP 域 PDL 草案（方法/参数/事件/错误语义、`getCapabilities` 形状、IO stream 用法）；generation 传播协议（通道、初始快照传递点、混合代与确认规则）；身份映射模型（`attribution.document` 开填条件、crosswalk 格式与来源标记）；脚手架移除清单；P3 测试矩阵新增行。附第 5 节决策点的推荐方案与备选。

验收：架构师裁决通过（决策点逐项回填），方可进 C++。

### P3-E2：CDP 域骨架与受信强制

- PDL 接入与协议生成（真实入口是 `content/browser/devtools/BUILD.gn:55` 与 `protocol_config.json:206`，不是不存在的 `protocol/BUILD.gn`）；handler 注册进 browser target（`browser_devtools_agent_host.cc:226` 起）。
- `getCapabilities` 先行：返回 schema、模式、可观测路径、限制、动态/启动时配置项。
- 受信强制：非受信会话调用 XTrace 域一律拒绝（受 `debugger_api.cc:247,746,825` 同族信任约束）；附正向/反向实测。

### P3-E3：capture 生命周期接口

- `startCapture`：校验范围与模式，返回 capture ID、generation 与启动状态（starting 也可失败且原因可查）。
- `stopCapture`：幂等；返回 stopping 或已有终态，不提前承诺 complete。
- `getCaptureStatus`：producer 集合、配置收敛、计数、丢失与终态。
- 产物 IO stream：可读取时返回 handle，读取复用 `IO.read/close`（参考 `tracing_handler.cc:911`）；首期不逐条广播事件。
- 接入现有 CaptureCoordinator（P2 交付），不重写写入路径。

### P3-E4：updateCapture 与 generation 传播

- browser 串行分配 generation、快照当前参与集合；renderer 经带内 `XTraceControl` 下发；worker/SW 覆盖独立启动与生命周期路径；新 producer 继承最新版。
- 更新进行中允许旧/新 generation 同时出现在日志；状态接口报告未确认 producer；进入 stopping 拒绝 update；退出者记录退出结果，不伪造 applied ACK。
- renderer 启动初始快照：首次脚本执行前确定（沿用启动期配置路径，不视为已有代码保证，需在新链路实现并验证）。

### P3-E5：身份映射

- browser 从 target、RenderProcessHost、frame、document、worker 生命周期构建关联（`TargetInfo` 不提供 PID，PID/frame ID 不单独代表一次文档执行）。
- `attribution.document` 按设计文档开填；不可得保持 unresolved（v3 §3.3 规则不破坏）。
- 网络映射：优先 `devtools_request_id`，保存底层请求 ID、来源与 redirect hop；ID 缺失时建立带来源的 crosswalk；分场景验证（导航、普通 resource、Worker/SW、redirect、未启用 Network 域）。

### P3-E6：脚手架移除与矩阵扩展

- 按 `XTRACE_TEST_SCAFFOLDING` 标记 grep 移除 `--xtrace-stop-after-ms`（正式 `stopCapture` 接管）；`--xtrace-test-capacity` 按决策点 5 裁决处置；移除情况在本文档登记。
- 12 组矩阵全量回归（v3）+ 新增 P3 用例：启动配置、运行期更新、更新中创建 Worker、停止中创建 producer、pipe 断连/重连、BFCache 进入（≠ context 销毁）。
- 每项用例附证据；终态语义同 P2（计数等式为唯一判据）。

### P3-E7：Host 通信验证

- pipe FD 3/4、NUL framing 实测（framing 边界、断连检测、请求取消）；明确不启用 CBOR 模式。
- 不引入 HTTP 调试端口与 `--remote-allow-origins=*`（反向断言沿用 P1 E4 模式）。
- 测试驱动与 launcher 的 domain 路径适配（launcher 可继续走启动期配置；domain 路径作为新能力单列，不替代既有链路）。

### P3-E8：证据包与终审提交

沿用 P2 证据纪律与 §7.5 清单：补丁回写（改动集中 0001；v3 字段若涉 0003/0004 同步）+ 干净索引顺序复验 + 逐文件一致性核对（P2 终审方法：补丁清单逐文件 blob 比对）；回归 338/28/211 + 新增测试数；`integration-progress.json` 新增 P3 段（初始 `p3-in-progress`，终审前不得 accepted）；文档状态同步（草稿 §2.3/§12、本文件勾选）。

## 5. 实施前需架构师裁决的决策点（P3-E1 提交，逐项给推荐与备选）

1. **CDP 域 PDL 草案**：方法/参数/事件/错误语义；`getCapabilities` 的版本化形状；IO stream 的创建时机与生命周期。
2. **generation 传播通道**：`XTraceControl` 增加 `UpdateConfig` vs 独立接口；renderer 初始快照传递点（启动期配置链路 vs 带内）。
3. **身份映射承载位置**：`attribution.document` 开填的时机与条件；crosswalk 落盘形式（事件内嵌 vs manifest 映射段）。
4. **脚手架移除口径**：`stop-after` 移除计划；`test-capacity` 保留为长期测试设施还是一并移除（若保留，改为何种形态）。
5. **Host 连接语义**：NUL framing 定稿；断连/重连与请求取消的客户端契约；Host 进程模型对 P6 的预留（不实现，只定接口约束）。

## 6. 纪律与纠偏事项（沿用 P1/P2，新增第 9 条）

1–8 条沿用 [P2 交接](chromium-p2-capture-foundation-handoff.md) §6（补丁分层回写 + 干净索引复验、不改测试预期掩盖、沙箱不动、性能口径、文档证据一致、旧病不移植、计数等式为终态唯一判据、构建效率）。

9. **受信边界是硬条款**：XTrace 域只接受受信会话；UI/扩展/普通 CDP 客户端的任何"方便打通"请求都必须先回架构师——不沿用 P1 时代 `--remote-allow-origins=*` 的任何残留路径。

## 7. 长程执行模式（沿用 P2 v1.1 §7）

入口条件：P3-E0 清零 + P3-E1 设计文档经架构师裁决。此后 **P3-E2 → P3-E8 为一个连续执行块**，中间不设例行审查点；完成后一次提交，架构师终审（R2+R3 合并）。

- 自主权：实现细节、命名、测试组织、默认值调优、bug 修复全权；每完成一项在 §4 对应标题打勾并附一行证据指针。
- 升级触发器：沿用 P2 §7.4 六条（基线变更/规范语义改动/计数等式不成立/新增对外能力/新二选一/设计层故障），另加第七条：**受信边界需要放宽的任何迹象**。
- 终审提交物：沿用 P2 §7.5 清单，另附受信强制的正/反向实测、generation 更新矩阵、身份映射分场景证据、脚手架移除登记。

## 8. 完成定义

- A.2 单测欠账清零；XTrace 域 PDL 冻结且 handler 落地；非受信会话拒绝有实测。
- capture 生命周期五接口可用；startCapture 校验、stopCapture 幂等、状态可查、产物可经 IO stream 读取。
- generation 更新在 renderer/worker/SW 路径逐一可确认；混合代与 stopping 拒绝行为符合草稿 §8.3；无伪造 ACK。
- `attribution.document` 按设计开填；网络映射分场景验证通过；缺失一律 unresolved 不猜测。
- 脚手架两开关按裁决移除/处置并登记；12 组矩阵 + P3 新用例全绿；pipe 断连/重连语义实测。
- 补丁栈可复现（逐文件一致性核对）；回归全绿；证据包经架构师终审；`integration-progress.json` 标记 `accepted-p3`。

## 9. 源码定位索引（P3；其余见草稿 §14）

| 范围 | 位置 |
| --- | --- |
| browser target 注册与受信检查 | `chromium/src/content/browser/devtools/browser_devtools_agent_host.cc:226` |
| CDP pipe 协议入口 | `chromium/src/content/browser/devtools/devtools_pipe_handler.cc:396` |
| 协议生成接入点 | `chromium/src/content/browser/devtools/BUILD.gn:55`、`chromium/src/content/browser/devtools/protocol_config.json:206` |
| 扩展 browser-target 信任限制（参照） | `chromium/src/chrome/browser/extensions/api/debugger/debugger_api.cc:247,746,825` |
| IO stream 参考实现 | `chromium/src/content/browser/devtools/protocol/tracing_handler.cc:911` |
| Renderer 初始化契约 | `chromium/src/content/common/renderer.mojom:176` |
| browser→renderer 发送 / renderer 绑定 | `chromium/src/content/browser/renderer_host/render_process_host_impl.cc:2003`、`chromium/src/content/renderer/render_thread_impl.cc:1702` |
| Worker 更新 / 新线程启动 | `chromium/src/content/renderer/worker/worker_thread_registry.cc:90`、`chromium/src/third_party/blink/renderer/core/workers/worker_thread.cc:675` |
| P2 控制面（带内端点） | `chromium/src/content/browser/xtrace/xtrace_capture_controller.{h,cc}`、`chromium/src/third_party/blink/renderer/platform/xtrace/xtrace_control_impl.{h,cc}` |
