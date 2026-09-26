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

## M3-E1→E7 长块执行记录（2026-09-27）

按工单 §5 一次推进。零 chromium/src 改动（C/D 组全在 Host 侧，如 §6 预判）。

### E1 host-exec 档实装（PD1）

`broker.js` 新增 `gateHostExec`：默认拒绝（无策略对象即全档 deny）；策略三段 paths/network/deps 评估（**network.allow:['*'] 触发 policy-too-wide 防呆**——负控门禁实测拒）；**逐次确认载荷为具体动作**（argv/writePath，payload 进待决队列）；网络引用仅认显式 http(s) URL（普通 argv token 绝不当域名）；审计行记录完整 argv/exit_code/output_bytes/timed_out/cancelled。`executors.js`：run_node+run_python（**无 shell**，spawn 直传 argv）、超时 SIGKILL（timed_out 记账）、输出字节上限（truncated 披露）、**Broker 中介取消**（`context.onKill` 注册 kill 句柄，`cancelExecution(id)` 触发——**取消后子进程确实终止**：pid 活→死轮询实测，审计 execution-cancelled + executed.cancelled）。
门禁 7 条全绿（`test/e1-host-exec.test.js`）：默认拒/策略命中执行+审计全字段/超时杀/取消杀真/网络越界+写越界逐 verdict/防呆负控/无载荷拒。

### E2 D 组原生轨

`adapters-dgroup.js`：fs_list/fs_read/fs_write/fs_mkdir/fs_copy + scripts_save。全路径过 `workspace.assertInside`（realpath 闸门）；fs_read 32KB 分页（offset/limit 等式 + eof + limit 不超上限）；fs_write 父目录自动创建 + depth>24 拒 + 1MB 上限 + append 分段；scripts_save 经 `Debugger.getScriptSource`（404 拒、<16 字节残片标记、workspace scripts/ 目录落盘）。
门禁 5 条全绿（`test/e2-dgroup.test.js`）：三形态边界（符号链接/绝对/..，工具层与 workspace 层结论一致）、70KB 分页等式、append 精确拼接、depth、404/残片/happy path。

### E3 C 组 14 项

`adapters-cgroup.js`：page_navigate/elements/click/type/scroll/screenshot/info/eval、hook_inject、cookies、net_capture/net_list/net_get、page_automation_scan（真实浏览器一条门禁一工具，`test/e3-cgroup.test.js`）。**披露即数据**：hook_inject 带 OOPIF 差异 reason、cookies 结果自带 `scope: current-browser-context`、automation_scan 带 deltas_vs_firefox 列表；page_type 事件序列 input→change 断言；net 族 enable-then-navigate（先 about:blank attach 再导航——初始请求不丢）；net_list D2 游标窗口。

### E4 完整 env 管理器（M3 边界）

`env-manager.js` 扩展：`probePort`（真实 bind 探测）、`claimPort`（扫描 + **port-conflict 状态机**——冲突行指认占用 env）、`registerInstance`/`instanceStatus`/`terminateInstance`（SIGTERM→SIGKILL，状态机 running→stopped）、`allInstances`；fingerprint 挂载点**预留**（env.json 记录、不解释——M5）。双 env 并行实测（live Chromium×2）：各自 profile 被启动规格消费、进程互不干扰、实例行状态机全断言；exec -a 归启动器（规格承载 profile 的断言沿用 R1 锚点）。5 门禁全绿（`test/e4-env.test.js`）。

### E5 frx 轨（not-transferred 分支）

`adapters-frx-track.js`：notes_add/remember/wasm_probe/wasm_disasm/js_trace 五项 unavailable-with-reason（FRX_REASON 指向移交清单）；**无任何弱替**——run 一律拒绝；不出现在模型工具表。门禁断言注册形态+执行期拒绝+模型面排除（`test/e5-frx.test.js`）。

### E6 结构化不可绕过 + 重连设计（PD2/PD4）

- **broker-bound**（PD4）：`host.adapters.all()` 返回描述符行（run/available 剥离）——外部无执行入口；唯一执行路径 `callTool`。
- **静态门禁扩展**：adapter `.run(` 调用点限定 broker.js（作用域=产品目录；sqlite statement.run/loop.run 非 adapter 调用不误伤）；**负控**：植入 bypass 文件必须被抓（gate 自身可点火）。
- **重连设计文档** `docs/chromium-reconnect-design.md`：传输选型（UDS 首选需引擎补丁/TCP 次选需重开 P3/WebSocket 否决）、capture 状态恢复语义（收养+配置重放+会话重建，**不承诺断连期事件无缝**）、resolveOrphan 关系（降级 fallback，二选一不变）、六行失败模式表。
- **resolveOrphan/收养硬化门禁**（P6-R2 H 闭环）：收养路径（死 pid+settled→adopt+**index 实际 ingest**+幂等）与终止路径（活 pid+unsettled→kill 被调）各有断言（`test/e6-structural.test.js`）。

### E7 证据包

- 能力矩阵重生成（活组合根 + hostExecPolicy——有策略才有 executors，矩阵反映出货形态）：**available=41 / degraded=8 / unavailable=16，清单冻结范围全数在表**（A13+B12+env7+M5四+C14+D原生7+frx5+M4/M5 OUT 3+executors 2+npm_install 1=66 项），逐项 gate 出处。
- run_tests.sh：python 381 / launcher 28 / **host 51** / GUI 216 一条命令 exit 0（E1×7+E2×5+E3×1(14 工具)+E4×5+E5×1+E6×3 = 新增 22 测试）。
- E5 九场景+B1 逐动作等式+双负控 GREEN；E6 闭环 GREEN；static shape 7 检查 GREEN（含新 2 条）；S0 8/8、合约 21/21、P5 反例 12/12、verify_patches pass（零引擎触碰）。
- 不得削弱断言清单（37 组）保持——本轮只增不删。

progress JSON：`m3` = `e1-e7-final-package-submitted`；`m3_detail` 补 E1-E7 逐项。**申请：按工单 §5 长程一次终审；accepted-m3 由架构师标记。**
