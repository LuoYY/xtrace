# P6 执行工单记录：Agent 闭环（工程师执行侧）

- 对应工单：[chromium-p6-agent-loop-handoff.md](chromium-p6-agent-loop-handoff.md) v1.0（2026-09-26，四预决策冻结）。
- 纪律沿用：阶段成果落盘、补丁栈强制同步（本轮 E0 未触碰 chromium/src，无需重生成）、门禁含全部测试目标、未经要求不推送。
- 执行状态行：progress JSON `p6`。

## E0：进入债务清零（2026-09-26）

### E0-a：D-P55-1 同程序语义等价（红测试冻结 + E7 修复）

- **债务事实**：accepted-p55 记录的 D-P55-1——E7 门禁的 off/on"语义等价"比较了**两个不同程序**（stateOff 跑 PLAIN 内联循环、stateOn 跑 LOOP 函数+natives），对观察器零证明力。
- **新门禁** `scripts/p6-e0-dp551-equivalence.cjs`（冻结为常设门禁）：**完全相同的程序源**（确定性整数运算 + 字符串构建 + 嵌套结构）经注入 `<script>`（页内 URL、被追踪激活——Runtime.evaluate 不在 sync-causality 激活内，这是当年 E7 用注入式的原因，已复核）在两个浏览器各跑一次：capture-off vs capture-on（观察器 + 29,934 个 value tap + 1 次 token dump saved + terminal complete）。断言：结果对象 **deep-equal 逐位一致**、getter 哨兵与微任务哨兵两侧相等。亲跑 **PASS**（number/text/list/nested/totalFinite 全等，哨兵 1/0=1/0）。
- **E7 修复**（债务本体）：`p55-e7-valueobs-evidence.cjs` 的 stateOff 改跑**同一 LOOP 源**（off 侧也带 `--allow-natives-syntax --max-opt=0`，xtrace 旗标仍仅在 on 侧）；stateOn/afterStop 增加 `assert.deepEqual(…, stateOff.page)`——等价断言从"两个程序各自 allFinite"升格为"同一程序逐位相等"。重跑 **PASS**（off/on/afterStop 全 `{allFinite:true,last:1330}`，30 taps、validator 0）。

### E0-b：analyzer v3 因果树（P2 遗留债务）

- **债务事实**：`analyze_vmp_trace.build_causality_summary` 过滤 `schema_version == 2` 且读 v2 扁平字段——**所有 v3 capture 报 available=False**（P2 交接 §107-110 记录的未做项）。
- **修复**：新增 `_normalized_causality()` 双形归一（v3 对象形 `{kind,call_id,parent_id,depth,duration_us}`——schema 文档"v2 契约原样搬移"——与 v2 扁平形），树构建/计数/树节点全部走归一视图；v1 仍 unavailable（未触碰）。
- **门禁** `scripts/p6-e0-analyzer-v3-gate.py`（6 案例 **GREEN**）：v3 合成夹具（三层 paired 链 + exception 终态 + unclosed + singleton + external——树形/深度/计数精确断言）；v2 同形夹具产出**逐字段一致**（搬移等价）；v1 不变；**真实 accepted-p55 capture**（E7 最新运行，含 taps/paired/external）经 CLI 全链分析 available=True 且 paired>0。

### E0-c：GUI v3 可读不崩（P2 遗留债务）

- GUI 读取器本为 schema 无关 JSON-lines、报告构建防御式缺省——缺口是**代表性 v3 证据**。`xtrace-gui/test/xtraceReport.test.js` 新增两测试：v3 代表性事件集（causality 对象形 + value_tap 含 object_token/plan_serial + ignition 六字段 + external bnet 行）过 `buildLocalReport` + `buildAgentInputPack`；v1/v2 legacy 回归。GUI 套件 **213/213 全绿**（211 旧 + 2 新）。

### E0 证据汇总

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| `p6-e0-dp551-equivalence.cjs` | PASS（同程序 off/on deep-equal，29,934 taps + dump 下逐位一致） | `validation/p6-e0-dp551-*/` |
| `p55-e7-valueobs-evidence.cjs`（同程序化后） | PASS（off/on/afterStop 三方 deep-equal） | `validation/p55-e7-ERduFv/` |
| `p6-e0-analyzer-v3-gate.py` | 6/6 GREEN（合成精确形状 + v2 搬移等价 + v1 不变 + 真实 capture） | 内联合成 + `p55-e7-ERduFv/trace.ndjson` |
| GUI `npm test` | 213/213（v3 代表性 + v1/v2 回归） | `xtrace-gui/test/` |

进入条件达成（工单 §1.2：两者不清不进 E2）。E0 未触碰 chromium/src（无补丁重生成需求）。

progress JSON `p6` = `e0-debt-cleared`（下一步：E1 Host 骨架 + Broker 核心，长块 E1→E7 开始）。
