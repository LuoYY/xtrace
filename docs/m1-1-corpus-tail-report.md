# M1.1 语料尾件报告（a/b/c 三项，2026-09-27，工程师）

> 任务源：[P6 交接 §6](chromium-p6-agent-loop-handoff.md)（a/b/c）+ [路线图 §8.1 当前步](roadmap-milestones.md)。
> 预授权降级（路线图 M1.1 行）：真二阶段不可得时按"合成两段流 + 语料级锚点"收口，产物等级如实降级。
> 原始证据：`chromium/src/out/XTraceIntegration/validation/m11-a-*/`、`m11-b-*/`（本机 git-ignored，逐目录列出）。
> 语料基座：`analysis/corpus-capture/`（P5.5 采集步，三站首阶段 wrapper+bundle，09-24）。

## a 项：本地 412→200 重放服务 + 真实两段流 nav_chain 锚点（echo oracle 三级）

交付：`scripts/m11_replay_server.py`（重放服务器：单端口双 Origin——语料 Origin = `localhost` Host，驱动 Origin = `127.0.0.1` IP，跨 site 天然 OOPIF）+ `scripts/m11-a-replay-navchain.cjs`（驱动 + 三级断言）。

**机制**（两次失败方案如实记录：同源 isolate-origins 不拆同源 frame，导航提交排队在 VM 死循环后；127.0.0.2 在本沙盒不可绑定 Errno 49）：语料 VM 字节不动，作为 stage-1 文档的跨站 iframe 在**独立进程**里跑（本地无挑战材料时 VM 阻塞自己的 renderer 主线程——P5.5 采集用 `--capture-seconds` 定时正因此）；驱动页（A Origin）保持可导航。首访 `/` 无新 cookie → **412**（body = 驱动文档内嵌语料一阶段，声明：重构 wrapper 非原始 412 页）；请求携带一阶段未有的 cookie → 同 URL **200**（合成二段，声明）。

**三级 oracle**：
- **L1 observed（服务器真相，引擎外）**：echo 日志逐请求记录 path/status/Cookie 头——412（无 cookie）与 200（携带锚 cookie）双双在案。
- **L2 observed（引擎事件）**：manifest.identity.nav_chain 同帧后继行（from/to document 不同、cause、wall_us、`ftn-<frame_tree_node_id>`）+ 载体事件（Document.cookie.set / 二段 Document.cookie.get）携带锚值。
- **L3 derived**：L1==L2 值相等 + 顺序（set 先于请求 / get 后于请求，按臂记录不相混）+ 链同一。

**臂**：R（语料 VM 本地真算 cookie→驱动桥接转发，声明合成桥）未触发——三站 VM 在本地均不落 cookie（与 P5.5 README 边界一致）；**S 臂（预授权合成锚）三站全绿**。二段页 `cookieSeen` 实证。

| 站 | 臂 | L1 | L2 载体 | L3 | 证据 |
| --- | --- | --- | --- | --- | --- |
| xj1 | S | 412→200 ✓ | get | 值等+顺序 ✓ | `m11-a-8Q0bS9`（语料 VM 流内 14,822 reverse 事件） |
| sc | S | 412→200 ✓ | get | ✓ | `m11-a-JobLI4` |
| jibei | S | 412→200 ✓ | get | ✓ | `m11-a-UcAIX8` |

边界如实：锚链等级 derived（值相等+链同一+顺序，不作因果闭合断言）；终态 incomplete/stop-timeout 为语料 VM 不让出主线程的预期（与 09-24 语料采集终态同类）。

## b 项：三站带 tap 窗口（D1 热点绑定）+ dump 锚点复跑 → vPC 序列

交付：`scripts/m11-b-tap-dump-recapture.cjs`（两遍式：pass1 定位 → pass2 观测）。

- **pass1（定位，D1 级）**：语料配方定时采集（observer + max-opt=0 + sync 因果 + 死代理护栏），per-(script,offset) 直方图 → **派发循环热 offset**（绑 D1 元数据资产：`v8-bytecode-metadata://6/*` 确认 script 6 = 外部 bundle）；per-activation offset 流 → **vPC 序列**（derived）。
- **pass2（观测）**：**先 startCapture 后导航**（tap 计划挂在新编译上——首版后启动零 tap，已修）；valueObservation 双窗：`[0..hot-1]` init 锚（解码表构建区）+ `[hot..hot+64]` 派发邻域（不相交策略合规，均在 script 内）；活体 token 观测 + `XTrace.requestDump`（CDP 级，零页面交互）。

| 站 | ignition 事件 | 热点 (script@offset) | vPC 序列长 | init 区 | pass2 taps | 证据 |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| xj1 | 422,047 | 6@65（10,477 次） | 422,031 | ≤2276 | 95 | `m11-b-xj1-mujo1jad` |
| sc | 348,126 | 6@65（8,429 次） | 348,110 | ≤2295 | 86 | `m11-b-sc-mujo3ddy` |
| jibei | 426,864 | 6@50（10,455 次） | 426,240 | ≤301 | 79 | `m11-b-jibei-mujo57he` |

**边界（如实，登记给 M4-E4/E5 设计输入）**：语料 renderer 主线程被 VM 死循环占住，`XTrace.requestDump` 全部 `timeout: no renderer reply in 10s`——dump 机器本身在可响应页已证（`p55-s0` dump-control 正环：tap→token→dump→asset），语料场景需 VM 让出点或中断式 dump 通道（M4-E4 signer_trace 的"非暂停"设计约束同族）。tap 事件（含 176 个 object_token≠0 的真堆对象引用）与 vPC 序列不受影响，已交付。

## c 项：产物包与等级标注

每站产物（`validation/m11-b-<site>-*/`）：`pass1.ndjson`+manifest、`pass2.ndjson`+manifest+assets（D1 元数据）、`analysis.json`（热点/激活/vpc 统计）、`vpc-sequence.ndjson`（offset+opcode 全序列）、`report.json`。a 项另含 `echo.ndjson`（L1 真相）与 trace+manifest。

**等级标注**：
| 产物 | 等级 | 依据 |
| --- | --- | --- |
| vPC 序列（bytecode_offset 流） | **derived** | 由 Ignition.execute 观测事件推导，非直接观测寄存器 |
| tap 事件（init/派发窗寄存器与对象值） | **observed** | 值观测面直接事实（P5.5 契约语义） |
| D1 元数据资产（v8-bytecode-metadata） | **observed** | 资产通道直接落盘 |
| a 项锚链（cookie 值跨段相等） | **derived** | 值相等+链同一+顺序；不作因果闭合 |
| L1 服务器 echo 日志 | **observed** | 引擎外请求级真相 |
| 二段文档 / S 臂锚 / 412 body | **合成/重构（声明）** | 预授权降级路径；XJ 二阶段 blob 不可得（语料 README） |
| 解码表 dump 资产 | **未取得（边界）** | 语料 renderer 不响应 requestDump；机器在 S0 已证 |

## 状态

M1.1 a/b/c **完成（降级路径如实标注）**。依赖均已满足：R2-C producer-盲游标修复在案（多 producer 语料 capture 可查）；412→200 重放、tap 窗、vPC 序列三站齐。**M4-E1 选型冻结解除阻塞**（工单进入条件 ③ b 项产物在盘）。
