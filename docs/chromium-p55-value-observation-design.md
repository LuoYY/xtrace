# P5.5 设计提案：值观测二期（vPC 流截获 / 值级 tap / 物化 dump）

- 版本：v1.4-review（2026-09-24；总架构师复审及增强路线见 §13）。**已由 [chromium-p55-design-contract.md](chromium-p55-design-contract.md) v2.0 取代——本文件保留作历史（含 §13 复审原文），实施以契约为准。**
- **当前状态：设计修订门，非无条件引擎开工批准。** §11 与实施意见原裁决保留为历史；Entry/单通道/有界观测方向保留，但 vPC、T3 输入、预算记账、对象遍历与跨导航证据语义须先按 §13 重新定稿。P5 产品回归须先闭环；允许并行做证据索引、合成fixture和分析器骨架，不将私有样本还原或现场访问作为默认执行任务。
- 依据：[P4 交接](chromium-p4-ignition-observer-handoff.md)（observer/scope selector/两阶段弱回调）；[trace-schema-v3.md](trace-schema-v3.md) v1.2；[P5 设计](chromium-p5-design.md) DP3（反扰动分派表）；真实样本语料 `analysis/pmos-{xj,sc,jibei}-sgcc-20260923/`（瑞数 JSVMP 三站四份挑战脚本，本地 gitignored）。
- 定位：P4 交付的是**物理层**（V8 字节码执行前事件）；本提案打开**虚拟层**——VM 自己的指令流、虚拟寄存器值、运行期物化的表数据。目标是让瑞数级 JSVMP 的 cookie/签名计算从"黑盒"变成"可重建的计算图"。

## 1. 问题定义（由样本证实）

瑞数挑战层（三站四份脚本）的防御结构：LCG PRNG 洗牌构造字符串/操作码表 → `while(1)` 派发器按虚拟 PC 取指 → API 名全部运行期解码 → VM 算出 cookie → 服务端校验。由此推出四个"看不见"：

1. **虚拟指令流不可见**：P4 只能看到 V8 在跑派发循环，看不到 VM 实际执行的虚拟程序。
2. **虚拟寄存器值不可见**：计算过程的中间值全部在 VM 内部的 JS 数组/变量里。
3. **表数据运行期才物化**：`$_ts.cd` 大 blob 与 meta 加密内容只有解码后才成为可用常量表。
4. **环境读取面不可枚举**：API 名运行期解码，静态分析拿不到读取清单。
5. **挑战链在导航处断裂**：两段式挑战（412 脚本算 cookie → reload → 200 脚本续算/校验）是两次 VM 执行、两个 document——没有会话身份，T4/T5 的值观测只是两段孤立片段，"一阶段写出的 cookie 值是否就是重载请求里被校验的值"无法闭环断言。

本期目标是在自有或明确授权的实验中理解运行状态与计算证据，不从响应码/cookie外观推断服务端校验机制，也不承诺观测到几个值即可还原完整计算。三类能力分别解决执行点、值与快照的可见性，证据与推断边界见 §13。

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
- 产物：每条 tap 记录编译实例、物理 `v8_offset`、slot来源、执行前值/摘要、window与激活归属；这是**观测值流**。只有在选定探针角色和实例身份经验证后，分析层才能给出候选虚拟PC/opcode序列，两者分列，不自动把accumulator值改名为vPC（§13.2/§13.3）。

### 与 P4 的关系

不新增第二条观测通道：vPC tap 复用 observer 的 Entry 与 gate，只是事件负载多了 accumulator 字段；per-isolate 状态、范围启停、销毁顺序、弱回调两阶段语义全部沿用（P4 N1/N2 修复成果不得回退）。

## 4. 能力 T4-b：值级 tap（选择性执行点值观测）

### 机制

- 配置项：`(script, function?, offset_windows[], kinds[], budget)`；`kinds`：`accumulator` / `register_range(start,count)` / `frame_args`。
- 值形态以 §13.4 的安全值契约为准：标量有界值、字符串切片与截断信息、不可展开对象ref；TypedArray仅经引擎安全读取路径复制有界内容/元数据，**原生指针不进入产物或异步队列**；record/sequence不能因IDL类型就调用iterator/访问器，未知形态显式unavailable。
- 预算：每激活 N 条；超限计 `sampled_out`（启用 DP5 预留的等式扩展——这是其首次实际启用，规范 §7 的扩展式同步落文档）。
- 用途：补充已支持边界钩之间的局部运行值证据。0002的builtin/runtime钩不具备通用tier免疫；只在实际覆盖与身份、依赖证据成立时建立分析边，不能据此声称完整计算图。

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

1. **候选虚拟执行重建**：依据编译实例/调用片段/slot角色/缺口信息解释tap流，区分物理offset、候选虚拟PC与虚拟opcode；`activation_ref + 时序` 单独不足以证明序列归属。
2. **handler 语义提取**：vPC 值 → 对应 V8 子 trace（P4 事件）→ handler 语义指纹；跨多态会话按语义指纹聚类（打包层轮换不改变 handler 代码——三站样本已实证骨架一致）。
3. **字符串表收获**：dump 的解码表 + 使用点事件（属性名/内建参数）交叉补全。
4. **值关系图**：事件/值/资产按明确身份引用组织，直接传递证据与内容相等候选分列；仅 `activation_ref`、短窗口ref或相同值不能推出def-use。跨GC ref不稳定时不建立确定边，见§13.4。
5. **T3：分层环境读取证据清单（分析骨架可先行，完整输入待补）**。P4现有六字段可提供opcode到达事实；静态属性名还需新导出的operand/常量池，动态key和receiver归属还需运行值证据。清单按已解析/未解析条目记录顺序、offset、次数和来源，与bindings/impl交叉核对。不能把未采到的属性名/值或未插桩API标作observed；输入依赖与边界详见§13.2/§13.7。
6. **T7：可解释的部署形态候选分类（纯分析骨架可先行）**。输入同一可证明会话中的响应、脚本、cookie来源、导航和sink证据；输出family/mode/stages候选、置信/规则依据、缺失项与证据引用。状态码/URL等直接事实为observed，按规则重算事实为derived，机制/阶段的启发式判断为hypothesis，缺身份时unresolved。私有样本是补充研究输入，不硬编码站点/名称作为验收真值；合成正负例和泛化门槛见§13.7/§13.9。

T3/T7 的输入schema、合成fixture与分析骨架可先行；完整T3所需metadata/动态key及T7的nav身份尚有采集依赖。输出作为后续解释的候选与证据索引，不作为已证明虚拟执行的前提。

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

## 13. 总架构师设计复审与增强路线（2026-09-24）

### 13.1 从原始需求重排价值，而不是从样本形态倒推通用能力

复核输入：`docs/runtime-trace-plan.md:44–62` 的排序/归属/因果/值流/低扰动目标、`docs/tool-inventory.md` 中 `jsvmp_query/jsvmp_trace/closure_read` 的缺口、Firefox 迁移分析中帧/寄存器/闭包观测要求，以及本地三份语料 README。未执行语料、未联系原站；README 是来源说明与观察记录，不能把其推断都当成已验证事实。

原始需求真正要回答的是：**选定代码在什么输入、上下文和阶段下读取了哪些值、产生了哪些结果，以及哪些关联有直接证据。** 更好的增强主线是“可定位的运行证据 + 按需探针 + 有界值快照 + 可审查的分析假设”，而不是首期承诺“完整虚拟指令流/完整计算图/每会话一次dump就能还原”。

| 原始能力诉求 | 首期可交付的最小高价值结果 | 不得偷换的保证 |
| --- | --- | --- |
| 看清派发循环的执行 | 静态字节码元数据与执行轨迹对齐，输出候选循环/位置和证据引用 | V8 offset、虚拟PC、虚拟opcode是三种不同量 |
| 看中间值 | 可配置的执行前标量/寄存器范围快照，注明slot与采样位置 | 真值只属于该时刻，不自动证明谁定义/消费它 |
| 看初始化后表数据 | 有界、可重现的稳定数据切片，结构与内容摘要分离 | 一份表不等于完整VM语义或算法已还原 |
| 看环境读取 | 已解析静态key + 运行期key证据 + 未解析条目，标注receiver来源 | 非空清单不等于完整环境读取面 |
| 跨导航串联实验 | 可定位的文档/请求/状态变更关系与证据等级 | 同frame后继或值相等不自动成立因果 |
| 让工具可消费 | 统一只读索引/查询与机器可读能力、预算/缺口 | 不让每个分析器重新猜v3结构或复写身份系统 |

**保留的决策：** Entry起步、Exit后置；不新增capture状态机；V8到embedder单一边界；正常/异常结算和有界队列；只有明确范围的本地/自有或授权实验；原始trace不默认外发。

**须修订的决策前提：** §§3/9 将accumulator流直接称为vPC；§4将builtin hook称为tier免疫；§9.5承诺现有P4数据足以恢复动态key；§6把同frame和cookie相等称作因果闭环；§11预算与“首次完整激活”不相容；DP3静态IDL类型不能自动证明深序列化安全。项目架构师应先补契约、工程师先补反例，不直接沿这些前提开长程引擎块。

### 13.2 D1：先交付编译实例元数据，再建立值探针

当前边界 `v8/include/xtrace_observer_boundary.h:31–36` 只传script_id/version/offset/opcode/url；`Runtime_XTraceIgnitionObserve` 接收到accumulator但尚未发出。现有trace不含operand索引、常量池、register布局或源位置表。**T3不是“收集一次现成P4 trace就能纯离线恢复全部字段”**。

推荐最先补一个受控元数据资产，内容至少包括：编译实例的生命周期命名空间、脚本源摘要、bytecode版本、函数区间/可选名字、逻辑offset/opcode、经过筛选的operand与register数量、可安全保存的常量条目及source-position映射。每编译实例一次、后续事件只引用；large/非标量常量不展开，公开输出不含原生地址或代码指针。

- 建议键由 `capture + producer/process_epoch + isolate_epoch + script_id + bytecode_version` 共同定位（具体字段在规范定稿）；不要以URL/函数名当唯一键，同名匿名函数、eval、重编译、同URL不同源、跨isolate都必须可区分。
- scope中的URL是发现过滤器，不是probe最终地址。计划在已知元数据上绑定实例和逻辑offset；未知函数/越界register/非指令起点/旧版本必须拒绝或明确unresolved，不能落到另一个函数。
- 区间表应在**配置应用时**按目标元数据预处理，而不是假设重建Chromium才能变更tap窗口；运行时gate与查找零分配，不等于值序列化也能零分配。
- 元数据不齐时，T3保留 `key=unresolved`。`GetNamedProperty` 的key在operand引用的常量池中，不在opcode名称里；`GetKeyedProperty` 的key通常来自运行期值，静态常量表也不能普遍恢复；只有属性名也不证明receiver是navigator或DOM。

T3先行边界调整：可以立即开发输入schema、fixture和“已证key/未证key”的分析器骨架；缺元数据/运行期key的真实输入不得伪造填满。精确动态key读取面要等最小值tap接入，不再声称没有任何引擎依赖。

### 13.3 D2：tap采集事实与虚拟执行解释分离

Entry处的accumulator是**当前物理V8指令执行前的状态**。在载入虚拟opcode的物理指令之前，它往往还不是opcode；循环头也可能是比较值、累加值或前次调用结果。不能把“选到循环头、读到非空值”当作虚拟指令流验收。

建议计划显式区分 `value_role=unclassified|candidate_pc|candidate_opcode|operand|result_snapshot` 等分析标签（候选字段，需规范审查）；producer只记录来自哪个slot的值、时点、编译实例与window_id。虚拟PC应来自被验证的索引状态，虚拟opcode来自被验证的取指/解码结果，两者可由不同探针联合观察，不能用一个整数同时命名。

- 本期仍只做Entry；需要某条物理指令结果时选择验证过的后继Entry并说明异常/跳转路径，不声称已有完整after-op。复用传入的accumulator handle，不未经论证重读已变化的栈槽；frame/register读取必须在所属isolate线程、合法布局和GC作用域内完成。
- `activation_ref` 现主要指Script.evaluate同步激活，不是任意JS函数调用身份。递归、同函数多次调用、generator/async暂停恢复必须有可区分的调用/恢复片段标识或明确限制；不能将同一脚本激活下所有tap直接串为一个VM执行。
- 验收采用**自有合成解释器**：PC与opcode值不同、有循环回跳、同opcode重复、变长指令、分支、嵌套/递归、暂停恢复；对已知程序逐事件核对slot、时序、PC与opcode。保留反例：在错误Entry读到值时应输出unclassified，而不是“识别成功”。
- builtin/CSA/Torque hook 不具备通用tier免疫，P4已记录优化器内联/替换会绕过部分路径。以能力矩阵和实际tier证据为准，删除“边界钩必全覆盖所以能拼完整图”的推理。

### 13.4 D3：值编码要按运行期形态守边界，禁止输出裸指针

P5当前实际交付的是入口/部分outcome，不是DP3值序列化器；且P5已被本轮反例重新打开。**不得将“IDL类型已知”当作no-getter/no-Proxy保证**：IDL转换本身可调用用户代码，dictionary可能由Proxy传入，sequence可能通过iterator获取，Window等宿主对象也不等价普通JS对象。

建议分两层交付：

1. **最小tap**：undefined/null/boolean、数值（含NaN/Infinity/-0）、BigInt的有界表达、字符串有界切片、不可展开对象ref。记录 `value_state=captured|truncated|unavailable` 与原因，缺值不编码成空串/0。
2. **dump增强**：仅对明示支持的普通对象own-data slots、数组/TypedArray/ArrayBuffer等内部可安全路径做有界拷贝；遇accessor、Proxy、interceptor、弱集合、宿主安全检查或未知exotic对象，跳过并记录原因。禁止走通用 `obj[key]`、Reflect枚举、用户iterator或toString来“只读”抓值。

TypedArray的原生地址仅能作为引擎内部短期读取实现细节，**不得写进trace、传过异步队列或交给离线工具**。保存元素类型、byteOffset、原长/保存长、内容资产引用；处理detach/resize/OOB、SharedArrayBuffer并发变更。shared内存快照不是天然一致，首版可不支持；不能以锁住页面/暂停worker暗中换取一致性。

`depth≤2,width=256,16KB转资产`不是总内存预算：每个叶子可以是超长字符串，图还有重复/环。还必须配置总节点、总读字节、单值字节、单dump字节、capture总资产字节与工作量上限；16KB只是内联/资产分流阈值，不是安全上限。摘要只覆盖实际保存字节时必须如此标明，不为计算“完整hash”遍历超预算大值。

对象ref若仅best-effort地址派生，则不能用来建立确定的跨GC数据流。高价值方案是有界的isolate/capture内对象token，使用已验证的GC生命周期管理；首版若成本过高，可以限制为单快照身份并把跨事件相关标为hypothesis。数据值相同/hash相同只证明内容相似，不证明赋值/因果；真DAG边须注明传递证据，不伪造def-use。

验收加入getter/Proxy/iterator计数哨兵（观测前后额外调用数必须为0）、抛错访问器、循环图、大字符串、稀疏数组、detach/resize、BigInt与特殊数字、GC搬迁/释放，以及开启/关闭观测的JS语义对照。

### 13.5 D4：预算按探针机会计数，传输完整与观察完整分开

当前默认 `N=2000/activation`、`512/window` 可以作为诊断起步值，**不能同时保证10⁴～10⁵次循环的首次完整激活**。超过512次的同一探针必截断；计数器应使分析器知道断在哪里，不能仍拼接成无缺口虚拟程序。

`nadc_partial`只是P5另计的观察缺失，未直接参与eligible等式；把它推广为sampled_out不是复制字段这么简单。项目架构师需冻结：

- 什么是一次eligible tap机会：先符合scope/版本/window/kind，再分配序号并做预算；多个重叠窗口按明确规则去重或各算一个逻辑tap，不能临时由实现决定。
- 预算跳过 `sampled_out`、队列失败 `dropped`、写盘失败 `failed`、值不可读取 `unavailable`、停止/未选中“不在范围内”分开记账；dump资产的bytes计数独立，不把资产大小算成事件数。
- 每window的seen/recorded/skipped、首末位置和缺口段绑定generation；发生配置更新时重置还是延续必须确定；counter溢出/未确认watermark保持unknown纪律。
- `eligible=enqueued+dropped+sampled_out` 的分母与全局合计必须在producer/writer/manifest/validator一致，且旧v3文件需要有明确accounting-model/revision区分。只改文档v1.2→v1.3不会自动让旧consumer识别语义改变。
- 建议状态分两轴：传输结算 complete/incomplete 与观测coverage full/partial/unknown。即便已记录数据完整落盘，只要budget截断，分析输出必须显示partial；若要让现有complete语义包含sampled capture，先正式修订契约，不能悄悄把完整性的含义放宽。

增强建议：先实现每window独立命中序号、first-K/nth-hit/明确区段三种可重现探针计划中的最小一项，分析器根据缺口请求**新的独立实验**补充；不能把不同输入/不同会话的分段拼成一次完整执行。随机采样不是首版默认，也不默认增加N掩盖成本。

### 13.6 D5：nav_chain是生命周期骨架，不是自动因果证明

同frame document successor是值得优先补的基础能力，但关系至少区分：已提交导航、reload、redirect request hop、被取消/失败导航、同文档导航。一次HTTP redirect未必创建document，不能按每个状态码建立一条文档后继；同frame跨renderer切换也必须保留关系，不能因为“跨进程不在范围”而丢掉普通导航。

当前事件经常 `attribution=unresolved`，P3终态frame快照没有历史绑定。**事件行不新增字段**只有在现有事件能用稳定key关联到对应document时才可成立：项目架构师须定义 producer/context/script activation → document 的身份映射和生效区间，按实际生命周期记录，不靠URL+时间最近邻。不能只在manifest新增一组from/to文档就宣称任意tap已可入链。

cookie硬锚点也需修改：本地语料README自己记录了**响应 Set-Cookie 的 HttpOnly cookie**；JS `document.cookie`不能读取或覆盖同一HttpOnly cookie，不能预设它由脚本算出。需区分server-set、script-write-attempt、browser实际接受的变更和request实际发送四种事实，键含name/domain/path/partition与相关属性，不只比较value。一次赋值可能被拒绝/覆盖；同名不同path、旧会话cookie、编码/截断、多个请求都能制造假匹配。

首期用自有本地“两文档导航+脚本可写cookie”的fixture验证请求承接，另加HttpOnly由服务端设置的负例、重复值/同名不同path、导航取消/跨进程fixture。对缺少浏览器接受结果或身份绑定的边，只能输出candidate/unresolved，不声称已证明服务端验签逻辑。

T2阶段识别不以随机路径/版本标记硬编码为确定会话身份；先用nav关系及脚本源/激活来源组织候选，再以规则和证据解释stage。handler相似只能是分析候选，不能“兜底”修复缺失的会话身份。

### 13.7 D6：T3/T7输出分层，并为真实输入缺失建立拒绝/未知分支

- **T3**：先列 observed opcode/边界事件；有operand+常量池才能 derived static property name；动态key/receiver未采到必须unresolved。不能仅从 `GetNamedProperty` 推导环境类别，也不能凭属性名或源码同名变量确定对象归属。接口层bindings/impl事件作为交叉证据，而不是宣称未插桩API全覆盖。
- **T7**：412→200只是一段响应序列，随机URL、特定cookie名或版本后缀都是可变特征。缺nav/请求归属时保留多候选与confidence/证据引用；启发式归类用hypothesis，不因它由程序计算就升级成“事实已derived”。规则确定推出的仅是“满足某规则”，不是部署机制真值。
- 本地材料分别来自curl/浏览器、不同运行/环境，不可直接拼接成一条observed会话；文件名、版本相似或两个脚本都可运行不证明相同会话。`curl空响应`也不足以单独证明TLS指纹过滤，需保留连接失败等替代解释。
- T7可先行做schema、已知输入的规则测试和未知分支；T3可先行做索引/元数据消费骨架，但不能在缺必要字段时只要求“输出非空”。

本地重放不天然隔离：HTML脚本可能保留原站URL、动态fetch/导航/WS/SW；`--disable-background-networking`不阻止页面主动联网。真实语料动态实验必须有明确授权、网络出口隔离/请求白名单和拒绝日志，且不复用生产cookie/profile；仅拦主页面fetch不是完整隔离。没有此环境时只做静态读取或自有合成fixture。本轮不提供针对第三方防护的绕过流程或默认现场采集任务。

### 13.8 推荐增强优先级与角色分工

| 阶段 | 项目架构师先冻结 | 资深工程师交付 | 放行证据 |
| --- | --- | --- | --- |
| P55-A0：需求/输入契约 | 本节D1～D6、P5尚缺能力、支持类型/脚本来源、accounting修订 | 自有fixture、数据schema、拒绝/unknown单测、输入字段可用性检查 | “每一项分析所需字段在哪里”可回答，不依赖假定已采到 |
| P5-C0～C4（前置功能线） | P5 §14成员/路径与安全边界 | 修Fast API语义、outcome/coverage/precise并复验 | 关闭采集不改变API、fast拒绝真实命中、P5新反例全过 |
| P55-A1：元数据与只读索引 | 编译实例/函数/offset命名空间、资产schema | 每实例有界metadata资产、v3读入、目标筛选与引用查询 | 同URL异源、重编译、不同isolate、缺metadata不误连 |
| P55-A2：最小值tap | 配置接受/生效/generation、slot与预算语义 | Entry标量/有界字符串+register范围，原子安装计划，stop/超限记账 | 已知合成程序逐条真值、on/off语义、异常/预算/GC均可核 |
| P55-A3：安全dump | own-data类型白名单、图/bytes总预算、shared一致性边界 | 最小普通对象/数组/二进制切片，unsupported原因、资产摘要 | getter/Proxy/iterator额外调用0、环/超大值/缺失有界 |
| P55-A4：导航与阶段 | 同frame历史关系、事件到document绑定、cookie来源与边等级 | 本地可审计实验链、nav manifest、T7可解释候选 | 取消/重载/HttpOnly/重复值负例，无假因果 |
| P55-A5：证据驱动分析 | vPC/虚拟opcode/物理offset分列，DAG边等级 | T3分层清单、候选循环、声明式探针计划、按证据定位/回放比对 | 合成golden与未见变体、错误probe/缺口/假匹配负例 |

**更有价值的增强方向（有序，不要求一次全做）：**

1. **证据浏览与差分优先。** 在trace/schema可读层补“事件→元数据→值→资产”的跳转和两次受控实验差分，展示缺口/未解析原因；这比先把全部结果画成看似确定的DAG更能支持工程判断，也能优先偿还analyzer/GUI v3消费欠账。
2. **按问题生成探针，而非默认全量抓值。** 分析器先输出候选与所缺字段，再提出带window_id/预算/作用域/预期验证的声明式计划，由操作者确认；计划不得执行任意回调或改变页面逻辑。计划摘要进manifest，报告能重算“为何观察这一点”。
3. **内容去重与对象身份分离。** 大表按内容资产复用以减IO，状态对象按有界生命周期token引用；同内容不合并对象，同对象不同时间版本不覆盖旧值。
4. **分析可靠性作为产品字段。** 每项结论附observed/derived/hypothesis/validated/unresolved、证据ID和适用输入；预算外、native/JIT未覆盖、脚本未捕获等作为显式缺口。少给结论也优于补造完整链。
5. **用未见合成变体验泛化。** 至少含不虚拟化的普通循环负例、动态属性键、多层解释器、表初始化晚于脚本入口、同URL内容轮换和跨导航失败；真实私有语料只作授权下的补充，不把“3站4脚本全命中”当通用算法证明。

新增tap/dump功能原型可并行开发schema/测试，真实引擎接线在A0契约与P5安全基线确认后推进。无需恢复全量编译做设计验证；源稳定后再通过资源协调器做必要增量与回归。

### 13.9 验收矩阵必须从“非空”改为“有真值与反例”

| 维度 | 正向 | 负向/边界 |
| --- | --- | --- |
| 元数据/身份 | 每条tap可定位实例、函数、slot、window | 名字重复、同URL异源、旧版本窗口、register越界必须拒绝/unknown |
| 值语义 | 合成程序真值、特殊标量、明确pre状态 | 错误tap位置不是vPC；getter/Proxy不触发；shared不声称原子 |
| 预算/故障 | 0/1/N/N+1边界、重叠窗口规则、完整计数 | skip/drop/fail不混记，stop后不再捕获，未知尾部不补0 |
| dump | 有界数据切片+摘要+结构一致 | 超大叶子、环、detach/resize、缺资产、值截断不伪造原hash |
| 导航/阶段 | 本地文档后继+请求归属+可写cookie承接 | HttpOnly来源、同值/同名path、取消导航、跨进程不误连 |
| 分析 | 已知合成VM程序与参考轨迹一致 | 普通while循环/错误候选/缺key/未见变体不过拟合 |
| 回归/资源 | 既有P2～P5契约、实际优化层、有限开销 | “A/B没看到差异”只写本次分辨率内未检出，不能用5次min/median/max宣布统计等价；首次安全预算不能被性能试验绕过 |

项目架构师下一次提交应是**修订后的字段/生命周期/计账/支持边界+矩阵**，而非仅把现有六决策点再勾一次；工程师下一次提交应给出可移植fixture、每项缺口的实际反例和必要最小数据接线，不做未授权第三方现场验证。六项原决策中不受本节影响的复用与边界继续有效，冲突内容以本节的修订门为准。
