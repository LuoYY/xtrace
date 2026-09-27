# 开放项登记册（债务 / 边界 / 设计 IOU / 外部依赖 / 授权门槛）

- 版本：v1.4（2026-09-27，项目架构师；`accepted-m3` 达成：D-M3-5 与 M4-8 关闭；M4 工单已发布）。
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
| M3-2 | host-exec 档（tier c）实装：策略白名单、具体动作确认载荷、argv/路径审计、超时/输出上限/取消 | 债务 | **机制落地**（R1 复审确认：默认拒/防呆/载荷/审计/取消杀子进程均实测）；**产品面缺口未关** → 转 D-M3-M2 | M3 交接 §4 PD1；`test/e1-host-exec.test.js` |
| M3-3 | 能力矩阵**自动生成**（禁止手写）+ "每个 available 项必有一条门禁名"断言 | 债务 | **部分落地**：生成器存在且对活组合根生成（已实测）；**覆盖断言不符**（缺清单 7 项静默缺席）+ gate 出处未机验 → 转 D-M3-B4 / M1 | `scripts/m3-capability-matrix.js`、`docs/m3-capability-matrix.md` |
| M3-4 | Broker 不可绕过从约定变**结构**（broker-bound 适配器、`.run(` 调用点静态门禁 + 负控） | 债务 | **关闭 09-27** | `host.adapters.all()` 剥离 run/available；静态门禁 7 检查含植入旁路负控（我亲跑 GREEN） |
| M3-5 | 完整环境管理器（端口扫描/bind 探测/进程状态机/实例所有权/`exec -a`）+ 双 env 并行实测；指纹挂载点仅预留 | 债务 | **大部分落地**（双 env 并行实测我亲跑绿）；`exec -a` 静默消失 → 架构师裁决改归 M5（D-M3-M3）；端口机制管道传输下无消费面（advisory，已披露，架构师认领工单过度纳入） | `test/e4-env.test.js`；[M3 交接 §3.3](chromium-m3-tool-surface-handoff.md) |
| M3-6 | **可重连控制面设计文档**（传输选型/capture 状态恢复/与 `resolveOrphan` 的关系/失败模式表）——本轮只设计不实现 | 设计 IOU | **关闭 09-27**（交付合格：不承诺断连期无缝，诚实） | `docs/chromium-reconnect-design.md` v1.0 |
| M3-7 | `resolveOrphan` 与只读收养两路径的门禁（P6-R2 H 项的一半归此） | 债务 | **关闭 09-27**（收养幂等 + index 落地、终止真杀，各有断言；E5 resolve-orphan 交互实测） | `test/e6-structural.test.js`、`validation/p6-e5-pluSSA` |
| M3-8 | C 组 14 项 CDP 映射 + `page_automation_scan` 的 Chromium 环境面适配（字段面差异逐项披露） | 债务 | **部分落地**：14 项均有真浏览器门禁（我亲跑 51/51 套件内）；**tier 错配 + net 族泄漏/假查询** → 转 D-M3-B2/B3 | `test/e3-cgroup.test.js` |
| **D-P6-1** | E5 驱动器曾一次不可复现失败（首个 workspace-open 等待超时），且 driver-error 路径不落 report/面板/console → flake 即盲区。**M3 进入条件** | 债务 | 开放 | [P6 交接 §R3.4](chromium-p6-execution-handoff.md)；失败运行 `validation/p6-e5-n5OkSm`、通过运行 `validation/p6-e5-SQj0yC` |
| **D-P6-2** | S3 门禁布尔式优先级缺陷：盘上读数成功时 `s3ok` 不参与判定（R2-A 的两条正则实际未被要求）。**M3 进入条件** | 债务 | 开放 | §R3.4；行为本身已亲验正确，缺陷在门禁 |
| **D-P6-3** | 真机 `(terminal, coverage)` pair 只在 E6 驱动器断言；`r1-adapters.test.js:433` 仍留冗余弱断言 `\|\| stop.terminal != null`。**M3 进入条件** | 债务 | 开放 | §R3.4 |
| M3-9 | P6-R3 的四条小项：stop 成功路径不清截止定时器（8s 滞留）、B1 锚点三处装饰缺陷（negativeControl 恒 null / 负控是算术非真注入 / 读侧无等式）、grep 锚点仅存在性检查、E5 残留死取值与恒真三元 | 债务（小） | 开放 | §R3.4 m-R3-4…8；随 M3-E0 一并清 |

### 3.1 M3 终审 R1 整改项（架构师登记，2026-09-27；`accepted-m3` 前必须关闭）

| ID | 项 | 类型 | 状态 | 证据/指针 |
| --- | --- | --- | --- | --- |
| **D-M3-B1**（关闭 09-27） | `scripts_save` 在真浏览器 100% 抛错（browser 级 `Debugger.getScriptSource` 无 sessionId → "wasn't found"；带 sessionId 同一调用返回 711 字节）；e2 happy path 是假 host；矩阵却标 available | 债务（阻塞） | **关闭 09-27**（probe1/2 翻转、run_tests host 62/62、矩阵 66 全覆盖、E5/E6 绿） | [M3 执行记录 §R1.3-B1](chromium-m3-execution-handoff.md)；`docs/review-artifacts/m3-r1/probe1-*.cjs` |
| **D-M3-B2**（关闭 09-27，但见 D-M3-5） | C 组 tier 错配：agent 来源 `page_navigate`/`page_click`/`page_type`/`cookies` 静默会话级放行（实测 ledger 四行 granted:session-grant）；清单"需确认"列均为是；`net_list` 读档却导航 | 债务（阻塞） | **关闭 09-27**（probe1/2 翻转、run_tests host 62/62、矩阵 66 全覆盖、E5/E6 绿） | §R1.3-B2；`probe2`（ledger 证据）；须新增 tier==清单列机检门禁 |
| **D-M3-B3**（关闭 09-27） | net 族：每调用挂**永不摘除**的监听器（泄漏 + 过期收集器堆积）；`net_list` 重新导航而非查询缓冲（假查询）；游标等式在动态页面不可核对 | 债务（阻塞） | **关闭 09-27**（probe1/2 翻转、run_tests host 62/62、矩阵 66 全覆盖、E5/E6 绿） | §R1.3-B3；修法已裁（单例监听器 + 有界缓冲 + 窗口捕获 + 纯查询） |
| **D-M3-B4**（关闭 09-27） | 能力矩阵对清单**静默缺席 7 项**（env/指纹族，M5 归属）：`env_current`/`env_import`/`env_import_fingerprint`/`env_read_config`/`env_write_config`/`env_generate_fingerprint`/`env_capture_fingerprint`；记录算术不符（65 行 vs 66 清单） | 债务（阻塞，纪律类第三次复发） | **关闭 09-27**（probe1/2 翻转、run_tests host 62/62、矩阵 66 全覆盖、E5/E6 绿） | §R1.3-B4；我亲跑的清单↔矩阵 diff |
| **D-M3-M1**（关闭 09-27；19 个真实缺口转为覆盖债 → 见 M4-7） | 矩阵 gate 出处为手写映射且只查文件存在（不查文件是否真行使该工具）；`scripts_capture_all` 用文案豁免占位 | 债务（重要） | **关闭 09-27**（probe1/2 翻转、run_tests host 62/62、矩阵 66 全覆盖、E5/E6 绿） | §R1.4-M1 |
| **D-M3-M2**（关闭 09-27，GUI 接线一项转 M4-8） | host-exec 产品面六缺口：pendingList 无 action 载荷；运行中执行不可列（`cancelExecution` 不可路由）；GUI 出货无 hostExecPolicy 而矩阵带策略跑；执行器全量继承 `process.env`（密钥面）未披露；`timeout_ms` 无上限；writeRoots 用未解析字符串前缀 | 债务（重要） | **关闭 09-27**（probe1/2 翻转、run_tests host 62/62、矩阵 66 全覆盖、E5/E6 绿） | §R1.4-M2 |
| **D-M3-M3**（关闭 09-27，裁决生效：归 M5-2） | `exec -a` 进程名伪装静默消失（全仓无 argv0 设置点）；架构师裁决：**改归 M5**（伪装面同族），记录措辞更正 | 债务（重要）→ M5 登记 M5-2a | **关闭 09-27** | §R1.4-M3 |
| **D-M3-5**（关闭 09-27） | **架构师自纠 delta（R1-C1）**：R1 评审的"tier==清单需确认列"指令错误——那列是 frx 习惯、不是 §5.2 tier 合同；`fs_write`/`fs_mkdir`/`fs_copy` 须回 stateful（工作区写动作），`r1-tiers` 门禁改**语义合同表**（例外引用裁决编号 + "清单列是⇒stateful"总闸）+ 红测试（agent 来源 fs_write 停 pending）。**M3 验收前必落（估 15 分钟）** | 债务（阻塞 delta，责任在架构师裁决文本） | **关闭 09-27**（点验：tiers 回 stateful、语义合同表 + 总闸、红测试、run_tests host 64/64） | [M3 执行记录 §R2.3](chromium-m3-execution-handoff.md) |
| M4-7 | 矩阵覆盖债：19 个 available 工具渲染 "(no direct gate — gap)"——披露诚实但要排期清零（M4 起每档先补 5 个） | 债务（覆盖，排期） | 开放 | `docs/m3-capability-matrix.md` |
| M4-8 | `runningExecutions()` 已可路由但 GUI 未接线（IPC + 面板按钮） | 债务（小） | **关闭 09-27**（D-M3-5 顺带落：`evidence:running`/`cancel-execution` IPC + Running 按钮） | M3 执行记录 §R2.4 M2-② |
| M4-9 | 小项批：`MAX_TIMEOUT_BYTES` 死 import；矩阵缺项负控自引用（建议改活 host 缺项）；`net_list` 缓冲滚窗后游标应披露 `buffer_oldest_seq` | 债务（小） | 开放 | M3 执行记录 §R2.4 m-R2-1/2/3 |


## 4. M4 名下（观测面扩展）

> **工单已发布**：[chromium-m4-observation-handoff.md](chromium-m4-observation-handoff.md) v1.0（2026-09-27；进入条件已满足）。本表逐项归其 E0–E7。

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
| M5-2 | 完整环境管理器剩余项：指纹挂载、暖 profile 复用、一键生成"profile+指纹+采集配置"；**+ `exec -a` 进程名伪装（R1 裁决改归本档，M3-5 划出）** | 债务 | 未启动 | 草稿 §37、路线图 M5；M3 执行记录 §R1.4-M3 |
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
