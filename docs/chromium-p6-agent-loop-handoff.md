# P6 交接：Agent 闭环（Node Host / Broker / 首批工具 / 证据界面）

- 文档版本：v1.0（2026-09-26）。前置：P1–P5.5 冻结（accepted-p55）；[迁移草稿](chromium-migration-enhancement-draft.md) §5/§11/§12 P6 行；[66 工具清单](tool-inventory.md)（首批冻结范围）；[路线图](roadmap-milestones.md) M2。
- 分工：执行层实施；架构师裁决与终审。长程单次终审模式沿用。
- **四个前置决策已冻结（§5）**，块内不再议；M1.1 语料尾件为并行轨（§6），不占 P6 关键路径。

## 1. 接手先做什么

1. 读本文件 + 草稿 §11（Broker/能力协商/UI 边界）+ 工具清单 §3（首批冻结）。
2. **先清进入债务（P6-E0）**：D-P55-1（E7 同程序 deep-equal 红测试+修复）；analyzer/GUI v3 债务（草稿 §10.5 遗留 1）。两者不清不进 E2。
3. 现场确认：accepted-p55 的二进制与补丁栈（verify pass）；Node/npm 环境；Electron GUI 可跑。

## 2. 冻结输入

| 项目 | 值 |
| --- | --- |
| 浏览器 | ChromiumX（out/XTraceIntegration），CDP pipe + XTrace 域 + valueObservation（P3/P5.5 交付） |
| 数据契约 | trace-schema-v3（v1.3，accounting model 2）；manifest/identity/nav_chain/coverage 为分析输入 |
| 首批工具范围 | 清单 §3：**A 组 13 项全入**；B 组仅最小集（`jsvmp_trace` start/stop/status/clear 不含 dump、`jsvmp_status`、`webapi_trace` 首批接口内、`scripts_capture_all`、env 最小七项）；C/D 组不接入 |
| 许可 | frx 迁入代码保留 MPL-2.0 标注，不改标（草稿 §5） |

## 3. 范围与非目标

范围：Node Agent Host（浏览器所有权 + 能力协商 + 工具执行 + 授权 Broker + 工作区）；证据索引与 trace_query 族；A/B 首批适配器；最小 env；Electron 证据界面（capture 状态/coverage/停止进度/丢弃计数/证据跳转/授权记录）；首个完整闭环验收。

非目标：MV3 sidePanel、跨平台、指纹层、完整环境管理器（P7）；C/D 组工具；Agent 的模型外发默认开启（默认关闭，显式策略）；重连语义（见 §5.4）。

## 4. 任务分解

| 序 | 任务 | 关键交付 | 验收锚点 |
| --- | --- | --- | --- |
| P6-E0 | 债务清零 | D-P55-1 红测试+修复；analyzer v3 读取 + causality 树；GUI v3 可读不崩 + 代表性 v3 fixture + v1/v2 旧回归 | 红测试先红后绿；旧 golden 全绿 |
| P6-E1 | Host 骨架 + Broker 核心 | Host 经 pipe 拥有 ChromiumX 生命周期；capabilities 握手（消费 getCapabilities 全字段）；Broker 三档授权 + 审计日志；工作区布局 | 非受信路径拒绝实测；Broker 单入口（Agent/UI/MCP 同径）测试 |
| P6-E2 | 证据索引 + A 组适配器 | SQLite 派生索引（§5.1）；trace_query/资产读取/索引检索/报告查看 13 项 | 索引可从 capture 目录重建；查询结果带 capture+producer+seq 引用 |
| P6-E3 | B 组控制适配器 | start/stop/status 经域；env 最小七项（目录/profile/登记表/生命周期） | stop 走域且断言预期 (terminal, coverage)；env 隔离实测 |
| P6-E4 | Agent loop 接入 | frx L1 纯逻辑抽离入 Host；工具 schema 映射；输入切片（§5.3） | 一次可取消的工具调用循环；切片大小上限实测 |
| P6-E5 | Electron 证据界面 | 状态/coverage/停止进度/丢弃计数/证据跳转/授权记录 | **真实交互验收**（草稿 §11.3：正常/停止超时/incomplete/取消/恢复五场景 + console/network 检查） |
| P6-E6 | 闭环验收 | 隔离环境→受控采集→本地页→停止+完整性→索引→Agent 分析→UI 证据跳转 | 全链一次通过；所有执行入口过 Broker 审计 |
| P6-E7 | 证据包 + 终审 | 补丁/Host/UI 回归；文档同步 | 架构师终审后 accepted-p6 |

## 5. 已冻结的前置决策（块内不重开）

1. **证据索引存储**：Node Host 内 SQLite（better-sqlite3），与 LedgerBackend 同族但**独立库文件**（index.db / ledger.db，生命周期不同）。索引为**派生数据**：capture 级 + producer 级计数 + api 级聚合 + 资产登记表；**事件级查询不回索引，直读 NDJSON 流式**。必须可从 capture 目录全量重建（重建即验收用例）。理由：可重建者不做第二真源。
2. **Broker 授权粒度（三档）**：(a) 只读证据（A 组）= 会话级授权，不逐次弹窗；(b) 有状态控制（B 组）= 逐次确认 + 理由串 + 审计；(c) 宿主执行（D 组，P6 不接入但 Broker 形状预留）= 逐次确认 + 默认拒绝的策略白名单（路径/网络/依赖）。UI 与 Agent/MCP 走同一 Broker；审计落工作区 ledger。
3. **Agent 输入切片**：原始 trace 永不入上下文。切片三形：manifest 摘要 / 有界证据切片（按分析相关性 top-K，带值边界事件优先，附行引用）/ 索引查询结果。每切片带 capture+producer+seq 引用与大小上限；要更多走 trace_query 工具，不靠 dump。
4. **进程所有权与重连**：pipe 断开即浏览器退出（运行事实）。Host = 浏览器所有者；**P6 不做重连语义**：Host 重启后不假设 capture 延续——产物（manifest/trace）在盘上持久，提供"只读收养"（读产物）或"终止孤儿实例"（pid 活性 + manifest 状态判定）二选一。可重连控制面另立设计轮（P3 终审记录在案）。

## 6. 并行轨 M1.1（语料尾件，不占关键路径）

- M1.1-a：本地 **412→200 重放服务**（先服务捕获的 412 HTML+一阶段 bundle，见 cookie 后服务 200 wrapper+二阶段）→ 在真实两段流上验 nav_chain 锚点（echo oracle 三级）。
- M1.1-b：语料三站带 **tap 窗口（绑定 D1 元数据的派发循环热 offset）+ dump 锚点（VM 初始化点）** 复跑 → vPC 序列 + 解码表资产。
- M1.1-c：每站产物包 + README 等级标注（vPC=derived、dump=observed、锚点=derived）。
- 纪律：本地复跑 + 死代理护栏，不回连原站。

## 7. 纪律与长程模式

- 沿用 P2 §6 全条 + P5.5 契约 §2（产品行为零改变等）；补丁栈强制同步；门禁含全部测试目标。
- 长程块：E0 完成后 **E1→E7 一次推进、一次终审**；升级触发器沿用（基线/规范语义/计数等式/新对外能力/新二选一/设计层故障 + 受信边界 + Broker 旁路迹象）。
- frx 代码迁入逐项许可核对；Agent 护栏（熔断/无进展/上下文预算）按 frx 原语义移植，不削弱。

## 8. 完成定义

草稿 §12 P6 行全部 + 首批清单逐项能力矩阵与实测一致 + 债务零 + E5 真实交互五场景 + E6 闭环一次通过 + Broker 审计覆盖全部执行入口 + accepted-p6 由架构师标记。

## 9. 终审 R1 裁定（2026-09-26，架构师）

**不通过，`accepted-p6` 未标。**完整审查记录、逐项证据与整改工单在
[执行工单记录 §架构师终审 R1](chromium-p6-execution-handoff.md)（§R1.1 复验表 /
§R1.3 六项阻塞 / §R1.4 十三项整改 / §R1.6 两项裁决 / §R1.7 P6-R1 长程整改块 /
§R1.8 复审门禁清单）。复现材料：`docs/review-artifacts/p6-r1/`。

对本工单的三条影响（即时生效）：

1. **§8 完成定义的三条未满足**：Broker 审计未覆盖全部执行入口（UI 的 `evidence:start`/`cancel` 绕过，实测三次 startCapture 零审计行）；首批清单能力矩阵与实测不一致（`jsvmp_query`/`webapi_query` 在真实 capture 上分别返回 0/13,444 与 0/592 行）；E5 五场景不含证据跳转（面板无 jump 入口，E6 第 7 阶段内联重写且未解析 Agent 自己的引用）。
2. **§5 冻结决策的落地缺口**：§5.1 派生索引成立（重建即验收通过）；§5.2 三档语义在单元层成立、在产品路径被自批与旁路架空；§5.3 切片路径守住、**工具路径未守住**（返回无字节上界而 loop 只按 8192 计账）；§5.4 只做了"收养"半边，`resolveOrphan` 零消费者。
3. **§4 任务分解的验收锚点从 P7 起加四条**（P6 的教训前置到工单，不靠事后 review 兜）：每个"等价/优先/覆盖/审计"类断言配负控；至少一条门禁用真实 capture（≥2 万事件、非约定命名）；组合根唯一化且源码形态核对入门禁；产品路径禁 harness 钩子。

下一步：工程师按 §R1.7 的 R1-1…R1-13 一次推进、一次提交；M1.1 并行轨在 R1-5 转绿后启动（见
[路线图 §8.1](roadmap-milestones.md)）。
