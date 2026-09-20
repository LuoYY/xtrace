# P2 执行状态（长程块检查点；非验收文档）

- 检查点时间：2026-09-20 凌晨（第二次检查点；当晚已达成主要里程碑，见下）。
- 性质：执行层进度痕迹（P2 交接 §7.3 允许）。**P2 尚未完成，无任何验收声明**；本文件记录已落代码、当前编译错误面与精确续接点，供续接会话零上下文恢复。
- 依据：[P2 交接](chromium-p2-capture-foundation-handoff.md) v1.1 长程块；[trace-schema-v3.md](trace-schema-v3.md) v1.1 冻结版；[R1 决策](chromium-p2-r1-decisions.md)（DP2–5 已裁决带条件）。

## 1. 已完成的代码工作（全部在 Chromium 工作树，未回写补丁——E8 统一做）

### 新文件（6）
| 文件 | 内容 | 状态 |
| --- | --- | --- |
| `third_party/blink/public/mojom/xtrace/xtrace.mojom` | 重写：Batch/Asset/Watermark 结构 + `XTraceHost{LogBatch,LogAsset,SubmitWatermark}` + `XTraceControl{StopCapture=>bool}`（描述符随批携带；逐条 Log 已删） | 写毕，编译进行中 |
| `third_party/blink/renderer/platform/xtrace/xtrace_producer.h/.cc` | 每线程有界 producer（drop-newest、条数/时间双触发 flush、eligible/enqueued/dropped/assets_out 计数、Settle=flush+watermark、线程析构即结算）+ 进程级 Hub（stopping 原子位、lseq、registry+task runner 停止分发，V09 注释在位）+ `--xtrace-test-capacity`（XTRACE_TEST_SCAFFOLDING 标记） | 写毕 |
| `third_party/blink/renderer/platform/xtrace/xtrace_control_impl.h/.cc` | `XTraceControl` renderer 侧实现（StopCapture→Hub::BeginStop→reply accepted=true"仅分发"语义；断连自毁） | 写毕 |
| `third_party/blink/public/platform/xtrace_control.h` | content 注册门面（`BindXTraceControlReceiverOnMainThread`，BLINK_PLATFORM_EXPORT） | 写毕 |
| `content/browser/xtrace/xtrace_capture_controller.h/.cc` | browser 单一 writer+协调器：writer runner=**BLOCK_SHUTDOWN**（DP5）；capture_id/writer_seq 盖章；producer 注册表与双侧计数；计数等式终态裁决（唯一判据）；manifest 产出；停止编排（UI 分发 RPH/帧接口 + writer runner 截止定时器 + 超时列未确认）；`--xtrace-stop-after-ms`（测试脚手架）；bnet 进程内 producer；关停路径仅结算已入队数据（无跨进程等待） | 写毕，编译修错中 |

### 修改文件
| 文件 | 变更 |
| --- | --- |
| `xtrace_logger.cc` | **v3 发射重写完成**：envelope 换 v3（attribution resolved/unresolved、causality 常驻对象、删除 event_id/session/seq/t/ts/result/error/truncated/帧空串字段）；V06 收口（事件侧 asset_refs 四元组、资产行无 source、summary=metadata-only、first_seq 取自 AcceptEvent 返回的序号）；LogEventWithSequence→EmitEvent；NextSequenceNumber 删除；调用方全部改写 |
| `chrome_content_browser_client.cc` | **browser-network 并轨完成（代码层）**：删 `g_xtrace_browser_network_sequence`、删 AppendToFile 私有写入与 runner 转接、事件改走 controller bnet producer；三个事件构造器换 v3（Unix epoch 微秒字符串、attribution unresolved、causality external、truncation 单形态=args 内 value_truncations 四元组、complete 事件的错误材料移入 args）；`xtrace-test-capacity` 已加 renderer 转发列表 |
| `render_process_host_impl_receiver_bindings.cc` | XTraceHost 注册改绑 controller（writer runner 上绑定） |
| `render_thread_impl.cc` | 主线程关联接口注册 `XTraceControl`（门面） |
| `content/browser/BUILD.gn` / `platform/BUILD.gn` | 源清单更新（host_impl 删除→controller；producer/control_impl 加入） |
| 删除 `content/browser/xtrace/xtrace_host_impl.{h,cc}` | 职责并入 controller |

## 2. 当前编译状态（第 3 轮后未再跑）

第 3 轮剩余错误全部集中在 **controller 的 RPH 关联接口获取**（新 API 发现，非设计问题）：

- `RenderProcessHost::GetID()` 返回 `ChildProcessId`（base::IdType 包装）——`std::set<int>/map<int,...>` 键类型错。修：键用 `ChildProcessId`（含 `GetUnderlyingType()`，include `content/public/common/child_process_id.h`）或其底层 int32。
- 公共 `RenderProcessHost` 无 `GetRemoteInterfaces()`；本版本（ASG 时代）进程级 renderer 关联接口经**帧级** `RenderFrameHost::GetRemoteInterfaces()`（public，`service_manager::InterfaceProvider*`，见 `render_frame_host.h:650`）到达——RenderThreadImpl 的进程关联注册表路由在其中（实例：`render_frame_host_impl.cc:13586`）。**DistributeStopOnUI 的正确写法**：遍历进程→每进程取任一活帧（可经 RPH 的 ASG/frame 树；最简：`RenderFrameHost::AllFrames()` 等价物，实现层用 RPHI/ASGH API）→ `frame->GetRemoteInterfaces()->GetInterface(remote.BindNewEndpointAndPassReceiver())`。每进程绑一条即可（XTraceControl 是进程级）。**这正是 DP2 裁决条件①要求的绑定路径实证内容**——落地后以单测+E7 真浏览器证据回报。
- 其余已知小修：`base::Value::Dict` 报错的 include（chrome client 的 `base/values.h`）；`mojo::Receiver` raw-ptr 断言定位（可能来自 controller 里 `MakeSelfOwnedReceiver` 前 lambda 捕获方式）；`WTF::IsMainThread` 需 `platform/wtf/threading.h` 确认实际行文（producer.cc:190 附近，可能为级联）。
- 每轮编译命令：`env -u GOROOT -u GOTOOLDIR DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer third_party/ninja/ninja -C out/XTraceIntegration -j 10 chrome`（错误用 `grep -E "^FAILED|error:" | sort -u` 收集）。

## 3. 续接路线（严格顺序）

1. **修完编译**（上节错误面，预计 1–2 轮）。遵守：不改测试预期掩盖故障；补丁不动（E8 统一回写）。
2. **E2 收尾**：`XTraceControlImplTest`（platform 单测：绑定→StopCapture→accepted=true + Hub stopping + 同线程 settle；绑定为 main-thread 语义）+ 回报绑定路径证据（DP2①）。
3. **E3 收尾**：controller 的 content_unittests（等式裁决：complete/incomplete/失联/超时四态；构造 ProducerState 直接驱动 Finalize）。RPH 观察者注册移到首个帧/进程出现点（`ObserveRenderProcessHost` 已有方法，需在 UI 侧接线——可放 `DistributeStopOnUI` 首次调用时 + chrome client `RenderProcessStarted` 覆写点）。
4. **E4**：worker descriptor 注入（三个 WorkerGlobalScope 子类 ctor 各一行 `xtrace::XTraceThreadProducer::SetCurrentThreadWorkerDescriptor(kind, Url())`）；`content_browsertests` 覆盖溢出计数/watermark/Worker 销毁结算。
5. **E5**：对照 §6.6 十条逐条出修复前后证据（logger 侧已做 V06/result-error/attribution；限额四元组 browser-network 侧已做；剩余核对 renderer 值截断点与"测试断言旧行为"同步改——`tests/test_build_scripts.py` 中 `'"schema_version\\":2"'`、`AppendCausalityFields` 等断言将随实现更新，附对照证据，DP2②）。
6. **E6**：validator `--schema-version 3`（规范 §12 九条断言，含 manifest 等式与 overflow_policy 缺口规则——DP3 裁决补充）；`scripts/` 导入适配器 v1/v2→v3（规范 §10 映射）；analyzer/GUI v3 可读；v3 golden；338/28/211 全绿。
7. **E7**：驱动脚本 v3 化（browser-integration.cjs 校验段换 schema 3 + manifest 检查）；七场景 + 基线对比（P1 数据在 `integration-progress.json` baseline_metrics）。
8. **E8**：补丁回写（写入路径→0001；控制面/停止协议新文件→0001；v3 causality 表示若触及 0003/0004 hunk 同步修订）；干净索引复验（模板 P1 review §7.1）+ **分层复现校验**（目标：0001'→0003'→0004' 干净基线应用后树 == 当前工作树）；证据包（沿用 postFixSupplement 口径）；文档/进度同步（`integration-progress.json` 增 P2 段，状态 `p2-in-progress`，终审前不得 accepted——已按 §7.5 预置）。
9. 回报格式：P1 交接 §7 七行结构；升级触发器见 P2 交接 §7.4（命中即停）。

## 4. 已确认的设计事实（防续接时重推导）

- mojom 双变体：renderer 侧**统一用公共变体**（`xtrace.mojom.h`，`blink::mojom::`，string=std::string）——-blink 变体的 WTF::String 字段与消息构造代码不匹配；两变体可在不同 TU 共存；broker `GetInterface` 按 `Name_` 路由，变体无关。
- blink 分层：content→platform 禁止直接 include，经 `blink/public/platform` 门面（已建）；core→platform 合法（worker descriptor 注入走 core）。
- 线程序保证：producer 的 settle 任务只经其自身 task runner 投递（或同序列内联），与析构天然串行；registry `alive` 位是跨线程护栏。
- `AcceptEvent` 返回 `optional<uint64_t>`：stopping/malformed→nullopt（不计数）；溢出→返回已消费序号（资产行 first_seq 可指向尾部缺口序号，罕见且无害，已记录）。
- 关停判定：全 renderer 管道消失 + `GetContentClient()->browser()->IsShuttingDown()`（chrome 已重写）→ finalize("browser-shutdown")；仅 renderer 丢失不提前 finalize（等正常 stop/超时，未确认列于 manifest）。
- 资产行/事件的 capture_id、writer_seq 均由 browser writer 盖章（renderer 无需知 capture_id）；资产行另补 producer_id 盖章（OnLogAsset 的 StampWriterFields 已含 writer_seq/capture_id，producer_id 在行内由 renderer 构造时缺失——**注意：v3 资产行规范要求 producer_id，OnLogAsset 需从 asset->producer 补插该字段**——续接时补）。

## 5. 风险与未验证边界（如实）

- 未编译通过前，一切"已写毕"仅为代码完成度声明，非功能声明。
- manifest 的 batching 参数目前硬编码（200/50/4096/drop-newest）与 renderer 默认一致——若改默认值需两侧同步（自描述原则：以 manifest 声明为准）。
- bnet producer 的 watermark 在 BeginStopOnWriter 内联合成（in-process 无管道）；其 `final_producer_seq=accepted` 与盖章序号一致（每事件 ++accepted）。
- `XTraceHostImpl` 删除后 `StampGlobalSequenceForWrite`/`global_seq` 随之消失（v3 用 writer_seq）——v1/v2 旧行为只存在于历史 trace 与补丁基线，消费端经适配器读。


## 6. 第二检查点进展（2026-09-20 凌晨）

### 已达成（全部有原始证据）
- **编译全绿**：控制面改**带内端点**（`XTraceHost.ProvideControlEndpoint`，renderer 首个 producer 管道传递一次；断连=renderer 死亡信号）——彻底绕开 ASG 时代帧路由，DP2① 的"绑定路径"答案随之改变（原 associated-registry 方案已撤销，render_thread 注册已回退）。
- **v3 端到端冒烟 PASS**：`validation/p2-v3-smoke.cjs`（stop-after 脚手架驱动正常停止；6643 事件、三组计数等式全立、complete 终态、资产行无 source、writer_seq 严格递增）。
- **E7 故障注入五场景全过**：`validation/p2-fault-injection.cjs` —— 正常 stop=complete（冒烟）、溢出=sticky drop-newest（11873 dropped、前缀连续、无中部缺口）、renderer 崩溃=stop-timeout+unconfirmed 列表（11906 事件保留）、磁盘失败=只读 trace 文件+disk-write-failure、**browser 关停 mid-capture=incomplete/browser-shutdown**（结算钉在 `AllowBrowserToClose()` 同线程同步执行；退出路径用裸 POSIX IO sink——base::File 跨线程触发线程限制断言是本链路最深的一个坑）。
- **12 组矩阵 v3 全过 12/12**：`browser-run-YsuPUw`（事件量 7210-7658/组，与 P1 基线 7001-7658 持平；驱动已 v3 化：schema 3 校验、资产断言翻转为无 source、terminal 断言）。
- **回归全绿**：338/28/211（tests/test_build_scripts.py 中 7 个断言 v1/v2 旧形态的测试已按 DP2② 改写为 v3 契约——含 writer_seq/controller 断言替换 global_seq/host_impl、V06 翻转、mojom 新形状）。
- **修复清单（当晚）**：MakeDescriptor null 解引用、空 producer 伪 complete（no-producers-observed 守卫）、stop-after 与 deadline 混淆、manifest 文件名、E4 worker URL CHECK（SafeScopeDescriptionForXTrace）、锁重构引入的两处死锁（EDEADLK：锁内调 Finalize / MaybeFinalize 双锁）、OnStopDeadline 结构重写、timer SetTaskRunner 序列断言。
- **launcher 冒烟部分通过**：exit 0、trace+manifest 产出、terminal=incomplete/browser-shutdown——但见下。

### 续接首项（已知未解）
- **launcher 链路 v3 异常**（`p2-launcher-smoke-bXd4ZH`）：仅 1 条 network 事件、**renderer 零事件**、stop-after 未在 15s 内结算（browser-shutdown 抢先）。矩阵直启路径 renderer 正常（数千事件/组），差异仅在 launcher 传参方式（switch+env 并存 vs 矩阵纯 switch）。排查方向：① renderer 在 env+switch 并存时的配置读取路径；② bnet 事件为何仅 1 条（其余被 finalized 门闩丢弃？时间线）；③ stop-after 计时起点（Get() 首调时点）在 launcher 路径是否过晚。修复后跑 `validate_trace.py --schema-version 3 --expect JSON.parse --expect JSON.stringify`。
- E8 补丁回写（分层：写入路径/控制面/controller→0001；causality v3 对象若触及 0003 hunks 同步）+ 干净索引复现校验 + `postFixSupplement` 口径摘要。
- E2/E3 的 C++ 单测未写：以真浏览器证据（冒烟+故障注入+矩阵）+ 仓库静态契约断言（test_build_scripts.py v3 化）替代，**作为偏差如实提交架构师终审裁决**（DP2① 原文要求"以单测实证"，现证据形态更强但不同）。
- 基线对比表（P1 baseline_metrics vs browser-run-YsuPUw）入 integration-progress.json。
- 临时诊断残留检查：`/tmp/p2-s4.cjs`（外部，无碍）；源码内所有 XTRACE-P2 探针已撤（grep 验证过 0）。

### 当晚新增/修改的仓库内文件（E8 回写时的完整清单基础）
Chromium 树新增：xtrace_producer.{h,cc}、xtrace_control_impl.{h,cc}、public/platform/xtrace_control.h、xtrace_capture_controller.{h,cc}；删除 xtrace_host_impl.{h,cc}。
修改：xtrace.mojom（重写）、xtrace_logger.cc（v3 发射）、chrome_content_browser_client.cc（并轨+三构造器 v3+test-capacity 转发+AllowBrowserToClose 钩子）、application_lifetime_desktop.cc（OnClosingAllBrowsers 钩子）、chrome_devtools_manager_delegate.cc（AllowBrowserToClose 结算）、receiver_bindings、content/browser/BUILD.gn、platform/BUILD.gn、三个 WorkerGlobalScope（SafeScopeDescriptionForXTrace+注入）、worker_global_scope.h、validate_trace.py（v3 全项断言）、browser-integration.cjs（v3）、tests/test_build_scripts.py（7 测试 v3 化）、p2-v3-smoke.cjs、p2-fault-injection.cjs（新增）。
