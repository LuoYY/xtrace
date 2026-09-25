# P5.5 设计契约：值观测二期（v2.0 定稿）

- 版本：v2.0（2026-09-24，设计契约定稿）。v1.0–v1.3 为提案与裁决轮；本版并入 [总审 §13](chromium-p55-value-observation-design.md)（若本文件与原设计文档并存，以本契约为准）、[§15 架构师裁定](chromium-p5-webidl-generator-handoff.md) 与 P5-R1 教训；原设计文档保留作历史。
- 依据：P2/P3/P4 已冻结设施、P5 交付（含重开整改）、trace-schema-v3、真实语料（`analysis/pmos-*-sgcc-20260923/` + 本次采集 `analysis/corpus-capture/`）。
- 状态：**契约为验收依据，不代表实现通过。71a69c1 整改复审仍为 changes required**，最新裁决与 S0～S6 执行任务见 [执行工单 §12](chromium-p55-execution-handoff.md)。旧反例部分修复、echo本地oracle获认可；但dump任意表达式求值/多renderer广播/超时栈指针、controller旧计数式、每激活预算和完整实例身份未闭合。不得把后者自动登记为不阻塞的后续项；根定位同样须遵守不执行用户代码、唯一目标和stop范围纪律。

## 1. 目标与交付框架

**首期交付框架：可定位的运行证据 + 按需探针 + 有界值快照 + 可审查的分析假设。** 不做以下承诺：完整虚拟指令流、完整计算图、"一次 dump 即还原"。所有分析输出按五级纪律分级（observed / derived / hypothesis / validated / unresolved），分析器不得把 hypothesis 级输出冒充已还原算法。

问题定义（由样本证实）不变：瑞数级 JSVMP 的虚拟指令流、虚拟寄存器值、运行期物化表、环境读取面四项"看不见"，且两段式挑战链在导航处断裂。本契约给出逐项的证据获取与分级规则。

## 2. 设计原则（硬约束）

1. **产品行为零改变**（P5-R1 教训成文）：观测永远不决定业务是否执行。任何"用 capture 门包住 API 本体"的形态禁止——NADC 修复确立的"`retval = call(); if (TryEnter()) observe; return retval;`"是唯一合法形状。
2. 范围限定：tap/dump 只在选定 script + 函数 + offset 窗口内生效；精细模式环境之外不启用。
3. 构造性不调用用户代码：值捕获只做类型分派；IDL 转换可能调用用户代码这一事实意味着**捕获点必须位于转换之后、且不自己解引用对象**（own-data slots 见 §5）。
4. GC 安全沿用 N1 教训：事件/资产不持 V8 堆指针；新弱引用一律两阶段回调。
5. 计数契约不破坏；突发量由有界缓冲 + drop-newest 兜底。

## 3. 编译实例元数据资产（D1，首个引擎交付物）

现有边界头只传 script_id/version/offset/opcode/url——**不足以做 key 解析与 tap 定位**。D1 是本阶段第一个引擎交付物，先行于一切值探针：

- **内容**：编译实例的生命周期命名空间、脚本源摘要（sha1 + 长度）、bytecode_version、函数区间与可选名字、逻辑 offset/opcode 全表、经筛选的 operand 与 register 数量、可安全保存的常量条目、source-position 映射。大/非标量常量不展开；**公开输出不含原生地址或代码指针**。
- **频率与引用**：每编译实例一次；后续事件只引用实例键。
- **键组成**：`capture + producer/process_epoch + isolate_epoch + script_id + bytecode_version`。URL/函数名只是发现过滤器，不是键（同名匿名函数、eval、重编译、同 URL 不同源、跨 isolate 必须可区分）。
- **绑定与拒绝**：探针在已知元数据的实例与逻辑 offset 上绑定；未知函数、越界 register、非指令起点、旧版本——拒绝或明确 `unresolved`，不得落到另一个函数。
- **预处理时机**：区间表在**配置应用时**按目标元数据预处理（不假设重建 Chromium 才能改窗口）；运行时 gate 与查找零分配，但值序列化本身不承诺零分配。

## 4. 值级 tap 契约（D2 + D3）

### 事实与解释的分离（D2）

- Entry 处读到的 accumulator 是**当前物理指令执行前的状态**——它是候选值，不是虚拟操作码。循环头处也可能是比较值/前次调用结果。
- 事件必须携带 `value_role`（候选枚举：`unclassified | candidate_pc | candidate_opcode | operand | result_snapshot`，经规范审查后定稿）；producer 只记录"值来自哪个 slot、什么时点、哪个编译实例、哪个 window_id"，**不命名虚拟语义**。虚拟 PC 与虚拟 opcode 须由被验证的探针联合观察得出，不能用同一个整数兼任两个含义。
- `activation_ref` 承接 v2 同步激活身份，**不是任意函数调用身份**：递归、同函数多调、generator/async 暂停恢复必须有可区分的调用/恢复片段标识，或首期明确限制为"只在单函数激活内串接，跨调用链接标 hypothesis"。
- **删除"builtin hook tier 免疫"推理**（与既定事实边界 #5 对齐）：优化器可降低/替换/消除调用，钩只在调用真实发生时触发；以能力矩阵与实际 tier 证据为准，缺口如实进覆盖表。

### 值编码（D3，两层）

1. **最小 tap**：undefined/null/boolean；数值（含 NaN/Infinity/-0）；BigInt 有界表达；字符串有界切片；不可展开对象 = 短窗口 ref。记录 `value_state=captured|truncated|unavailable` 与原因，缺值不编码成空串/0。
2. **对象 ref**：若仅 best-effort 地址派生，**不得建立确定的跨 GC 数据流**——跨事件相关标 hypothesis；高价值方案（有界 isolate/capture 内 token + 已验证 GC 生命周期）成本过高时，首版限制为单快照身份。
3. **TypedArray**：原生地址仅为引擎内部短期读取实现细节，**不得写进 trace、不得过异步队列**；只存元素类型、byteOffset、原长/保存长、内容资产引用；处理 detach/resize/OOB；SharedArrayBuffer 首版不支持（快照不保证一致，不用锁页面换一致性）。

### 验收哨兵

getter/Proxy/iterator 计数哨兵（观测前后用户代码调用数必须为 0）、抛错访问器、循环图、大字符串、稀疏数组、detach/resize、BigInt 与特殊数字、GC 搬迁/释放、开启/关闭观测的 JS 语义对照。

## 5. 物化 dump 契约（D3）

- **深序列化边界**：仅对普通对象 own-data slots、数组/TypedArray/ArrayBuffer 的内部安全路径做有界拷贝；accessor、Proxy、interceptor、弱集合、宿主对象、未知 exotic 一律跳过并记录原因；不走 `obj[key]`、Reflect 枚举、用户 iterator、toString 来"只读"抓值。
- **预算总量轴**：`depth≤2, width=256, 16KB` 只是分流阈值，不是内存上限。必须另有：总节点数、总读字节、单值字节、单 dump 字节、capture 总资产字节、工作量上限。摘要只覆盖实际保存字节时必须如此标明。
- **锚点**：`anchor` 增 `window_id` 回引（配置自描述，分析器免二次对齐）；`asset_refs` 四元组冗余随事件。

## 6. 预算与探针计划（D4）

- **预算不承诺完整覆盖**。默认 N=2000 tap/激活、512/offset 窗口仅为诊断起步值（语料实测校准：挑战 VM 在 max-opt=0 下约 17K ignition 事件/秒、单 25s 运行 40 万+ 事件——窗口必然截断）。
- **探针计划**：首期实现 first-K / nth-hit / 明确区段三种可重现计划中的最小一项；每 window 记录 seen/recorded/skipped 与首末位置，缺口段绑定 generation；分析器据缺口请求**新的独立实验**补齐，不把不同输入/不同会话的分段拼成一次执行。随机采样不是首版默认。
- **eligible 定义**：先符合 scope/版本/window/kind → 分配序号 → 预算；重叠窗口的去重规则在规范中定死，不由实现临时决定。
- **记账扩展**：`sampled_out`（预算跳过）、`dropped`（队列失败）、`failed`（写盘失败）、`unavailable`（值不可读）、范围外分开记账；dump 资产字节独立，不算事件数。沿用 P5 `nadc_partial` 已落地的 watermark 计账模式推广；等式 `eligible = enqueued + dropped + sampled_out` 随规范升 v1.3 生效，validator 同步。
- **完整性两轴**：传输结算（complete/incomplete）与观测覆盖（full/partial/unknown）分列；预算截断的 capture 即使数据完整落盘，分析输出必须显示 partial。等式/全局合计在 producer/writer/manifest/validator 一致；**旧 v3 文件以 accounting-model revision 区分**，只改文档不会让旧 consumer 识别语义变化。
- **计数器语义**：配置更新时各计数器重置还是延续必须确定；溢出与未确认 watermark 保持 unknown（null）纪律。

## 7. 挑战会话身份（T1/T2）

- nav_chain：导航后继以 succession 记录进 `manifest.identity` 段（事件行不加字段）；同 frame 导航序列共享 `nav_chain_id`。
- **锚点**：一阶段写入的 cookie 值在重载请求 Cookie 头中可定位——保留为验收锚点，等级为 **derived 级强证据**（值相等 + 链身份 + 时序），不称"闭环因果"（值相等不自动成立因果，语料已知 cookie 为服务端下发的一次性材料，该证据强度足够但措辞必须诚实）。
- 范围：只交付同 frame 导航后继子集；BFCache/redirect 全景/跨 frame 归 P3 身份修订。
- VM 会话关联：同 nav_chain 内挑战脚本激活按文档顺序编 stage；T4/T5 产物按 `(nav_chain, stage)` 成组呈现。

## 8. 配置接口与 v3 契约演进

- `startCapture` 的 `valueObservation` 子段（不造第二套生命周期）；`getCapabilities` 披露 `valueObservation.windows` 与 `budget.maxTapsPerActivation`。
- v3 规范升 v1.3 时合并 P5 终审修订（顶层 channel、`selected_overload`、`nadc_partial`）为正式条款，并写入 accounting-model 扩展；消除双修订层。
- 新事件形状：`value_tap`/`dump`/`metadata_ref` 字段按"只加字段不改语义"演进；规范定稿时冻结。

## 9. 分析层契约

- **T3 环境读取还原**：骨架（输入 schema、fixture、已证/未证 key 的分析器）可先行；**完整 key 解析依赖 §3 元数据资产**——`GetNamedProperty` 的 key 在常量池（D1 可解析），`GetKeyedProperty` 的 key 多为运行期值（不可普遍恢复，如实标 unresolved）。非空清单不等于完整环境读取面。
- **T7 部署形态判定**：全部输入来自现有 capture；DP6 落地前的近似证据标注 derived 级。
- **vPC 序列重建 / handler 语义提取**：输出为 hypothesis 级；跨多态会话的语义聚类（打包层轮换不改变 handler 代码——三站样本已实证）是分析器的推断，不是引擎事实。
- **值流关联**：真 DAG 边须注明传递证据；值相等/hash 相等只证明内容相似，不证明赋值或因果。

## 10. 验收

| 验收 | 内容 |
| --- | --- |
| 合成解释器 fixture | `test-pages/` 类 VMP 派发器页：PC 与 opcode 值不同、循环回跳、同 opcode 重复、变长指令、分支、嵌套/递归、暂停恢复；对已知程序逐事件核对 slot、时序、PC/opcode；读到错误 Entry 的值必须输出 `unclassified` 而非"识别成功" |
| 语料三站（本地复跑，不回连原站） | 派发器自动定位在三份 bundle 全部命中；T3 读取清单非空、已证/未证 key 分列；wrapper + 死代理护栏的采集步已交付（见附） |
| 挑战会话闭环 | 两段式站点：cookie 值锚点（derived 级）+ nav_chain 归属断言 |
| §4 哨兵矩阵 | getter/Proxy/iterator 零增量、抛错访问器、循环图、大字符串、稀疏数组、detach/resize、BigInt/特殊数、GC 搬迁、观测开/关 JS 语义一致 |
| 引擎四态 | NADC 形态沿用 P5 修复的强制 fast API 四态矩阵（关/开/未配置/满队列/stop 后），API 行为与对照一致 |
| 计数与回归 | 等式/终态不被 tap/dump 破坏；sampled_out 记账正确；**全部门禁含全部测试目标（content_unittests/blink_platform_unittests 同步重建）**；契约 21/21、矩阵、故障、parity、375/28/211 |

## 11. 决策点（v1.3 裁决，维持）

1. tap 注入点：Entry+谓词起步（offset 区间编译期预编译、二分查找、零分配），Exit 后置。
2. 接口形状：`startCapture.valueObservation` 子段。
3. 预算：N=2000/激活、512/window 起步；sampled_out 推广 nadc_partial 计账模式。
4. dump：深度 2/宽度 256/16KB 阈值 + §5 总量轴；anchor 增 window_id。
5. 字段清单：§8 演进规则。
6. nav_chain：succession 进 manifest.identity。

## 12. 非目标

不做全量 post-op 值观测；不做精确 def-use 全程跟踪；不承诺完整虚拟指令流/计算图；不对未授权目标启用；不对时序门活目标承诺隐形（线上常规模式、深挖用重放）；TypedArray 裸地址不进 trace；accessor/Proxy 深拷贝不做。

## 13. 修订记录

- **v2.0（2026-09-24）**：并入总审 §13（D1–D4）与 §15 裁定；交付框架改为"证据+探针+快照+假设"；新增 §3 元数据资产为首交付物；§4/§5 按运行期形态重写值编码与深序列化边界（禁裸指针、own-data slots）；§6 预算探针计划化与完整性两轴；§7 锚点降为 derived 级；新增"产品行为零改变"原则（P5-R1）；语料实测校准写入 §6（17K 事件/秒）；验收增哨兵矩阵与"全部测试目标"门禁。
- v1.3（2026-09-24）：六决策点裁决。
- v1.2（2026-09-23）：分析层 T3/T7。
- v1.1（2026-09-23）：T1/T2 挑战会话。
- v1.0（2026-09-23）：架构师提案。

## 附：语料采集步记录（2026-09-24，架构师执行）

- **方式**：本地 serve 已捕获语料（`python3 -m http.server 8799`），wrapper 页面注入各站 `$_ts.cd` blob 后加载本地 bundle；patched ChromiumX，causality=sync + `--xtrace-ignition-observer` + `--js-flags=--max-opt=0`（P4 精细环境）；**死代理护栏**（`--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1`）保证任何外联即时失败——**未回连原站**；挑战脚本经 grep 确认零外站硬编码。
- **产物**（`analysis/corpus-capture/`）：

| 站点 | bundle | 事件总数 | ignition |
| --- | --- | ---: | ---: |
| xj1 | W1bH0CpS9gGF（357KB） | 435,553 | 428,054 |
| sc | Et7GvjDbH0Mg（180KB） | 378,795 | 370,798 |
| jibei | dgriSjYT5mQe（257KB，配对 xj blob） | 463,995 | 456,137 |

- ignition 事件六字段形状实测在位（`script_id/bytecode_version/bytecode_offset/opcode/tier/activation_ref`）；builtin 家族事件带值并存（Bitwise.and/DataView.getUint32 等）；终态 browser-shutdown/incomplete（定时采集路径的预期终态）。
- **边界如实**：本地上下文无服务端挑战材料，VM 行为与活站不同（输入 blob 为历史会话材料）；T3 的"环境读取清单"在此语料上仍然成立（环境读取在 VM 内核路径上），但"cookie 计算链"类断言须等授权现场。jibei 原始 200 页 blob 缺失，已用同族 xj blob 配对（观测目标是 bundle 内核，配对关系记入 `corpus-manifest.json`）。
- XJ 二阶段脚本（UedhOAXnElXv）的原始 blob 不可得，本批语料不含；后续如获授权现场再补。
