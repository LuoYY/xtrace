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
