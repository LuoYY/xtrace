# P3 设计文档：browser-only XTrace CDP 域 / 配置 generation / 身份映射

- 版本：v1.0（P3-E1 产出，R1 审查对象）。依据：[P3 交接](chromium-p3-control-plane-handoff.md)、[迁移草稿](chromium-migration-enhancement-draft.md) §8/§13.1、[trace-schema-v3.md](trace-schema-v3.md) v1.2、[R1 决策](chromium-p2-r1-decisions.md)（DP4 脚手架移除约定）。
- P3-E0（A.2 单测欠账）**已清零**：controller 5 例（`content_unittests`）+ producer 4 例（`blink_platform_unittests`）全绿，测试缝为 host 工厂替换/hub 复位/容量覆盖/解析导出。

## 1. CDP 域 PDL 草案（决策点 1）

新文件 `content/browser/devtools/protocol/xtrace.pdl`，注册进 `protocol_config.json` 与 `BUILD.gn`（真实入口，见 P3 交接 §4 E2）。

```pdle
experimental domain XTrace
  # browser-only: the domain is registered on the browser target only.
  # Sessions without browser-level trust are rejected (see §2).

  type CaptureState extends string
    # idle | starting | active | stopping | complete | incomplete | failed

  type TerminalInfo extends object
    properties:
      state: CaptureState
      reason: string optional   # null on complete
      unconfirmedProducers: array of string

  type ProducerStatus extends object
    properties:
      producerId: string
      kind: string              # main-thread | dedicated-worker | ... | browser-network
      finalProducerSeq: string  # decimal string; "" when unknown (unconfirmed)
      eligible: string          # decimal string; "" when unknown
      enqueued: string
      dropped: string
      accepted: string
      written: string
      failed: string
      confirmed: boolean

  type Capabilities extends object
    properties:
      schemaVersion: integer          # 3
      modes: array of string          # reverse, fingerprint, network(script)
      launchTimeConfig: array of string  # xtrace-* switch names applicable at launch
      runtimeConfig: array of string  # categories/capture-values/capture-assets/causality (update subset P4+)
      limits: object                  # buffer capacity, batch size, overflow policy
      trustedOnly: boolean            # always true (declared)

  command getCapabilities()
    returns: capabilities: Capabilities

  command startCapture(
      categories: string,
      captureValues: string optional,   # default full
      captureAssets: string optional,   # default full
      causality: string optional)       # off | sync
    returns:
      captureId: string
      generation: string                # decimal; "1" for the first runtime capture
      state: CaptureState               # starting → active on producer confirmation

  command updateCapture(categories: string)
    returns:
      generation: string                # newly allocated serial generation
      appliedProducers: array of string # producers confirmed on the new generation
      pendingProducers: array of string # registered but unconfirmed

  command getCaptureStatus()
    returns:
      captureId: string
      generation: string
      state: CaptureState
      config: object
      producers: array of ProducerStatus
      terminal: TerminalInfo optional   # present once settled

  command stopCapture()
    returns:
      state: CaptureState               # stopping | terminal state
      manifestStream: string optional   # IO stream handle once artifacts ready
```

- **错误语义**：`startCapture` 已有活动采集 → `invalidState`；参数非法（未知类别/模式）→ `invalidParams`；非受信会话 → `invalidRequest`（域整体拒绝，见 §2）。`updateCapture` 在 stopping/终态 → `invalidState`。`stopCapture` 幂等：重复调用返回当前状态。
- **IO stream**：`stopCapture` 返回 manifest 的 stream handle（`tracing_handler.cc:911` 模式）；调用方用 `IO.read`/`IO.close` 读取。生命周期：handle 在终态后创建一次，客户端 `IO.close` 或会话断开即失效。**不创建事件流**（首期不逐条广播）。
- **版本化**：`Capabilities.schemaVersion` 为机器可读锚点；后续演进只加字段不改语义，破坏性变更提 P 交接审查。

## 2. 受信强制（P3-E2）

- 注册路径：`browser_devtools_agent_host.cc:226` 起的 browser-only session。XTrace 域 handler 在 `CanAttach`/session 建立时核验：仅 `DevToolsAgentHostClient::IsTrusted()`（或等价 browser-target 会话属性）为真的会话可调用；否则每个方法返回 `invalidRequest` 并记录一次告警日志（不崩溃、不静默成功）。
- 实测：正向（pipe 直连 browser target，host 可调用）+ 反向（以扩展 `chrome.debugger` 会话模拟非受信，方法被拒）——反向用 browsertest 覆盖。

## 3. generation 传播（决策点 2）

**通道**：复用带内 `XTraceControl`，新增 `UpdateConfig(generation, config, deadline_ms) => (accepted)`——与 `StopCapture` 同管道、同分发语义（经 Hub 到各线程 producer）。不新增独立接口：端点已按进程注册、生命周期已验证，扩消息比为每进程再开一条控制通道更少状态。

- **分配**：browser `CaptureCoordinator` 串行分配（uint64，十进制字符串）；启动采集为 generation "0"（P2 语义），首个运行期 update 为 "1"。
- **renderer 初始快照**：沿用启动期配置链路（launcher/switch 路径不变）；带内 `UpdateConfig` 只覆盖**已存在**的 producer 线程。新 worker 线程 producer 建立时从 Hub 读取"当前生效配置"（Hub 缓存最新 generation 快照），保证后加入者继承最新版。
- **确认规则**：每 producer 在 watermark 之外新增轻量 `ConfigApplied(generation)` 消息？——**不加**：确认语义复用事件本身。事件的 `config_generation` 字段即"应用证据"；`getCaptureStatus.pendingProducers` = 已登记但尚无该 generation 事件的 producer。不伪造 applied ACK（草稿 §8.3）。
- **stopping 拒绝**：stopping 状态下 `updateCapture` 返回 `invalidState`。
- **混合代合法**：更新进行中旧/新 generation 同现于 trace 属正常，validator v3 已按字段校验不强求一致。

## 4. 身份映射（决策点 3）

- **`attribution.document` 开填**：browser 侧在 frame 导航提交（`RenderFrameHostImpl::DidNavigate` 路径）维护 `frame_tree_node_id → document_id`（`DocumentToken` 字符串化）；writer 在写事件行时按事件的 frame 归属把 `document_id` 注入 `attribution.document`。renderer hook 点不可得时保持 unresolved（v3 §3.3 不破坏）。P3 范围：主 frame + 同进程子 frame；跨进程 OOPIF 归属经 frame_tree_node_id 可对应，document token 由 browser 掌握——统一在 browser 注入。
- **crosswalk 落盘形式**：manifest 增设 `identity` 段（决策点推荐）：`{frameUrl→documentId, devtoolsRequestId→networkRequestId, workerScope→producerId}` 的带来源映射表，允许 `unresolved` 项；不内嵌到事件行（避免热路径膨胀）。事件行内的 `attribution` 保持轻量；深度关联由分析器查 manifest。
- **网���映射**：优先 `devtools_request_id`（DevTools Network 域已启用时 browser 侧可取）；未启用时建立 crosswalk 记录底层 `GlobalRequestID` + 来源标记 `source: url_loader_throttle`；redirect hop 记录于 crosswalk（`redirect_from` 链）。禁止 method+URL 哈希合并（草稿 §8.4）。
- **分场景验证**：导航、普通 resource、Worker/SW、redirect、未启用 Network 域——browsertest 矩阵逐一断言。

## 5. 脚手架移除（决策点 4）

- `--xtrace-stop-after-ms`：**移除**（正式 `XTrace.stopCapture` 接管）。P2 驱动脚本改用 domain 路径触发停止。
- `--xtrace-test-capacity`：**保留为长期 test-only 设施**——它只改缓冲参数、走真实丢弃计数路径，是 P3-E0 已用的确定性溢出手段（producer 单测依赖）。处置：改名 `--xtrace-test-buffer-capacity` 并继续 `XTRACE_TEST_SCAFFOLDING` 标记；不出现在 launcher 透传；长期留任的理由（故障注入确定性）登记于本文件。
- 移除登记表（P3-E6 回填 grep 计数与 diff 摘要）。

## 6. Host 连接语义（决策点 5）

- **Framing 定稿**：NUL 分隔（`\0`）JSON 消息，FD 3/4。不用 CBOR。断连=会话终止（capture 不受影响——capture 状态属于 browser 不属于连接）。
- **重连**：新连接 `getCaptureStatus` 即得当前状态；进行中的 capture 不因断连中止（stop 只由显式命令或 browser 退出驱动）。
- **请求取消**：CDP 每请求独立 id，无跨请求取消语��；长操作（stopCapture 结算等待）上限为内部 deadline（P2 的 2s），超时返回 stopping 状态而非挂起。
- **P6 预留（只定约束不实现）**：Host（Node）以 `--remote-debugging-pipe` 持有 browser target；域方法名/参数将直接映射为工具面；`getCapabilities` 输出将作为能力协商的权威来源。

## 7. P3 测试矩阵新增行

| 用例 | 断言 |
| --- | --- |
| domain-launch-config | 启动期配置经 domain 可见（getCaptureStatus 呈现 switch 快照） |
| domain-runtime-update | updateCapture 后新事件携带新 generation；pending 集合随确认收敛 |
| domain-update-worker | 更新中创建 Worker：新线程首事件已是最新 generation |
| domain-stop-during-update | stopping 中 update → invalidState |
| domain-untrusted-reject | 非受信会话所有方法 → invalidRequest（正向对照 pipe 会话成功） |
| domain-io-stream | stopCapture 返回 handle；IO.read 读到 manifest 字节；IO.close 后再 read 报错 |
| identity-document | 导航后事件 attribution.document 非空且与 document token 一致 |
| identity-crosswalk | Network 域关/开两种形态下 crosswalk 正确、无哈希合并 |
| pipe-reconnect | 断连重连后状态可查、capture 未中止 |
| scaffolding-removed | stop-after 全树无引用；capacity 改名后 producer 单测仍绿 |

## 8. 决策点建议汇总（供架构师逐项回填）

| # | 推荐 | 备选 |
| --- | --- | --- |
| 1 PDL | §1 草案（五命令、TerminalInfo/ProducerStatus 类型、IO stream 仅 manifest） | 事件流通知（后置 P4+） |
| 2 generation 通道 | 复用 XTraceControl 加 UpdateConfig；确认以事件 generation 字段为证，不加 ACK 消息 | 独立接口（多余状态）/显式 ACK（伪确认风险） |
| 3 身份承载 | browser 注入 document_id；crosswalk 落 manifest.identity 段 | 事件内嵌（热路径膨胀） |
| 4 脚手架 | stop-after 移除；test-capacity 改名保留 | 全移除（损失确定性溢出手段） |
| 5 Host 语义 | NUL framing 定稿；断连不中止 capture；P6 约束如 §6 | CBOR（无必要） |
