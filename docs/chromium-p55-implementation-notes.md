# P5.5 实施侧意见（设计 v1.2 六决策点 + T3/T7 先行评估）

- 版本：v1（2026-09-24，实施方提交，供架构师裁决参考）。
- 对象：[P5.5 设计 v1.2](chromium-p55-value-observation-design.md) §11 决策点 1–6；§9.5/9.6（T3/T7）先行交付评估。
- 立场：六项均**同意推荐方案**，以下为实施侧补充的机制事实、参数建议与风险边界，供裁决时替换"待定"项。

## 1. 决策点逐项意见

### DP1 tap 注入点：同意 A 起步、B 后置

- 实施事实：P4 observer 的 Entry 插桩已在 V8 解释器派发循环头部读取 accumulator（vPC tap 是同一读取 + offset 谓词），per-isolate 状态/范围启停/两阶段弱回调全部复用，不新增第二条观测通道——与设计 §3 的"复用"判断一致。
- 风险与对策：**逐事件谓词成本**。Entry 事件在派发循环上全量发生，谓词必须零分配、O(log n)：建议编译期把 offset 窗口预编译为 per-function 有序区间表（挂 script 元数据，二分查找），运行期不建任何容器。
- 附带意见：候选 B（Exit 变体）后置正确——语义是"执行后结果"，与 A 的"执行前状态"互补但先解决主要矛盾。

### DP2 接口形状：同意 (a) startCapture.valueObservation 子段

- 实施事实：B1 教训在 P5 内再次验证——capture 生命周期/watermark/终态是单一状态机（P2/P3 交付），第二套生命周期意味着第二套结算与故障语义。valueObservation 作为子段直接继承 stop 的 settlement 与 manifest 自描述。
- 补充建议：`getCapabilities` 披露 `valueObservation.windows`（可用粒度：script/function/offset）与 `budget.maxTapsPerActivation`，与 P5 webidlCoverage 同风格（生成/配置期冻结披露）。

### DP3 预算默认值与 sampled_out 记账

- 建议初值：**每激活 N=2000 tap、每 offset 窗口 512**；dump 深度 2 / 宽度 256 / 资产阈值 16KB（同意设计默认）。
- 依据（语料实测）：瑞数挑战脚本派发循环迭代量为 10^4–10^5 量级（357KB 脚本、全量运行期解码），N 太小则 vPC 序列断在中段、重建价值骤减；预算内先覆盖"首次完整激活"（对应设计 §4 的 first-activation 采样意图）。
- sampled_out 记账：**沿用 P5.5 修复刚落地的 watermark 通道**——nadc_partial 的计账模式（producer 侧原子计数 + watermark 结算 + manifest 披露 + 未确认 null 纪律）可直接推广为 `sampled_out`，等式扩展 `eligible = enqueued + dropped + sampled_out` 落 v1.3 时同步进 validator（等式检查已有先例：dropped 分支）。

### DP4 dump 对象图边界：同意默认，阈值参数化

- 深度 ≤2、宽度上限、16KB 走资产通道：同意。大数组（S-box/字节码表）复用 dynamic-code 资产通道的 sha1 去重与 `retrieval_status`（v3 §5.3）——通道已验证（P3/P4 矩阵资产断言）。
- 补充：dump 事件的 `anchor` 建议增加 `window_id` 回引（配置自描述，分析器免二次对齐）。

### DP5 v3 字段清单：同意形状，两处补强

- `value_tap.values` 用 DP3 分派形态（P5 DP3 已裁决的静态表语义，本批未实现值捕获——P5.5 首次真正落地，注意与 P5 交接 §10.2 的"值捕获后续"衔接，不重复造第二种形态）。
- v1.2→v1.3 升版时同步把 **P5 终审修订**（顶层 channel、selected_overload、nadc_partial——已按"只加不改"进 v1.2 修订段）合并为正式条款，避免两个修订层。

### DP6 nav_chain 身份模型：同意 succession 进 manifest.identity

- 实施事实：P3 已交付 manifest.identity 的 frame_tree_node_id → document_token 映射；导航后继是同段增量（browser 侧 NavigationHandle 观测），事件行不加字段与 crosswalk 决策一致。
- **硬验收锚点已具备两侧前提**：renderer cookie 钩与 browser-network producer 均带值（P5 证据里 BrowserNetwork.request 头部截断四元组与 cookie 事件并存）；"一阶段 cookie 值在重载请求 Cookie 头中定位 + 两端同 nav_chain"可直接由现有事件流断言，不需要新采集语义。
- 范围边界同意：BFCache/redirect 全景/跨 frame 归属留 P3 身份修订（三站样本均同 frame ��段式，本子集够用）。

## 2. T3/T7 先行交付评估（可独立先行，确认）

- **输入前提缺口**：语料库（`analysis/pmos-{xj,sc,jibei}-sgcc-20260923/`）含四份挑战脚本 + DOM/环境快照，**无 observer trace**。T3 的输入是"四份脚本的 observer 流"，需先补一个采集步：本地 serve 语料脚本 + 现有 P4 observer（scope selector 按 URL 模式圈定挑战脚本）capture——全部用已交付设施，无引擎依赖，与"纯分析层先行"的定位一致。
- T3（环境读取面还原）：常量池解析在 v8 层已有 bytecode_offset/opcode 事实（P4 六字段），GetNamedProperty/CallProperty 流 + 常量池还原为离线分析；验收按设计 §10 行（非空、可与"源码中不存在的解码 API 名"互证——语料 README 已实证静态 grep 无明文，互证判据成立）。
- T7（部署形态判定）：输入全部来自现有 manifest/事件（状态码、URL 形态、cookie 事件、导航后继、sink）；注意 T7 的"导航后继"输入在 DP6 落地前可用 412→200 的响应码序列 + 两脚本 URL 形态近似——判定器输出标注 derived 级（五级纪律）。
- 建议顺序：裁决后先跑 T3/T7 采集步与分析器（不动引擎），与 DP1–6 的引擎实现并行；T3 输出同时是 §9.1 vPC 重建的输入契约验证。

## 3. 资源与风险

- 引擎侧改动集中在 0002（V8 observer 扩展）与 0001/0003（producer/预算/watermark 推广），补丁栈本批已转为按文件不相交所有权、机械可再生——P5.5 迭代时重生成成本低。
- 主要技术风险：Entry 点读帧的谓词成本（对策见 DP1）；值捕获的 GC 安全（沿用 N1 教训：即时序列化、不持堆指针——设计 §2.5 已列）。
