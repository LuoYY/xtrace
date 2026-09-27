# M3 终审 R1 复现材料（架构师亲跑，2026-09-27）

两个取证 probe，结论写进 [chromium-m3-execution-handoff.md](../../chromium-m3-execution-handoff.md)
的「架构师终审 R1」节。从仓库根目录跑：

```bash
node docs/review-artifacts/m3-r1/probe1-scripts-save-real-browser.cjs   # 需 ChromiumX（真浏览器）
node docs/review-artifacts/m3-r1/probe2-cgroup-tier-grants.cjs          # 不启动浏览器（stateful 档各等 60s TTL，总 ~3 分钟）
```

| 文件 | 取证内容 | 结论 |
| --- | --- | --- |
| `probe1-scripts-save-real-browser.cjs` | 真浏览器上经组合根调 `scripts_save`（本地页面、真 scriptId） | **工具 100% 抛错**：`'Debugger.getScriptSource' wasn't found`（browser 级无 sessionId 发送）；同一调用带 sessionId 返回 711 字节真源码 → 会话域错位实证。e2 门禁的 happy path 用的是**脚本化假 host**（测试注释自认），所以缺陷漏网；能力矩阵却标 available |
| `probe2-cgroup-tier-grants.cjs` | agent 来源经组合根调 `page_navigate`/`page_click`/`page_type`/`cookies`（无浏览器），对照 `page_eval`/`net_capture`/`jsvmp_trace` | **四项 C 组工具被静默会话级放行**（ledger：`granted:session-grant`，无人被问），而清单 §2/C 的"需确认"列对 page_navigate/page_click/page_type/cookies 均为"是"；三项 stateful 档工具正确停靠待决至 TTL 过期（对照组行为正确） |
