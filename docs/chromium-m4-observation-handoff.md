# M4 交接：观测面扩展（WebIDL 第二批 / Sparkplug 对照 / worker-SW / 引擎级函数与闭包观测）

- 文档版本：v1.0（2026-09-27，项目架构师）。**进入条件（全部）**：① `accepted-m3`（D-M3-5 关闭，见 [M3 执行记录 §R2.3](chromium-m3-execution-handoff.md)）；② [登记册](open-items-register.md) M3 名下无开放阻塞；③ M1.1 语料尾件**至少完成 b 项**（三站带 tap+dump 复跑的产物在盘上）——M4 的接口选型要吃它的实测形态。
- 对应里程碑：**M4**（[路线图](roadmap-milestones.md) §1，窗口 2026-11-06 → 11-28）。
- 分工：执行层实施；架构师裁决与终审。长程单次终审模式沿用；**本轮回到引擎面**（V8/Blink），补丁栈强制同步与 rebuild-before-run 纪律恢复为最高优先级。
- 本档与 M3 的本质差异：M3 全在 Host 侧（零引擎改动）；M4 的每一项都可能动 `chromium/src` 或 `v8`。因此**每个执行块开工前先确认补丁边界归属**（改动落在哪个补丁层、补丁重生成在哪个 commit 落盘）。

## 1. 接手先做什么

1. 读本文件 + [P4 observer 交接](chromium-p4-ignition-observer-handoff.md)（引擎观测面的现有形态）+ [P5.5 设计契约](chromium-p55-design-contract.md)（值观测的语义与计账纪律）+ [P5 设计](chromium-p5-design.md)（WebIDL 生成器插桩面）+ 清单 [tool-inventory.md](tool-inventory.md) §2/C 的 `signer_trace`/`closure_read`/`whitebox_diff` 行。
2. **先清债务门（M4-E0）**：登记册 M4 名下条目 + 覆盖债 top-up + GUI 接线残留。
3. 现场确认：`accepted-m3` 的二进制与补丁栈（`verify_patches.py --with-dylibs` pass）；P4/P5/P5.5 全部门禁在**当前二进制**上绿（跑一遍再过引擎改动）。

## 2. 冻结输入

| 项目 | 值 |
| --- | --- |
| 浏览器 | ChromiumX（out/XTraceIntegration），基线固定 151.0.7917.0 不变 |
| 数据契约 | trace-schema-v3（v1.3，accounting model 2）；**任何新事件种类先进 schema 文档评审**，再进实现 |
| tier 合同 | **语义合同**（[M3 执行记录 §R2.3 R1-C1](chromium-m3-execution-handoff.md)）：按动作性质分档；清单"需确认"列只能收紧（是⇒stateful）；例外必须引用裁决编号 |
| 能力矩阵 | 自动生成 + 覆盖断言（66 清单全集 + 内部原语分节）是**常设门禁**，本轮新工具一落地即入表 |
| 许可 | frx 迁入代码保留 MPL-2.0；本轮仍无 frx 依赖项 |

## 3. 范围与非目标（冻结）

### 3.1 范围（五项）

1. **WebIDL 第二批接口**（需求驱动）：从语料实测形态出发选接口（参考面：URL/Body/Element/Performance 族——P5 首批之外的既有披露缺口；最终名单以 M1.1 产物 + 语料分析为准，开工前由执行层提案、架构师在 E1 冻结）。**每接口一个分路径门禁**（worker/主线程/跨导航三态至少各一）；批上限 20 个接口（超出走裁决）。
2. **Sparkplug baseline 对照观测**：**本轮只测不对插**——产出"Ignition-only vs Ignition+Sparkplug"的对照矩阵（d8 确定性负载 + 浏览器本地页，事件率/开销/事件语义差异），回答"打开 Sparkplug 会丢失/改变什么观测"。**不做 Sparkplug 层插桩**（另立设计轮）。
3. **worker/SW 场景扩展**：P4 observer + P5 WebIDL 面扩展到 **ServiceWorker / SharedWorker / worklet** 作用域；每作用域一条实测门禁（事件归属的 producer 五元命名空间不变形）；跨 scope 的 nav_chain/causality 承接要实测（不止主线程）。
4. **`signer_trace`（清单"部分"→ 完整）**：**非暂停**的引擎级"选定脚本函数入口 + 实参"观测（CDP 断点会暂停页面、不等价，清单已记录）。引擎侧扩展 P4 observer：按 script 选定的函数边界事件 + 有界实参序列化（沿用值观测的编码器与计账纪律——先过 §4 MD4 设计门）。
5. **`closure_read`（清单"部分"→ 完整）**：执行后真值 + 深序列化——值观测扩展到"读取选定 frame/environment 的执行后值"+ S-box/字节码数组整段深序列化落**有界资产**（沿用 P5.5 S1 的 dump 资产契约：受控根、epoch 键、预算与 coverage 轴）。

### 3.2 非目标（冻结）

Sparkplug 层插桩（只要对照矩阵）；TurboFan/Maglev 观测；`whitebox_diff` 的覆盖对齐器（留 M5 或专项）；指纹层一切（M5）；MV3/跨平台（M6）；活站采集（未授权，AUTH-1）；**全量 WebIDL 覆盖（永远不做）**。

### 3.3 边界声明

- `signer_trace` 的"选定脚本"以 P4 observer 的现有 scriptPattern 面为准；实参序列化预算沿用值观测的每激活预算与 coverage 轴（超预算记 sampled_out，绝不静默截断）。
- `closure_read` 的深序列化只在 dump 资产通道（受控根）；事件流里永不内联大对象。
- 对照观测（Sparkplug）的结论是**对照报告**（observed 级测量），不是"等效性证明"。

## 4. 已冻结的前置决策（块内不重开）

**MD1 引擎改动纪律**：补丁栈强制同步（触碰 `chromium/src`/`v8` 的提交必须同 commit 补丁重生成 + `verify_patches.py --with-dylibs` pass）；**rebuild-before-run**（陈旧二进制结果作废）；每个执行块收尾必须全门禁不回退（不得削弱断言清单 + 新增断言只增不改基线语义）。引擎面回到 P5.5 的返工密度预期：**每个引擎子块预算 = 执行 + 等量整改**。

**MD2 值观测扩展的设计门（防 P5.5 级返工）**：`signer_trace` 与 `closure_read` 各先交一份**设计契约**（参照 P5.5 设计契约的形状：内存安全/生命周期/GC 安全/计账等式/覆盖轴影响/拒绝矩阵），**架构师评审通过前不写引擎代码**。这两条是本轮最高风险面（V8 内存安全）。

**MD3 WebIDL 第二批的选型纪律**：名单提案必须引用**实测证据**（M1.1 产物或语料 capture 里"该接口读了什么/被谁读"的事件），不许按"常见面"拍脑袋；每接口的覆盖矩阵行在能力矩阵里自动生成。

**MD4 门禁纪律（新增三条固定锚点，源自 P6/M3 教训）**：
- **tier 语义合同表**：新工具一注册即进 `r1-tiers` 的合同表（带裁决引用），机检门禁同时覆盖。
- **工具语义与真实产品面一致性**：凡声称"可用"的工具必须有**真实产品路径**的门禁（真浏览器/真会话/真文件系统），假 host/mock 只能做单元层；M3-B1（scripts_save 会话域）就是缺了这条。
- **能力矩阵覆盖债**：本轮 top-up ≥ 10 项（19 → ≤9），目标 M5 清零。

**MD5 新事件种类的 schema 先行**：任何新事件种类（函数入口事件、闭包真值行、对照观测行）先在 `docs/trace-schema-v3.md` 增补并评审，再实现；计账 model-2 等式与 coverage 轴对新 producer 必须成立（含分代/未确认 producer 语义）。

## 5. 任务分解

| 序 | 任务 | 关键交付 | 验收锚点 |
| --- | --- | --- | --- |
| M4-E0 | 债务门 | 登记册 M3 名下清零核对；矩阵覆盖债 top-up（19→≤9，每项一个真实门禁）；GUI 残留接线核对（runningExecutions 面板已由 D-M3-5 顺带完成则核验）；M1.1 产物盘点（若 b 项未完成，E1 选型冻结顺延——其余项不受影响） | `run_tests.sh` 全绿 + 矩阵重生成 + 覆盖债数字如实下降 |
| M4-E1 | WebIDL 第二批选型冻结 | 执行层提案（每项引用实测证据）+ 架构师裁决 → 名单冻结进本文档 §3.1 | 每项提案有证据指针；裁决记录进登记册 |
| M4-E2 | WebIDL 第二批实现 | 生成器插桩扩展 + 分路径门禁 | 每接口主线程/worker/跨导航至少各一条实测；P5 首批不回退 |
| M4-E3 | Sparkplug 对照观测 | d8 确定性负载 + 浏览器本地页的 Ignition-only vs +Sparkplug 对照矩阵（事件率/开销/语义差异） | 对照报告落 docs + 数为 observed 级测量；明确"不是等效性证明" |
| M4-E4 | `signer_trace` 设计契约 → 实现 | 设计契约（MD2 门）+ 引擎扩展 + Host 适配器（stateful） | 契约过我评审；**非暂停**证明（页面计时不失真对照）；实参序列化预算与 coverage 轴计账闭合 |
| M4-E5 | `closure_read` 设计契约 → 实现 | 同上 + 深序列化进 dump 资产通道 | 契约过我评审；深序列化资产走受控根 + epoch 键 + 预算；事件流零大对象内联（静态核对） |
| M4-E6 | worker/SW/worklet 场景扩展 | 每作用域一条实测门禁；跨 scope 因果承接实测 | SW/SharedWorker/worklet 各产一条真实 capture 行（producer 五元不变形）；跨 scope nav_chain 实测 |
| M4-E7 | 证据包 + 终审 | 全门禁矩阵 + 能力矩阵（含新工具入表）+ 文档同步 | 架构师终审后 `accepted-m4` |

## 6. 纪律

- 沿用 M3 交接 §6 全条 + PD5（不得削弱清单/删测试须给替代位置/记录逐条可核）+ 本文件 MD1–MD5。
- 升级触发器：基线变更/规范语义变更/新对外能力/新二选一/内存安全疑虑/受信边界/Broker 旁路迹象。
- 证据目录、progress JSON、执行记录回填照旧；每轮阶段性成果必须 commit，不推送远端。

## 7. 完成定义

路线图 §1 M4 行全部 + 五项范围各有实测证据 + 两份设计契约过审 + 全门禁不回退 + 能力矩阵含新工具且覆盖债 ≤9 + `accepted-m4` 由架构师标记。
