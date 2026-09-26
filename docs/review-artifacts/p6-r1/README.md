# P6 终审 R1 复现材料（架构师亲跑，2026-09-26）

三个 probe 是本轮终审的**取证脚本**，不是门禁。结论已写进
[chromium-p6-execution-handoff.md](../../chromium-p6-execution-handoff.md) 的
「架构师终审 R1」节；工程师整改时须把每条发现转成常设冻结红测试
（先红后绿，独立目录，不覆写历史证据），本目录仅作复现锚点保留。

运行方式（仓库根目录）：

```bash
node docs/review-artifacts/p6-r1/probe1-slicer-and-query-windows.cjs
node docs/review-artifacts/p6-r1/probe2-loop-crash-skill-escape-jump.cjs
node docs/review-artifacts/p6-r1/probe3-status-noop-clear-confirmation.cjs
```

依赖：已构建的 `out/XTraceIntegration` 证据目录（probe1 读取
`validation/p6-e5-ui-4pKd5L`、`validation/p6-e6-QmV7vy`、`validation/p55-e7-ERduFv`
三个真实 capture；若目录被清理，改成任一 ≥2 万事件的真实 capture 即可）。
三个 probe 均**不启动浏览器**、不写仓库内文件（临时目录在 `/tmp`），可反复跑。

| 文件 | 取证内容 | 对应发现 |
| --- | --- | --- |
| `probe1-slicer-and-query-windows.cjs` | `slicer.bound()` 硬截断路径在 cap=100/150/200 抛 JSON SyntaxError；`relevance()` 的 paired 分支对 v3 恒假；四个真实 capture 上 `jsvmp_query`/`webapi_query` 的返回行数 vs 全文件真值计数（含 accepted-p55 参考 capture：13,444 条 ignition → 返回 0 行） | B3、B4、M11 |
| `probe2-loop-crash-skill-escape-jump.cjs` | 切片异常击穿 agent loop（工具异常则被正确上报，形成对照）；`skill_read_resource` 经符号链接读到工作区外内容，而 `workspace.assertInside` 对同一路径正确拒绝；`evidenceJump` 对 `trace-on.ndjson` 命名的 capture 抛 ENOENT | B4、B5、B6 |
| `probe3-status-noop-clear-confirmation.cjs` | `captureStatus` 对非 `trace.ndjson` 命名静默报零（盘上 manifest 实为 dropped=7/failed=3/sampled_out=11/partial=5 + 1 个未确认 producer）；`jsvmp_trace clear` 只发 `getCaptureStatus`、无任何状态变更却返回 `cleared:true`；同键并发确认导致一个调用方永久悬挂；看门狗超时后**迟到批准仍会执行副作用**（ledger 出现 confirmed→executed） | B5、M3、M4 |

第三条 probe 里还测了一个**我原本怀疑、实测不成立**的点：`stopProgress`
在 deadline 后底层 `stopCapture` 拒绝不会产生 unhandled rejection
（`Promise.race` 已挂处理），600ms 内无异常——记录在此以免整改时误修。
