# M3 执行工单记录（工程师执行侧）

- 对应工单：[chromium-m3-tool-surface-handoff.md](chromium-m3-tool-surface-handoff.md) v1.0；[登记册](open-items-register.md)（架构师维护）。
- 进入条件核对（2026-09-27，M3-E0 开工时）：① `accepted-p6` ✓（ec51564）；② M2 名下 8 项全部关闭 ✓（R3.4 附证据指针）；③ frx 移交状态判定 ✓（`not-transferred`，见 [frx-transfer-checklist.md](frx-transfer-checklist.md)）。
- 纪律：沿用 P6 工单 §7 + M3 §6（含 PD5）；补丁栈强制同步；本文件为执行记录侧。

## M3-E0：债务门（2026-09-27）

### 三条硬债务（D-P6-1/2/3）

| ID | 整改 | 证据 |
| --- | --- | --- |
| D-P6-1 E5 flake | open 门禁允许**恰好一次**重试（`waitForWithRetry` 仅用于三处 workspace-open）；driver-error 路径**必落 report.json**（面板全文 + consoleErrors + exceptions + 最近 40 条网络请求 + 已连接 target 的 type/URL——CDP 仍活着时全取，死了则尽力） | 驱动器源码；错误报告结构在 catch 块内落盘 |
| D-P6-2 S3 布尔缺陷 | 断言改 `s3ok && reconciliationOk`（双正则**必选**）；对账推广到**盘上每个 capture**：manifest 四计数（sampled_out/dropped/failed/partial）== 面板渲染行对应字段，等式列表逐条进 report.json | E5 实测 2 条 reconciliation 全 equal（cap-incomplete + 真 capture c1790…-D0），S3 ok=true 由双条件共同决定 |
| D-P6-3 真机 pair | r1-adapters 组合根集成断言改实质：`stop.pair.terminal === 'complete'` 且 coverage 轴非空（原恒真 includes||!=null 删除） | host 套件 29/29 内该测试绿 |

### 四条小项（m-R3-4/5/6/8）

| ID | 整改 |
| --- | --- |
| m-R3-4 | stop 截止定时器在**成功路径 clearTimeout**（catch 路径同样清理）——成功 stop 不再滞留 8s 定时器 |
| m-R3-5 | B1 负控改双方向：row-drop（删一条 executed 行→等式破）**加** phantom-expectation（多算一次副作用→等式破，模拟未经审计的直连注入）；读侧建等式（trace_summary 行数==status 点击数、recall 行数==auth 点击数）；`agentApproved` 恒真三元删除 |
| m-R3-6 | grep 锚点测试降级为**存在性注释**（测试名自带 "not a behavioral gate"，不计门禁数；行为门禁=两条单测+E5 S2） |
| m-R3-8 | E5 三段死取值（jumpRef/realRef/firstRef）整段删除 |

### 不得削弱断言清单

[docs/p6-do-not-weaken-assertions.md](p6-do-not-weaken-assertions.md)：P6 全部常设门禁断言逐条列表（37 组），含变更纪律（删行必须给替代位置；存在性检查不计门禁数）。M3 各阶段以此为基线。

### 能力矩阵生成器（首版，A+B 组）

`scripts/m3-capability-matrix.js`：对**活组合根**（真 ChromiumX）协商生成 `docs/m3-capability-matrix.md` + validation JSON。首轮实测：**available=24 degraded=4 unavailable=6**（degraded=jsvmp_query/webapi_query/recall + ? 见矩阵；unavailable=frx 两项+指纹四项）；逐工具带 gate 出处（gate 文件缺失即抛错）；清单 A-13+B-12+M5 四项全数在表。禁止手编输出（文件头标注）。

### frx 移交清单与状态判定

[docs/frx-transfer-checklist.md](frx-transfer-checklist.md)：七项（A 组 2 + D-frx 轨 5）逐项依赖/状态/许可现状；**判定 `not-transferred`**（仓库与 git 历史零 frx 源）→ M3-E5 按未到位分支（unavailable-with-reason + 记债，禁弱替）；移交后首验清单预备。

### E0 终验（2026-09-27 亲跑）

| 门禁 | 结果 |
| --- | --- |
| `bash scripts/run_tests.sh` | exit 0（python 381 / launcher 28 / host **29** / GUI 216） |
| `scripts/m3-capability-matrix.js` | GENERATED（活 host，计数如上） |
| `scripts/p6-e5-ui-scenarios.cjs` | GREEN（S3 双正则 + 2 条盘面对账全 equal + B1 双负控 + 读侧等式；双会话全 0） |
| `scripts/p6-e6-closed-loop.cjs` | GREEN 九阶段 |
| `scripts/p6-r1-static-shape.js` | GREEN 5/5 |

progress JSON：`p6` 保持 `accepted-p6`；`m3` = `e0-debt-gate-complete`；`m3_detail.e0` 记录债务闭环与矩阵计数；`frx_transfer_status` = `not-transferred`。

**进入 M3-E1→E7 长块**（E1 host-exec 档实装起步）。
