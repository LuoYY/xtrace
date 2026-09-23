# XTrace × Firefox-Reverse：Chromium 迁移增强方案设计草稿

- 版本：v0.8（P4 已通过终审并冻结；P5 交接文档已出；本轮为状态收口，设计内容不变，记录见第 16 节）
- 日期：2026-09-19
- 状态：设计草稿；区分已验证事实、已选定设计和仍需实现验收的项目。
- 依据：两项目报告、已返回的子 agent 研究结论、固定版本源码核对与本地验证实验。
- 当前范围：v0.2 的临时索引、物化副本和原版 d8 验证已完成；现已将四补丁应用到固定源码，继续完整 Chromium 构建和本地浏览器集成。不启动新的子 agent，不升级基线，不实现新迁移架构。

## 1. 目标与结论

以 XTrace 的补丁版 Chromium 为内核、采集与离线分析底座，迁入 Firefox-Reverse 中可复用的 Agent、工具编排、会话及工作区能力；对 Gecko/SpiderMonkey 特有的宿主和引擎接入重新设计，而不是机械移植。

建议采用“增强 Chromium + 独立 Node Agent Host + 既有 Electron 工作台”的首阶段组合。MV3 sidePanel 作为后续入口，通过 Host 接入同一套控制和授权能力，不在第一阶段同时重建浏览器内 UI。

首个完整闭环应为：

> 创建隔离实验环境 → 开始有范围的采集 → 执行本地测试页面 → 确认停止与数据完整性 → 生成证据索引 → Agent 基于证据分析 → 在工作台展示可追溯结果。

优先级不是立即迁移全部 66 个工具，而是先建立可验证的采集语义、受控运行状态和可信输出。

### 1.1 范围

| 纳入首阶段 | 后续阶段 | 不作首版承诺 |
| --- | --- | --- |
| 固定版本基线、可复现补丁应用 | Sparkplug 字节码观测 | 全 JIT 层逐指令追踪 |
| 单次受控 capture 的控制与可靠关闭 | 更多 WebIDL 接口、异步关联 | 所有 Web API 与所有属性访问全覆盖 |
| Ignition 执行前事件与选定 WebIDL 入口 | MV3 sidePanel、多平台 | 全量无损高频采集、零开销 |
| Electron、Node Host、首批只读分析工具 | 其余工具分批迁移 | 通用自动还原任意 VMP 算法 |
| 日志、脚本资产、分析结论的证据链 | 编译器层语义增强 | 默认兼容任意 Chromium 版本 |
| 最小隔离实验环境（独立 profile、专用实例生命周期与端口管理） | 完整环境管理器；指纹伪装层 | 对未授权第三方目标站的使用 |

所有测试以本地、自有或明确授权的页面和样本为对象。增强能力不以关闭 renderer 沙箱、向公网暴露调试端口或默认执行外部脚本为前提。

两个原属 Firefox-Reverse 主能力的取舍在此显式登记（v0.4 补充，此前版本未提，属无声的范围缺口）：

- **指纹伪装层（FrxFingerprintConfig 对应物）显式暂缓至 P7。** 首期只记录指纹面 API 的读取（现有 `fingerprint` 类别），不修改任何返回值。理由：首期目标是可验证的采集语义与控制面；指纹覆盖层按迁移分析报告的三档策略落地（UA/UA-CH/时区/locale/屏幕走 CDP override 与启动开关，零补丁；hardwareConcurrency/WebGL 任意串/canvas/audio 噪声需 Blink patch，可参考 Brave farbling），是独立工程，与采集契约无依赖。环境管理的接口设计须为其预留挂载点（每环境一份指纹 JSON）。
- **环境管理首期只交付最小集。** 首个闭环的“创建隔离实验环境”由 P6 的最小 env 能力承担：隔离 profile、专用实例启动/停止、实例所有权与端口管理。Firefox-Reverse `EnvironmentBackend` 的端口扫描、真实 bind 探测、进程状态机与 macOS `exec -a` 伪装逻辑届时平移；完整版（含指纹挂载、暖 profile 复用策略）随 P7 一并落地。

## 2. 依据、基线与验证状态

### 2.1 输入材料

- XTrace 报告：`../XTRACE-REPORT.md`。
- Firefox-Reverse 迁移分析：`/Users/luoyy/work/github/GitHub/firefox-reverse/docs/chromium-migration-analysis.md`。
- 关联融合设计：`/Users/luoyy/work/github/GitHub/firefox-reverse/docs/xtrace-merge-design.md`。
- XTrace 当前四个补丁、构建脚本、launcher、GUI 和分析脚本。
- 本地固定版本 Chromium/Blink/V8 源码。

报告描述的是设计意图或某次验证结果；当它与当前补丁、源码冲突时，以固定版本源码和可复现测试为准。

### 2.2 固定版本

| 项目 | 基线 |
| --- | --- |
| 首阶段平台 | macOS / arm64 |
| Chromium 版本 | `151.0.7917.0` |
| Chromium SHA | `73088b4e50b1dc69eaa0bdb14a8e4592813174fd` |
| V8 SHA | `af6aa2ec5047676cfb3150b46449faac7578be7e` |
| V8 配对依据 | 上述 Chromium 提交中的 `DEPS` |
| Chromium 目录 | `chromium/src` |
| V8 目录 | `chromium/src/v8`，独立 Git 工作树 |
| 工具目录 | `depot_tools` |

应用补丁前再次核对了两棵源码树的 HEAD、Chromium 版本文件与干净工作树；版本一致。当前 HEAD 未改变，工作树已应用四补丁。后续不同时引入 Chromium 升级、架构迁移和采集协议重构三个变量。

### 2.3 已做与未做

| 检查 | 状态与解释 |
| --- | --- |
| 固定 Chromium 下载、按 DEPS 同步 V8 及依赖 | 已完成 |
| 构建准备与 GN | d8 与完整 Chromium 构建图均已生成；已补齐 Dawn/GPU/Skia 元数据、固定 Rollup 原生库及官方 Metal Toolchain |
| d8 编译与运行 | 编译成功（3443/3443 步）；10 组字节码/语义样本、4 组 tier/baseline 检查和上游 ignition/tracing.js 通过，详见第 9.6 节 |
| 补丁实际应用 | v0.2 在临时索引验证；v0.3 已在固定 Chromium/V8 工作树顺序应用 |
| 四补丁按依赖顺序应用 | 全部通过，无 3-way 回退；不等于 C++ 编译通过 |
| 主项目 Python 测试 | 物化副本及已应用补丁的实际工作树中均为 338 项通过，无 skip |
| launcher / GUI 逻辑测试 | 本轮再次分别 28 / 211 项通过；不代表浏览器行为验收 |
| schema v2 golden fixture 校验 | v0.2 通过 |
| Blink 上游 Python 单测 | 隔离 Python 3.11.16 中 57 项全部通过；Python 3.13.11 中有 6 项因已删除的 unittest 别名失败，未修改测试 |
| 完整 patched Chromium 构建及浏览器集成 | **已完成并通过 R3 核验冻结（2026-09-19）**：`chrome` 目标 50640/50640 构建成功（增量退出码 0 存档）；12 组集成矩阵 12/12 通过；launcher 端到端补验通过；首轮发现的 V05 缺口已修复闭环。证据与基线数据见[实施交接文档](chromium-patched-build-implementation.md)，审查记录见 [P1 架构 review](chromium-p1-architecture-review.md) |

后续补丁依赖顺序为 `0001 → 0003 → 0004 → 0002`，见 `scripts/apply_patches.sh:85–93`。将依赖补丁一次性对原始树执行检查，不等于逐层应用验证。

### 2.4 研究结论的来源

| 研究范围 | 已返回结论的主要用途 |
| --- | --- |
| Firefox 迁移资产 | 区分纯 JS、特权宿主、工具声明与真实能力 |
| XTrace 采集保障 | 校正写入、关闭、schema、provenance 和分析能力边界 |
| 迁移依赖与验证设计 | 阶段依赖、最小 PoC 和验收路径 |
| Blink 生成器 | callback 分类、析构顺序、Fast API 与缓存路径 |
| Chromium 控制面 | CDP pipe、browser target、Renderer/Worker 配置及生命周期 |
| V8 插桩 | 对应辅助任务未产出研究结果；本稿采用主代理直接核实的源码证据，不归为该 agent 的成果 |

下文“源码确认”表示静态事实；“测试确认”只对执行过的样本与配置成立；“选定设计”表示新实现必须满足的要求，不等于已有能力；“仍待验收”只用于尚未实施或缺少运行证据的项目。

### 2.5 本轮已经收敛的结论

| 编号 | 确定结论 | 验证方式与边界 |
| --- | --- | --- |
| V01 | 四补丁能按 `0001 → 0003 → 0004 → 0002` 干净叠加 | 独立 `GIT_INDEX_FILE` 从两树 HEAD 开始逐层 `apply --cached --check` 和 `apply --cached`；未使用 3-way 回退 |
| V02 | 当前补丁与仓库测试的静态契约一致 | 物化 95 个 Chromium、126 个 V8 补丁文件，补入未修改的 document.idl；主套件 338 项通过，无 skip |
| V03 | launcher、GUI 逻辑和 v2 fixture 基线通过 | 28 项、211 项及 golden validator 通过；不是新 UI 或真实浏览器验收 |
| V04 | 本机可生成该版本的 d8 构建图 | 使用已有 GN/Clang/Ninja，生成 LASTCHANGE 后 GN 成功；无需修改上游源码或运行全部 hooks |
| V05 | 仅传 `--xtrace-causality=sync` 的配置转发缺口——**已修复并验证** | 原缺口：`chrome_content_browser_client.cc` 的 renderer 复制列表不含此开关。2026-09-19 集成矩阵 `causality-switch-only` 首轮失败（v1 记录混入）确证；补丁 0001 加入该开关后干净索引复验、增量重建、单案例与 12 组全量复测通过，launcher 链路 renderer 进程实测携带该开关 |
| V06 | 当前 `capture_assets=summary` 不排除完整源码 | 物化 `xtrace_logger.cc:318–375` 在 full 条件外向 manifest/event 附加 source；现有测试还断言此内容，迁移时需同步改变实现与契约 |
| V07 | 当前链路没有热更新与可靠 stop 协议 | `GetCachedConfig` 是静态缓存；mojom 只有 Log/LogBatch/LogAsset，无响应、水位或 generation；不是仅补一个 CDP 命令就能完成 |
| V08 | 普通 MV3 扩展不能直接作为受信 browser 控制入口 | `debugger_api.cc:247,746,825` 限制信任资格；browser target 在 AttachSession 拒绝不受信客户端 |
| V09 | Worker 广播数量不是应用 ACK | `worker_thread_registry.cc:90–96` 返回映射大小且不检查各 PostTask 的返回值 |
| V10 | WebIDL 首批接口与语义可以确定 | URL、Body、Element、Performance 和 NADCAttributeTest IDL 已核实；Element.scroll 是 Promise 返回的重载 |
| V11 | 上游 tracing 的关闭不等于无 runtime 开销 | handler 编译进 tracing 调用，runtime 再检查 flag；正式 observer 需要前置 gate，不能将上游 trace-off 当成无插桩性能基线 |
| V12 | Sparkplug trace 调用是否存在取决于编译时配置 | `baseline-compiler.cc:633–657` 在生成代码时判断 flag；旧机器码不会因之后开关变化自动补入调用 |
| V13 | 固定源码的 d8 上游 tracing 可以实际构建并运行 | 3443 步构建成功，产物约 80 MiB；10 组样本通过，关闭/开启输出一致，目标 offset/opcode 与同进程反汇编对照 |
| V14 | `max_opt=0` 是可被显式参数覆盖的默认层限制 | 2000 次调用后，默认保持 Ignition；附加 `--sparkplug --always-sparkplug` 后实际进入 baseline，帧内状态与 active-tier intrinsic 一致 |
| V15 | baseline tracing 在本版本确实可用 | `--max-opt=1` 配合 `%CompileBaseline` 和 `--trace-baseline-exec` 产生 `B->`，关闭/开启结果均为 514；不代表热更新已经可用 |
| V16 | Blink 生成器单测可在兼容的隔离 Python 中完整运行 | Python 3.11.16 下 57/57 通过；Python 3.13 下的 6 项旧 unittest 别名错误已定位，不是新插桩缺陷 |

V05–V07 最初在 v0.2 补丁物化副本中核实；当前固定 Chromium 工作树已应用相同补丁。旧验证材料见第 15 节，完整构建与执行层接管状态见[实施交接文档](chromium-patched-build-implementation.md)。

## 3. 必须保留的事实边界

1. **现有 XTrace V8 hooks 不是完整 Ignition 字节码流。** 当前主要覆盖部分 builtin、runtime、位运算和 ARM64 调用入口。
2. **schema v2 不是全局因果图。** 它提供 renderer 线程内同步 script evaluate 的因果身份，不自动连接 Promise、timer、microtask、IPC 或跨进程父链，见 `docs/trace-schema-v2.md:3–26`。
3. **`global_seq` 不是发生时间或因果顺序。** 当前写入路径共享 sequenced runner，但存在多个 receiver 实例和文件句柄；已有 `global_seq` 还可能被保留，不能视为统一重编号的全局时钟。
4. **当前停止不等于完整排空。** `SKIP_ON_SHUTDOWN`、独立日志通道和 launcher 的 terminate/kill，均不能证明日志全部落盘。
5. **builtin hook 不具备天然 JIT 免疫。** 优化器可降低、替换或消除原调用；公共调用路径也不一定保留原始 API 身份。
6. **现有分析包含启发式。** 按位置聚合、按值近邻匹配的 provenance、循环形状与候选变换匹配，不等于精确 def-use 或保护壳真实虚拟指令。
7. **有工具声明不等于已实现能力。** `_need` 筛选不是权限系统；能 import 的模块也不等于持久化和宿主行为正常。
8. **环境准备与技术障碍分开。** 固定源码已下载；后续重点是实际构建与行为验证，而不是继续将缺源码作为方案阻碍。

## 4. 总体架构与组件职责

```text
Electron 工作台（首期）             MV3 sidePanel（后续）
            \                         /
                 Node Agent Host
          Agent core / 会话 / 工具适配器
               统一授权 Broker
                  |          \
          CDP pipe 控制       工作区、分析进程、证据索引
                  |
          增强 Chromium browser 进程
       XTrace CDP 域 / CaptureCoordinator
       target 身份映射 / writer / artifact registry
                  |
           Renderer 配置与控制
                  |
       Blink / V8 / Worker producers
                  |
        独立、有界批量的日志 Mojo 通道
                  |
            browser writer → 本地采集产物
```

`CaptureCoordinator`、writer、artifact registry 是拟议职责名称，不表示源码中已经存在对应类。

### 4.1 职责分界

- **Chromium browser**：权威 capture 状态、producer 登记、身份核验、写入和完整性结算；renderer 不直接指定任意文件写入路径。
- **Blink/V8**：在正确线程和生命周期内产生结构化事件；不负责 Agent、模型调用、用户授权或跨进程合并。
- **Node Host**：浏览器启动管理、CDP pipe、能力协商、工具执行、授权和工作区管理。
- **分析层**：解析 trace、建立索引、生成候选与验证结果；始终保留原始证据位置和结论等级。
- **UI**：展示状态、审批、证据和分析结果；不另建一条可绕过 Broker 的执行路径。

### 4.2 关键设计选择

| 选择 | 原因 | 代价 |
| --- | --- | --- |
| 以 XTrace 仓库为主线 | 复用补丁、采集格式和现有分析链 | 需持续维护 Chromium/V8 双树补丁 |
| 独立 Node Host | 隔离 Gecko 特权依赖，统一执行策略 | 增加进程生命周期和 IPC 管理 |
| 首期复用 Electron | 尽快打通真实闭环 | MV3 体验后置 |
| browser-only XTrace CDP 域 | 控制、身份和写入在可信进程汇合 | 普通扩展不能假设直接访问 |
| 先 Ignition、后 Sparkplug/优化层 | 控制覆盖语义与验证复杂度 | 精细观测模式有执行层限制 |
| 首期单 browser 实例同一时刻一个 capture | 避免多采集争用 producer 与输出 | 并行实验通过不同实例和 profile 实现 |

## 5. Firefox-Reverse 迁移分层

| 资产 | 策略 | 首期验收重点 |
| --- | --- | --- |
| Agent loop、消息组织、工具 schema | 复用纯逻辑，抽离 Firefox 全局对象与模块导入 | 在 Node 中完成一次可取消的工具调用循环 |
| AgentSession、会话记录 | 保留语义，重做宿主存储与恢复边界 | 区分完成、取消、中断；不把内存 Map 当崩溃恢复 |
| ConfigStore、ConversationStore | 实现明确的文件/数据库适配器 | 重启后可恢复；禁止静默退回内存后宣称已持久化 |
| LedgerBackend | 保留 SQLite 和 workspace 隔离 | 事务、路径归属、退出恢复 |
| Tools 中 66 个声明 | 制作逐项能力清单，分批迁移 | 对每项标记完整、部分、不可用及原因 |
| WorkspaceBackend、Node/Python 执行 | 重写宿主与授权入口 | 路径、符号链接、超时、输出上限和子进程生命周期 |
| 浏览器调试、DOM、网络工具 | 采用 CDP / XTrace adapters | 声明字段与后端实际采集一致 |
| WebApiTraceCore | 重写为 Blink 生成器与运行时支持 | 不假设 setter、constructor、Promise 完成已覆盖 |
| JsvmpTraceCore | 重写为 V8 observer 与消费端协议 | 分清 script ID、字节码 offset 和 VMP 的 VPC |
| 环境管理 | 首期最小集映射到独立 profile、启动参数、存储和显式 CDP 能力；完整环境管理器随 P7（§1.1） | 不承诺 Chromium 无法提供的 Gecko 行为 |
| 指纹配置层 | 显式暂缓至 P7（§1.1）；首期保留现有 fingerprint 采集类别，只记录不改值 | 三档策略按迁移分析报告 §7 执行：CDP override 与启动开关优先，Blink patch 只补剩余字段 |

工具迁移建议分组：

- **A：证据只读**——trace 查询、脚本资产读取、索引检索、报告查看。
- **B：实验控制**——启动环境、打开本地测试页面、开始/停止采集、查询状态。
- **C：页面调试**——DOM、网络、调试器、截图等，逐项声明作用范围和副作用。
- **D：宿主执行**——文件写入、Node/Python、依赖安装等，最后接入，执行前经过统一策略。

66 项工具的逐项能力清单是 P6 的**前置交付物**，不是 P6 中的活动：它只依赖阅读 Firefox-Reverse 源码，不依赖任何浏览器产物，可在 P1 期间并行完成（交接文档 E7）。每项标注完整/部分/不可用及原因，并给出目标分组（A–D）；P6 启动时按清单冻结首批 A 组工具范围，不在验收时临时议定。

Firefox-Reverse 文件需逐项核对许可证和来源。不得因为 XTrace 根目录为 MIT，就将迁入的 MPL-2.0 文件或 Chromium/Blink/V8 修改统一改标为 MIT。

## 6. 采集协议、身份与证据模型

### 6.1 版本策略

本版选定新增事件契约使用 schema v3；现有 v1/v2 保持原含义并通过独立导入适配读取。该决定是新实现的协议要求，不表示当前 producer 已输出 v3。

新 producer、writer、validator 和分析器一同升级；单个 capture 不混写多个 schema 版本。manifest 声明 schema、producer 能力及缺口，不在核心写入链加入隐式兼容行为。

### 6.2 拟议身份字段

| 字段 | 语义 |
| --- | --- |
| `capture_id` | browser 为一次采集分配，不复用旧 v2 `session_id` 的含义 |
| `producer_id` | capture 内登记的事件生产者 |
| `process_epoch` | 进程实例身份，避免 PID 重用 |
| `producer_seq` | producer 本地递增的逻辑事件序号，用于检测缺口 |
| `writer_seq` | writer 接受事件的合并顺序，不表示因果顺序 |
| `config_generation` | 事件生成时实际生效的配置代数 |
| `target_id` / frame / document / worker 身份 | 分层关联，允许未解析，不用 URL 代替身份 |
| `isolate_id` / context / world 身份 | 带生命周期的局部身份，不使用裸指针作持久 ID |
| `activation_id` | 有观测依据时的动态激活身份；不得凭相邻事件补造 |
| `script_id` / `bytecode_version` / `bytecode_offset` | 映射到相应脚本资产及字节码元数据 |

一条事件的唯一定位采用 `capture_id + producer_id + producer_seq`。序号、generation 和累计计数在内部/Mojo 中使用 uint64，在 NDJSON/CDP 中使用十进制字符串，避免 Node/浏览器 JavaScript 的 Number 精度丢失；字典压缩不作为首版前置。

browser 绑定日志 receiver 时登记进程归属，核验 renderer 上报的更细粒度身份。process 级 receiver 只能直接认证进程，不自动证明 frame/document 归属。

### 6.3 时间与因果

- 单调时钟和墙上时钟分别编码，写明单位、epoch 和进程/时钟基准。
- 不混用 `Time::ToInternalValue()` 的 Windows epoch 与 Unix epoch；不按同名字段盲目排序。
- 首期保留已经成立的同步父链；异步边必须有明确调度/执行关联 token 才能建立。
- 调用、请求、脚本激活等不同类型的关系分别标记，不将“相关”统一写成“父子”。
- 缺少映射时写 unknown/unresolved，并保留原始 ID，禁止按 URL 或时间邻近伪造确定关联。

### 6.4 值与资产

- 每次 capture 有 manifest，记录版本、构建参数、执行模式、过滤范围、产物、计数和终态。
- 源码、长字符串、二进制内容采用有界资产记录；事件引用资产 ID、长度、截断状态和摘要。
- 原始长度与保存长度区分；缺失、截断、不可序列化不能用同一空字符串表示。
- 捕获值不得主动执行 getter、Proxy trap 或用户自定义 `toString`；异步缓冲不保存裸 V8 堆指针。
- `summary` 模式的测试必须证明没有意外嵌入完整 source，不能只检查配置名称。
- 网络正文默认不纳入首期基线；启用时要求明确能力、限额和敏感字段处理。

### 6.5 分析结果等级

每项分析结论附证据引用、适用输入和失败/缺失条件，并区分：

- **observed**：日志直接观测的事实。
- **derived**：可按明示规则从证据重算的结果。
- **hypothesis**：位置聚合、数值匹配、循环形状等产生的候选解释。
- **validated**：候选在指定输入集合上通过验证，不自动推广到未知输入。
- **unresolved**：证据不足或候选冲突。

现有 oracle 中 `derived`、`observed_output`、`unresolved` 的含义应显式映射，不因 UI 展示需要改成确定的“已还原算法”。

### 6.6 既有缺陷清单的收口

`docs/runtime-trace-plan.md` 与 `docs/trace-log-improvements.md`（2026-07）列出的已知缺陷不得随 producer 移植原样进入 v3。逐条处置如下；P2 验收逐项核对，v3 validator 必须断言字段被实际填充而不仅是存在：

| 旧缺陷（出处） | v3 处置 |
| --- | --- |
| `result`/`error` 恒为 null（trace-log-improvements §1.1） | 值与错误进入 §6.4 的有界值/资产契约；producer 移植时接线，不接线的字段删除，不留恒空字段 |
| `seq` 每进程重复、非文件级单调（§1.2） | §6.2 以 `producer_seq` + `writer_seq` 替代；不再有裸 `seq` |
| truncation 双形态并存（§1.3） | 单一截断形态：资产引用 + 原始长度/保存长度/摘要（§6.4） |
| `frame_url`/`origin` 恒空（§2.1） | §6.2 分层身份字段；缺失写 unresolved，不留空字符串占位 |
| 脱敏边界文档与实现矛盾（§3.1） | 默认本地全保真 + 显式外发脱敏策略（§11.2）；文档与实现必须一致 |
| `LogBatch` 已实现但无调用点，逐事件 IPC（§4.1） | §7.1 的有界批量是唯一上报路径 |
| upload body/header 限额从不生效（§4.2） | §6.4 限额与截断状态；P2 验收包含限额触发用例 |
| validator 只查字段存在（§5.1） | v3 validator 增加按事件类型断言已填充的契约测试 |
| summary 模式仍附完整 source（本稿 V06） | 迁移时同步修改实现与契约；测试证明 summary 不嵌入完整源码（§6.4） |
| browser-network 私有计数器与逐事件 `AppendToFile`（`chrome_content_browser_client.cc:6043,6634`） | 并入 §7.1 单一 writer 与计数守恒；producer 完整清单见 §7.1 |

## 7. 写入、背压与停止协议

这是结构化高频采集的前置工程，不应等字节码事件接入后再补。

### 7.1 writer 与 producer

- 每个 capture 由单一逻辑 writer 负责序号、manifest 和产物终态；可以产生多个资产文件，但不由多个 receiver 独立决定关闭。
- 每个 producer 在所属线程维护有界缓冲，通过自己的日志通道批量上报。
- 队列满时采取已声明的降采样、丢弃或结束采集策略；不无限扩容，也不在 V8 热路径阻塞等待磁盘。
- 过滤掉的事件与因资源不足丢弃的事件分开统计。
- 选中过滤条件的事件先分配逻辑序号；溢出导致的缺口以累计计数和区间摘要记录，不能悄悄重排成连续序号。
- crash 可能丢失最后一段尚未上报的事件和计数；不能将未知损失伪装成零。

首期须登记的 producer 清单（缺一不得结算 complete）：

- renderer 内 XTraceLogger 各线程实例（含 dedicated/shared/service worker 线程）；
- browser 进程网络插桩（`chrome_content_browser_client.cc` 的 URLLoaderThrottle 路径）——当前它使用私有计数器 `g_xtrace_browser_network_sequence` 并逐事件 `AppendToFile` 自行写文件，迁移时必须取消其私有写入路径、并入单一 writer，同时拆除该私有计数器；
- 资产通道与动态代码通道（作为所属 producer 计数的一部分，或单列 producer；二选一写入 manifest）；
- V8 事件经 event_logger 回调汇入 Blink，计入所属 renderer/Worker 线程 producer，不单列。

选定计数契约如下：producer 记录 `eligible/enqueued/dropped`，writer 记录 `accepted/written/failed`。正常收尾要求 `eligible = enqueued + dropped`、`enqueued = accepted`、`accepted = written + failed`；每个 producer 的终止 watermark 携带最终序号与计数。只有这些等式成立、所有 producer 已结算且 `dropped = failed = 0`，才可报告 complete；crash 等导致计数未知时报告 incomplete，不补成零。这是实现验收契约，不是现有 writer 的保证。若将来引入 1/k 采样，被采样排除的事件计入单列的 `sampled_out`，不混入 `dropped`，保证上述等式在采样模式下仍成立。

### 7.2 capture 状态机

```text
idle → starting → active → stopping → complete
                    |          ├── incomplete
                    |          └── failed
                    └───────────── failed
```

配置 generation 更新是 `active` 内部过程，不等于重启 capture。每个终态包含原因、最后确认的 producer 集合和数据计数。

- `complete`：已登记 producer 全部有可核对的结束信息，写入与关闭成功，指定范围内无已知丢失或未知缺口。
- `incomplete`：仍有可用产物，但发生丢弃、producer 失联、停止超时或其他覆盖缺口。
- `failed`：无法建立或完成有效采集产物；可保留诊断和已写入片段，不冒充成功。

`complete` 只对声明的采集模式和过滤范围成立，不意味着浏览器全部活动被观测。正常关闭但存在 `dropped > 0` 仍归为 `incomplete`；`starting` 阶段也可以失败，失败原因必须可查询。

### 7.3 正常停止流程

1. browser 将 capture 转为 `stopping`，冻结成员策略，不再接受无归属的新 producer；并发注册请求得到明确的加入或拒绝结果。
2. 下发停止请求，producer 在所属线程停止接纳新事件，提交剩余批次。
3. 每个 producer 在**原日志通道**提交结束 watermark，携带最终序号、计数和 generation。
4. writer 按该通道顺序消费批次及 watermark，核对所有已登记 producer 的终态。
5. 写完事件与资产，记录写入失败，完成 manifest 和文件关闭。
6. 通过状态查询或完成事件返回最终结果；Host 此后才退出浏览器或读取完成产物。

控制通道收到 ACK，不能证明另一条 thread-local 日志通道已经排空。`Worker` 广播任务的投递数量也不能作为确认数量。

首版选定保证为写入操作和文件关闭完成，并以最终 manifest 表示正常结算；不承诺断电安全。`fsync`、目录持久化与断电恢复不纳入 complete 的首版含义；如将来增加，必须作为单独能力及故障注入验收项。

### 7.4 异常路径

- producer 崩溃或断连：记录最后已确认序号，标记未知尾部，不补造结束事件。
- 停止超时：返回未确认 producer 清单和 incomplete 产物；超时本身不自动授权杀进程。
- browser 崩溃：Host 将未完成 capture 标记为中断；恢复时对已有片段做校验，不能生成虚假的正常终态。
- profile 关闭、Worker 销毁、导航、BFCache、Host 断开分别处理；BFCache 进入不等于 context 销毁。
- 优先通过显式 stop 完成关闭；browser termination 通知只作最后兜底。

## 8. 控制面：CDP、Renderer 与 Worker

### 8.1 browser-only XTrace 域

固定源码中 browser target 已支持受信任客户端、browser-only session 和 IO handler，见 `chromium/src/content/browser/devtools/browser_devtools_agent_host.cc:226–245`。

建议首期域接口如下，名称和参数均为草案，不是当前可调用 API：

| 接口 | 拟议语义 |
| --- | --- |
| `XTrace.getCapabilities` | 返回 schema、模式、可观测路径、限制、动态/启动时配置项 |
| `XTrace.startCapture` | 校验范围与模式，返回 capture ID、generation 和启动状态 |
| `XTrace.updateCapture` | 更新动态过滤/预算，返回新 generation 及应用进度 |
| `XTrace.getCaptureStatus` | 查询 producer、配置收敛、计数、丢失和终态 |
| `XTrace.stopCapture` | 发起幂等停止，返回 stopping 或已有终态，不提前承诺 complete |

可配套状态变化与配置应用事件。IO stream handle 在产物可读取时返回，读取复用 `IO.read/close`；首期不将高频事件逐条广播为 CDP 通知。

协议接入涉及公共 PDL、协议生成、handler 和 browser target 注册，不是只新增一个 C++ handler。实际构建入口是 `content/browser/devtools/BUILD.gn`，不是不存在的 `content/browser/devtools/protocol/BUILD.gn`。

### 8.2 Host 通信与权限

- 首期由 Node 启动专用实验 Chromium，通过 `--remote-debugging-pipe` 通信。
- pipe 使用 FD 3/4；默认 NUL 分隔协议消息，CBOR 是另一种模式；Host 明确选择并测试 framing、断连和请求取消。
- 不继承现有注入路径中的宽泛 `--remote-allow-origins=*` 设置，不默认开放 HTTP 调试端口。
- 自定义域只接受受信任会话；UI 的访问权不自动等于任意 browser 控制权。
- `chrome.debugger` 的 method 是字符串，不代表普通扩展可以访问受信 browser target。后续 sidePanel 通过 Host 代理。
- Native Messaging 只是桥接机制，不保证 Host 永久常驻；重连、实例所有权和 capture 状态恢复必须单独设计。

### 8.3 配置传播

建议复用现有 Renderer 控制接口：初始化携带快照，运行期增加 generation 更新；日志仍经独立 XTraceHost 通道。

- renderer 启动：首次脚本执行前具备已确定的初始配置；需在新链路中实现，不视为现有代码保证。
- 已有 Worker：在所属线程应用新配置并逐一确认。
- 新 Worker：首次执行前读取最新 generation；不能只依赖向现有线程广播。
- Service Worker：覆盖其独立启动和生命周期路径。
- Worklet（AudioWorklet 等）首期不覆盖其配置传播与事件归属；指纹面部分读取可能发生在 worklet 线程内，能力表必须披露此缺口，不得在覆盖声明中默认包含。
- 更新时由 browser 串行分配 generation、快照当前参与集合；后来加入的 producer 继承最新版，退出者记录退出结果，不伪造 applied ACK。
- 更新进行中允许旧/新 generation 同时出现在日志中；状态接口报告尚未确认的 producer。进入 stopping 后拒绝 update，并按注册裁决确定最终需结算集合。
- 不跨线程共用普通 `mojo::Remote`、可变 logger、V8 对象或裸 GC 指针。

对“捕获首次脚本”有硬要求的场景，首期采用预先配置后启动的新实验环境。对已运行 target 附加采集，只能声明从确认生效时刻开始覆盖。

### 8.4 身份与网络映射

- browser 从 target、RenderProcessHost、frame、document 和 Worker 生命周期构建关联；`TargetInfo` 本身不提供 PID。
- frame 导航需要 document 身份，PID 或 frame ID 不能单独代表一次文档执行。
- 网络优先复用 `devtools_request_id`，同时保存底层请求 ID、来源及 redirect hop。
- ID 缺失时建立带来源的 crosswalk，允许 unresolved；禁止用 method + URL 哈希合并请求。
- 需要分别验证导航、普通 resource、Worker/SW、redirect，以及未启用 Network 域时的行为。

## 9. V8 增强设计

### 9.1 已核实的可复用能力

固定 V8 已有 `V8_TRACE_UNOPTIMIZED`、Ignition handler Entry、`InlineShortStar` 专门 Entry，以及 `Runtime_TraceUnoptimizedBytecodeEntry/Exit`。

关键位置：

- `chromium/src/v8/src/interpreter/interpreter-assembler.cc:52`：handler 构造中的 Entry。
- `chromium/src/v8/src/interpreter/interpreter-assembler.cc:1363–1374`：内联短 Star 及专门 Entry。
- `chromium/src/v8/src/interpreter/interpreter-assembler.cc:1600`：向 runtime 传递字节码数组、offset、accumulator。
- `chromium/src/v8/src/runtime/runtime-trace.cc:119,167`：上游 Entry/Exit 实现。
- `chromium/src/v8/src/flags/flag-definitions.h:962,1012`：`max_opt` 与 `jitless` 的不同语义。

这些设施比新增一个 Dispatch 单点 hook 更适合作为 PoC 起点，但上游打印输出不是正式协议，也不是完整调用/返回配对。

### 9.2 第一版事件语义

建议第一版结构化事件定义为：

> 某个已选中脚本激活，在指定执行层到达规范化后的某条 V8 字节码，尚未执行该指令。

必须处理以下边界：

- `Wide/ExtraWide` 的前缀、operand scale 和规范化 offset，避免一次逻辑指令被误计两次。
- `InlineShortStar`，不能因未进入独立 handler 而漏记。
- Return、Throw、ReThrow 和不正常返回路径；不把 Entry/Exit 名称直接解释为每个 opcode 的完整 before/after。
- 函数调用、递归、生成器与 async 的激活身份，不能用 C++ 栈深度替代完整 JS 语义。
- accumulator/寄存器输入可从现有设施验证获取；所有 opcode 执行后的值与精确 def-use 不属于第一版保证。
- V8 code cache：字节码可能经反序列化而非编译产生，元数据 hook 只挂编译路径会在 warm profile 下缺数据。P4 设计冻结时二选一：精细模式禁用/绕开 code cache 并披露行为差异，或在反序列化路径补元数据事件；验收必须覆盖 warm profile 场景。

字段需区分 `v8_bytecode` 与分析器推断的 `virtual_opcode/vpc`。后者是样本相关推断，不能把 V8 opcode 政名后冒充 VMP 指令。

### 9.3 从 PoC 到正式 observer

1. P0 先构建独立 d8 产物，使用上游 trace 验证覆盖、offset 和执行层，不改事件协议。
2. P4 再加入结构化 observer：编译期保留能力，运行期按 isolate/context/script 范围启停。
3. 关闭时在进入观察 runtime 前检查轻量 gate；不分配事件，但仍需测量分支等残余开销。
4. 字节码元数据按版本预解码并缓存，避免每事件从字节码起点扫描。
5. V8 runtime 调用遵循 bytecode offset、accumulator、寄存器保存与 GC 不变量。
6. 事件入有界缓冲，由 Blink/embedder 边界批量交给 browser；不在 V8 热路径拼 JSON 或做磁盘 IO。

V8 初始化后全局 flags 可冻结，因此运行期控制使用独立采集状态，不热改 `v8_flags`。Blink 可基于 `V8PerIsolateData::UserData` 管理自身状态，但 V8 不直接依赖 Blink；跨边界回调、状态句柄及销毁顺序在 P4 定义。

### 9.4 执行模式与覆盖声明

| 模式 | 目的 | 边界 |
| --- | --- | --- |
| 常规语义采集 | 保持通常的优化行为，采集已支持的 API/语义事件 | 优化器可能绕过 hooks，必须报告缺口 |
| Ignition 精细实验 | 为选定样本获得可验证字节码序列 | 约束 JS 执行层，性能和时序不同于常规运行 |
| Sparkplug 扩展 | 后续提供 baseline 对照 | 编译时是否生成 trace 调用影响动态启用能力 |
| jitless 实验 | 特定对照测试 | 改变更多可执行内存、Regexp/Wasm 等行为，不作为默认替代 |

`max_opt=0/1/2/3` 分别对应 Ignition/Sparkplug/Maglev/TurboFan 的最高 JS tier 意图。本轮已实测：`--max-opt=0` 默认保持 Ignition，但附加 `--sparkplug --always-sparkplug` 可以覆盖弱 implication 并实际进入 baseline。精细模式的校验分两层：Host 在启动前做静态参数检查，`XTrace.startCapture`（browser 侧）做权威拒绝并回报实际生效配置——绕过 Host 直接以 `--js-flags` 启动的路径也必须被拦住；不能只看 `max_opt` 字符串。Maglev/TurboFan 的观测覆盖尚未测试。

### 9.5 现有 hooks 的处理

先保留并验证现有 ARM64/Torque/CSA/runtime hooks，不把“退役汇编 hook”列为第一阶段阻塞项。`Function.apply`、`Reflect.apply` 等进入公共路径后可能失去原始 API 身份；即使改到公共 CSA，也不能避免编译器先行降低或内联。

跨 tier 覆盖应建立测试矩阵，对每个 API/路径明确 supported、partial 或 unavailable，再决定是否需要编译器层增强。

### 9.6 固定 d8 的运行验证结果

本轮成功构建未打 XTrace 补丁的固定 V8，以下结果验证上游设施的可用性，不验证尚未实现的结构化 observer。两组运行使用同一个插桩产物，分别关闭与开启打印；这不是“无插桩版本 vs 插桩版本”的性能对照。

10 组样本均满足：JS 结果与预期及 trace-off 一致；trace-off 无 Entry；trace-on 中目标函数的 offset/opcode 与同进程字节码反汇编匹配；`%ActiveTierIsIgnition` 为 true。合计匹配 2120 条目标函数 Entry。

| 样本 | 预期结果 | 匹配 Entry / 静态指令数 | 实测重点 |
| --- | --- | --- | --- |
| 短 Star | 10 | 5 / 5 | Star0 和 Return 都可见 |
| Wide 常量 | 256 | 2 / 2 | LdaSmi.Wide 仅一个逻辑 Entry |
| ExtraWide 常量 | 65536 | 2 / 2 | LdaSmi.ExtraWide 仅一个逻辑 Entry |
| 分支循环 | -2 | 81 / 25 | 循环和两条条件路径实际重复执行 |
| 递归调用 | 120 | 49 / 13 | 5 次 Return、4 次递归调用 |
| throw/catch | 8 | 13 / 13 | Throw 后 catch 路径与 Return |
| rethrow/finally | `[9,1]` | 19 / 19 | finally 副作用保持，ReThrow 可见 |
| generator | 两次 next 分别为 3/未完成、5/完成 | 24 / 30 | SuspendGenerator / ResumeGenerator |
| async/await | 6 | 31 / 38 | Promise 完成值和暂停/恢复指令 |
| 270 个局部变量 | 270 | 1894 / 1894 | 宽寄存器读写、数组写入、Return |

短 Star、Wide、ExtraWide、throw/catch、rethrow/finally、宽寄存器这 6 个样本额外逐 offset 校验一次覆盖，排除数量相同但发生遗漏/重复的情况。存在分支、循环或暂停的样本不要求“动态数量 = 静态数量”，更不能把未执行分支直接认定为漏采。

执行层另有 4 组检查：

| 配置 | 实测结果 |
| --- | --- |
| `--max-opt=0`，2000 次调用 | Ignition；帧内 `%GetOptimizationStatus` 为 33859，解释器位为真 |
| `--max-opt=1 --always-sparkplug` | baseline；帧内状态为 82947，baseline 位为真 |
| `--max-opt=0 --sparkplug --always-sparkplug` | 仍是 baseline；证明显式参数可以覆盖 max_opt 的弱 implication |
| `--max-opt=1` + `%CompileBaseline`，对照 baseline trace 开关 | 两次结果均为 514；开启有 `B->`，关闭无 `B->` |

`--print-flag-values` 的最终值与 active-tier intrinsic、帧内状态一起保存在日志中；不是仅通过打印启动参数判断 tier。上游 `test/mjsunit/ignition/tracing.js` 也以 `--max-opt=0 --trace-ignition` 成功运行，但它本身只检查不崩溃，不替代上述覆盖断言。

本轮没有证明任意程序的全指令覆盖、精确 def-use、跨异步激活父链、GC 压力下安全性或正式采集性能；这些仍归 P4 的实现验收。

## 10. Blink WebIDL 生成器增强

### 10.1 接入粒度

固定版本 `bind_gen` 是 Python 代码节点生成器，不是简单文本模板。入口至少区分 getter、setter、operation、constructor、overload dispatcher，以及不同签名的 accessor/interceptor。

主要位置均在 `chromium/src/third_party/blink/renderer/bindings/scripts/bind_gen/interface.py`：

| 位置 | 用途 |
| --- | --- |
| `:1879` | getter callback |
| `:2003` | setter callback |
| `:2159` | overload dispatcher function |
| `:2254` | constructor callback |
| `:2439` | Fast API / NoAllocDirectCall callback |
| `:2623` | operation callback |

建议普通 JS 入口创建 call token，内部实现补充选中的 overload/signature。不能在通用空 callback helper 中无差别加 scope，否则易重复计数或错用返回槽。

### 10.2 scope 和异常语义

- 观察 scope 初始只依赖稳定的 `info/isolate`，避免惰性代码节点提前触发 receiver 或参数转换。
- scope 覆盖 receiver 检查、参数转换、缓存早返回和 native 调用异常。
- Promise rejection 转换可能发生在作用域析构时；需要正确构造/析构顺序才能看到最终返回的 rejected Promise。
- 不保存已经析构的 `ExceptionState` 引用；也不能只依赖 `HadException()` 判断所有 V8 异常。
- CEReactions 析构可回调 JS；区分日志自身递归与真实页面重入，后者不得被 guard 一并吞掉。
- 返回 Promise 只代表同步返回一个 Promise，不代表 Promise 已完成；settlement 关联后置。

### 10.3 Fast API 与缓存

`NoAllocDirectCall` 的“NoAlloc”是历史名称，当前允许分配、异常和 JS 回调。`NewWithCFunctionOverloads` 和 `NewWithCache` 等路径说明普通 callback 不覆盖每次访问。

建议两种明确策略：

- **常规模式**：保留 Fast API 与缓存，能力表披露未覆盖路径，不宣称全量 Web API 审计。
- **精细实验模式**：对选定接口，在模板/快照建立前用统一 predicate 抑制快速定义与注册，必要时抑制缓存路径；需要新环境时显式重启，不假装可任意热切换。

不在首期全局禁用 Fast API，不用大面积改变浏览器行为来制造“覆盖完整”。

### 10.4 最小接口集合与测试

首批集合收敛为 URL constructor/href getter-setter/canParse、Element.scroll 两个 overload、Response.text（来自 Body mixin）、Performance.now，以及 NADCAttributeTest.float64Value setter。固定源码已确认：Element.scroll 在此版本返回 `Promise<ScrollResult>`，不能按旧版 void 方法设计验收；Performance.now 是真实 NoAllocDirectCall operation，NADCAttributeTest 是专用测试接口，不对普通网页承诺可见。

验收必须包含正常调用、错误 receiver、参数转换抛错、早返回、重载选择、Promise rejection 转换、CEReactions 重入、Worker context 销毁。运行 Python bindings 单测不等于生成的 C++ 已编译，也不等于浏览器行为通过；需真实生成、编译和页面测试。

## 11. Agent Host、UI 与授权

### 11.1 能力协商

Host 启动时结合 browser 的 `getCapabilities` 与自身 adapter 状态建立实际工具清单。每项能力声明输入/输出、目标范围、权限、副作用、完整性限制及当前可用原因。

原版 Chromium 可以运行明确的 CDP 能力子集，但不能静默把增强能力替换成较弱行为后返回成功。能力协商的输出是三态清单：**可用 / 降级且明示 / 不可用且拒绝**。首期选定：Host 不连接非增强浏览器——探测到无 XTrace 域的实例时，增强能力一律报告不可用并给出原因；CDP 通用子集（页面调试类工具）是否可用由逐项能力清单标注，不做任何隐式行为替代。后续若支持原版浏览器降级模式，降级项必须在工具结果与 UI 中显式标注。

### 11.2 统一 Broker

Agent 自动工具调用、UI 直接操作和 MCP 入口均进入同一个 Broker。迁移时修正原先直接 `callTool` 路径可能绕过确认的语义，不只在聊天界面增加一个确认按钮。

Broker 至少约束：

- browser instance、capture、target 与 workspace 归属。
- 文件读取/写入边界，含符号链接解析；不能只做字符串前缀检查。
- 页面执行和宿主进程执行的独立授权、超时、输出上限与取消语义。
- 依赖安装、外网访问和模型数据发送的显式策略。
- 秘钥与会话凭据不进入普通日志；原始 trace 不默认发送给模型。

Agent 首期以限额证据切片和本地索引为输入，结论可以回链到事件、脚本和候选验证结果，而不是将全部 trace 填入上下文。

证据索引的存储形态在 P6 启动前冻结，三项一并决策：索引 schema 与 capture manifest 的引用关系；是否复用 LedgerBackend 的 SQLite（同库或分库）；索引损坏或缺失滞后时的重建流程。冻结前 P6 首批工具只读原始产物与临时索引，不对外承诺持久查询接口。

### 11.3 UI 首期变化

复用现有 Electron 主进程/渲染进程隔离，补充 capture 状态、模式与覆盖范围、停止进度、丢弃/失败计数、证据跳转和授权记录。Node 权限不下放到渲染页面。

未来实施 UI 时必须启动应用，实际验证正常路径、停止超时、incomplete、取消与恢复场景，并检查 console/network；已有 GUI 逻辑测试不能替代交互验收。

## 12. 实施阶段与验收门槛

| 阶段 | 主要交付 | 验收门槛 | 依赖 |
| --- | --- | --- | --- |
| P0：上游 d8 追踪 PoC（最小验证已通过） | 独立产物、10 组覆盖样本、4 组 tier 检查；见第 9.6 节 | 固定版本下样本语义、ShortStar/Wide/分支/调用/返回/异常及真实 tier 已核验；不外推为任意程序保证 | 固定源码与构建环境 |
| P1：重现 XTrace 基线（**已完成，2026-09-19 经 R3 核验冻结**） | 四补丁实际应用及静态/分析测试通过；完整 `chrome` 构建成功；12 组矩阵 12/12；launcher 端到端通过；V05 修复闭环 | 干净基线可复现；实际调用的 API 有对应事件；v1/v2 validator 通过 | P0 结论作为输入 |
| P2：采集与写入基础（**已完成，2026-09-20 经 R2+R3 终审冻结**） | producer 登记（§7.1 全部写入源，browser-network 已并轨）、有界批量、manifest、终态和 watermark；§6.6 旧缺陷逐条收口 | 正常停止可核对；溢出/崩溃/磁盘错误不伪报 complete；限额与 summary 截断有触发用例；schema v3 落地、launcher 与 12 组矩阵 v3 通过 | P1 |
| P3：控制面（**已完成，2026-09-23 追记冻结**） | browser-only 域、pipe、配置 generation、身份映射 | renderer/worker 首次生效及更新可确认（B7 过滤快照经 F1 修复、契约五项复验）；断连/重连状态明确 | P2 |
| P4：结构化 Ignition（**已完成，2026-09-23 经终审冻结**） | observer、字节码元数据（code cache 禁用并披露）、执行层与值边界 | 与 P0 对照（逐事件 offset/opcode 深等 10/10）；无重复/漏记的已支持路径；三态性能（A/B 等价、C 观测开销）在 release 构建上可测 | P0、P2/P3 契约 |
| P5：Blink 选定接口 | 生成器修改、scope、模式和覆盖表 | 生成 C++ 编译；异常、重入、overload、Fast API/cache 分路径测试通过 | P2/P3 契约 |
| P6：Agent 闭环 | Node adapters、最小 env 能力、首批工具（A 组清单按 §5 前置冻结）、Electron 证据界面 | 一次真实 capture → stop → 分析 → UI 证据跳转；所有执行入口经过 Broker | P3，P4/P5 的最小能力 |
| P7：扩展 | Sparkplug、更多接口、其余工具、sidePanel、跨平台 | 每项有独立覆盖矩阵与回归，不能借首期结果宣称全覆盖 | P6 |

P4 与 P5 在公共协议和生命周期契约冻结后可并行；Agent 纯逻辑抽离及只读 adapter 可提前做，但不能越过尚未验证的采集契约完成端到端验收。本表是工作拆分，不是当前运行中的任务列表。

### 12.1 P0 最小测试矩阵

- 算术与寄存器读写、短 Star、Wide/ExtraWide。
- 循环、条件分支、正常调用、递归、Return。
- Throw/ReThrow、try/catch/finally。
- async/await、Promise、generator 的实际到达序列和限制。
- 分别对比关闭追踪、启用上游追踪、未来结构化 observer 的 JS 输出与异常语义。
- 不按整段 stdout 做脆弱的逐字符 golden；以小函数的字节码结构和事件语义核对，并披露工具自身噪声。

### 12.2 集成与性能矩阵

| 维度 | 必测项 |
| --- | --- |
| 生命周期 | 主 frame、子 frame、导航、reload、Worker/SW 创建与退出、BFCache、renderer crash |
| 配置 | 启动配置、运行期更新、更新中创建 Worker、停止中创建 producer |
| 输出 | 正常 stop、超时、队列满、磁盘写失败、Host 断开、browser 异常退出 |
| 覆盖 | 支持路径逐项有事件；不支持路径明示，不以修改预期掩盖错误 |
| 性能 | 关闭时开销、启用时事件速率、批大小、峰值 RSS、队列占用、丢弃率、停止耗时 |
| 安全边界 | 非受信控制拒绝、workspace 越界与符号链接、敏感字段、模型外发控制 |

性能目标值在 P0/P1 获得基线后确定。草稿不预设缺乏测量支持的“零开销”或固定吞吐承诺。P1 的 12 组集成矩阵同时承担基线采集：每组记录事件数、trace 字节数、墙钟时间与峰值 RSS，作为本节目标值的输入；不补采则 P2 定标无据。

进程内测试宿主分配：writer 与计数守恒 → `content_unittests`（或 browser 侧单测目标）；renderer/Worker 配置传播与生命周期 → `content_browsertests`；bind_gen scope → 现有 bindings Python 单测 + 生成代码编译 + `blink_web_tests` 页面级用例。注意 0001 的浏览器网络插桩位于 chrome/ 层，`content_shell` 覆盖不到，相关用例必须用完整 `chrome` 目标。上述测试目标均已在 XTraceIntegration 的 GN 图中存在，可直接构建。

### 12.3 补丁与回归管理

- 继续使用固定 Chromium/V8 双树，分别记录修改、补丁顺序与校验结果。
- 每阶段记录上游 SHA、GN 参数、补丁摘要和测试命令；新补丁必须可从干净基线复现。
- d8 PoC 与 Chromium 主构建使用独立产物目录，避免混用不同 instrumentation 的生成物。
- 轻量测试与需要 patched Chromium 的集成检查分开；缺少可选源码时明确 skip，集成任务中则应因缺前置失败。
- 升级 Chromium、移除现有汇编 hooks 和扩展架构单独排期，不混进首个闭环。
- P4/P5 的 C++ 迭代按“改补丁 → 增量编译 → 浏览器验收”的循环预算时间；d8 独立产物只覆盖 V8 语义验证，凡涉及 Blink/embedder 边界的改动必须走完整 `chrome` 目标。性能结论一律以 release 构建（`scripts/build_xtrace_release.sh`）为准。

## 13. 风险、待验证项与冻结点

| 风险或未知 | 应对与判定点 |
| --- | --- |
| 完整 Chromium 的构建成本仍未测量 | 已核对本机 64 GiB 内存、18 核、约 137 GiB 初始可用磁盘及可用工具链；d8 的结果不外推为全浏览器成本 |
| 插桩改变 GC、寄存器或异常语义 | V8 mjsunit/语义对照与 Blink 运行测试；正确性优先于事件数量 |
| JIT、Fast API、缓存绕过入口 | 模式与 capability 披露；精细模式的限制必须可验证 |
| 高频事件造成内存/IO 压力 | 有界缓冲与显式丢弃；先建 writer 再接高频 producer |
| 多通道关闭竞态 | 按原日志 pipe 的 watermark 结算；未确认尾部标 unknown |
| 首次执行早于配置到达 | 新实验环境先配置再执行；附加模式只承诺确认后的范围 |
| 网络 ID 或异步因果证据不足 | 保存原 ID、来源和 unresolved，不猜测关联 |
| 原迁移资产隐藏 Firefox 依赖 | adapter 契约测试，包括持久化、取消和重启 |
| 授权只存在于 UI | Broker 统一拦截 Agent/UI/MCP/直接工具调用 |
| 许可证混用 | 文件来源清单和逐文件许可核验 |

### 13.1 本版已收敛的设计决策

| 项目 | 选定结论 | 证据与约束 |
| --- | --- | --- |
| P0 构建 | Chromium 根构建图中的 `d8`，独立 `out/XTraceD8Verify`；同时编入 Ignition/baseline tracing | GN 已接受参数并生成 `V8_TRACE_UNOPTIMIZED`；不是另取一份 V8 最新源码 |
| P0 tier 确认 | 测试使用 `--max-opt=0`，通过 `%ActiveTierIsIgnition` 和实际 Entry 对照；baseline 另测 | `max_opt` 的弱 implication 不可当强制不可覆盖限制 |
| P2 协议 | v3、uint64 序号以 JSON 字符串传输、显式计数守恒 | 旧 v2 因果契约不变；新协议尚未实现 |
| P2 关闭 | 同日志通道 watermark；丢失或未知即 incomplete；不承诺断电持久化 | 当前 mojom 无停止响应，`SKIP_ON_SHUTDOWN` 不提供排空保证 |
| P3 控制 | browser-only XTrace 域，经专用实例的 CDP pipe；初始化快照加 generation 更新 | 普通扩展不具备 browser-target 信任资格；现有配置静态缓存无法热更新 |
| P4 第一版观测 | Ignition 执行前事件、规范化 bytecode offset、按版本元数据 | 不承诺 opcode 执行后值、全 JIT 或精确 VMP 指令 |
| P5 接口与模式 | 使用第 10.4 节已核对的接口；Fast API/cache 的模式在模板建立前确定 | 当前真实签名、Promise 转换和 NADC 语义已核实 |
| P6 首批工具 | 证据只读加受控 capture 生命周期；宿主任意执行后置 | 首先验证统一 Broker 与证据回链，不一次性迁完 66 项 |
| 指纹伪装层 | 显式暂缓至 P7；首期只记录不改值 | 独立工程，与采集契约无依赖；env 接口预留挂载点（§1.1） |
| 环境管理 | 首期最小集归 P6；完整环境管理器随 P7 | frx EnvironmentBackend 的端口/状态机/伪装逻辑届时平移 |
| 能力协商 | 三态清单；首期 Host 不连接非增强浏览器 | §11.1；禁止隐式降级 |
| 采样计数 | `sampled_out` 单列，不混入 `dropped` | 保证 §7.1 等式在采样模式下成立 |
| code cache | P4 冻结时二选一：禁用并披露，或补反序列化元数据事件 | 验收须覆盖 warm profile（§9.2） |
| 证据索引存储 | P6 启动前冻结（SQLite/文件、与 LedgerBackend 关系、重建流程） | 冻结前首批工具只读原始产物（§11.2） |

以上是本版选定的实现要求，不伪装成当前实现已具备的能力；只有实际实现后的验收才可证明遵守契约。

### 13.2 不能仅靠阅读源码消除的剩余项

1. 新 observer 的 GC/寄存器安全、无 getter/Proxy 副作用的值序列化、关闭开销与高频吞吐：需要 P4 实现及压力测试。
2. producer 注册、销毁、generation 更新和停止竞态：需要 P2/P3 的真实 IPC 测试及 crash/超时故障注入。
3. 新 Blink scope 的异常、Promise 和 CEReactions 行为：需要真实生成 C++、编译和页面测试；上游 Python 单测不证明新 scope 正确。
4. 网络 crosswalk、BFCache 和 Worker/SW 覆盖：需要浏览器集成样本，不以 URL 或邻近时间推测补齐；code cache warm 路径下的字节码元数据来源同样需浏览器集成验证。
5. Agent 持久化、取消、重连和 Broker 不可绕过：需要迁移 adapter 后的宿主/UI 测试。
6. 完整 patched Chromium 构建与浏览器 smoke：不能由补丁适用检查、文本断言或未打补丁的 d8 代替。

这些是明确的实施验收依赖，不再作为待选架构方向；本轮不把尚不存在的实现标为“验证通过”。

## 14. 主要源码定位索引

以下行号对应本稿固定源码或已检查的项目文件，用于实施前快速定位，不代表该处已经加入本设计代码。

| 范围 | 位置 |
| --- | --- |
| 固定版本 bootstrap | `scripts/bootstrap_chromium.sh:9` |
| 补丁应用顺序 | `scripts/apply_patches.sh:85–93` |
| schema v2 真实契约 | `docs/trace-schema-v2.md:3–26` |
| V8 GN tracing 配置 | `chromium/src/v8/BUILD.gn:194,694` |
| Ignition Entry / 内联 Star / runtime 参数 | `chromium/src/v8/src/interpreter/interpreter-assembler.cc:52,1363,1600` |
| 上游字节码 trace 与 offset 归一 | `chromium/src/v8/src/runtime/runtime-trace.cc:31,119,167` |
| Sparkplug trace 生成条件 | `chromium/src/v8/src/baseline/baseline-compiler.cc:633,645` |
| JS 最高 tier 与 jitless | `chromium/src/v8/src/flags/flag-definitions.h:962,1012` |
| 初始化冻结 flags | `chromium/src/v8/src/init/v8.cc:187` |
| apply/call 的优化器改写 | `chromium/src/v8/src/compiler/js-call-reducer.cc:3203,3466,3760,3782` |
| Blink callback 生成 | `chromium/src/third_party/blink/renderer/bindings/scripts/bind_gen/interface.py:1879,2003,2159,2254,2439,2623` |
| Promise rejection 转换 | `chromium/src/third_party/blink/renderer/bindings/core/v8/generated_code_helper.cc:104` |
| Fast API / cached accessor 安装 | `chromium/src/third_party/blink/renderer/platform/bindings/idl_member_installer.cc:148` |
| Blink per-isolate UserData | `chromium/src/third_party/blink/renderer/platform/bindings/v8_per_isolate_data.h:217` |
| CEReactions 重入 | `chromium/src/third_party/blink/renderer/core/html/custom/ce_reactions_scope.cc:23` |
| NoAllocDirectCall 当前语义 | `chromium/src/third_party/blink/renderer/bindings/IDLExtendedAttributes.md:1258` |
| browser target 注册 | `chromium/src/content/browser/devtools/browser_devtools_agent_host.cc:226` |
| browser-network 私有写入与计数器（P2 待并轨） | `chromium/src/chrome/browser/chrome_content_browser_client.cc:6043,6634` |
| CDP pipe 协议入口 | `chromium/src/content/browser/devtools/devtools_pipe_handler.cc:396` |
| DevTools 构建与协议生成 | `chromium/src/content/browser/devtools/BUILD.gn:55`、`chromium/src/content/browser/devtools/protocol_config.json:206` |
| Renderer 初始化契约 | `chromium/src/content/common/renderer.mojom:176` |
| browser 发送 / renderer 绑定 | `chromium/src/content/browser/renderer_host/render_process_host_impl.cc:2003`、`chromium/src/content/renderer/render_thread_impl.cc:1702` |
| Worker 更新 / 新线程启动 | `chromium/src/content/renderer/worker/worker_thread_registry.cc:90`、`chromium/src/third_party/blink/renderer/core/workers/worker_thread.cc:675` |
| IO stream 参考 | `chromium/src/content/browser/devtools/protocol/tracing_handler.cc:911` |
| shutdown 任务语义 | `chromium/src/base/task/task_traits.h:94` |
| 扩展 browser-target 信任限制 | `chromium/src/chrome/browser/extensions/api/debugger/debugger_api.cc:247,746,825` |
| URL 的 constructor/static/attribute | `chromium/src/third_party/blink/renderer/core/url/url.idl:34–49` |
| Element.scroll 的 Promise 重载 | `chromium/src/third_party/blink/renderer/core/dom/element.idl:156–157` |
| Body.text Promise | `chromium/src/third_party/blink/renderer/core/fetch/body.idl:16` |
| 实际 NADC operation/setter | `chromium/src/third_party/blink/renderer/core/timing/performance.idl:38`、`chromium/src/third_party/blink/renderer/core/testing/nadc_attribute_test.idl:8` |
| tier 测试 intrinsic | `chromium/src/v8/src/runtime/runtime-test.cc:534,542,915` |

Firefox-Reverse 对照位置以其仓库为根：`additions/browser/components/agent-sidebar/modules/Tools.sys.mjs:1157`、`AgentSession.sys.mjs:256`、`ConfigStore.sys.mjs:53`、`LedgerBackend.sys.mjs:45`；后面三个文件同属前述 modules 目录。SpiderMonkey 对照入口为 `additions/js/src/vm/JsvmpTraceCore.cpp:898`。

## 15. 复现材料与下一步

已完成 P0 的最小 d8 构建/运行验证、P1 的补丁/静态测试部分，以及 P1 的完整 patched Chromium 构建、12 组浏览器集成矩阵与 launcher 端到端补验（2026-09-19；唯一产品修复为 V05 因果开关转发，已在补丁 0001 内闭环）。66 项工具迁移前置清单已产出（[tool-inventory.md](tool-inventory.md)）。P1 的最终冻结待总架构师核验原始证据；未启动子 agent，未实现新的自定义域、writer 或 observer。实施证据与剩余缺口见[实施交接文档](chromium-patched-build-implementation.md)。

### 15.1 本地验证产物

- 独立构建目录：`chromium/src/out/XTraceD8Verify`。
- 证据目录：`chromium/src/out/XTraceD8Verify/validation`，包含 patch SHA-256、源码 SHA、GN 参数和各测试日志。
- 可复测补丁文件与仓库测试：上述证据目录内的 `patched-repo`；它是只含所需源码的验证副本，不能用于编译整个 Chromium。
- 原始临时索引与物化目录：`/tmp/xtrace-verify-hpq3yjuu`；临时目录可被系统清理，长期本地证据以独立输出目录为准。
- Blink 复测 Python：隔离 CPython 3.11.16；未改系统默认 Python，未修改上游失败测试。

以上均为本地、git-ignored 或临时产物，不是已提交的构建发布包。

### 15.2 d8 构建命令

以下保留 v0.2 在未打补丁固定源码上的历史命令，使用系统 Python 3.13.11 驱动 GN。当前源码已应用 XTrace 补丁，不应在原 `XTraceD8Verify` 输出目录重跑，否则会覆盖 P0 的未打补丁基线；如需重现原实验，应使用独立干净工作树和独立输出目录。

```bash
python3 chromium/src/build/util/lastchange.py -o chromium/src/build/util/LASTCHANGE
chromium/src/buildtools/mac/gn gen chromium/src/out/XTraceD8Verify \
  --root=chromium/src --fail-on-unused-args \
  --args='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 chrome_pgo_phase=0 use_siso=false use_remoteexec=false v8_enable_trace_ignition=true v8_enable_trace_baseline_exec=true v8_enable_disassembler=true v8_enable_object_print=true'
chromium/src/third_party/ninja/ninja -C chromium/src/out/XTraceD8Verify -j 10 d8
```

GN 实际宏包含 `V8_TRACE_UNOPTIMIZED`、`ENABLE_DISASSEMBLER`、`OBJECT_PRINT` 和 `V8_ENABLE_SANDBOX`，同时存在上游调试/检查特性；不得将此产物当成无插桩发布版做性能对照。

### 15.3 测试复现

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s chromium/src/out/XTraceD8Verify/validation/patched-repo/tests -v
uv venv --python 3.11 /tmp/xtrace-blink-python311
PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
  /tmp/xtrace-blink-python311/bin/python \
  chromium/src/third_party/blink/tools/run_bindings_tests.py -j 1
```

复用已有临时 Python 环境时无需重复创建。首次普通 Python 运行受用户 site-packages 中的 requests/brotli 导入冲突影响；隔离后确认 Python 3.13 的 6 项失败来自已删除别名，Python 3.11 中原测试 57 项全部通过，未通过 skip 或更改期望值制造成功。

d8 运行验证脚本与样本已保存在证据目录，可复跑：

```bash
python3 chromium/src/out/XTraceD8Verify/validation/verify_d8.py \
  chromium/src/out/XTraceD8Verify/d8
python3 chromium/src/out/XTraceD8Verify/validation/verify_tiers.py \
  chromium/src/out/XTraceD8Verify/d8
```

`d8-cases/summary.json`、`d8-tiers/summary.json` 保存断言结果，旁边保留生成的 JS、stdout/stderr；`baseline-evidence.json` 包含源码/补丁/二进制摘要。运行脚本会覆盖自身上次实验输出，需比较历史结果时先保留相应目录。

完整 patched Chromium 构建已在 `out/XTraceIntegration` 完成（增量确认退出码 0 存档）；同一输出目录的后续增量构建须先确认无运行中 Ninja。12 组浏览器矩阵、launcher 补验结果、基线数据与架构 review 关卡统一见[实施交接文档](chromium-patched-build-implementation.md)。第 13.2 节仍需新实现才能验证的项目不因本次完成而视为完成。

## 16. 修订记录

- v0.8（2026-09-23）：P4 经总架构师终审通过并冻结（N0–N6 整改证据链独立复验：契约 21/21、parity 10/10、三态性能、双树重放 124+137 文件 0 不符；终审记录见 [P4 交接](chromium-p4-ignition-observer-handoff.md) §13）；P5 交接文档 [chromium-p5-webidl-generator-handoff.md](chromium-p5-webidl-generator-handoff.md) 发布。仅状态更新，设计决策不变。
- v0.7（2026-09-20）：P2 经总架构师 R2+R3 合并终审通过并冻结（schema v3 落地、browser-network 并轨、§6.6 收口、五场景故障注入、矩阵与 launcher v3 通过；终审记录见 `integration-progress.json` 的 `p2_acceptance`）；P3 交接文档 [chromium-p3-control-plane-handoff.md](chromium-p3-control-plane-handoff.md) 发布。仅状态更新，设计决策不变。
- v0.6（2026-09-19）：P1 经总架构师 R3 核验通过并冻结（审查记录：[chromium-p1-architecture-review.md](chromium-p1-architecture-review.md)）；P2 交接文档 [chromium-p2-capture-foundation-handoff.md](chromium-p2-capture-foundation-handoff.md) 发布。仅状态更新，设计决策不变。
- v0.5（2026-09-19）：P1 完整构建与浏览器集成执行完毕并写入状态：`chrome` 50640/50640 构建成功、12 组矩阵 12/12、launcher 端到端通过、V05 缺口修复闭环（补丁 0001 + 回归断言 + 干净索引复验）；产出 66 工具清单 `docs/tool-inventory.md`（P6 前置交付物）；`docs/chromium-build.md` arm64 hook 表述勘误。仅状态与文档更新，设计决策不变。
- v0.4（2026-09-19）：登记指纹伪装层缓期与环境管理最小集（§1.1、§5）；新增既有缺陷收口表（§6.6）；补 producer 完整清单与采样计数约定（§7.1）；补 worklet 边界（§8.3）、code cache 路径（§9.2）、tier 校验双层（§9.4）、能力协商三态与非增强浏览器立场（§11.1）、证据索引存储决策（§11.2）；更新 P2/P4/P6 阶段交付与验收（§12）、测试宿主分配与基线采集（§12.2）、迭代成本预算（§12.3）、收敛决策表（§13.1）、源码索引（§14）。本轮为文档级补充，不改变任何已验证结论与实施状态。
- v0.3（2026-09-19）：四补丁应用到固定工作树；P0 d8 验证完成；转入完整构建与浏览器集成。
