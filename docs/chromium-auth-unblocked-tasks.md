# 授权解锁的两个执行块（架构师工单，2026-09-27）

- 上游：两条授权于 2026-09-27 由用户下达（原文见 §1）。
- 性质：两个独立小长程块，互不依赖，可并行；都不是新里程碑，是对既有里程碑的"解锁收尾"。
- 纪律沿用：[M3 交接](chromium-m3-tool-surface-handoff.md) §6 + [M4 工单](chromium-m4-observation-handoff.md) §6（含 PD5 不得削弱、记录逐条可核）。

## 1. 授权记录（逐字，不可改写）

| ID | 授权内容（用户原话） | 日期 | 范围解释（架构师落笔，供执行层照此执行） |
| --- | --- | --- | --- |
| **AUTH-3** | "可以从 firefox-reverse 复制进 xtrace" | 2026-09-27 | 允许把 `~/work/github/GitHub/firefox-reverse/` 内的 MPL-2.0 源文件复制进本仓库；逐文件保留许可头与来源路径、登记 `docs/frx-migration-provenance.md`、不改标。仅限复制+迁入，不改 firefox-reverse 本体 |
| **AUTH-1** | "有书面授权，但是仅做 412->200 的验证，这都是 get 页面读操作，且低频请求，无任何系统攻击风险" | 2026-09-27 | **范围 = 仅 412→200 验证**：对三个语料站做 GET 页面加载（412 → 带 cookie 重载 → 200），只读观测，低频。**不含** POST/表单/登录/交互/扫描/指纹层 |
| **AUTH-2** | （未授权） | — | M5 活站指纹对等**不在本次授权内**，保持未授权边界；LIVE-412 的任何证据不得用于宣称指纹对等 |

**三个语料站（AUTH-1 的域名白名单，硬边界）**：`pmos.xj.sgcc.com.cn:20080`、`pmos.sc.sgcc.com.cn`、`pmos.jibei.sgcc.com.cn`。

## 2. 块 FRX-T：frx 轨实装（M3-E5"移交到位"分支激活）

M3 已按缩减范围验收（frx 轨 5 项 + A 组 2 项为 unavailable-with-reason）。AUTH-3 到位 → 现在激活实装分支。**归属：M4**（M3 已 accepted，不重开）；作为 M4 的首个执行块，排在 M4-E1 之前或与 E0 合并（由执行层定，但 E0 的债务门不受影响）。

### 2.1 移交源（我亲核在盘）

`~/work/github/GitHub/firefox-reverse/additions/browser/components/agent-sidebar/modules/`：

| 目标工具 | 源模块 | 源内形态 |
| --- | --- | --- |
| `jsvmp_split_dispatcher`、`jsvmp_disassemble` | `JsvmpBackend.sys.mjs` | babel/AST 离线分析（`dispatcher_probe` 随迁） |
| `notes_add` | `NotesBackend.sys.mjs` | NDJSON 追加（≤600 字、"只记已验证"约定） |
| `remember` | `LedgerBackend.sys.mjs` | SQLite/ledger.md，事实/死路两类条目 + 每轮注入语义 |
| `wasm_probe`、`wasm_disasm`、`js_trace` | `JsvmpBackend.sys.mjs` | wasm 装载 hook / wabt 反汇编 / acorn 插桩 + Node 执行 |
| （参考，不直接迁） | `Tools.sys.mjs`、`WorkspaceBackend.sys.mjs`、`EnvironmentBackend.sys.mjs` | 工具规格工厂 / 工作区后端 / 环境管理器——供对照，不复制 |

### 2.2 任务分解 FRX-T-1..4

| 序 | 任务 | 验收锚点 |
| --- | --- | --- |
| T1 | **移交登记**：逐文件复制进 `frx/`（仓库内新目录），MPL-2.0 头原样保留；写 `docs/frx-migration-provenance.md`（文件 → 源路径 → 许可 → 本地改动摘要） | `grep -L "MPL" frx/` 为空（逐文件许可头在位）；登记表与文件一一对应 |
| T2 | **依赖盘点**：每个待迁模块的 import 依赖列表；凡 npm 依赖（babel/wabt/acorn 等）逐一登记——**经 host-exec 的 deps 策略门**（默认拒绝，命中白名单才放行；`npm_install` 同理） | 依赖清单进登记表；无策略下任何 npm 安装调用被拒（红测试） |
| T3 | **实装 7 项**：`jsvmp_split_dispatcher`/`jsvmp_disassemble`/`notes_add`/`remember`/`wasm_probe`/`wasm_disasm`/`js_trace` 从 unavailable-with-reason 翻实装；每项一条真实产品路径门禁（真 Node 执行 / 真 SQLite / 真 wabt，不许假 host） | 每项一个门禁绿；执行期拒绝路径删除；能力矩阵 7 项翻 available/degraded |
| T4 | **矩阵与回归**：`scripts/m3-capability-matrix.js` 重跑（7 项翻绿、行数与算术闭合）；`run_tests.sh` 全绿；静态门禁不回退 | 矩阵重生成 + 全套件绿 |

### 2.3 完成定义

FRX-T-1..4 全绿 + 登记表在盘 + 矩阵 7 项翻绿 + 零引擎改动。完成后 M3 的"缩减范围达成并记债"标记改为"frx 轨补齐"（登记册 M3-1 关闭）。

## 3. 块 LIVE-412：活站 412→200 验证（M1.1 R 臂闭合）

M1.1 的 R 臂（语料 VM 真算 cookie 驱动 412→200）因"本地无服务端挑战材料"未演示。AUTH-1 解锁活站验证。**归属：M1.1 收尾**（把"本地未演示"边界升级为活站已证）。

### 3.1 硬护栏（验收锚点的一部分，违反任何一条即中止）

| # | 护栏 |
| --- | --- |
| G1 | **域名白名单硬编码**：只允许 `pmos.xj.sgcc.com.cn:20080`、`pmos.sc.sgcc.com.cn`、`pmos.jibei.sgcc.com.cn`；其余一切走死代理（`--proxy-server=http://127.0.0.1:9` + bypass 仅三域名） |
| G2 | **GET-only**：任何非 GET 请求出现（页面内 subresource 除外，subresource 也只许 GET）→ 立即中止并记录；驱动器对每个请求记录 method/url，report 里逐条列出 |
| G3 | **低频**：站间串行；每站导航 ≤2 次（412 一次 + 重载一次）；导航间隔 ≥2s；总请求（含 subresource）每站 ≤ 50 |
| G4 | **无交互**：不点、不填、不登录；只加载与重载 |
| G5 | **失败即停**：任何一步非 412/200/超时/网络错误 → 记录现状并退出，**不重试风暴**（指数退避上限 1 次重试/站） |
| G6 | **凭证不落盘明文**：cookie 值在 report 里只记 SHA-256 头 16 hex；trace（含 set 事件全文）本机 git-ignored 目录，不进仓库 |
| G7 | **只读观测**：XTrace 采集照常（观测不改值原则）；不留任何写操作 |

### 3.2 任务分解 LIVE-412-1..3

| 序 | 任务 | 验收锚点 |
| --- | --- | --- |
| L1 | **驱动器** `scripts/live-412-verify.cjs`：对每站——加载 412 页（XTrace capture 开）→ 有界轮询 cookie 落盘（≤60s，每秒一次）→ 同 URL 重载 → 观察 200；G1–G7 全程约束；每站独立证据目录 | 三站各跑一次；report 含逐请求 method/url 清单（证 GET-only）+ 时间间隔（证低频）+ 每请求总数（证上限） |
| L2 | **R 臂证据分级**：VM 真算 cookie（引擎观测 `Document.cookie.set`）→ 重载 200（服务器真相）→ 值相等 + 链同一 = **observed 级** R 臂锚 | M1.1 报告的"一阶段算 cookie 本地未演示"边界改写为"活站已证（observed）"，登记册 M1.1-d 预案关闭 |
| L3 | **失败处置门禁**：故意把白名单收窄（不含目标站）跑一次 → 断言零请求出网 + 干净中止（负控） | 负控绿：收窄白名单下零出网请求 |

### 3.3 完成定义

L1–L3 全绿 + 三站 R 臂 observed 级证据 + M1.1 报告边界改写 + 登记册 M1.1-d 关闭。**任何护栏违反 → 立即中止并回报，不绕。**

## 4. 状态落账

- 登记册：AUTH-3 → 已授权已执行（FRX-T 进行中）；AUTH-1 → 已授权（范围收窄，LIVE-412 进行中）；AUTH-2 → **未授权**（M5 指纹对等，不动）。
- progress JSON：`auth3 = transferred-in-progress`、`auth1 = authorized-scoped-412-only`、`auth2 = not-authorized`。
- 路线图：§8.1 加两行当前步；M4 的 frx 关键路径从"外部依赖"改为"已解锁"。
- 交接回执：两块完成后由架构师复核（FRX-T 我终审矩阵翻绿与许可登记；LIVE-412 我终审护栏遵守与证据分级）。
