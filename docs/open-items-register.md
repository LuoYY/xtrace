# 开放项登记册（债务 / 边界 / 设计 IOU / 外部依赖 / 授权门槛）

- 版本：v1.1（2026-09-27，项目架构师；P6 R3 复审后更新：M2 名下 8 项全部关闭，新增 3 条 M3 进入条件债务）。**唯一跨阶段汇总处**：各阶段的细节仍以其交接文档为准（本册只登记"归谁、在哪一档关、证据在哪"），避免同一债务在多处漂移。
- 维护规则：① 每轮终审由架构师更新本册（新增/关闭/改归属）；② 关闭一项必须有证据指针（门禁名 + 证据目录），不许以"已修"字样关闭；③ 类型分五种——**债务**（必须修）、**边界**（不修，但引用结论时不得越级）、**设计 IOU**（欠一份设计文档）、**外部依赖**（不在我们手里）、**授权门槛**（需用户显式授权）；④ 归属里程碑变更走裁决。

## 1. M2 名下（P6-R2）—— **全部关闭**（2026-09-27，R3 复审，`accepted-p6`）

| ID | 项 | 类型 | 状态 | 证据/指针 |
| --- | --- | --- | --- | --- |
| R2-A | UI 计账披露退步：面板丢弃计数恒为 0、未确认 producer/terminal_reason 不再渲染；`enrichStatusRows` 零消费者；S3 断言被削弱 | 债务 | **关闭 09-27** | [P6 交接 §R2.3-A](chromium-p6-execution-handoff.md)；`docs/review-artifacts/p6-r2/probe7-*.cjs`；修前对账 `validation/p6-e5-AEpszF`、**修后对账 `validation/p6-e5-SQj0yC`（面板 sampled_out=143 == 盘上 143；cap-incomplete 两条正则亲验为真）** |
| R2-B | 冻结的 §11.3"停止超时"档位连同 `stopProgress` 实现被删；`cdp.send` 无超时 → 挂住的浏览器使 UI stop 永久悬挂；注释声称的单元门禁不存在 | 债务 | **关闭 09-27** | §R2.3-B；修后：E5 S2 面板 `TIMEOUT after 2ms [stop-requested -> deadline-missed]`、host 套件两条 stop-timeout 单测、`cdp.js` CDP_TIMEOUT |
| R2-C | 分页游标 producer-盲：两个 producer 命中同一谓词时重复计数（实测 sum=89 / 真值 60，重复 29） | 债务 | **关闭 09-27** | §R2.3-C；修后：`probe6` = lossless（duplicates 0）、三 producer 常设门禁（90 行 sum==90） |
| R2-D | 执行记录申报不符（m1 `cdp.js`、m5 `env-manager.js` 均未触碰）+ 未披露的覆盖删除（env 七操作/隔离、loop 取消与熔断、索引重建等式、A-13 注册、不可用工具执行期拒绝、真机 pair） | 债务（纪律） | **关闭 09-27**（记录已更正；六类覆盖中五类回套件，真机 pair 仍只在 E6 → 转 D-P6-3） | §R2.3-D；`git show --stat 93299e6` |
| R2-E | 循环侧上下文计账仍 `min(actualBytes,8192)`：三个 60,001 字节结果实付 180,003、账面 24,576 | 债务 | **关闭 09-27**（实测账面 120022 = 两个接纳 + 第三个 refused） | §R2.4-E；probe7 |
| R2-F | `basisHint` 不看 origin：agent 调用可自批并写下 `basis:ui-direct-click`（E6 驱动器依赖此洞） | 债务 | **关闭 09-27**（`broker.js:136` 加 origin 条件；E6 ledger 该类行 = 0） | §R2.4-F；probe7 |
| R2-G | B1 审计锚点是 `>=` 阈值而非等式，检测不到旁路 | 债务 | **关闭 09-27**（逐动作等式：clicks{3,4,1,1,+1 approved} == ledger 10） | §R2.4-G |
| R2-H | Jump / Authorization / Capabilities / Clear / Choose-workspace 五个控件从未被点击；`evidence:resolve-orphan` 与 `jsvmp_trace clear` 新语义零覆盖 | 债务 | **关闭 09-27**（caps/auth/jump/clear/resolve-orphan 均实测；Choose-workspace 属人工对话框，以静态门禁 + S5 覆盖，如实记为边界） | §R2.4-H（`resolveOrphan` 的门禁归 M3-E6，见下） |

## 2. M1.1 名下（语料尾件，并行轨）

| ID | 项 | 类型 | 状态 | 证据/指针 |
| --- | --- | --- | --- | --- |
| M1.1-a | 本地 **412→200 重放服务** + 真实两段流上验 nav_chain 锚点（echo oracle 三级） | 债务 | 未启动 | [P6 交接 §6](chromium-p6-agent-loop-handoff.md)；**依赖 R2-C**（多 producer 游标）先修 |
| M1.1-b | 三站语料带 **tap 窗口 + dump 锚点** 复跑 → vPC 序列 + 解码表资产 | 债务 | 未启动 | 同上；纪律：本地复跑 + 死代理护栏，不回连原站 |
| M1.1-c | 每站产物包 + README **等级标注**（vPC=derived、dump=observed、锚点=derived） | 债务 | 未启动 | 同上 |
| M1.1-d | 若瑞数 cookie 时效导致拿不到真二阶段 → 降级为"合成两段流 + 语料级锚点"，产物等级如实降级 | 边界（预案） | 待触发 | 架构师已承诺届时据此裁 |
| M1.1-e | 语料 412 页的 JS 属 **README 级**证据（非机制级） | 边界 | 长期 | P5.5 交接 §18.3 |

## 3. M3 名下（工具面完整）

| ID | 项 | 类型 | 状态 | 证据/指针 |
| --- | --- | --- | --- | --- |
| M3-1 | **frx 源码移交**（A 组 2 项 + D 组 frx 轨 5 项的前提；MPL-2.0 逐文件核对） | 外部依赖 | 未到位 | [M3 交接 §7](chromium-m3-tool-surface-handoff.md)；当前 `jsvmp_split_dispatcher`/`jsvmp_disassemble` 已按 unavailable-with-reason 注册 |
| M3-2 | host-exec 档（tier c）实装：策略白名单、具体动作确认载荷、argv/路径审计、超时/输出上限/取消 | 债务 | 未启动 | M3 交接 §4 PD1、§5 E1 |
| M3-3 | 能力矩阵**自动生成**（禁止手写）+ "每个 available 项必有一条门禁名"断言 | 债务 | 未启动 | PD3、E0/E7 |
| M3-4 | Broker 不可绕过从约定变**结构**（broker-bound 适配器、`.run(` 调用点静态门禁 + 负控） | 债务 | 未启动 | PD4、E6 |
| M3-5 | 完整环境管理器（端口扫描/bind 探测/进程状态机/实例所有权/`exec -a`）+ 双 env 并行实测；指纹挂载点仅预留 | 债务 | 未启动 | §3.3、E4 |
| M3-6 | **可重连控制面设计文档**（传输选型/capture 状态恢复/与 `resolveOrphan` 的关系/失败模式表）——本轮只设计不实现 | 设计 IOU | 未启动 | PD2、E6；IOU 源自 P3 终审记录与草稿 §362 |
| M3-7 | `resolveOrphan` 与只读收养两路径的门禁（P6-R2 H 项的一半归此） | 债务 | 未启动 | E6 |
| M3-8 | C 组 14 项 CDP 映射 + `page_automation_scan` 的 Chromium 环境面适配（字段面差异逐项披露） | 债务 | 未启动 | §3.1、E3 |
| **D-P6-1** | E5 驱动器曾一次不可复现失败（首个 workspace-open 等待超时），且 driver-error 路径不落 report/面板/console → flake 即盲区。**M3 进入条件** | 债务 | 开放 | [P6 交接 §R3.4](chromium-p6-execution-handoff.md)；失败运行 `validation/p6-e5-n5OkSm`、通过运行 `validation/p6-e5-SQj0yC` |
| **D-P6-2** | S3 门禁布尔式优先级缺陷：盘上读数成功时 `s3ok` 不参与判定（R2-A 的两条正则实际未被要求）。**M3 进入条件** | 债务 | 开放 | §R3.4；行为本身已亲验正确，缺陷在门禁 |
| **D-P6-3** | 真机 `(terminal, coverage)` pair 只在 E6 驱动器断言；`r1-adapters.test.js:433` 仍留冗余弱断言 `\|\| stop.terminal != null`。**M3 进入条件** | 债务 | 开放 | §R3.4 |
| M3-9 | P6-R3 的四条小项：stop 成功路径不清截止定时器（8s 滞留）、B1 锚点三处装饰缺陷（negativeControl 恒 null / 负控是算术非真注入 / 读侧无等式）、grep 锚点仅存在性检查、E5 残留死取值与恒真三元 | 债务（小） | 开放 | §R3.4 m-R3-4…8；随 M3-E0 一并清 |

## 4. M4 名下（观测面扩展）

| ID | 项 | 类型 | 状态 | 证据/指针 |
| --- | --- | --- | --- | --- |
| M4-1 | `signer_trace`：非暂停的引擎级"选定脚本函数入口 + 实参"观测（P4 observer 扩展） | 债务（能力缺口） | 未启动 | 清单 §2/C 判定"部分"；M3 期间保持 unavailable-with-reason |
| M4-2 | `closure_read`：执行后真值 + 深序列化（S-box/字节码数组整段）依赖值观测扩展与有界资产契约 | 债务（能力缺口） | 未启动 | 同上 |
| M4-3 | Sparkplug baseline 对照观测矩阵 | 债务 | 未启动 | 路线图 M4 行 |
| M4-4 | WebIDL 第二批接口选择（需求驱动）+ 分路径测试 | 债务 | 未启动 | 路线图 M4 行 |
| M4-5 | **gate 关 vs "无 observer 编译" 的精确零差对照**（需 P0 基线 d8） | 边界→债务 | 开放 | P4 交接 E7 披露；M4 用 P0 基线 d8 补齐 |
| M4-6 | 同配置跨跑总事件数波动源于**页面非确定性**（非 observer 开销） | 边界 | 长期 | P4 交接 E7 披露 |

## 5. M5 名下（对抗面对等）

| ID | 项 | 类型 | 状态 | 证据/指针 |
| --- | --- | --- | --- | --- |
| M5-1 | 指纹伪装层设计（三档策略：CDP override/启动开关优先，Blink patch 只补剩余字段） | 设计 IOU | 未启动 | 草稿 §1.1/§5、迁移分析报告 §7 |
| M5-2 | 完整环境管理器剩余项：指纹挂载、暖 profile 复用、一键生成"profile+指纹+采集配置" | 债务 | 未启动 | 草稿 §37、路线图 M5 |
| M5-3 | 四项指纹依赖 env 工具（`env_current_process` 等）从 unavailable 转可用 | 债务 | 未启动 | 清单 §3.4；P6-R1 已按 unavailable-with-reason 注册 |
| M5-4 | **活站对等验证需用户显式授权**；未授权则 M5 以本地重放 + 派生一致性规则收口，"活站对等"记为未验证边界 | 授权门槛 | 未授权 | 路线图 §1 M5 行、§5 |

## 6. M6 名下（按需，未排期）

| ID | 项 | 类型 | 状态 |
| --- | --- | --- | --- |
| M6-1 | MV3 sidePanel 经 Host 接入 | 债务 | 未排期 |
| M6-2 | 跨平台构建 + 发布流水线（每平台独立覆盖矩阵） | 债务 | 未排期 |

## 7. 需用户授权的门槛（工程估计之外，单列）

| ID | 项 | 现状 |
| --- | --- | --- |
| AUTH-1 | **活站采集**（任何回连真实第三方目标的采集/验证） | 未授权。当前所有语料工作一律本地复跑 + 死代理护栏 |
| AUTH-2 | M5 的活站指纹对等验证 | 未授权（同 AUTH-1） |
| AUTH-3 | frx 源码移交（M3-1 的前提，属外部依赖但需用户推动） | 未到位 |

## 8. 已关闭（留档，勿重复登记）

| ID | 项 | 关闭处 | 证据 |
| --- | --- | --- | --- |
| D-P55-1 | E7 的 off/on 语义对照用两个不同程序 | P6-E0 | `scripts/p6-e0-dp551-equivalence.cjs`（正控有效：首轮 `p6-e0-dp551-HFuuPZ` 因 taps=0 变红）；`p55-e7-valueobs-evidence.cjs` 同程序化 |
| D-P2-analyzer | analyzer 的 v3 因果树（曾对所有 v3 报 available=False） | P6-E0 | `scripts/p6-e0-analyzer-v3-gate.py` 6/6（v2 搬移等价为全字典相等） |
| D-P2-gui | GUI 的 v3 代表性证据与 v1/v2 回归 | P6-E0 | GUI 套件（216 中的 v3 代表性 2 条） |
| P6-R1 B1/B2/B3/B4/B6 | Broker 旁路（UI 入口）、人工确认面、谓词下推与窗口契约、切片健壮性、skill realpath 闸门 | P6-R1（R2 复审确认） | [P6 交接 §R2.2](chromium-p6-execution-handoff.md)；`probe4/5/7`；E5/E6 实跑 |
| P6-R1 M1/M2/M4/M7/M8/M9/M11/M12 | 能力协商接通、组合根与单一启动规格、确认生命周期、去钩子、门禁接线、relevance 归一、状态账 | P6-R1（R2 复审确认） | 同上 + `scripts/p6-r1-static-shape.js` |

## 9. 长期"已披露边界"汇总（不修，但引用结论时不得越级）

P5.5 的完整边界汇总在其交接 §20.4（S1–S5 各节 + E6 夹具 terminal=incomplete），本册不复制。跨阶段引用的三条硬规则：

1. **等级分离**：`observed` 只承载原始事实；family 级无 oracle 至多 `hypothesis`；语料级 vPC/锚点为 `derived`（M1.1-c 的标注要求）。
2. **计账优先于结论**：任何"覆盖完整/无丢弃"的说法必须能落到 manifest 的 counts 与 coverage 轴（R2-A 正是违反此条）。
3. **绿灯不替代路径验证**：门禁绿 ≠ 该路径被走过；每个 available 工具必须有一条真实执行它的门禁（PD3 的矩阵断言）。
