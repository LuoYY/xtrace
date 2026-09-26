# 可重连控制面设计（M3-E6/PD2 交付，只设计不实现）

- 版本：v1.0（2026-09-27，执行层）。实现推到 M4 之后另议；本文回答传输选型、capture 状态恢复语义、与 `resolveOrphan` 的关系、失败模式表四件事。

## 1. 冻结前提（不可重开）

- P6 §5.4：pipe 断开即浏览器退出；Host 是浏览器的**所有者**。P3 终审已明确不引入 HTTP 调试端口与 `--remote-allow-origins=*`（安全面）。
- 因此"重连"意味着**另一种传输**承载同样的 DevTools 会话语义，而不是把现有 pipe 换成网络端口后假装风险没变。

## 2. 传输选型

| 候选 | 判定 | 理由 |
| --- | --- | --- |
| Unix domain socket（`--remote-debugging-pipe` 的 CDP over fd 换成 `--remote-debugging-path` 同等的 UDS 方案；Chromium 当前无此旗标，需引擎补丁） | **首选（若接受引擎改动）** | 继承文件系统权限（sock 属主/模式即 ACL）；断连语义与 pipe 相同（无 TCP 半开问题）；不进网络栈 |
| 本地回环 TCP + 随机端口 + 令牌握手 | 次选 | 零引擎改动（`--remote-debugging-port` 现成），但 P3 的安全裁定必须重开：需要令牌文件、绑定 127.0.0.1、禁 origin 检查豁免的替代证明 |
| WebSocket 直连（Mojo/DevTools http 端点） | 否决 | 同 TCP 的暴露面 + 额外握手状态；无补偿优势 |

**推荐**：UDS 路线立一个 P4 级引擎小补丁（把 fd 传输抽象成可插拔 transport，UDS 作为第二种实现），TCP 路线只在架构师显式重开 P3 裁定时评估。M4 之前不动引擎。

## 3. capture 状态恢复语义

重连后 Host 能恢复什么、不能恢复什么（按 capture 状态机）：

| 状态 | 可恢复 | 不可恢复（如实） |
| --- | --- | --- |
| trace 文件/manifest/索引 | 全部（已在盘上；`reindex()` 即收养） | — |
| observer/tap 配置 | 可重放（配置是 Host 侧不可变快照，重连后重推 `UpdateConfig`，plan_serial 递增） | 旧 plan 的 in-flight tap 是否已入文件未知 → 以 `plan_serial` 分代统计对账，差异记为 generation gap |
| CDP 会话（page/session/target 绑定） | target 列表可重枚举；**session id 全部失效**——重连后按 targetId 重新 attach，session 级 state（断点、已 enable 的域）重建 | Runtime/Network 域的监听窗口中断期间的事件**永久丢失**——恢复语义是"从重连点继续"，不是"补齐断连期"；中断时长写入 manifest 的 reconnect 记录 |
| capture 计账 | watermark/计数是 producer 累计的，重连不影响；最终 stop 时 model-2 等式照常裁决 | 断连期的 sampled_out 无法归因到具体窗口（记为 generation gap 而非猜测） |

**关键裁定建议**：重连恢复 = "数据面收养 + 配置重放 + 会话重建"，**不承诺事件无缝**。任何把断连期描述为零丢失的 UI 文案都是越级。

## 4. 与 `resolveOrphan` 的关系（二选一不变）

重连引入后，Host 重启时的选择仍是**二选一**，只是多了一个前置判据：

```
pipe 断开
  ├─ Host 进程也退出（现状，P6 冻结）
  │    └─ 重启后：resolveOrphan(pid, traceDir)
  │         ├─ pid 死 / manifest settled → adopt-read-only（现行为）
  │         └─ pid 活 + manifest 未落 → terminate（现行为）
  └─ Host 存活、传输可重建（未来 UDS 方案）
       └─ reconnectOrResume(captureId)
            ├─ 传输握手成功 → §3 的恢复语义（收养+重放+重建）
            └─ 握手失败/超时 → 降级回 resolveOrphan 路径
```

即：**resolveOrphan 不被替换，只是成为 reconnect 失败的 fallback**。两条路径的门禁（收养经 E5 resolve-orphan 实测、终止经 r1-core 单测）保持为基线；reconnect 落地时新增其自身门禁，不削弱现有两条。

## 5. 失败模式表

| # | 失败 | 检测 | 处置 | 审计/披露 |
| --- | --- | --- | --- | --- |
| F1 | 传输握手失败（浏览器已死/权限不符） | 握手超时（cdp watchdog 已有） | 降级 resolveOrphan；不重试风暴（指数退避，上限 3 次） | ledger 记 reconnect-attempt + outcome=handshake-failed |
| F2 | 重连成功但 target/session 树已变（页面关闭/导航） | targetId 重枚举 diff | 丢失的 target 记 generation gap；新 target 不自动纳入 scope（显式重放配置才进） | manifest.generation_gaps[] |
| F3 | 配置重放被 renderer 拒绝（plan_serial 冲突/precise 环境不符） | UpdateConfig 回执 | 停止重放，capture 标 coverage-partial + reason=reconnect-plan-rejected | ledger 记 plan_serial 前后值 |
| F4 | 双 Host 竞争同一浏览器（用户手起第二个 Host） | 握手时浏览器报告已有所属（协议扩展） | 第二 Host 拒绝并报 already-owned；不抢 | ledger 记竞争双方 workspace 根 |
| F5 | 断连期 producer 计数漂移（等式不再成立） | model-2 等式裁决（现机制） | terminal=incomplete + 原因；**绝不回填计数** | manifest.counts + reason=generation-gap-drift |
| F6 | 重连风暴（网络抖动/UDS 满） | 单位时间握手次数 | 熔断：N 次后直接 terminate + adopt-read-only | ledger 记熔断计数 |

## 6. M3 交付边界

本文即 M3 的 PD2 交付物；实现（UDS 引擎补丁、reconnectOrResume、协议扩展）不在本窗口。`resolveOrphan`/收养路径的**硬化门禁**另由 E6 的 e6-structural 测试覆盖（收养两条路径各有断言）。
