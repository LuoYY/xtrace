# P5.5 设计提案：值观测二期（vPC 流截获 / 值级 tap / 物化 dump）

- 版本：v1.3（2026-09-24；v1.3 六决策点经裁决定稿（§11），T3/T7 先行获批，设计进入实施；v1.2 补入分析层 T3/T7；v1.1 补入 T1/T2 挑战会话；v1.0 架构师提案）。
- 依据：[P4 交接](chromium-p4-ignition-observer-handoff.md)（observer/scope selector/两阶段弱回调）；[trace-schema-v3.md](trace-schema-v3.md) v1.2；[P5 设计](chromium-p5-design.md) DP3（反扰动分派表）；真实样本语料 `analysis/pmos-{xj,sc,jibei}-sgcc-20260923/`（瑞数 JSVMP 三站四份挑战脚本，本地 gitignored）。
- 定位：P4 交付的是**物理层**（V8 字节码执行前事件）；本提案打开**虚拟层**——VM 自己的指令流、虚拟寄存器值、运行期物化的表数据。目标是让瑞数级 JSVMP 的 cookie/签名计算从"黑盒"变成"可重建的计算图"。

## 1. 问题定义（由样本证实）

瑞数挑战层（三站四份脚本）的防御结构：LCG PRNG 洗牌构造字符串/操作码表 → `while(1)` 派发器按虚拟 PC 取指 → API 名全部运行期解码 → VM 算出 cookie → 服务端校验。由此推出四个"看不见"：

1. **虚拟指令流不可见**：P4 只能看到 V8 在跑派发循环，看不到 VM 实际执行的虚拟程序。
2. **虚拟寄存器值不可见**：计算过程的中间值全部在 VM 内部的 JS 数组/变量里。
3. **表数据运行期才物化**：`$_ts.cd` 大 blob 与 meta 加密内容只有解码后才成为可用常量表。
4. **环境读取面不可枚举**：API 名运行期解码，静态分析拿不到读取清单。
5. **挑战链在导航处断裂**：两段式挑战（412 脚本算 cookie → reload → 200 脚本续算/校验）是两次 VM 执行、两个 document——没有会话身份，T4/T5 的值观测只是两段孤立片段，"一阶段写出的 cookie 值是否就是重载请求里被校验的值"无法闭环断言。

服务端校验 cookie 使"伪造"不可行——唯一正路是**还原计算**。本提案的三个能力就是还原链的三段。

## 2. 设计原则（硬约束）

1. **范围限定是前提**：所有 tap/dump 只在选定 script + 函数 + offset 窗口内生效，无全局开关；精细模式环境（P4 已交付）之外不启用。
2. **预算硬闸**：每激活事件预算 N（超限按 DP5 预留扩展式 `eligible = enqueued + dropped + sampled_out` 记账）；dump 的深度/宽度/条数同样有限。
3. **构造性不调用用户代码**：值捕获只做类型分派（P5 DP3 的静态表），永不触发 getter/Proxy trap/toString——与 P5 同一保证等级。
4. **计数契约不破坏**：tap/dump 事件走既有 producer 管道与 watermark 结算；突发量由 P2 有界缓冲 + drop-newest 兜底。
5. **GC 安全沿用 N1 教训**：不在事件/资产中持 V8 堆指针；对象引用为即时序列化（短窗口 identity ref，GC 后跨事件相关仅 best-effort——与 P5 裁决口径一致）；任何新弱引用必须两阶段回调。

## 3. 能力 T4-a：vPC 流截获（虚拟指令流）

### 机制

- P4 observer 的 Entry 插桩点增加**带 offset 谓词的 accumulator 读取**：当事件 PC 命中选定窗口时，在 Entry 处从当前帧读 accumulator（此刻它正是刚取出的虚拟操作码或其输入）。
- **循环头 tap 点选择**：先粗观测一次（普通 P4 observer 流），分析层按结构特征自动定位派发循环——回边计数、表索引读取密度、分支扇出——产出候选 `(script, function, offset)`；操作者确认或写入 scope 配置。瑞数四份脚本就是开发期 fixture：定位器必须在四份上全部命中 `while(1)` 循环头。
- 产物：每条 tap 事件 = `(script_id, bytecode_version, v8_offset, accumulator值/摘要, activation_ref)`；分析层把 tap 流按激活串接即为 **vPC 序列**（VM 自己的指令流）。

### 与 P4 的关系

不新增第二条观测通道：vPC tap 复用 observer 的 Entry 与 gate，只是事件负载多了 accumulator 字段；per-isolate 状态、范围启停、销毁顺序、弱回调两阶段语义全部沿用（P4 N1/N2 修复成果不得回退）。

## 4. 能力 T4-b：值级 tap（选择性执行点值观测）

### 机制

- 配置项：`(script, function?, offset_windows[], kinds[], budget)`；`kinds`：`accumulator` / `register_range(start,count)` / `frame_args`。
- 值形态沿用 DP3 分派表：标量直接值；字符串走长度上限与截断四元组；对象=短窗口 identity ref + 类型名（不解引用）；TypedArray=原生指针+长度不解码；record/sequence=长度+元素类型标签。
- 预算：每激活 N 条；超限计 `sampled_out`（启用 DP5 预留的等式扩展——这是其首次实际启用，规范 §7 的扩展式同步落文档）。
- 用途一（瑞数）：在 VM handler 调内建的边界，0002 家族钩（charCodeAt/base64/位运算）本就带值且 tier 免疫——值级 tap 补齐 VM 内部段，与边界钩拼成完整计算图。

### 注入点（决策点 1 的两个候选）

- 候选 A：Entry 点 + offset 谓词，读帧（当前状态语义——"执行前这一刻的值"）。
- 候选 B：上游 Exit 变体（`Runtime_TraceUnoptimizedBytecodeExit`）同款改造（"执行后结果"语义）。
- 推荐 **A 起步**：与现有 Entry 设施同构、风险低；候选 B 作为后续补充（覆盖/成本另行评估），本期不做。

## 5. 能力 T5：物化 dump（定点快照）

### 机制

- 锚点类型：函数入口、指定 offset、VM 初始化完成标记（由操作者按样本锚定，如瑞数 `_$jc` 洗牌完成点）。
- 快照内容：frame args + 寄存器文件 + 选定全局对象属性（如 `window.$_ts` 的解码产物）+ 选定大数组（S-box/字节码表——走资产通道，sha1 去重、`retrieval_status` 按 v3 §5.3）。
- 对象图遍历：深度 ≤2、宽度有界、只读；触发用户代码的路径一律不进入（构造性保证同 §2.3）。
- 产物：dump 事件（引用资产 ID + 四元组），manifest 照常结算；**解码后的表数据一旦落盘，离线分析器按会话参数化，多态退化为"每会话多跑一次 dump"**。

### 与动态代码资产的关系

现有资产通道已捕获脚本源码（dynamic-code）。T5 补的是**运行期物化值**——源码里不存在的、只有执行后才存在的数据（解码表、VM 字节码数组、计算中间态）。两者合起来才是"该会话 VM 的完整自描述"。

## 6. 能力 T1/T2：挑战会话身份与 VM 会话关联（跨导航因果）

### 问题

瑞数两段式（以及所有"挑战 → 跳转 → 真页"形态）把一次逻辑会话切成两个 document：一阶段脚本在 document A 算 cookie 并写 `document.cookie`，导航后 document B 的二阶段脚本与业务代码带着该 cookie 请求服务端。v3 的 `causality` 只覆盖 renderer 线程内同步链，`attribution.document` 只到单文档身份——**链在导航处断裂**（这正是此前工具清单 T1/T2 的落位，P3 全量 crosswalk 是后续项，本节只交付挑战所需子集）。

### T1：挑战会话身份（nav_chain）

- browser 侧在现有 `manifest.identity` 段（P3 交付的 frame_tree_node_id → document_token 映射）上增量记录**导航后继**：同 frame 内 document N → document N+1 的替换关系 `{from_document, to_document, cause: reload|navigation|redirect, wall_us}`。
- 同一 frame 的导航序列共享 `nav_chain_id`；capture 内挑战相关的 document 通过 identity 段挂到同一链上。事件行不新增字段（保持轻量——与 crosswalk 落 manifest 的既定决策一致），nav_chain 信息全部在 manifest。
- **硬验收锚点**：一阶段写入的 cookie 值，必须能在重载请求的 Cookie 头中被定位（renderer cookie 钩与 browser-network producer 均带值）；且两端事件经 identity 段属于同一 nav_chain。该锚点同时验证了身份模型与因果闭环。

### T2：VM 会话关联

- 同一 nav_chain 内、URL 匹配挑战脚本形态（随机路径 + 版本标记）的多个 script 激活，按文档顺序编 stage，归为同一 challenge_session 的 VM 执行序列。
- T4/T5 的产物（vPC 序列、dump 资产、值 tap 流）按 (nav_chain, stage) 组织呈现——分析器面对的是"一次挑战会话的两段 VM 执行"，而非两个孤立 capture 段。两段字节码不同（打包层多态）但 handler 语义指纹稳定，stage 间关联由 §9.2 的语义聚类兜底。

### 范围边界（防蔓延）

本节的导航身份只覆盖**同 frame 导航后继**。BFCache、redirect 链全景、跨 frame/进程归属、SW 场景仍属 P3 身份映射的后续修订，不在本提案交付范围。

## 7. 范围与配置接口（决策点）

- scope selector（N3 交付的三命名空间）扩展**函数与 offset 粒度**：`scripts:[url_pattern], functions:[name/script-local-id], offsets:[(function,start,end)]`。
- 域接口两个候选：**(a)** `startCapture` 的 config 对象扩展 `valueObservation` 子段；**(b)** 独立 `XTrace.startValueTap` / `XTrace.startDump` 方法。推荐 (a)——与 capture 生命周期/终态/计数同一治理，避免第二种 capture 状态机（B1 教训：不做第二套生命周期）。
- 配置快照进 manifest（自描述原则）；`getCapabilities` 披露 valueObservation 的可用范围与预算上限。

## 8. v3 字段扩展（只加不改）

```json
"value_tap": {"kind": "accumulator|register_range|frame_args", "v8_offset": "123",
              "values": [<DP3 分派形态的值对象>], "budget": {"limit": "N", "used": "k"}}
"dump": {"anchor": "function-entry|offset|custom", "frame_ref": "<activation_ref>",
         "asset_refs": [<资产引用+四元组>], "notes": "..."}
```

`ignition` 对象六字段不变；`sampled_out` 等式扩展落规范 v1.3（同时把 §7 的预留式写成正式条款）。

## 9. 分析层配套（本提案一并交付契约）

1. **vPC 序列重建**：tap 流按 (activation_ref, 时序) 串接 → 虚拟指令序列。
2. **handler 语义提取**：vPC 值 → 对应 V8 子 trace（P4 事件）→ handler 语义指纹；跨多态会话按语义指纹聚类（打包层轮换不改变 handler 代码——三站样本已实证骨架一致）。
3. **字符串表收获**：dump 的解码表 + 使用点事件（属性名/内建参数）交叉补全。
4. **值流 DAG**：边界钩值 + tap 值按 `activation_ref` + 短窗口 ref 链接（runtime-trace-plan Phase 2 的 sha 描述符此处不重复引入——值级 tap 是真值，比 hash 更强）。
5. **T3：环境读取面还原（纯分析层，可独立先行）**。输入：P4 observer 流（`GetNamedProperty`/`CallProperty`/`GetKeyedProperty` 等 opcode + 字节码元数据常量池解析），无需 P5.5 引擎即可运行。产出：按激活分组的**有序属性访问清单**（属性名、首现 offset、次数、所在激活），并做读取面分类（navigator/screen/canvas/storage/timing/function-probe/异常检测点等）；与 bindings/impl 边界事件交叉——回答"瑞数读了哪些环境字段、按什么顺序、读到值没有"三问，粒度细于 API 调用级（未插桩 API 的读取也可见）。这是 frx `webapi_trace`"补环境清单"用途的对位能力。
6. **T7：部署形态判定器（纯分析层，可独立先行）**。输入：一次 capture 的 browser-network 状态码、挑战脚本 URL 形态（随机路径+版本标记）、cookie 事件（名称/属性）、导航后继、sink 事件。产出：部署形态判定 `{family, mode: 412-interstitial-two-stage | 200-inline, stages, cookie: {name, attrs}, sink}`，每条判定带证据引用（沿用分析结果五级：本项为 derived/observed 级）。用途：下游分析配置自动生成，不手写站点特判——"站点无关"从纪律变成工具。三站样本（两段式 XJ、内嵌 SC/Jibei、两种 cookie 名）是验收集。

T3/T7 均不新增采集语义、不动引擎，可在 P5.5 引擎工作之前先行交付；但其输出是 §9.1–9.2 的输入契约（vPC 重建与 handler 聚类消费读取清单与形态判定）。

## 10. 验收设计（fixtures 全部在手）

| 验收 | 内容 |
| --- | --- |
| 合成 fixture | `test-pages/` 新增类 VMP 派发器页（已知虚拟程序）：vPC 流与已知程序逐条一致；值 tap 还原已知计算；dump 捕获已知表 |
| 瑞数离线语料 | 派发器自动定位在四份挑战脚本全部命中；环境读取清单（GetNamedProperty 流）产出非空且可人工抽查 |
| T3 环境读取还原 | 对四份挑战脚本的 observer 流产出有序属性访问清单：非空、可抽查（与源码中不存在的解码 API 名互证）；分类覆盖 navigator/screen/storage/timing 等读取面；未插桩 API 的读取同样在列 |
| T7 形态判定 | 判定器对三站样本正确输出：XJ=412 两段式（stages=2、cookie=`CyFIZHvBqps2O`）、SC=200 内嵌（cookie=`cookie_persist`）、Jibei=200 内嵌 + 传输层门槛标注；每条判定附证据引用 |
| 瑞数现场（授权研究环境） | 挑战脚本范围内：vPC 序列非空、dump 得解码表资产、cookie.set sink 事件存在且值与请求头一致（边界证据，不承诺完整算法还原） |
| 挑战会话闭环（T1/T2） | 两段式站点现场：一阶段 cookie.set 的值在重载请求 Cookie 头中定位成功；两端事件经 identity 段同属一个 nav_chain；vPC 序列与 dump 资产按 (nav_chain, stage) 成组呈现 |
| 契约与回归 | 计数等式/终态不被 tap/dump 破坏；sampled_out 记账正确；P2–P5 全部门禁（契约 21/21、矩阵、故障、parity、单测）不回退 |

## 11. 决策点（**已裁决 2026-09-24**）

1. **tap 注入点**：Entry+谓词读帧起步、Exit 变体后置（**已裁决**）；offset 窗口编译期预编译为 per-function 有序区间表、运行期二分查找、零分配。
2. **接口形状**：`startCapture.valueObservation` 子段（**已裁决**）；`getCapabilities` 披露 `valueObservation.windows` 与 `budget.maxTapsPerActivation`。
3. **预算默认值**：每激活 **N=2000 tap**、每 offset 窗口 **512**（**已裁决**）；`sampled_out` 推广 `nadc_partial` 的 watermark 计账模式，等式扩展随 v1.3 生效。
4. **dump 对象图边界**：深度 ≤2、宽度 256、资产阈值 16KB（**已裁决**）；`anchor` 增 `window_id` 回引。
5. **v3 字段扩展清单**：§8 形状（**已裁决**）；v1.2 → v1.3 升版时合并 P5 终审修订（顶层 channel、`selected_overload`、`nadc_partial`）为正式条款。
6. **nav_chain 身份模型**：succession 进 `manifest.identity` 段（**已裁决**）；事件行不加字段；硬验收锚点按 §6 实施。

裁决全文与 T3/T7 先行批准见 [实施侧意见](chromium-p55-implementation-notes.md) §4。

## 12. 非目标

- 不做全量 post-op 值观测（只在选定窗口）；不做精确 def-use 全程跟踪。
- 分析层的 handler 语义标注为 hypothesis 级输出，不冒充已验证算法还原（沿用分析结果五级纪律）。
- 不在常规（非精细）模式启用；不对未授权目标启用；不承诺对时序门活目标的隐形性（观测开销如实披露，线上用常规模式、深挖用重放）。
