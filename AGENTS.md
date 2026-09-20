# AGENTS.md — 项目工作规范

## Git 提交纪律

- **阶段成果必须落盘**：agent 每轮回复结束前，若任务产生了阶段性成果（可运行的代码修复、通过的验证证据、新交付文档、状态更新等），必须提交一个 commit 保存，不留未提交的工作成果跨轮累积。
- commit message 用祈使句概括"这轮做成了什么"（例：`Fix V05 causality switch forwarding and verify matrix`），正文可附证据指针（日志目录/测试名）。
- 仅提交有意义的阶段成果；探索性中间态、明确标注"待续接"的半成品在提交信息中如实说明，不伪装完成。
- `chromium/src` 为 git-ignored 工作树：Chromium 侧改动的阶段成果以受跟踪文件（补丁、文档、测试、驱动脚本）为准提交；C++ 现场进度记录在 `docs/chromium-p2-execution-state.md` 类状态文档中。
- 未经用户明确要求不推送远端。

## 其他

- 回报格式沿用各阶段交接文档（P1/P2 交接 §7 七行结构）。
- 原始证据目录位于 `chromium/src/out/XTraceIntegration/validation/`（本机 git-ignored，路径写进文档供核验）。
