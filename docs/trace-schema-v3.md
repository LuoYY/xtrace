# XTrace Trace Schema v3

- 版本：v1.2（P2-E1 产出，架构师 R1 审查通过；v1.1 并入单调钟基准、producer_id `lseq`、args 适配包装三处修订；v1.2 并入未确认 producer 计数 null 规则、bnet producer_id 格式、带内控制端点说明——实现以本文件为准）。**v1.2 P5 终审修订（2026-09-24，只加不改）**：①顶层 `channel` 字段——渲染器/浏览器手写钩事件为 `"impl"`，WebIDL 生成回调事件为 `"bindings"`（DP2 裁决：无模糊缺省；历史无字段 trace 由校验器兼容）；②`webidl_outcome.selected_overload`——overload 派发器路由事实（0 基索引十进制串，未路由则缺省），与入口事件按 `(producer_id, call_token)` 配对（token 为进程内序号，配对按 producer 作用域）；③manifest `producers[].nadc_partial`——TryEnter 预检查拒绝的 NADC 入口计数，未确认 producer 同 null 纪律。P5.5 值观测字段（`value_tap`/`dump`/`sampled_out` 等式）保留为 v1.3。
- 依据：[迁移增强草稿](chromium-migration-enhancement-draft.md) §6（协议/身份/证据模型）、§7（写入/背压/停止）、§6.6（旧缺陷收口）、§13.1（已收敛决策）；语义以草稿为准，本文件不另造契约。
- 现状基线：v1/v2 语义见 [trace-schema-v1.md](trace-schema-v1.md)、[trace-schema-v2.md](trace-schema-v2.md)。**P2 起，新 capture 一律输出 v3；v1/v2 trace 由导入适配器只读兼容，不做原地升级。单个 capture 不混写多个 schema 版本。**

## 1. 设计原则

1. **事件自证身份**：一条事件的唯一定位是 `capture_id + producer_id + producer_seq`。文件位置与 `writer_seq` 只表示写入合并顺序，不表示因果或发生顺序。
2. **缺失显式化**：不可得的归属/值一律写显式的 unresolved/unknown 标记，禁止空字符串、`null` 伪装"字段存在"，禁止用 URL 或时间邻近猜测关联（草稿 §6.3）。
3. **值有界、资产引用**：事件内不内嵌无界内容；长内容走资产引用，带原始长度/保存长度/截断状态/摘要四元组（草稿 §6.4）。
4. **计数守恒是终态唯一判据**：manifest 的计数等式成立与否决定 complete（§7 本文件）。
5. **64 位整数在 NDJSON 中一律十进制字符串**：`producer_seq`、`writer_seq`、`config_generation`、`process_epoch`、`mono_time_us`、`wall_time_us`、所有计数与尺寸字段。避免 JavaScript Number 精度丢失（草稿 §6.2）。普通小整数（`depth`、`pid`、`tid`、`line` 等）保持 JSON number。

## 2. capture 产物布局

一次 capture 产生于一个独立目录语义（沿用现有 launcher 布局）：

```
<trace_dir>/
  trace_<stem>.ndjson        # v3 事件流（仅 schema_version=3 行）
  trace_<stem>.manifest.json # capture manifest（§6，单一 JSON 对象）
  assets/<stem>/             # 资产内容目录
  assets/<stem>/manifest.ndjson  # 资产清单（v3 资产行，§5.3）
```

- trace 文件内**不得**出现 v1/v2 行；validator 按此断言。
- 资产清单行是 append-only 的资产行（供增量读取）；manifest 的 `artifacts` 块给出权威清单与计数。
- `global_seq`（v1 时代 browser 盖章的文件序）**废除**，由 `writer_seq` 取代；同一文件内 `writer_seq` 严格递增且无重复。

## 3. 事件 envelope

每行一个 JSON 对象。字段分为五组：身份、时间、语义、归属、值引用。

### 3.1 身份与时间（所有事件必有）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `schema_version` | number | 恒为 `3` |
| `capture_id` | string | browser 为一次采集分配；格式 `c<wall_start_us>-<browser_pid>-<nonce8>`（如 `c1750000000000000-47787-a1b2c3d4`）。一次 browser 生命周期内不复用 |
| `producer_id` | string | producer 注册身份；格式见 §4.2 |
| `process_epoch` | string | 进程实例身份 `<pid>.<creation_ticks>`，防 PID 重用；十进制字符串 |
| `producer_seq` | string | producer 本地递增逻辑序号（先分配序号再过滤/丢弃，见 §7.1）；严格连续，缺口只来自溢出丢弃并以 watermark/manifest 记账 |
| `writer_seq` | string | writer 接受事件的合并顺序；文件内严格递增唯一；**不表示因果顺序** |
| `config_generation` | string | 事件生成时生效的配置代数。P2 无热更新，恒为启动代 `"0"`；P3 起由 browser 串行分配 |
| `mono_time_us` | string | producer 进程单调钟微秒；基准为平台单调钟原点（`base::TimeTicks` 语义，macOS 上通常为系统 boot 起算，**不保证等于进程启动时刻**）；只用于差值计算，不得跨进程比较绝对值，**不得**与 wall 钟混算 |
| `wall_time_us` | string | producer 进程墙上钟微秒，Unix epoch |
| `pid` | number | 便捷字段（真实值在 producer_id/process_epoch 中） |
| `tid` | number | 同上 |

### 3.2 语义字段（沿用 v1 语义，收窄契约）

| 字段 | 类型 | 契约 |
| --- | --- | --- |
| `category` | string | `reverse` / `fingerprint` / `network` / `script` 等 |
| `phase` | string | `call`/`return`/`exception`/`get`/`set`/`lifecycle`/`complete`/`iterate` |
| `api` | string | 观测入口名，沿用 v1 命名 |
| `args` | array | 参数/材料对象；每个捕获值遵守 §5 有界形态 |
| `stack` | array | JS 栈帧；不可得时 `[]` |
| `t` | — | **废除**（v1 中为 phase 别名）；导入适配器丢弃 |
| `result` / `error` | — | **废除**。返回/错误材料进入 `args[*]` 的有界值形态；§6.6 中"恒为 null 的兼容字段"不再保留（实现未接线即删除，不留恒空字段） |

### 3.3 归属字段（收口 §6.6 的 frame_url/origin 恒空）

| 字段 | 类型 | 契约 |
| --- | --- | --- |
| `attribution` | object | `{status, frame?, document?, worker?}`；`status ∈ resolved | unresolved` |
| `attribution.status` | string | 任一子身份可得即 `resolved`；全部不可得即 `unresolved`，且**不写**子字段（不是空串、不是 null 占位） |
| `attribution.frame` | object | renderer hook 点可廉价获得的 frame 身份：`{frame_url, origin}`（v1 语义的承接，但不得为空串——不可得就不写该子对象） |
| `attribution.worker` | object | `{scope_url, kind}`，`kind ∈ dedicated | shared | service`；worker 线程 producer 的常规归属 |
| `attribution.document` | object | P2 **预留不填**（document 身份需 browser 侧生命周期，P3）；hook 点若自然可得 frame_url 则只填 `frame` |

browser-network producer 的归属：`attribution.status = "unresolved"`，请求侧上下文（referrer、initiator）保持在 `args` 内的网络材料字段中，**不得**冒充 frame 归属（草稿 §6.2"不用 URL 代替身份"）。

V8/VMP 热路径（`xtrace:vmp-runtime:` 系）：归属按现状可空——`attribution: {status:"unresolved"}`，轻量数字 provenance（`script_id`、`source_position` 等）保持在 `args`，由分析器经脚本登记解析（v1 §Context Attribution 语义延续）。

### 3.4 因果字段（承接 v2，收紧表示）

`causality` 恒为对象，字段为 v2 契约原样搬移：

```json
"causality": {
  "kind": "paired | singleton | external",
  "call_id": "session:token" | null,
  "parent_id": "session:token" | null,
  "depth": 0,
  "duration_us": "123" | null
}
```

- 语义与 v2 相同（renderer 线程内同步 script evaluate 因果；`external` 供 browser-network 等 producer-local 观察；paired 终止事件才带 `duration_us`，十进制字符串）。
- `causality=off` 的 capture 中该对象仍存在，`kind` 全为 `singleton`/`external`——字段集稳定优于按模式裁剪。

## 4. producer 模型

### 4.1 producer 清单（缺一不得结算 complete；草稿 §7.1）

| producer | 位置 | 计数归属 |
| --- | --- | --- |
| renderer 主线程 logger | renderer 进程 | 独立 producer |
| dedicated / shared / service worker 线程 logger | renderer 进程 | 各自独立 producer |
| V8 event_logger 路径（`xtrace:vmp-runtime:` 等） | renderer 进程各线程 | **并入所属线程 producer**，不单列 |
| 脚本资产通道（`LogAsset`） | renderer 进程各线程 | **并入所属线程 producer**（资产行计入该 producer 的 `assets_out` 计数，见 §7.2） |
| browser-network 插桩 | browser 进程 | 独立 producer（P2 拆除其私有写入路径后成为 writer 的本地 producer） |

资产通道"并入所属 producer"是本规范对草稿二选一的**选定**（另一选项"单列 producer"不采用），理由：资产与事件共用同一线程管道，归属无歧义，watermark 无需跨通道对账。

### 4.2 producer_id 格式

```
<pkind>:<pid>.<epoch>:<tid>:<lseq>
<pkind> ∈ rtx (renderer 主线程) | rtw (renderer worker 线程) | bnet (browser-network)
<lseq>  = renderer 进程内单调递增的 producer 序号（进程级原子计数器，从 1 起；主线程与工作线程共用同一序列）
示例: rtw:43839.128990467:68976564:3
```

- 自声明、browser 在注册时核验唯一性（冲突即 capture failed，不静默改名——带 `lseq` 后冲突仅意味实现缺陷）。
- `lseq` 是 tid 复用的答案：capture 期间操作系统可复用 tid（worker 线程退出后新线程获得同值），进程内序号保证同 tid 的不同 producer 实例仍有唯一 `producer_id`，事件的唯一定位（`capture_id + producer_id + producer_seq`）不受复用影响；browser 不做任何改名或实例推断。
- `rtw` 线程还需在注册描述符中给出 `worker.kind` 与 `worker.scope_url`（不可得写 unresolved）。
- `bnet` 同样遵守五段格式：`<pid>.<creation_ticks>` 为 browser 进程真实值，`tid` 为 writer 线程 tid，`lseq` 可用常量 `1`；不得省略段或用 `local` 占位（P2 初版实现曾写 `bnet:<pid>.local:1`，属偏离，终审前修正）。

### 4.3 注册与注销

- 注册：producer 首个数据消息（batch / 资产 / watermark）携带完整描述符 `{producer_id, process_epoch, worker?}`；browser 按收到消息的 mojo 管道登记进程归属（管道即进程边界凭据）。无独立 Register 消息（零额外往返）。
- 注销：线程退出或 producer 终结时在**原日志通道**提交 watermark（§8）；未提交即失联，按 §9 异常路径裁决。
- 控制端点（P2 带内方案，DP2 追认）：renderer 进程的首个 producer 数据管道经 `XTraceHost.ProvideControlEndpoint` 带内传递一次控制端点；browser 按 `process_epoch` 登记，端点断连兼作 renderer 死亡信号。**从未产生数据的 renderer 不进入 producer 集合，停止编排不等待它**——这不是缺口：无管道即无事件可结算。

## 5. 值与资产

### 5.1 事件内有界值

`args[*]` 中的捕获值对象统一形态：

```json
{"value": "<有界捕获内容>", "original_size": 1234, "saved_size": 1234,
 "truncated": false, "sha1": "sha1:..."}
```

- `saved_size == original_size` 且 `truncated=false` 表示未截断；截断时四元组完整、`value` 为前缀。
- 限额（`max_body_bytes`、`max_header_value_bytes`、value 上限）触发时必须置 `truncated=true` 并填四元组——**限额生效与截断状态如实记录是 P2 硬验收**（§6.6 收口）。
- 缺失值写 `{"missing": true}`；不可序列化写 `{"unserializable": "<原因>"}`；三者不得用空串互相冒充。

### 5.2 v1 truncation 双形态收口

v1 的顶层 `truncation` 对象与嵌套 `xtrace_truncated`/`original_args` **不再产生**。截断信息只存在于 §5.1 四元组与资产引用。导入适配器负责把旧形态折叠为四元组。

### 5.3 资产行（assets/<stem>/manifest.ndjson 每行）

```json
{"schema_version": 3, "capture_id": "...", "producer_id": "...",
 "asset_id": "sha1:...", "kind": "script", "url": "...",
 "original_size": "1048576", "saved_size": "1048576", "truncated": false,
 "sha1": "sha1:...", "content_path": "assets/<stem>/<id>.js",
 "retrieval_status": "captured | metadata-only", "first_seq": "12"}
```

- **summary 资产模式收口（V06）**：`capture_assets=summary` 时 `retrieval_status="metadata-only"`、`content_path` 缺省、**行内不得有 `source` 字段**——摘要、尺寸、hash 足够定位，完整源码只在 `captured` 状态经由 `content_path` 落盘。事件侧同样不再内嵌 `source`（v1 `BuildScriptAssetFieldsAndSend` 的行为废除），改为 `asset_refs` 引用。
- `captured` 状态：`content_path` 必填且内容 SHA-1 与 `sha1` 一致、长度等于 `saved_size`。
- 事件引用资产：`"asset_refs": [{"asset_id": "sha1:...", "original_size": "...", "saved_size": "...", "truncated": false, "sha1": "..."}]`——四元组冗余随事件携带，读取方不回表也能判断截断。

## 6. capture manifest（trace_<stem>.manifest.json）

单一 JSON 对象，由 writer 在结算时写出（终态前可先写 `state:"stopping"` 快照供观测，终态覆盖）：

```json
{
  "manifest_version": 3,
  "capture_id": "...",
  "schema_version": 3,
  "created": {"wall_time_us": "...", "mono_time_us": "..."},
  "closed": {"wall_time_us": "...", "terminal_state": "...", "reason": null},
  "config": {"generation": "0", "categories": "...", "capture_values": "full",
             "capture_assets": "full", "causality": "sync",
             "max_body_bytes": 0, "max_header_value_bytes": 0},
  "build": {"product": "Chrome/151.0.7917.0", "is_debug": true,
            "component_build": true},
  "artifacts": {"trace": "trace_<stem>.ndjson",
                "asset_manifest": "assets/<stem>/manifest.ndjson",
                "asset_dir": "assets/<stem>/",
                "asset_count": "5"},
  "batching": {"max_batch_events": "200", "flush_interval_ms": "50",
               "producer_buffer_events": "4096",
               "overflow_policy": "drop-newest"},
  "producers": [
    {"producer_id": "rtw:43839...:68976564", "process_epoch": "43839...",
     "kind": "dedicated-worker", "first_wall_us": "...", 
     "final_producer_seq": "7049",
     "eligible": "7049", "enqueued": "7049", "dropped": "0",
     "accepted": "7049", "written": "7049", "failed": "0",
     "assets_out": "3", "watermark": {"received": true, "wall_us": "..."},
     "confirmed": true}
  ],
  "counts": {"eligible": "7049", "enqueued": "7049", "dropped": "0",
             "accepted": "7049", "written": "7049", "failed": "0",
             "sampled_out": "0"},
  "overflow_intervals": [{"producer_id": "...", "from_seq": "10", "to_seq": "25"}],
  "terminal": {"state": "complete | incomplete | failed",
               "reason": "string | null",
               "unconfirmed_producers": []}
}
```

- `producers[].kind ∈ main-thread | dedicated-worker | shared-worker | service-worker | browser-network`。
- producer 侧三元组（eligible/enqueued/dropped）来自 watermark；writer 侧二元组（accepted/written/failed）为 writer 记录。`accepted` 按管道顺序核销 watermark 前的最后一个批次后定值。
- `overflow_policy` 与溢出区间是"已声明的丢弃策略"（草稿 §7.1）：`drop-newest`（默认，见决策提案 DP3）只产生尾部缺口；若实施 `drop-oldest` 必须记 `overflow_intervals`。
- 采样（若将来启用 1/k）：`sampled_out` 单列，不混入 `dropped`（草稿 §13.1）。

## 7. 计数契约（唯一终态判据；语义引自草稿 §7.1，不得改写）

对每个 producer：

```
eligible = enqueued + dropped        （producer 侧：入选事件 = 已入队 + 溢出丢弃）
enqueued = accepted                  （管道语义：mojo 消息不丢即达）
accepted = written + failed          （writer 侧：接受 = 落盘成功 + 落盘失败）
```

对整个 capture，`counts` 为全体 producer 之和，另加全局 `sampled_out`。

**complete 的判定（全部成立）**：所有已登记 producer 均有 `watermark.received=true` 且 `confirmed=true`；全部等式成立；`dropped = failed = 0`。任一不满足 → `incomplete`（有可用产物）或 `failed`（无法建立有效产物）。

- 计数未知（producer 失联、browser 崩溃）**不得补零**：未确认 producer 列入 `terminal.unconfirmed_producers`，终态 `incomplete`（§9）。其 manifest 行内 producer 侧三元组（`eligible/enqueued/dropped`）与 `final_producer_seq` 写 JSON `null`（非字符串 `"0"`，非缺省）；全局 `counts` 中 `eligible/enqueued/dropped` 仅合计**已确认** producer，`accepted/written/failed` 为 writer 全量实测——因此异常路径下全局等式可见缺口，这本身就是失联的证据，不得抹平。
- `writer_seq` 与计数的关系：`written` 等于 writer 为该 producer 盖章的行数；文件行数 = Σwritten（trace 文件仅含事件行）。

## 8. 停止协议的产物语义（流程本体见草稿 §7.3 六步）

规范只规定可验收的产物事实：

1. 每个 producer 的最后一个数据消息之后、同管道内必有一条 watermark 记录（`final_producer_seq` + 三元组 + generation）；mojo 管道保序使 watermark 之后该 producer 无新事件行。
2. manifest 的 `producers[]` 与注册表一致；停止期新注册请求要么进表要么在 `reason` 中记拒绝。
3. `terminal.reason` 枚举（P2 至少）：`null`（complete）、`dropped>0`、`producer-unconfirmed`、`stop-timeout`、`disk-write-failure`、`renderer-gone`、`browser-shutdown`、`inconsistent-counts`。
4. **不承诺断电安全**：complete 只保证写入与文件关闭完成、以最终 manifest 为结算凭据（草稿 §7.3 末段）。

## 9. 异常路径的记录规则（草稿 §7.4）

| 情形 | 产物事实 |
| --- | --- |
| producer 失联/断连 | 该 producer 行 `watermark.received=false`、`confirmed=false`；`final_producer_seq` 为最后已确认值；终态 `incomplete`，reason `producer-unconfirmed` 或 `renderer-gone`；**不补造结束事件** |
| 停止超时 | `unconfirmed_producers` 非空，reason `stop-timeout`；超时本身不杀进程 |
| 磁盘写失败 | `failed>0`，reason `disk-write-failure`；终态按等式裁决（多数 `incomplete`；全量失败 `failed`） |
| browser 崩溃 | manifest 缺失或停留于 `stopping` 快照 → 消费端按中断片段处理，校验后标注，不生成正常终态 |
| 等式不自洽 | reason `inconsistent-counts`，终态 `incomplete`；不得静默修正计数 |

## 10. v1/v2 → v3 字段映射（导入适配器契约）

| v1/v2 | v3 | 变换 |
| --- | --- | --- |
| `schema_version: 1\|2` | `schema_version: 3` | 适配器标记来源（`imported_from` 注入 manifest，不入事件行） |
| `session_id` + `seq`/`session_seq` | `producer_id` + `producer_seq` | v1 的 session 粒度≠v3 producer 粒度：同 session 的行按 `pid:tid` 分组各自重编 `producer_seq`；`producer_id` 按 `rt?:<pid>.unknown:<tid>:<分组内出现顺序号>` 合成（`process_epoch` 不可考，见下两行）；`event_id` 丢弃 |
| v1 自由形态 `args`（含网络材料等嵌套对象） | §5.1 有界值对象 | 逐值包装：内容全文可得时 `original_size=saved_size=实际长度`、`truncated=false`、`sha1` 重算；旧行已声明截断的按原截断信息填四元组；不可得标 `missing`，不得空串冒充 |
| `global_seq` | `writer_seq` | 原值照搬（本就单调） |
| `t` | — | 丢弃（phase 别名） |
| `ts` | `wall_time_us` | 数值→十进制字符串 |
| `mono_time_us` | `mono_time_us` | 数值→字符串 |
| `frame_url`/`origin`（可为 `""`） | `attribution` | 非空→`{status:"resolved", frame:{frame_url, origin}}`；空串→`{status:"unresolved"}`；browser-network 行→unresolved + args 保持 |
| `result`/`error`（恒 null） | — | 丢弃（权威材料在 args） |
| `truncated` + `truncation{}`（含嵌套 `xtrace_truncated`） | §5.1 四元组 | 顶层折叠进对应 args 值对象；嵌套历史形态同规则 |
| v2 `call_id/parent_id/depth/causality_kind/duration_us` | `causality{}` | 原样搬移，`duration_us`→字符串 |
| 资产 manifest 的 `source` 全文 | — | 适配器不搬运正文；引用改为 `asset_refs`（`retrieval_status` 按原行 `source` 是否存在映射 `captured`/`metadata-only`） |
| —（无） | `capture_id`/`config_generation` | 适配器合成 `capture_id = import-<原文件 stem>`；`config_generation="0"` |
| —（无） | `process_epoch` | 不可考：取 `"<pid>.unknown"` 并在 manifest `import_notes` 声明 |

## 11. P2 明确不含的 §6.2 字段（防越界）

| 字段 | 所属阶段 | P2 替代 |
| --- | --- | --- |
| `target_id` / frame-tree / document 的 browser 侧映射（crosswalk） | P3（草稿 §8.4） | renderer hook 点的 `attribution.frame`（可得即填）；browser-network 保持 unresolved |
| `isolate_id` / context / world 身份 | P4/P5（随 observer / 生成器接入） | 不填，不造 |
| `activation_id`（观测依据版） | 沿 v2 `causality.call_id` 承接；P4 扩展 | v2 因果链原样 |
| `script_id` / `bytecode_version` / `bytecode_offset` | P4 | V8 热路径的轻量数字 provenance 保持 args 原状 |
| 配置热更新 / generation 更新 | P3 | `config_generation` 恒 `"0"` |
| CDP XTrace 域触发 | P3 | 测试期 stop 走临时脚手架（决策提案 DP4） |

## 12. validator 契约（P2-E6 落地，此处定验收口径）

`validate_trace.py --schema-version 3` 必须断言（存在性之外）：

1. 每行 `schema_version===3`；无 v1/v2 行混入。
2. §3.1 字段齐全且类型正确；`producer_seq` 在同 producer 内不重复、不回退（缺口仅允许且必须被 manifest 记账）。
3. `writer_seq` 全文件严格递增唯一。
4. 十进制字符串字段不出现 JSON number。
5. `attribution` 形态合法：unresolved 时不携带子对象。
6. 截断四元组一致性：`truncated=true ⟺ saved_size<original_size`（或显式 `missing/unserializable`）。
7. 资产行（若 capture_assets 非 off）：`captured` 行的 `content_path` 存在、SHA-1、长度核对；`metadata-only` 行**不含 `source` 字段**（V06 回归断言）。
8. manifest 存在且等式核对（§7）；`complete` 时全 producer confirmed、dropped=failed=0；终态与 reason 自洽（§8.3 枚举）。
9. 因果对象（§3.4）类型断言承接 v2 validator 的配对/深度/顺序检查。

---

*本规范为 P2-E1 提案。配套的实施决策提案（控制通道形状、溢出默认、测试期 stop、shutdown 排空）见 [chromium-p2-r1-decisions.md](chromium-p2-r1-decisions.md)。两者共同构成 R1 审查对象；通过后方可开始 C++ 实施。*
