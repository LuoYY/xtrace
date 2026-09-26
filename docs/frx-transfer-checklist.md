# frx 移交清单（M3-E0 产出，待架构师确认）

依据 M3 交接 §7.1：按清单 [tool-inventory.md](tool-inventory.md) §2 逐项列出"需要哪些 frx 文件/模块"，标注组归属与许可头现状。**当前判定：`not-transferred`**（仓库内零 frx 文件，`git log` 全历史无移交 commit；进度 JSON 三态待架构师确认后随 E0 收尾写入）。

## 1. 逐项需求

| 工具 | 组 | frx 依赖（清单 §2 原文） | 移交状态 | 许可头现状 | 未到位时的形态 |
| --- | --- | --- | --- | --- | --- |
| `jsvmp_split_dispatcher` | A | `jsvmp.splitDispatcher`（babel + AST，离线；`dispatcher_probe` 随迁） | **not-transferred** | 无本地文件可核对 | unavailable-with-reason（已注册，见能力矩阵） |
| `jsvmp_disassemble` | A | `jsvmp.disassemble`（离线反汇编，依赖 handlers.json + 字节码输入） | **not-transferred** | 同上 | 同上 |
| `notes_add` | D-frx 轨 | `notes` backend（NDJSON 追加；≤600 字与"只记已验证"约定） | **not-transferred** | 同上 | E5 记债（M3 缩减范围达成） |
| `remember` | D-frx 轨 | `ledger.append`（SQLite/ledger.md；事实/死路两类条目 + 每轮注入语义） | **not-transferred** | 同上 | 同上 |
| `wasm_probe` | D-frx 轨 | `jsvmp.wasmProbe`（Node 装载 glue + wasm，hook wbg import；selectors 真值 + signerExpr 工厂语义） | **not-transferred** | 同上 | 同上 |
| `wasm_disasm` | D-frx 轨 | `jsvmp.wasmDisasm`（wabt，npm 自动安装；落盘 WAT、只回摘要护栏） | **not-transferred** | 同上 | 同上 |
| `js_trace` | D-frx 轨 | `jsvmp.jsTrace`（acorn AST 插桩 + Node 执行） | **not-transferred** | 同上 | 同上 |

间接依赖（随上表一起移交时核对）：`Tools.sys.mjs` 及关联模块（清单 §4：MPL-2.0，逐文件保留来源与许可标注，不得改标 MIT）。

## 2. 状态判定（E0 结束前写入 progress JSON）

- **当前三态：`not-transferred`**（依据：仓库与 git 历史零 frx 源文件）。
- 影响：M3-E5 按"未到位"分支执行——frx 轨五项 + A 组两项保持 unavailable-with-reason，**禁止自研弱替**（M3 交接 §7.4）；M3 以缩减范围达成的缺口记入能力矩阵与登记册。
- 移交发生时：逐文件登记 `docs/frx-migration-provenance.md`（文件→来源路径→许可→本地改动摘要），再按 E5 实装分支走。

## 3. 移交后首验清单（预备）

- MPL-2.0 头逐文件在位；`grep -L "MPL"` 于迁入目录为空。
- `scripts/m3-capability-matrix.js` 重跑：七项从 unavailable 翻 available/degraded，且各有对应门禁。
