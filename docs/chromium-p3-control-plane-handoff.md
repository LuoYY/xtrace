# P3 交接：控制面（browser-only XTrace CDP 域 / 配置 generation / 身份映射）

- 文档版本：v1.1（2026-09-20；P3-E0 单测欠账已清零（架构师亲跑 5/5 + 4/4）、P3-E1 设计文档经裁决通过（五项全部接受，PDL 两处修订，见 [chromium-p3-design.md](chromium-p3-design.md) §9）；新增 P3-E9 应用命名任务（用户指示）。实施从 P3-E2 开始，按 §7 长程块推进）。
- 前置状态：**P2 已冻结**（`integration-progress.json` 状态 `accepted-p2`，终审记录见其 `p2_acceptance`）。
- 分工：执行层 agent 实施；总架构师负责规范与证据 review、纠偏与关卡裁决。执行模式沿用 P2 的**长程单次终审**（§7）。
- 设计依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §8（控制面）、§12（阶段表）、§13.1（已收敛决策）；[trace-schema-v3.md](trace-schema-v3.md) v1.2（现行数据契约）；[P2 交接](chromium-p2-capture-foundation-handoff.md)（已完成范式）。设计语义以草稿为准，本文件规定落地顺序与验收方式。

## 1. 接手先做什么

1. 读本文件全文 + 草稿 §8、§13.1 的 P3 行、[R1 决策](chromium-p2-r1-decisions.md)（DP4 脚手架移除约定）。
2. **先清 P3-E0 的硬性欠账**（A.2 裁决：C++ 单测），不清零不进入 CDP 域实施。
3. 确认现场：两棵树仍为四补丁状态（0001/0003/0004 为 P2-E8 再生版，0002 未动）；`out/XTraceIntegration` 产物不重建、不清理。
4. ~~P3 设计文档（P3-E1）经架构师裁决后才写 C++~~ **P3-E0/E1 已完成并裁决（2026-09-20）**：单测 5/5 + 4/4 全绿（架构师复核）；设计五项决策全部接受、PDL 两处修订（`ProducerStatus` 未知计数用 optional、generation 起点统一为 "0"）。实施直接从 **P3-E2** 开始。

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
7. 应用命名 `ChromiumX`（用户指示；仅命名层面，站点可见面与 Chromium 完全一致，见 P3-E9）。

### 3.2 非目标（明确不做，越界即纠偏）

- 不做结构化 Ignition observer（P4）、Blink 生成器插桩（P5）、Agent Host / 66 工具 / sidePanel / Native Messaging 常驻宿主（P6）、指纹伪装层（P7）、Sparkplug（P7）、跨平台（P7）。
- 不改变启动期开关配置路径：launch-time 配置仍是"首次脚本前确定"的权威模式（草稿 §8.3 末段）；对已运行 target 的 startCapture 只声明从确认生效时刻起的覆盖。
- 不升级 Chromium/V8 基线；不动 0002 V8 插桩点；不退役 arm64 hooks；不关沙箱；不承诺断电持久化。
- 不做异步因果（Promise/timer/microtask 关联 token 属后续阶段）；schema 版本保持 v3，字段演进只按 v3 规范流程修订。

## 4. 任务分解

### P3-E0：C++ 单测欠账清零（硬性进入条件）

> [x] 完成（2026-09-20）：content_unittests 5/5（CompleteWhenConfirmedAndConsistent / IncompleteWhenDroppedPositive / IncompleteUnconfirmedNullCounters / IncompleteNoProducersObserved / MalformedBatchNotAccepted）；blink_platform_unittests 4/4（ParseTestCapacitySwitch / OverflowCountsStickyDropNewest / SettleIsIdempotentAndStopsAccepting / StopFlagRejectsNewEvents）。测试缝：host 工厂替换 + hub 复位/容量覆盖 + 解析导出。证据：`integration-progress.json` p3.e0_unit_test_debt

- controller 终态裁决四态（complete / incomplete / 失联 / 超时）content 层单测：构造 ProducerState 直接驱动 Finalize，断言终态与 reason（含 `no-producers-observed` 守卫、未确认 producer 计数为 null 的 v1.2 规则）。
- blink producer 计数/结算 platform 单测：溢出计数、watermark 提交、线程销毁即结算、`--xtrace-test-capacity` 触发路径。
- 验收：两目标构建通过、用例全绿；用例名与数量如实报告。

### P3-E1：P3 设计文档（R1 关卡，纯文档）

> [x] 产出 `docs/chromium-p3-design.md`（PDL 草案/受信强制/generation 传播/身份映射/脚手架处置/Host 语义/测试矩阵/决策点建议）——待架构师 R1 裁决

产出 `docs/chromium-p3-design.md`，覆盖：CDP 域 PDL 草案（方法/参数/事件/错误语义、`getCapabilities` 形状、IO stream 用法）；generation 传播协议（通道、初始快照传递点、混合代与确认规则）；身份映射模型（`attribution.document` 开填条件、crosswalk 格式与来源标记）；脚手架移除清单；P3 测试矩阵新增行。附第 5 节决策点的推荐方案与备选。

验收：架构师裁决通过（决策点逐项回填），方可进 C++。

### P3-E2：CDP 域骨架与受信强制

> [x] 完成——PDL 五命令（两处 R1 修订并入）、protocol_config/BUILD 接入、browser target 注册于 CreateAndAddHandler 受信门内；getCapabilities 三态；证据：p3-domain-smoke-tqMD5v

- PDL 接入与协议生成（真实入口是 `content/browser/devtools/BUILD.gn:55` 与 `protocol_config.json:206`，不是不存在的 `protocol/BUILD.gn`）；handler 注册进 browser target（`browser_devtools_agent_host.cc:226` 起）。
- `getCapabilities` 先行：返回 schema、模式、可观测路径、限制、动态/启动时配置项。
- 受信强制：非受信会话调用 XTrace 域一律拒绝（受 `debugger_api.cc:247,746,825` 同族信任约束）；附正向/反向实测。

### P3-E3：capture 生命周期接口

> [x] 完成——stopCapture 同步回终态 + manifest IO stream（DevToolsStreamFile + IO.read/close）；startCapture 回运行采集身份（launch-time 权威模式内）；证据：p3-domain-smoke（IO stream 断言）

- `startCapture`：校验范围与模式，返回 capture ID、generation 与启动状态（starting 也可失败且原因可查）。
- `stopCapture`：幂等；返回 stopping 或已有终态，不提前承诺 complete。
- `getCaptureStatus`：producer 集合、配置收敛、计数、丢失与终态。
- 产物 IO stream：可读取时返回 handle，读取复用 `IO.read/close`（参考 `tracing_handler.cc:911`）；首期不逐条广播事件。
- 接入现有 CaptureCoordinator（P2 交付），不重写写入路径。

### P3-E4：updateCapture 与 generation 传播

> [x] 完成——XTraceControl.UpdateConfig（带内）、串行 generation 自 "1"、新线程继承最新代、stopping 拒绝 update、applied/pending 不伪造 ACK；证据：update 后事件 config_generation "1"（直方图 0:5946/1:2）

- browser 串行分配 generation、快照当前参与集合；renderer 经带内 `XTraceControl` 下发；worker/SW 覆盖独立启动与生命周期路径；新 producer 继承最新版。
- 更新进行中允许旧/新 generation 同时出现在日志；状态接口报告未确认 producer；进入 stopping 拒绝 update；退出者记录退出结果，不伪造 applied ACK。
- renderer 启动初始快照：首次脚本执行前确定（沿用启动期配置路径，不视为已有代码保证，需在新链路实现并验证）。

### P3-E5：身份映射

> [x] 完成——manifest.identity crosswalk（frame_tree_node_id/document_token/frame_url/resolved），UI 线程快照 + writer 续写（两段式结算）；事件行保持轻量；validator identity 形状断言；证据：3 resolved rows

- browser 从 target、RenderProcessHost、frame、document、worker 生命周期构建关联（`TargetInfo` 不提供 PID，PID/frame ID 不单独代表一次文档执行）。
- `attribution.document` 按设计文档开填；不可得保持 unresolved（v3 §3.3 规则不破坏）。
- 网络映射：优先 `devtools_request_id`，保存底层请求 ID、来源与 redirect hop；ID 缺失时建立带来源的 crosswalk；分场景验证（导航、普通 resource、Worker/SW、redirect、未启用 Network 域）。

### P3-E6：脚手架移除与矩阵扩展

> [x] 完成——stop-after 移除（域接管停止，grep 仅余注释）；capacity 改名 xtrace-test-buffer-capacity（标记延续、launcher 不透传）；故障 4/4 + 矩阵 12/12 域驱动停止全绿

- 按 `XTRACE_TEST_SCAFFOLDING` 标记 grep 移除 `--xtrace-stop-after-ms`（正式 `stopCapture` 接管）；`--xtrace-test-capacity` 按决策点 5 裁决处置；移除情况在本文档登记。
- 12 组矩阵全量回归（v3）+ 新增 P3 用例：启动配置、运行期更新、更新中创建 Worker、停止中创建 producer、pipe 断连/重连、BFCache 进入（≠ context 销毁）。
- 每项用例附证据；终态语义同 P2（计数等式为唯一判据）。

### P3-E7：Host 通信验证

> [x] 完成——NUL framing（冒烟全程）；pipe 断连=干净退出 + browser-shutdown 结算（11812 事件保留，非中止）；未引入 HTTP 调试端口/宽 origins（驱动环境断言延续）

- pipe FD 3/4、NUL framing 实测（framing 边界、断连检测、请求取消）；明确不启用 CBOR 模式。
- 不引入 HTTP 调试端口与 `--remote-allow-origins=*`（反向断言沿用 P1 E4 模式）。
- 测试驱动与 launcher 的 domain 路径适配（launcher 可继续走启动期配置；domain 路径作为新能力单列，不替代既有链路）。

### P3-E8：证据包与终审提交

> [x] 完成——0001/0003/0004 再生 + 0005 新增；干净 HEAD 顺序复现 == 工作树（ca047253）；V8 0002 未动；摘要入 identity.json p3E8Supplement；回归 338/28/211 + 单测 5/5+4/4

沿用 P2 证据纪律与 §7.5 清单：补丁回写（改动集中 0001；v3 字段若涉 0003/0004 同步）+ 干净索引顺序复验 + 逐文件一致性核对（P2 终审方法：补丁清单逐文件 blob 比对）；回归 338/28/211 + 新增测试数；`integration-progress.json` 新增 P3 段（初始 `p3-in-progress`，终审前不得 accepted）；文档状态同步（草稿 §2.3/§12、本文件勾选）。

### P3-E9：应用命名 ChromiumX（用户指示，2026-09-20 登记）

> [x] 完成——ChromiumX.app（bundle 目录 + CFBundleDisplayName）；可执行仍为 Contents/MacOS/Chromium；product/UA/bundle-id 逐项实测不变；与本机 Chromium 共存（两 app 并存 out 目录）；全链路（冒烟/故障/矩阵/launcher/pipe）在 ChromiumX 上通过

本机已安装 Chromium，为避免共存混淆，产物应用命名为 **ChromiumX**——仅应用命名层面改名；对访问的目标网站而言与 Chromium 完全一致。

- 改动面：`.app` bundle 目录名与 `CFBundleDisplayName` 改为 `ChromiumX`。
- **不变面（硬约束）**：可执行文件名（`Contents/MacOS/Chromium`，launcher/驱动现有路径解析不变）、`CFBundleIdentifier`、`Browser.getVersion` 的 product（`Chrome/151.0.7917.0`）、`navigator.userAgent` / UA-CH brands / WebGL 渲染串等全部站点可见身份。
- 实现方式（已裁定）：走 branding/构建层的名称来源（GN 或 plist 生成处），以**新补丁 0005** 承载——命名是独立关注点，不并入 0001 的采集职责；`scripts/apply_patches.sh` 的 Chromium 序列登记为 `0001 → 0003 → 0004 → 0005`（V8 的 0002 位置不变）；补丁变更后重跑干净索引顺序复验。不用"构建后手工改名目录"的临时做法（会被后续构建覆盖）。
- 验收：改名后的 `ChromiumX.app` 上 `getVersion.product` 不变；12 组矩阵与 launcher 路径通过；与本机已装 Chromium 共存无干扰；UA 等站点可见字段与改名前逐项一致（对照证据）。

## 5. 决策点状态（v1.1：全部已裁决）

| 决策点 | 状态 |
| --- | --- |
| 1. CDP 域 PDL | **已裁决（两处修订）**：[chromium-p3-design.md](chromium-p3-design.md) §9——五命令草案接受；`ProducerStatus` 未知计数用 `optional`（对齐 manifest null 规则）；任何 capture 的初始 generation 恒为 `"0"` |
| 2. generation 通道 | **已裁决**：复用带内 `XTraceControl` 加 `UpdateConfig`；确认以事件的 `config_generation` 字段为证，不加 ACK 消息；`pendingProducers` 语义写明"静默≠故障" |
| 3. 身份映射承载 | **已裁决**：browser 侧注入 `document_id`；crosswalk 只落 `manifest.identity` 段，事件行保持轻量 |
| 4. 脚手架 | **已裁决**：`stop-after` 移除；`--xtrace-test-buffer-capacity` 改名保留（标记延续、launcher 不透传）；登记表随 P3-E6 回填 |
| 5. Host 连接 | **已裁决**：NUL framing 定稿；断连不中止 capture；无跨请求取消，内部 deadline 返回 stopping |
| 6. 应用命名（用户指示） | **已裁定**：`ChromiumX.app` + `CFBundleDisplayName`，站点可见面不变；新补丁 0005 承载，应用序列 `0001 → 0003 → 0004 → 0005`（0002 位置不变），见 §4 P3-E9 |

## 6. 纪律与纠偏事项（沿用 P1/P2，新增第 9 条）

1–8 条沿用 [P2 交接](chromium-p2-capture-foundation-handoff.md) §6（补丁分层回写 + 干净索引复验、不改测试预期掩盖、沙箱不动、性能口径、文档证据一致、旧病不移植、计数等式为终态唯一判据、构建效率）。

9. **受信边界是硬条款**：XTrace 域只接受受信会话；UI/扩展/普通 CDP 客户端的任何"方便打通"请求都必须先回架构师——不沿用 P1 时代 `--remote-allow-origins=*` 的任何残留路径。

## 7. 长程执行模式（沿用 P2 v1.1 §7）

入口条件：P3-E0 清零 + P3-E1 设计文档经架构师裁决（**均已于 2026-09-20 满足**）。此后 **P3-E2 → P3-E9 为一个连续执行块**，中间不设例行审查点；完成后一次提交，架构师终审（R2+R3 合并）。

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

---

## 10. 架构师终审记录（2026-09-20）

**结论：实质通过，附条件冻结。** 一项阻塞修复 + 三项小项完成后，P3 标为完成。

### 10.1 独立核验通过项

- **补丁重放**：干净索引顺序应用 0001→0003→0004→0005 复现 `ca047253`，与申报一致；`apply_patches.sh` 序列登记正确（0005 在 0004 后、0002 位置不变）。
- **ChromiumX 命名**：`CFBundleDisplayName=ChromiumX`、`CFBundleExecutable=Chromium`、`CFBundleIdentifier=org.chromium.Chromium` 未变；`--version` 输出 `Chromium 151.0.7917.0`；0005 补丁内容逐行核对（`mac_app_bundle` 可选 `bundle_name` 向后兼容）。
- **CDP 域端到端**：`startCapture` generation "0" → `updateCapture` "1" → `stopCapture` → complete（`p3-domain-smoke-tqMD5v`）；非受信会话拒绝实测（`pageSessionRejected: true`）；ProducerStatus 未知计数用 optional 的裁决已落地。
- **身份映射**：`manifest.identity` 段存在（frame_tree_node_id → document_token，含 chrome:// 内部页的诚实记录）。
- **脚手架**：`--xtrace-stop-after-ms` 已从 C++ 移除（仅余注释）；`--xtrace-test-buffer-capacity` 改名在位。
- **最终矩阵** `browser-run-Mj6NFk` 12/12（在 ChromiumX 上运行）；故障注入修复后场景全过。
- **回归**：架构师以 `scripts/run_tests.sh` 亲测 338/28/211 全绿（注意：直接 `python3` 在本机会落到 3.9 导致两个模块导入失败——验收一律走 run_tests.sh 的解释器选择）；单测 5/5 + 4/4 在最终二进制上亲测通过。
- **p3E8Supplement 摘要**与磁盘实测一致。
- **pipe 语义**（架构师亲跑 `p3-pipe-reconnect.cjs`）：pipe 断开 → 浏览器干净退出（exit 0）→ 以 `incomplete/browser-shutdown` 诚实结算、已入队数据全保留。**注意**：pipe 断开即关闭浏览器（pipe 即宿主所有权），设计文档 §6 的"断连不中止 capture"应理解为此路径；可重连控制面需另议（P6 输入）。

### 10.2 阻塞项（冻结前必须完成）

1. **补丁陈旧：`content/browser/xtrace/xtrace_capture_controller_unittest.cc`**。逐文件 blob 比对发现：工作树为 `BrowserTaskEnvironment + RunUntilIdle` 版（P3-E5 使 settle 变异步后所必需），补丁 0001 内仍是旧的 `base::test::TaskEnvironment` 版——干净基线重放该补丁后，controller 单测在异步 settle 下会失败。E8 回写发生在该测试修复之前。处理：重新生成 0001 → 重跑干净索引重放 + 逐文件比对（方法见 P2 终审记录口径）→ 更新 `p3E8Supplement` 摘要。这正是逐文件核对要拦的事，不要只重跑树哈希。

### 10.3 小项（不阻塞冻结，一并记录）

1. "stop-after 全树无引用"表述不准：`scripts/p2-fault-injection.cjs`、`scripts/p3-domain-smoke.cjs` 仍传该（已失效的）开关——C++ 忽略未知开关所以无害，但应清理残留或把登记表措辞改为"C++ 内无引用"。
2. manifest 的 `build` 块在 P3 产物中变为 `null`（P2 产物有 product/is_debug/component_build）——恢复或说明。
3. `scripts/p3-pipe-reconnect.cjs` 末行引用未定义变量 `after`，永不打印结果行（证据落盘不受影响）；顺手修。
4. `out/XTraceIntegration/` 下旧 `Chromium.app` 残留（0005 前构建遗物）；各驱动已指向 ChromiumX.app，无碍，但建议删除或注明，避免误用。

### 10.5 执行层阻塞与小项闭环记录（2026-09-20）

- **阻塞 1（10.2）已修**：0001 再生为含 `BrowserTaskEnvironment + RunUntilIdle` 单测的版本；干净 HEAD 顺序重放 == 工作树（tree `47e50d8b…`），且**逐文件 blob 比对**（全部 117 个补丁文件 vs 工作树）0 不符；`p3E8Supplement` 摘要与磁盘一致。
- 小项 1：4 个驱动脚本（tracked 与 out 副本）的惰性 `--xtrace-stop-after-ms` 参数已清理——C++ 内与本仓库脚本现均无引用。
- 小项 2：manifest `build` 块已恢复（`product` 取 version_info、`is_debug`/`component_build` 编译期判定；冒烟实测 `151.0.7917.0/true/true`）。
- 小项 3：`p3-pipe-reconnect.cjs` 悬空 `after` 已改为 `fs.statSync(trace).size`。
- 小项 4：旧 `out/XTraceIntegration/Chromium.app` 已删除（out 目录现存 app 仅 ChromiumX 及 Helpers）。

冻结后由架构师将 `integration-progress.json` 标为 `accepted-p3` 并更新草稿 §12 P3 行。下一阶段 P4 交接见 [chromium-p4-ignition-observer-handoff.md](chromium-p4-ignition-observer-handoff.md)（入口条件 = P3 冻结）。
