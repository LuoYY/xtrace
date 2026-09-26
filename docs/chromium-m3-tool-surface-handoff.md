# M3 交接：工具面完整（C 组页面调试 + D 组宿主执行 + 完整环境管理器）

- 文档版本：v1.0（2026-09-27，项目架构师）。**提前发布**：进入条件未达成前先冻结范围与决策，达成即可开工，不再等一轮问答。
- 进入条件（三者全部）：① `accepted-p6`（P6-R2 整改通过，见 [P6 交接 §R2.5](chromium-p6-execution-handoff.md)）；② [登记册](open-items-register.md) 里 M2 名下的开放项全部关闭或经我裁定转为记债；③ frx 源码移交状态已判定（§7 协议，两种状态都能开工，范围不同）。
- 对应里程碑：**M3**（[路线图](roadmap-milestones.md) §1，窗口 2026-10-08 → 11-04）。
- 分工：执行层实施；架构师裁决与终审。长程单次终审模式沿用（E0 完成后 E1→E7 一次推进、一次提交、一次终审）。

## 1. 接手先做什么

1. 读本文件 + 清单 [tool-inventory.md](tool-inventory.md) §2/C、§2/D（逐项迁移目标与"完整/部分"判定）+ 草稿 §11.2（Broker/策略白名单）+ §6.4（限额契约）。
2. 先跑一遍 **M3-E0 债务门**（§5）：把 P6-R2 的残留、"不得削弱断言清单"、能力矩阵生成器三件事做完再进 E1。
3. 现场确认：`accepted-p6` 的二进制/补丁栈（`verify_patches.py` pass）、`xtrace-host` 组合根形态（`host.callTool` 唯一执行口）、静态形态门禁（`scripts/p6-r1-static-shape.js`）仍在跑。

## 2. 冻结输入

| 项目 | 值 |
| --- | --- |
| 浏览器 | ChromiumX（out/XTraceIntegration），CDP pipe + XTrace 域；基线固定 151.0.7917.0 不变 |
| 数据契约 | trace-schema-v3（v1.3，accounting model 2）；索引/审计/切片沿用 P6-R1 形态 |
| 执行口 | **只有 `host.callTool`**（组合根内建 Broker）；C/D 组一律经此，禁止新增旁路形态 |
| 工具清单 | 清单 §2/C 16 项、§2/D 15 项；本轮范围按 §3 冻结，**不在验收时临时议定** |
| 许可 | frx 迁入代码保留 MPL-2.0 标注、不改标；逐文件登记来源（§7） |

## 3. 范围与非目标（冻结）

### 3.1 C 组：14 项 IN，2 项 OUT

- **IN（清单判定"完整"，含一项需适配）**：`page_navigate`、`page_elements`、`page_click`、`page_type`、`page_scroll`、`page_screenshot`、`page_info`、`page_eval`、`hook_inject`、`cookies`、`net_capture`、`net_list`、`net_get`、`page_automation_scan`。
  - `page_automation_scan` 的扫描脚本须按 Chromium 环境面适配（探测项增删），**"只读扫描"性质不变**，与 Firefox 的字段面差异逐项写进能力表。
  - `net_get`/`net_capture` 的大 body 按草稿 §6.4 限额契约在 Host 侧有界化（字节上限 + 截断披露 + 落盘指针），沿用 P6 的 256 KiB 单次返回上界与游标续读。
  - `hook_inject` 的 OOPIF 作用域差异（Target auto-attach 覆盖面）必须在能力表显式披露。
  - `cookies` 的作用域是当前 browser context（非 nsICookieManager 的全局视图），差异写进结果字段。
- **OUT（清单判定"部分"，需引擎侧观测扩展）→ 移到 M4**：`signer_trace`（需 P4 observer 扩展为"选定脚本函数入口 + 实参"，CDP 断点会暂停页面、不等价）、`closure_read`（需值观测扩展到执行后真值 + 深序列化）。两项在 M3 的能力矩阵里注册为 **unavailable-with-reason**（原因写"待 M4 观测面扩展"），不得以 CDP 断点或 `page_eval` 弱替充数。

### 3.2 D 组：13 项 IN（分两轨），1 项策略门，1 项 OUT

- **原生轨（不依赖 frx 源码，M3 内实装）**：`fs_list`、`fs_read`、`fs_write`、`fs_mkdir`、`fs_copy`、`run_node`、`run_python`、`scripts_save`（CDP `Debugger.getScriptSource` → Host 落盘）。
  - fs 族：workspace realpath 闸门（P6 的 `assertInside`，**不得另写字符串前缀判定**）、32KB 截断 + offset/limit 切片、append 分段写、depth 上限、写入自动建父目录。
  - `scripts_save`：404/残片检测等完整性护栏平移；写入路径经 Broker 路径策略。
- **frx 轨（依赖源码移交，按 §7 判定）**：`notes_add`、`remember`、`wasm_probe`、`wasm_disasm`、`js_trace`。
  - 移交到位 → M3 内实装并逐项许可登记；未到位 → 注册为 unavailable-with-reason（与今天的 `jsvmp_split_dispatcher`/`jsvmp_disassemble` 同形态），**M3 以缩减范围达成并记债**（路线图 §1 M3 行已授权此形态）。
- **策略门**：`npm_install` 实装但**默认拒绝**——必须命中显式网络策略条目才放行（§4 PD1）。
- **OUT → M4/M5**：`whitebox_diff`（V8 覆盖为块级/函数级，与 SpiderMonkey 粒度不等价，需对齐器设计）。注册 unavailable-with-reason。

### 3.3 完整环境管理器：M3 与 M5 的分界（冻结）

- **M3 交付**：`create/open/close/list/status/delete/update` 七项（P6 已有）+ **端口扫描 + 真实 bind 探测 + 进程状态机 + 实例所有权 + macOS `exec -a` 进程名伪装** + 与 `buildLaunchSpec` 的接线（每 env 独立 profile 已被消费，本轮加"每 env 独立实例与端口"）。
- **M5 交付（不在本轮）**：指纹挂载点、暖 profile 复用策略、一键生成"profile+指纹+采集配置"。M3 只**预留挂载点**（env 记录里留 fingerprint 字段位，不实现语义）。

### 3.4 非目标

MV3 sidePanel、跨平台构建、发布流水线（M6）；指纹伪装层（M5）；`signer_trace`/`closure_read`/`whitebox_diff`（M4/M5）；Agent 模型外发默认开启（仍默认关闭，显式策略）；**重连的实现**（见 PD2，本轮只交设计）。

## 4. 已冻结的前置决策（块内不重开）

**PD1：host-exec 档（Broker tier c）的策略形状。**
- 默认拒绝。策略对象三段：`paths:{read:[],write:[]}`（write 默认限工作区内）、`network:{allow:[]}`（**空 = 离线**）、`deps:{npm:[]}`。
- 逐次确认的载荷必须是**具体动作**（argv / 目标路径 / 目标域名），不是工具名；确认面（面板待决队列）显示同一载荷。
- 审计行记录：解析后的策略判定（命中哪条/被哪条拒）、**完整 argv 或路径**、输出字节数、退出码、超时与否。
- 首批执行器只有 `run_node` 与 `run_python`（**无 shell**）；三者必带超时 + 输出字节上限 + 经 Broker 的取消（`cancelPending` 同族语义，取消后子进程必须被终止并记账）。
- `npm_install` 只有命中 `network.allow` 才放行；`fs_write`/`fs_copy` 的目标必须过 realpath 闸门。

**PD2：重连语义——本轮不实现，只交设计。**
- 维持 P6 §5.4 的冻结事实：pipe 即宿主所有权，pipe 断开即浏览器退出；P3 已明确不引入 HTTP 调试端口与 `--remote-allow-origins=*`。因此"可重连控制面"需要另一种传输，属独立设计轮。
- M3 交付物 = `docs/chromium-reconnect-design.md`（传输选型、capture 状态恢复语义、与 `resolveOrphan` 的二选一关系、失败模式表）+ **`resolveOrphan`/只读收养路径的硬化与门禁**（P6-R2 的 H 项：目前零覆盖）。实现推到 M4 之后另议，不占 M3 窗口。

**PD3：能力矩阵必须自动生成，不许手写。**
- 交付 `scripts/m3-capability-matrix.js`：从 `host.capabilities()` 协商结果导出逐工具矩阵（name / group / tier / state / reason / 依赖 / 是否有门禁覆盖），落 `validation/m3-capability-matrix.json`，并由门禁断言"矩阵行数 == 清单 A+B+C+D 冻结项总数、每项非 available 必带 reason、每个 available 项必有一条对应门禁名"。
- 理由：P6 的"清单逐项能力矩阵与实测一致"是靠人工核对通过的，R1 复审抓到 4 项静默缺席（M5）。矩阵一旦手写就会再次与实插不符（P4 的 coverage 表教训）。

**PD4：Broker 不可绕过要从"约定"变成"结构"。**
- 适配器交给外部时必须是 **broker-bound 函数**（不暴露 `.run`）；`host.adapters.all()` 只供协商与矩阵生成使用，返回值不含可直调的 `run`。
- 静态形态门禁扩展：仓库内 `\.run\(` 的调用点只允许出现在 `broker.js`；`createBroker(` 调用点仍限定义 + 组合根 + 架构师 probe。
- 新增负控门禁：故意注册一个"绕过 Broker 直接调 adapter"的假入口，断言静态门禁**能抓到**（门禁自身要有负控，否则形同虚设）。

**PD5：整改轮的"不得削弱"纪律（P6-R2 教训，制度化）。**
- 每个执行块的提交必须在记录里附 **删除/修改的断言清单**，逐条给出替代位置；无替代即视为范围变更，走裁决。
- 我的复审固定动作包含"记录逐条 vs 实测（diffstat + grep）"，申报未做的项按纪律项处理（不是小项）。

## 5. 任务分解

| 序 | 任务 | 关键交付 | 验收锚点 |
| --- | --- | --- | --- |
| M3-E0 | 债务门 | P6-R2 残留清零确认；**不得削弱断言清单**（把 P6 现有全部门禁断言列成表，作为本轮基线）；`scripts/m3-capability-matrix.js` 首版（只覆盖 A+B 组） | 矩阵生成器跑通且与 P6 实测一致；清单表进 docs；`run_tests.sh` 全绿 |
| M3-E1 | host-exec 档实装（PD1） | Broker tier c 从"保留形状"变成可用：策略对象、具体动作确认载荷、argv/路径审计、超时/输出上限/取消、`run_node`+`run_python` | 默认拒绝实测（无策略→拒）；命中策略→执行并记账；**取消后子进程确实终止**（实测 pid 消失 + 审计行）；越界路径/越界域名拒绝；负控：把策略放宽到 `network.allow:['*']` 时门禁必须报"策略过宽"（防呆） |
| M3-E2 | D 组原生轨 | fs 五件 + `scripts_save`；全部经 realpath 闸门与字节限额 | 边界三形态（符号链接/绝对路径/`..`）全拒且工具层与 workspace 层结论一致；32KB 截断与 offset/limit 等式；`scripts_save` 对 404/残片的护栏实测 |
| M3-E3 | C 组 14 项 | CDP 映射 + 输入合成语义 + net 族有界化 + `hook_inject` OOPIF 披露 + `page_automation_scan` Chromium 适配 | 每项一条门禁（真实浏览器，本地页）；`page_type` 的事件序列断言（input/change + 可选回车）；`net_get` 大 body 截断披露 + 游标续读等式；`cookies` 作用域差异在结果字段里可见 |
| M3-E4 | 完整 env 管理器 | 端口扫描 + bind 探测 + 进程状态机 + 实例所有权 + `exec -a`；与 launch spec 接线；指纹挂载点预留 | **两 env 并行实测**：各自端口/profile/进程互不干扰（进程命令行核对 `exec -a` 名）；端口冲突时的状态机转移有断言；env_open 后启动的浏览器 `--user-data-dir` == 该 env profile（沿用 P6-R1 锚点） |
| M3-E5 | frx 轨（条件执行） | 按 §7 判定：到位则实装 `notes_add`/`remember`/`wasm_probe`/`wasm_disasm`/`js_trace`；未到位则 unavailable-with-reason + 记债 | 到位：每项一条门禁 + 逐文件许可登记（`docs/frx-migration-provenance.md`）；未到位：矩阵里五项状态与原因正确，且**没有任何弱替实现** |
| M3-E6 | 结构化不可绕过 + 重连设计（PD2/PD4） | broker-bound 适配器；静态门禁扩展 + 负控；`docs/chromium-reconnect-design.md`；`resolveOrphan`/收养路径门禁 | 静态门禁 GREEN 且负控能抓；设计文档含传输选型/状态恢复/失败模式表；收养与终止两条路径各有门禁（P6-R2 H 项闭环） |
| M3-E7 | 证据包 + 终审 | 全门禁矩阵、逐项能力矩阵、文档同步、progress JSON | 架构师终审后 `accepted-m3` |

## 6. 纪律

- 沿用 P2 §6 全条 + P5.5 契约 §2 + P6 工单 §7，**外加 PD5**。
- 补丁栈强制同步（触碰 `chromium/src` 或 `v8` 的提交必须附补丁重生成 + `verify_patches.py` pass）。C/D 组预计**零引擎改动**（全在 Host 侧）；若 `page_automation_scan` 或 `whitebox` 相关工作意外需要引擎改动，先回报再动。
- 门禁含全部测试目标；每个"等价/优先/覆盖/审计/等式"类断言配**负控**；至少一条门禁用**真实 capture**（≥2 万事件、多 producer、非约定命名）；产品路径禁 harness 钩子（钩子只能是标注的加速器）。
- 证据目录、progress JSON、交接文档回填照旧；每轮阶段性成果必须 commit，不推送远端。

## 7. 外部依赖协议：frx 源码移交

1. **移交清单（执行层在 E0 产出、我确认）**：按清单 §2 逐项列出"需要哪些 frx 文件/模块"，标注 A/B/C/D 组归属与许可头现状。
2. **许可程序**：逐文件保留 MPL-2.0 头与来源路径，登记进 `docs/frx-migration-provenance.md`（文件 → 来源 commit/路径 → 许可 → 本地改动摘要）。不改标 MIT。
3. **状态判定（E0 结束前）**：`transferred` / `partial` / `not-transferred` 三态写进 progress JSON，并据此确定 E5 是执行还是记债。
4. **未到位时的降级**：frx 轨五项 + A 组两项（`jsvmp_split_dispatcher`/`jsvmp_disassemble`）保持 unavailable-with-reason；M3 以缩减范围达成，缺口在矩阵与登记册里如实记录。**禁止**用自研弱替冒充迁移（P5 outcome 事件、P6 M5 静默缺席是同类教训）。

## 8. 完成定义

路线图 §1 M3 行全部 + 清单 §2/C、§2/D 的冻结范围逐项能力矩阵（自动生成）与实测一致 + Broker 不可绕过为**结构性**且有负控 + host-exec 策略白名单默认拒绝实测 + 完整 env 管理器（M3 边界内）双环境并行实测 + 重连设计文档 + `resolveOrphan` 两路径门禁 + 全部既有门禁不回退（"不得削弱断言清单"逐条核对）+ `accepted-m3` 由架构师标记。
