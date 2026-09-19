# P2 实施决策提案（R1 审查对象，决策点 2–5）

- 版本：v1.1（2026-09-19，执行层提案 v1.0；v1.1 由架构师回填四项裁决——全部接受，附条件见各节"裁决"栏）。
- 对象：[P2 交接文档](chromium-p2-capture-foundation-handoff.md) §5 决策点 2–5。每项给出推荐方案、备选、理由与影响面；架构师裁决后回填"裁决"栏，作为 P2-E2 起的实施依据。
- 配套规范：[trace-schema-v3.md](trace-schema-v3.md)（决策点 1 的产出）。

## DP2：控制与登记通道形状（mojom）

**推荐：数据面扩展 `XTraceHost`（batch-only + watermark），控制面新增独立 `XTraceControl` 接口。**

```
// 数据面（每线程一条管道，现状 thread_local remote 保留）
interface XTraceHost {
  LogBatch(BatchMessage batch);          // 唯一数据路径；逐条 Log 删除
  LogAsset(AssetMessage asset);          // 资产行走同管道、计入同 producer
  SubmitWatermark(WatermarkMessage wm);  // 停止结算凭据，同管道保序
};

struct BatchMessage {
  ProducerDescriptor producer;   // {producer_id, process_epoch, worker?}，每批携带
  string first_producer_seq;     // 十进制字符串；writer 校验 first+count 与行数一致
  uint32 count;
  array<string> event_json_lines;
};

struct WatermarkMessage {
  ProducerDescriptor producer;
  string final_producer_seq;
  string eligible, enqueued, dropped;   // producer 三元组
  uint32 assets_out;
  string config_generation;
};

// 控制面（每 renderer 进程一条，main thread 绑定）
interface XTraceControl {
  StopCapture(string capture_id, uint32 deadline_ms) → (bool accepted);
};
```

理由与影响：

- watermark 必须走**原日志通道**（草稿 §7.3 第 3 步）：mojo 管道消息保序，`SubmitWatermark` 放在 `XTraceHost` 上使"watermark 之后无该 producer 新事件"成为管道语义可直接断言的事实；放控制面则失去该保证。
- 停止是进程级动作、数据是线程级管道，合成一个接口会迫使每线程都收停止消息或跨线程转发——违背"不跨线程共用 mojo::Remote"（草稿 §8.3）。`XTraceControl` 每进程一条，由 renderer 侧控制代理经 `WorkerThreadRegistry` 转发；**转发投递数不作为确认数**（V09），确认只认各自管道的 watermark。
- 注册零往返：描述符随首批携带（规范 §4.3），无独立 Register 消息；browser 按管道登记进程归属。
- `Log`（逐条）删除而非降级：规范已定 batch 为唯一路径；保留双路径会让计数等式出现第二个入口。唯一例外是 browser-network producer——它不经 mojo（browser 进程内直接入队 writer），属实现细节不占接口面。
- `LogAsset` 保留独立方法而非折进 batch：资产行与事件行的 validator 契约不同（§5.3 vs §3），同批混发会让截断/摘要断言互相纠缠。
- 兼容性：`XTraceHost` 现有三方法仅被 renderer logger 调用（P1 已核：逐事件 `Log` 单调用点、`LogBatch` 零调用点）；改签名无外部消费者。v1/v2 行为由补丁 0001 内同步改，不走版本开关。

备选（不推荐）：全部折叠进 `XTraceHost`（停止消息每线程一份，浪费且语义错误）；或新增 `XTraceProducerRegistry` 独立注册接口（多一次往返，收益仅显式注册时点，停止语义下无意义）。

**裁决：接受推荐方案**（数据面 `XTraceHost` batch-only + watermark 同管道，控制面独立 `XTraceControl`）。附加条件：① `XTraceControl` 的 browser→renderer 绑定路径（interface broker 或 associated channel）在 P2-E2 以单测实证 main-thread 绑定，绑定方案随证据回报，不预设；② 删除逐条 `Log` 影响的 P1 期断言（如 `tests/test_build_scripts.py` 对 logger 内容的引用）随实现同步更新，保留对照证据；③ 经 `WorkerThreadRegistry` 向 worker 转发停止时，代码注释必须引用 V09（投递数不作确认数），确认只认各管道 watermark。

## DP3：溢出丢弃策略默认值

**推荐：默认 `drop-newest`（丢弃后到者、保留已入队前缀）；`drop-oldest` 作为可配置项；"触发即结束采集"不做。**

- `drop-newest` 下 `written` 行的 `producer_seq` 保持前缀连续，缺口只出现在尾部——等式核对与 validator 断言最简单，与规范 §3.1"严格连续、缺口仅来自溢出"直接吻合。
- `drop-oldest` 产生中部缺口，必须依赖 `overflow_intervals` 区间摘要（规范 §6 已留字段）；逆向分析中页首脚本装载段往往最关键，丢头部代价高。
- "溢出即结束"把数据损失升级为 capture 失败，违背"已声明的降采样/丢弃"原则（草稿 §7.1），不提供。
- manifest `batching.overflow_policy` 声明实际策略（规范 §6）；默认值不写死在代码外的任何文档——producer 配置快照进 manifest 即自描述。

**裁决：接受**（默认 `drop-newest`、`drop-oldest` 可配置、不做"触发即结束"）。补充：validator 按 §12.2 校验缺口时，以 manifest 的 `overflow_policy` 为唯一权威声明——`drop-newest` 只允许尾部缺口，`drop-oldest` 必须有 `overflow_intervals` 对应记账，两者之外的中部缺口视为计数缺陷。

## DP4：测试期 stop 触发机制

**推荐：test-only 命令行开关两个，均走正式停止路径，标记临时设施、P3 移除。**

```
--xtrace-stop-after-ms=<ms>     # capture 启动后由 browser coordinator 定时触发正常 StopCapture 流程
--xtrace-test-capacity=<n>      # 把 producer 有界缓冲容量压到 n 条（确定性触发溢出，替代压测页）
```

- 理由：browser 内测试钩子（friend class）只能覆盖 `content_unittests`/`content_browsertests`，覆盖不了 12 组矩阵这种真 app 启动场景；命令行开关两处都能用。
- 两个开关都**不旁路**协议：前者只是把"P3 时代 CDP `XTrace.stopCapture` 的调用方"提前为定时器，进入同一个 coordinator 停止入口；后者只改缓冲参数，溢出走真实丢弃+计数路径。
- 移除计划：代码内以 `XTRACE_TEST_SCAFFOLDING` 注释块集中标记（含"P3 由 XTrace CDP 域替换"字样）；P3 落地正式域时按标记 grep 删除，并在 P3 交接文档登记。开关不得出现在 launcher 默认参数与任何生产文档示例中（launcher 侧不加对应 CLI 透传，测试驱动直接拼参数）。
- 安全性：开关仅影响采集时序/缓冲，不新增写文件能力、不开端口、不碰沙箱。

备选（不推荐）：`base::FeatureList` 测试 feature（同样能达成，但引入 feature 基础设施依赖，P3 移除时改动面更大）；browser 测试钩子（覆盖不了真 app 场景，见上）。

**裁决：接受**。强制条件：① `XTRACE_TEST_SCAFFOLDING` 注释块必须真实落在每一处开关定义与消费点（P3 按标记 grep 移除，最终验收时核对标记覆盖率）；② launcher 不透传（无对应 CLI 参数），测试驱动直接拼参数；③ 两个开关不出现在任何面向使用者的文档示例中；④ P3 交接文档必须登记移除清单，移除前 P2 终审视为通过但标注临时设施存在。

## DP5：shutdown 排空的 task traits 方案

**推荐：writer 落盘 runner 改 `BLOCK_SHUTDOWN`；结算不等待任何远端；关停期 manifest 写在 runner 上的最后一个任务里。**

```
// 现状（xtrace_host_impl.cc:143-147）
{base::MayBlock(), base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN,
 base::TaskPriority::USER_VISIBLE}
// 改为
{base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN,
 base::TaskPriority::USER_VISIBLE}
```

- `BLOCK_SHUTDOWN` 保证已投递的写任务在浏览器关停阶段执行完；配合"manifest 写入本身是 runner 队尾任务"，正常退出路径能走完草稿 §7.3 的文件级结算（写完事件+资产、记失败、关闭文件、写 manifest）。
- **挂死防护**（关键）：关停路径**不等待 renderer watermark**——coordinator 在 browser 进程收到关停通知时，立即以"最后已确认计数 + unconfirmed_producers"写 `incomplete` manifest（reason `browser-shutdown`），该任务只处理**已在 writer 队列内**的数据，不做任何跨进程等待。因此 BLOCK_SHUTDOWN 任务有界（刷队列 + 一次文件写），不会挂死关停。
- 与显式 stop 的关系：显式 stop（DP4/未来 CDP）仍是正常结算路径；关停兜底只保证"已到 browser 的数据不丢 + 终态不伪报"（`incomplete`，非 complete），符合草稿 §7.4"browser termination 通知只作最后兜底"。
- `USER_VISIBLE` 优先级保留：关停前不与关键路径抢优先级；P2-E7 若测得排空不及时，再评估提 `BEST_EFFORT`→`USER_BLOCKING`（届时带数据再议）。
- 影响面：runner 由 `XTraceHostImpl`（content 层）与 browser-network（chrome 层）共用；P2-E3 拆除 browser-network 私有写路径后两者归一，traits 只改一处。

备选（不推荐）：维持 `SKIP_ON_SHUTDOWN` + 关停前主动 flush（需要挂接 browser 生命周期通知，时序脆弱）；`APPLICATION_EXIT` 观察者驱动（同前，且引入对退出顺序的依赖）。

**裁决：接受**（`BLOCK_SHUTDOWN` + 不等待任何远端 + manifest 为 runner 队尾任务）。验收条件：① P2-E7 必须有实证用例——browser 关停 mid-capture 产生 `incomplete` manifest 且 reason 为 `browser-shutdown`，仅结算已在 writer 队列内的数据；② 终审时以代码走查核对关停路径无任何跨进程等待（这是 BLOCK_SHUTDOWN 不挂死的前提，属硬性条件）；③ 优先级调整（如需 `USER_BLOCKING`）必须带 P2-E7 的实测数据再议，不预设。

---

## 提交说明（执行层 → 架构师 R1）

- 本提案与 [trace-schema-v3.md](trace-schema-v3.md) 共同构成 R1 审查对象（P2 交接 §7 R1 行）。
- 四项决策互相独立，可分别裁决；DP2 的消息形状在规范 §4/§7/§8 已按推荐方案成文，若裁决偏离推荐，规范相应小节随裁决修订后再进 C++。
- 裁决方式建议：直接在本文件各"裁决"栏批注（或另发 review 文档）；执行层收到裁决后启动 P2-E2（mojom），按 P2 交接 §4 顺序推进。
