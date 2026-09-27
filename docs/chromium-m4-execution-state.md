# M4 执行状态记录（工程师）

> 工单：[chromium-m4-observation-handoff.md](chromium-m4-observation-handoff.md) v1.0。
> 本文件按 P2 起的执行状态文档惯例逐块回填；progress JSON 照旧在
> `chromium/src/out/XTraceIntegration/validation/integration-progress.json`。

## E0 债务门（2026-09-27，工程师，提交 <hash>）

工单 §5 E0 四项 + §1.3 现场确认，全部落地：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 登记册 M3 名下清零核对 | M3-2/3/5/8 已转 D-M3-* 并于 R1 整改关闭；M3-4/6/7 关闭；**M3-1（frx 移交）外部依赖未到位**——非阻塞（缩减范围已随 accepted-m3 接受）；**M3-9 行状态"开放"疑似滞留**：其 m-R3-4/5/6/8 四小项已于 M3-E0（cb01d27）关闭，请架构师下轮登记册更新时核对收口 | 登记册 v1.4 §3 |
| 矩阵覆盖债 top-up（M4-7） | **19 → 6（+3 内部原语 = 9）**：十个 available/degraded 缺口工具全部配真产品路径门禁——`test/e0-coverage-topup.test.js` 三测试：① env 七件经 callTool 真路径（create/list/status/update/open/current/close/delete 全生命周期断言）；② 捕获族真浏览器（jsvmp_status 形状 + webapi_trace start/status/stop **PAIR 断言 terminal=complete 且 coverage 非空** + scripts_capture_all captureAssets=full 窗口、盘上落行）；③ fs_mkdir 真文件系统（目录真落地 + fs_list 可见）。三轮连跑稳定绿灯。剩余 6 缺口 = 指纹族 unavailable（M5 范围，"no gate required" 类）+ 3 内部原语——≤9 达标 | `test/e0-coverage-topup.test.js`；`docs/m3-capability-matrix.md`（重生成，counts 40/8/24，missing []） |
| m-R2-2 矩阵负控改活 host（M4-9 末项） | 生成器核心抽出并导出（`buildRows` / `reconcileAgainstInventory`，main 改 require.main 守卫）；`test/r1-matrix.test.js` 负控重写：**真 host 协商面删除一条注册 → 生成器自身对账必须翻红**（正向臂：未触碰活面 clean 对账 66 项）。不再 doctored JSON | `test/r1-matrix.test.js` 2/2 |
| GUI 残留接线核对（M4-8 已由架构师关闭） | 复核三层在位且语法过：`evidence:running`/`evidence:cancel-execution` IPC（main.js:86,90）→ preload 通道（31,32）→ 面板 Running 按钮（app.js:445 起，cancel 经 Broker 路由） | grep + node --check 三文件 |
| M1.1 产物盘点（b 项状态） | **b 项未完成**：在盘的是 P5.5 语料采集步（09-24，三站首阶段 wrapper+bundle+全量 ignition trace 435K/378K/464K 事件 + assets/profiles，死代理护栏记录在 README）；**tap 窗口 + dump 锚点复跑无产物、412→200 重放服务未建**；README 明示 XJ 二阶段 blob 不可得 → a 项按工单预定降级路径（合成两段流 + 语料级锚点）执行。E1 选型冻结顺延，其余 M4 项不受影响 | `analysis/corpus-capture/`（README + corpus-manifest.json） |
| §1.3 现场确认（引擎改动前） | `verify_patches.py --with-dylibs out/XTraceIntegration` **pass**（含五组件 dylib 摘要）；P4/P5/P5.5 常设门禁在当前二进制亲跑全绿：P4 contract **21/21**（p4-contract-MHW3G9）、P5 reopen counterexamples **GREEN**（p5-reopen-078Zzg）、P55-S0 browser **全不变量成立**（p55-s0-BeiZo9）、P55-S0 d8 **GREEN**、P55-D1 d8 **PASS**（8 instances） | 各证据目录 |

**E0 附带发现（记录给 E3/E4 的输入）**：terminal 判定（补丁 0001"计数等式唯一裁决"）对**闲置 renderer 的 stop 确认截止**敏感——`page_navigate` 类流程留下的额外 renderer 若在 stop 截止前未确认，manifest 诚实记 `stop-timeout` → incomplete（本轮两次亲见：e0 门禁首版、S0 browser 首跑，均在干净复跑转绿）。这不是缺陷而是判定语义；含义：① 依赖 terminal=complete 的门禁须用 E6 形态（单 target + 同文档活动 + 沉降）；② M4-E4 signer_trace 的"非暂停证明（页面计时不失真对照）"设计须把 producer 确认截止纳入预算。

零 `chromium/src` 触碰；补丁栈与 accepted-p55/accepted-m3 状态逐字节一致（verify pass）。

## M1.1 语料尾件 a/b/c（2026-09-27，工程师，提交 <hash2>）

并行轨当前步完成（详见 [docs/m1-1-corpus-tail-report.md](m1-1-corpus-tail-report.md)）：

- **a**：412→200 重放 + 三级 echo oracle + nav_chain 锚点，三站 GREEN（S 臂预授权降级；双 Origin OOPIF 收纳被阻塞语料 VM——同源 isolate-origins 不拆同源 frame、127.0.0.2 沙盒不可绑，两方案失败过程留档）。
- **b**：tap 窗（绑 D1 热点：xj1 6@65 / sc 6@65 / jibei 6@50）+ vPC 序列（42 万级，derived）+ pass2 taps（observed）；**边界**：语料 renderer 不让出主线程 → `XTrace.requestDump` 全超时（dump 机器在 p55-s0 已证）——已登记为 M4-E4/E5 设计输入。
- **c**：等级标注齐（vPC=derived、tap=observed、锚=derived、dump 资产=未取得边界）。

**M4-E1 选型冻结解除阻塞**（工单进入条件 ③ 满足）。附带工程事实：tap 计划只挂 startCapture 之后的编译——pass2 必须 config-first；pass1 热点在 bundle 早期 offset（65/50），派发循环就在 init 区内。

---

## 架构师审查：M1.1 + M4-E0（2026-09-27，一轮过）——**accepted**，附 3 条可靠性/披露债 + 3 小项

- 审查范围：`bc7e50c..db5b7ac`（2 个 commit：M4-E0 债务门 + M1.1 语料尾件 a/b/c）。方式：全部新门禁亲跑 + 证据盘上对账 + 两个取证运行（m11-a 新跑、m11-b 新跑）+ 一次真实挂起的事故调查（见 D-M4-1）。
- **裁定：M1.1 达成（降级路径如实标注）+ M4-E0 通过。** progress JSON：`m11 = accepted-m11`、`m4 = m4-e0-debt-gate-passed`。**M4-E1 选型冻结可以开工**（进入条件 ③ 满足）。

### 独立复验（我亲跑）

| 项 | 结果 |
| --- | --- |
| `run_tests.sh` | exit 0：python 381 / **host 67** / launcher 28 / GUI 216（见 D-M4-1：battery 形态曾挂起一次） |
| 静态形态 7/7 · 矩阵生成 · E6 九阶段 · E5 九场景 | 全绿，但 **E5 在我机器上红过一次**（session1 console errors: 2，见 D-M4-2） |
| `m11-a-replay-navchain.cjs`（xj1 新跑） | **GREEN**：L1 412→200 双双在案、L2 carrier=get + nav_chain 1 行、L3 值等+顺序、`stage2 stage=2 cookieSeen=true`（`validation/m11-a-X9WsGE`） |
| `m11-b-tap-dump-recapture.cjs`（xj1 新跑） | **GREEN**：pass1 ignition 292,208、热区 6@50、vPC 292,192 行、pass2 taps=88、dump 全超时（边界如实记录）；证据 `m11-b-xj1-mujplx60` |
| 工程师自报三站证据（盘上核） | sc/jibei 的 a 报告 L1/L2/L3 全 true；三站 b 报告 bundle 名、热点、taps、dump 超时逐项在盘；vPC 文件行数与 analysis 的 `vpc_len` 逐站相等（422,031 / 348,110 / 426,848）；176 个真堆对象 token 的声明在 xj1 pass2 报告里可核 |
| 矩阵 | 重生成 40/8/24；**inventory_total=66、行集 66 全覆盖**（我 diff 过）；40 available 中 37 有真实门禁文件、3 个内部原语披露为 gap；degraded 8 全有门禁；unavailable 24 全带 reason |
| 覆盖债 | 19 → **available 无门禁者剩 3（内部原语）**；MD4 上限（≤9）达标 |
| 矩阵负控改活 host | 真协商面删一条注册 → 生成器自身对账翻红（点名 env_current）；正向臂干净 66 项 |
| D-P6 系 + 补丁栈 | verify_patches pass、五个补丁与 dylib 摘要与 accepted-p55 逐字节一致（本轮两 commit 零 chromium/src） |

### M1.1 的降级处置（我复核为合格）

- **降级路径是预授权的**（路线图 M1.1 行）：XJ 真二阶段 blob 不可得 → "合成两段流 + 语料级锚点"。**S 臂三站全绿、R 臂未触发**且原因诚实（本地无服务端挑战材料，语料 VM 不让出主线程——与 P5.5 README 边界一致）。**"一阶段算出 cookie"如实记为本地未演示**——没有越级。
- **等级标注齐**：vPC=derived、taps=observed、D1 元数据=observed、锚链=derived、L1 echo=observed、二段/S 臂=合成声明、dump 资产=未取得边界。
- 两个真实工程发现写进记录：① 语料 VM 本地死循环占住主线程，收纳方案是**双 Origin 天然 OOPIF**（同源拆不掉、127.0.0.2 沙盒不可绑，两个失败方案留档）；② **tap 计划只挂 startCapture 之后的新编译**——pass2 必须 config-first，首版后启动零 tap 已修。
- **dump 超时的边界处置正确**：语料 renderer 不响应 `requestDump`（10s 无应答，逐 token 记 reason），dump 机器在 p55-s0 已证——归 M4-E4/E5 的"非暂停"设计约束输入，不装成已解。

### M4-E0 的附带发现（我采纳为设计输入）

**terminal 判定对闲置 renderer 的 stop 确认截止敏感**（`page_navigate` 类流程留额外 renderer → manifest 诚实记 stop-timeout/incomplete）——这不是缺陷而是判定语义；含义 ②（signer_trace 的"非暂停证明"须把 producer 确认截止纳入预算）我写进 M4-E4 的锚点。

### 本轮发现（3 债 + 3 小项，全部非阻塞，归 M4 排期）

| ID | 事实 | 裁定 |
| --- | --- | --- |
| **D-M4-1** | **run_tests.sh 在我的 battery 形态挂起过一次**：host 套件里 e4-env 双活浏览器测试 24 分钟未返回，留 orphaned ChromiumX 把管道撑住；外层 `run_tests \| grep` 的 grep 缓冲把全部中间输出藏掉，不可诊断。隔离重跑 67/67 在 180s 内绿 | **M4 排期**：① 活测试必须把浏览器子进程登记进 kill-list，node:test 超时不打断悬挂的 async 测试 → 测试自身兜底杀（teardown 钩子兜底，不依赖 finally 正常返回）；② 外层跑批**禁止 `| grep` 缓冲**（stdbuf -oL 或直接落盘）；③ 复跑两次连绿才算稳定 |
| **D-M4-2** | **E5 的 console 断言把 Electron 内部启动竞态当产品错误**：我的运行 session1 有 2 条 `sandboxed_renderer.bundle.js` / `node:electron/js2c/sandbox_bundle` 错误（全部 9 场景仍 ok=true），门禁判 RED。这是基础设施噪声，不是应用代码 | **M4 排期**：建**具名基础设施噪声白名单**（每条注理由、report 里显示被滤掉几条——不许静默吞），其余 console/exception 仍零容忍 |
| **D-M4-3** | **M1.1-b 热点/init 区/事件规模跨 run 不可复现**：同一 bundle（`W1bH0CpS9gGF.1058d2a.js`）我的重跑得 hot 6@50 / distinct 493 / init_end 301 / 304K 事件，工程师跑得 hot 6@65 / distinct 831 / init_end 2276 / 435K 事件。脚本身份（script 6）稳定，偏移与规模不稳定（规模差~45% 与并发负载相关） | **报告披露债**（诚实）：M1.1 报告须补一句"热点/init 区为逐 run 推导、非稳定 bundle 属性"；M4-E4/E5 的 dump 锚点设计输入**不得假设固定偏移** |
| m-1 | m11-b 门禁下限过弱（`vpc_len>100 && taps>0`，真值 29 万级/80-95）——应断言**结构性稳定**（hot_script 恒为 bundle 脚本）+ 量级带（vpc_len 与 pass1_ignition 同量级、±20%），不是 100 的地板 | 小项，M4 顺手 |
| m-2 | m11-b 每次只跑一站（M11_SITE 默认 xj1）；"三站全绿"是三次分别跑出来的——加个 `--all` 循环或在报告里写明逐站调用形态 | 小项 |
| m-3 | 矩阵 gate 字段的分类用词不齐：unavailable 的 env 指纹族渲染 "(none — disclosed gap)"，应与 frx 五项同用 "unavailable-with-reason — no gate required"（不可用 ≠ 覆盖缺口） | 小项 |

### 登记册与状态账

- 登记册：M3-9 滞留的"开放"更正为**关闭**（工程师正确指出——四条小项已在 M3-E0 `cb01d27` 关闭，我核过）；**M4-7 关闭**（19→可用无门禁者 3，全为内部原语；达 MD4 上限）；新增 D-M4-1/2/3（M4 排期）+ 3 小项。
- progress JSON：`m11 = accepted-m11`、`m4 = m4-e0-debt-gate-passed`。

### 下一步（M4 主线）

按已发布的 [M4 工单](chromium-m4-observation-handoff.md) §5：**M4-E1（WebIDL 第二批选型冻结）开工**——执行层提案（每项引用实测证据），我裁决后冻结。E2–E7 依工单推进。M1.1 语料产物已具备 E1 选型所需的实测形态（三站 vPC 序列 + tap + 派发器定位）。
