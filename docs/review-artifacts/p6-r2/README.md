# P6 复审 R2 复现材料（架构师亲跑，2026-09-27）

四个 probe 是 R2 复审的取证脚本（结论写进
[chromium-p6-execution-handoff.md](../../chromium-p6-execution-handoff.md) 的
「架构师复审 R2」节）。全部**不启动浏览器**，从仓库根目录跑：

```bash
node docs/review-artifacts/p6-r2/probe4-cursor-two-producers-synthetic.cjs
node docs/review-artifacts/p6-r2/probe5-cursor-real-capture.cjs
node docs/review-artifacts/p6-r2/probe6-cursor-page-sum-violation.cjs
node docs/review-artifacts/p6-r2/probe7-r1-fixes-behavioural.cjs
```

| 文件 | 取证内容 | 结论 |
| --- | --- | --- |
| `probe4-cursor-two-producers-synthetic.cjs` | 两 producer 交错、但**只有一个 producer 命中谓词**时的分页累加 | 40/40 无损 —— 说明 R1 的门禁夹具为何是绿的 |
| `probe5-cursor-real-capture.cjs` | 真实 accepted-p55 capture（`p55-e7-ERduFv`）分页：ignition（单 producer 13,444）与 bindings（两 producer 590+2） | 均无损 —— 因为该 capture 的命中子集实际由单 producer 主导 |
| `probe6-cursor-page-sum-violation.cjs` | 两 producer **都命中同一谓词**（`api='Document.cookie.set'`，rtx 与 rtw 交错、各自独立 seq 空间）、`maxRows=3` 分页 | **`sum=89` vs 真值 `60`，重复 29 行** → R1.6-D2 的分页累加等式被违反（游标是 producer-盲的数值 seq） |
| `probe7-r1-fixes-behavioural.cjs` | 经**组合根**复验 R1 六项阻塞的实际行为 + 两处申报不符 | B6 已拒（realpath 闸门）、B5 跳转已修（line 3 @ byte 772、`trace-on.ndjson`）、B4 loop 不再被切片异常击穿（`slice-error` 上报后 complete）；**B5 的计账实质未修**（`trace_summary` 行无 `drop_counters`/`unconfirmed_producers`，`enrichStatusRows` 唯一"消费者"是它自己的定义文件）；**M13 未修**（三个 60,001 字节结果实际进模型 180,003 字节，预算只记 24,576）；**D1 有洞**（`origin:'agent'` + `basisHint:'ui-direct-click'` 可自批，审计写下 `{origin: agent, basis: ui-direct-click}`） |

probe6 是本轮最关键的一条：真实 capture 普遍有 4–6 个 producer（本轮 E5 的
`ui-capture-1` manifest 就有 bnet + rtw + 4×rtx），只要两个 producer 命中同一
谓词且行序交错，分页就会重复计数——Agent 侧任何"数一数有多少次 X"的结论都会偏高。
