# P6 不得削弱断言清单（M3-E0 基线，2026-09-27）

依据 M3 交接 §4 PD5：本表把 P6 现有全部常设门禁断言**逐条列为基线**，M3 各阶段与后续整改轮**不得削弱任何一条**；确需变更（换位置/换载体）必须给出替代位置并逐行说明。每条断言的验收锚点 = 其所在门禁在 CI 全绿时**按原样通过**。

## A. 常设门禁与关键断言（按门禁分组）

| # | 门禁 | 不得削弱的断言 |
| --- | --- | --- |
| 1 | `bash scripts/run_tests.sh` | python 381 全过；launcher 28 全过；**xtrace-host 套件全过（≥29）**；GUI 套件全过（≥216）——任何套件从清单中移除即视为削弱 |
| 2 | xtrace-host `r1-core`：workspace 边界 | 符号链接逃逸 `contains=false` + `assertInside` 抛 WORKSPACE_BOUNDARY |
| 3 | r1-core：read 档审计 | agent/ui/mcp 三来源各一条 `granted` 且 `basis=session-grant` |
| 4 | r1-core：ui-direct-click | UI 直点自确认 `basis=ui-direct-click`；**无 basis 的 confirmed 行不存在** |
| 5 | r1-core：agent 不自批 | agent 调用停靠 pending（`pendingCount===1`）；拒绝→`denied-by-user`/`basis=human-denied` 且副作用 0；批准→`basis=human-approved` |
| 6 | r1-core：**迟到批准**（R1-4） | TTL 过期后批准 → `confirmation-expired`、副作用 0、ledger 有 expired 行、无 executed 行 |
| 7 | r1-core：同键并发 | 第二个同键调用被明确拒绝（`already pending`）；首个可正常 settle；pending 归 0 无悬挂 |
| 8 | r1-core：cancelPending | 取消后执行 promise reject `cancelled`；**迟到 resolve 惰性**（副作用仍 0） |
| 9 | r1-core：host-exec | 注册抛 + gate denied（保留档默认拒绝不变） |
| 10 | r1-core：launch spec | spec 含 causality=sync/observer/js-flags max-opt=0/user-data-dir/xtrace-file；**不含传输旗标** |
| 11 | r1-core：能力协商 | 非增强浏览器→增强工具全 unavailable 带 no-XTrace-domain 原因；degraded 带 first-batch 原因；unavailableReason 无 available 函数时权威 |
| 12 | r1-core：孤儿解析 | settled（含 incomplete）→ adopt-read-only；live+无 manifest → terminate（kill 被调）；dead pid → adopt |
| 13 | r1-core：env 七操作 | 目录隔离（互不见 marker）、单开独占、delete 拒 open 态、`opens` 计数、名字逃逸拒绝 |
| 14 | r1-core：loop 取消+熔断 | 迭代间取消→cancelled；重复未知工具→no-progress 且迭代 ≤ streak+1 |
| 15 | r1-core：rebuild 等式 | wipe 后 rebuild 与原 built 逐字段相等（含 drop_counters 四元组与 unconfirmed_count） |
| 16 | r1-core：A-13 注册 | 清单 13 项全在适配器表；不可用工具**执行期拒绝**（not migrated） |
| 17 | r1-core：agent+basisHint | agent 带 hint 停靠；deny 后副作用 0；ledger 无 agent+ui-direct-click 行 |
| 18 | r1-core：实际字节计账 | 100KB 预算 ×3×60KB → 恰 1 接纳 2 refused；接纳行 bytes>50000（无 min-clamp） |
| 19 | r1-core：CDP_TIMEOUT | 假连接 40ms → reject `CDP_TIMEOUT` |
| 20 | r1-core：stop 截止 | 死浏览器 stop 30ms → `stop-timeout` + `elapsed_ms≥25` + stages 含 deadline-missed |
| 21 | r1-adapters：B3 双门禁 | 合成（6000 前缀+40 ignition+25 bindings）分页累加==真值（含端点游标）；**真实 capture**（p55-e7）ignition 全量分页累加等式 + bindings==真值 |
| 22 | r1-adapters：三 producer 游标 | 90 行三 producer 交错、页 7 → sum==90 且 Set 去重==90（R2-C 常设化） |
| 23 | r1-adapters：B6 三形态 | 符号链接/绝对路径/`..` 全拒且与 workspace 层结论一致；good skill 可读 |
| 24 | r1-adapters：M6 jump | trace-on 命名下 jump line/byte_offset 正确、trace_file 为索引列值；未命中**抛错** |
| 25 | r1-adapters：B4 扫描 | cap∈{32..4096}×三形零异常、bytes≤max(cap,floor)、JSON.parse 可解析、极小预算 dropped_fields 披露 |
| 26 | r1-adapters：M11 权重 | value_tap>plain；paired return 权重生效（v3 对象形归一）；**打乱负控翻转**（注入权重改判必须红） |
| 27 | r1-adapters：loop 不 unwind | no-such-shape/unknown-capture 切片错误上报（slice-error 日志）且 loop settle 非 reject |
| 28 | r1-adapters：组合根真机 | 单一 broker、callTool 执行、toolSchemas 带 state、不可用工具不在模型表、ui-direct-click stop **pair={complete, coverage非空}**（D-P6-3 实质断言） |
| 29 | GUI 套件：B5 | trace-on 夹具下 drop_counters==盘上真值、unconfirmed_producers==名单、terminal_reason 正确 |
| 30 | GUI 套件：渲染器 | cancel 文案含"check Status"；capabilities 三态计数+缺口；授权行带 basis；jump 渲染 line/byte_offset |
| 31 | `p6-e5-ui-scenarios.cjs` | S1 pair（complete+partial）；**S3 双正则 && 修（D-P6-2）**；S2 stop-timeout；S4 cancel；S5 resume；S6 deny+approve；controls/clear/resolve-orphan；**B1 逐动作等式 + row-drop 与 phantom 双负控（m-R3-5）+ 读侧等式**；双会话 console/exception/非本地全 0 |
| 32 | `p6-e6-closed-loop.cjs` | 九阶段（env profile 被 spec 消费、pair、validator 0、index、agent 引用、citedRef jump、审计全 basis） |
| 33 | `p6-r1-static-shape.js` | createBroker 调用点=定义+组合根+probe；桩 0；resolveConfirmation 仅确认 IPC；run_tests 含 host；钩子仅 app.js |
| 34 | `p6-e0-dp551-equivalence.cjs` | 同程序 off/on deep-equal + 哨兵 + **taps>0 正控** |
| 35 | `p6-e0-analyzer-v3-gate.py` | 6/6（树形/计数/搬移等价/v1 不变/真实 capture） |
| 36 | 引擎侧冻结套件 | `p55-s0-red-tests.py` 8/8、`p4-review-contract.cjs` 21/21、`p5-reopen-counterexamples.cjs` 12/12、`p55-e7` 同程序等价——零 chromium/src 触碰前提下按字节相同接受 |
| 37 | `verify_patches.py --with-dylibs` | verdict pass（触碰 chromium/src 的提交必须补丁重生成后仍 pass） |

## B. 变更纪律

- 删除任何一行测试断言：必须给出**替代位置**（同强度或更强），并在 commit message 与执行记录中逐行说明。
- 本表由 M3-E0 建立、随每轮终审由架构师复核；新增门禁自动追加（不在表里的新断言不受"不得削弱"约束的误解——**所有**入库断言都受约束，本表是清单不是豁免表）。
- 存在性检查类测试（如 m-R3-6 降级的 grep 锚点）**不计入门禁数**，其测试名自带 "not a behavioral gate" 标注。
