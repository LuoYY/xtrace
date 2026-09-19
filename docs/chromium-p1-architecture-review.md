# P1 架构 Review：完整 patched Chromium 构建与浏览器集成

- 版本：v1.1（2026-09-19；v1.1 增加第 8 节冻结确认）
- 审查人：总架构师会话
- 审查对象：实施交接文档 v0.3（E1–E7 全部自报完成）、迁移草稿 v0.5、`integration-progress.json`、`docs/tool-inventory.md`、`e2-identity/`、`browser-run-SLcEOM/hvdHaB/4gDtWa`、`launcher-smoke-wTuzvt/` 等原始证据
- 关卡：实施交接文档 §7 的 R1/R2/R3
- **结论：实质通过，附条件冻结。** 完成第 5 节的 4 项证据补齐后，由总架构师确认，P1 标为完成并进入 P2。不需要重新构建或重跑矩阵。

## 1. 裁决摘要

| 关卡 | 结论 | 说明 |
| --- | --- | --- |
| R1 完整构建 | 通过（附证据补齐项 §5.1–5.2） | 确为固定版四补丁；三轮环境处理未越界；V05 修复真实且落点正确 |
| R2 真实浏览器 | 通过 | 断言强度足够且本轮只增不减；关键声明经独立复验 |
| R3 P1 冻结 | 附条件 | E6.1 缺口清单三态划分正确；两个裁量点均接受；冻结前先完成 §5 的 4 项 |

两个裁量点裁决：

1. **debug 构建基线数据接受为草稿 §12.2 的定标输入**，现有边界表述（"仅作定标输入，不作 release 性能结论"）保留即可。补充限制：这批数据可用于采集机制量级与模式间相对比值（v1/v2 体积差、各案例事件率）；debug component 构建的绝对值（峰值 RSS 约 3 GB/案例、墙钟）不得外推任何绝对阈值，绝对目标值待 release 基线（`scripts/build_xtrace_release.sh`）出来后定稿。
2. **`docs/chromium-build.md` 勘误与自检对账表述接受**。勘误准确保留历史由来；自检 4 样本分布于 3 个目录（IzTLTk=disabled-json、3M90bD=disabled-reverse+disabled-fingerprint、lFbeQ8=disabled-business）与现场一致。

V05 补丁变更（0001 加一行 `"xtrace-causality",`，hunk 计数 13→14）**接受**：该开关复制列表本就由 0001 引入，修复落在 0001 是正确分层；干净索引顺序复验已由本架构师独立重跑确认（§7.1）。

## 2. R1：完整构建核验

已核实：

- `chromium-build-04.log` 终态 `[50640/50640]`，`^FAILED:` 计数 0；日志中 7 处 `error:` 匹配均为 `webui_js_error` 目标名误匹配，非编译错误。
- 增量确认轮 `chromium-build-next-nvU5ax` 与修复轮 `chromium-build-fix1-dkZZLs` 的 `.exit-code` 均为 0。
- `identity.json`：Chromium HEAD `73088b4e…`、V8 HEAD `af6aa2ec…` 与固定基线一致；`Browser.getVersion` = `Chrome/151.0.7917.0`；`stderrCrashSignatures` 为空；退出码 0；启动参数无 `--no-sandbox`/`--disable-web-security`/公网调试端口。`revision` 全零已在 E2 中注明（本地构建未盖章 LASTCHANGE），接受该解释。
- 环境处理三轮（Dawn/GPU/Skia 元数据、DevTools rollup CIPD 库、Metal Toolchain 下载）均为元数据/组件补齐，未升级依赖、未关沙箱、未删 hook，未越界。
- 当前应用树 `chrome_content_browser_client.cc:3146` 已含 `"xtrace-causality",`，与补丁 0001 的 +1 行一致。

发现的问题（均列入第 5/6 节）：身份摘要未覆盖承载补丁代码的 dylib、0001 补丁摘要为修复前旧值、fix1 日志行数与文档表述不符。详见下文。

## 3. R2：真实浏览器核验

三个运行目录的分工与结论均成立：

- `browser-run-SLcEOM`（首轮 11/12）：`causality-switch-only` 失败信息 "v1 record mixed into v2 trace" 与 V05 诊断精确吻合（renderer 缺开关回退 v1，browser 网络事件按开关标 v2），是真实运行证据；失败证据保留未删。
- `browser-run-hvdHaB`：修复后单案例复测通过（6645 条记录、schema 2）。
- `browser-run-4gDtWa`（最终 12/12）：12 个案例名齐全、全 pass、退出码 0；v1/v2 案例的 schema 标记各自正确。

驱动脚本（`browser-integration.cjs`，290 行）逐行复核结论：**本轮只有增强，没有任何既有断言被削弱或删除**。新增项包括 RSS/墙钟基线采集、`worker-context.json` 线程归属证据、business 页 3 条新断言（自定义头到达服务端、query 键集合一致、XHR body 非空）。关键断言在位：页面预期值、网络 200、`Runtime.exceptionThrown` = 0、exit 0、v2 逐条 `schema_version === 2`、资产 path 越界检查 + size + source + SHA-1 + `truncated=false` 五重校验、validator 退出码。`closeEvidence` 字段如实写明"无 watermark 协议"，不冒充可靠排空。

独立抽查（细节见 §7）：

- Worker 线程来源：`worker-v1/worker-context.json` 中 `Body.text`/`fetch` 落在独立 tid 且该线程零 DOM API，主 tid 仅 DOM 类事件。线程归属断言实质成立。
- 资产一致性：reverse-v1 全部 5 个资产由我独立重算，SHA-1/内容/source/长度/`truncated=false` 全部一致。
- launcher 端到端：launcher/validator 退出码均 0，5926 条记录 PASS；运行时抓取的 10 条进程命令行 0 违禁开关，其中 6 条（1 browser + 5 renderer）携带 `--xtrace-causality=sync`，证明 V05 修复在 launcher 链路同样生效。静态半断言直接调用真实 `build_chromium_command`，可信。
- 抽样 stderr（json-v1/reverse-v1/business-v2）无 crash/fatal 签名。

已知边界（披露正确，非问题）：矩阵与 E2 均为 `--headless=new`；reverse 页 WebSocket 预期连接错误已在 E6.1 披露；`closeEvidence` 不宣称尾部零丢失。

## 4. R3：P1 冻结评审

E6.1 缺口清单的三态划分**正确**，"绿灯但没解决"的项均未被包装成已完成：可靠 stop/排空、summary 资产泄漏、browser-network 私有写入并轨、§6.6 旧缺陷、code cache、证据索引、release 基线均标为未验证/设计要求；指纹层与完整环境管理器显式缓至 P7。

`docs/tool-inventory.md`（E7）质量合格：66 项逐项有依赖/目标/状态/原因，A13/B22/C16/D15 统计与首批冻结建议（A 组全入、B 组 5 项、C/D 不接入、4 项不可用挂 P7）可直接作为 P6 输入；"部分"项的语义缺口（如 `jsvmp_trace` 的 dump 超出 P4 首版、`signer_trace` 的 CDP 断点时序问题）披露诚实。许可证提醒（MPL-2.0 不改标 MIT）在位。

文档一致性：实施文档 v0.3、草稿 v0.5、`integration-progress.json`、tool-inventory.md 四方在实质内容上无矛盾；两处表述问题列入 §5.3/§5.4 与 §6。

## 5. 冻结前必须补齐（4 项，执行层执行，均为分钟级记录修正）

- [ ] **5.1 补丁摘要更新为修复后终值。** `e2-identity/identity.json` 记录于 18:12（修复前），其 0001 摘要 `887b9ece…` 与当前补丁文件（`76ce5768…`）不一致。修复后的最终补丁 SHA-256 目前在证据包中没有任何记录。处理：重跑身份采集或在 `identity.json`/`integration-progress.json` 追加 post-fix 补丁摘要段，并注明两个值各自对应的时点（修复前/后）。
- [ ] **5.2 二进制摘要覆盖承载补丁代码的 dylib。** component 构建下 V05 修复落在 out 根目录的 `libchrome_dll.dylib`（framework 主二进制经 `@rpath` + `@loader_path/../../../../../..` 从 out 根加载它，已核实 mtime 18:17:40 与 fix1 吻合）；0002 的 V8 改动在 `libv8.dylib`，0001 的 Blink/content 改动在 `libblink_*.dylib`/`libcontent.dylib`。identity.json 目前只哈希了 loader 与 framework 主二进制，严格来说"所测即此补丁"没有哈希闭环。处理：摘要清单追加 out 根目录相关 dylib（至少 `libchrome_dll.dylib`、`libv8.dylib`，建议连同 `libcontent.dylib`、`libblink_core.dylib`、`libblink_platform.dylib`、`libblink_modules.dylib`）的 SHA-256。
- [ ] **5.3 `integration-progress.json` 的 `"status": "accepted-p1"` 越过了 R3 门。** 实施文档 E6 明确"总架构师核验后才标完成、本文件不自行宣告"，进度文件却自称 accepted。处理：改为 `p1-evidence-complete-pending-r3`；本 review 确认 5.1–5.4 完成后，再由架构师同意改为 accepted。
- [ ] **5.4 实施文档 §4.2 残留"快照时尚不存在"。** 该行（app 路径说明）写于 v0.1，app 现已存在并通过验收，且与 E6 自报的"历史残留表述已消除"直接矛盾。处理：删除该限定语或改写为现状描述（保留"不要用 patched-repo 物化副本编译、不要重建 XTraceD8Verify"的警示）。

完成后：更新实施文档 E6 勾选与 §8 完成定义状态，回报架构师确认。

## 6. 建议修正（不阻塞冻结）

1. **§3.1 的 fix1 表述与日志不符。** 文档称"22 步（重编 + 重链 + bundle 复制）"，但 `chromium-build-fix1-dkZZLs` 实际只有 3 行（止于 `[2/22]` SOLINK）。且因 rpath 从 out 根加载 libchrome_dll，本无 bundle 复制步骤。建议改为"日志可见 2 步（CXX + SOLINK）、退出码 0；修复生效以运行时证据（switch-only 复测 + renderer 命令行实测）为准"。
2. **E3 的 Worker 证据数值注明出处运行。** 引用的 pid/tid（43839/68976564）来自首轮 SLcEOM，最终运行 4gDtWa 为 46894/68989929；两次结构结论一致，但建议改引最终运行数值或注明出处。
3. **回归日志存档为修复前旧档。** validation/ 下三份回归日志时间为 15:26–15:27（修复前）。本架构师已在修复后状态独立重跑：主项目 338/338 OK、launcher 28/28 OK、GUI 211 pass / 0 fail。建议用修复后的运行覆盖存档，使证据包时间线自洽（可引用本节作为过渡证据）。
4. `.zcodeignore` 入库属工具配置沉淀，无害；若仓库定位为"只含可复现工程"，可考虑移至 `.git/info/exclude`，由维护者裁决。
5. 无需行动：12 组矩阵与 E2 均为 headless，headed 模式的渲染/指纹面差异不在 P1 范围，现有文档未误称，保持即可。

## 7. 独立复验记录（复核者可重跑）

### 7.1 补丁干净索引顺序复验（对应 E5）

```bash
ROOT=/Users/luoyy/work/github/GitHub/xtrace
export GIT_INDEX_FILE=$(mktemp /tmp/xtrace-review-idx.XXXXXX)  # 用完 rm
git -C $ROOT/chromium/src read-tree --empty
git -C $ROOT/chromium/src read-tree 73088b4e50b1dc69eaa0bdb14a8e4592813174fd
for p in 0001 0003 0004; do git -C $ROOT/chromium/src apply --cached --check $ROOT/patches/$p-*.patch && git -C $ROOT/chromium/src apply --cached $ROOT/patches/$p-*.patch; done
# V8 用第二个临时索引文件，read-tree af6aa2ec… 后 apply --cached 0002
```

本架构师实跑结果：0001（含 V05 修复）→0003→0004 在 Chromium 树、0002 在 V8 树全部 `apply --cached` 干净通过，无 3-way 回退。

### 7.2 资产三重一致（对应 E3）

对 `browser-run-4gDtWa/reverse-v1/assets/trace/` 全部 5 个资产独立重算：文件 SHA-1 与 manifest `sha1` 字段一致、文件字节与 manifest `source` 全等、`size == original_size` 且 `truncated=false`。

### 7.3 Worker 线程归属（对应 E3）

`browser-run-4gDtWa/worker-v1/worker-context.json` 共 6 个 `pid:tid` 上下文：`Body.text`=2、`fetch`=1 出现在 pid 46894 / tid 68989929，该 tid 的 API 集合无 Document/Node/HTML* 等 DOM 入口；同进程主 tid（68989768）只有 DOM 类事件。

### 7.4 修复后回归（对应 E5；validation/ 存档为修复前旧档）

本架构师在修复后工作树实跑：`tests/` 338/338 OK（含新增相邻断言）、`xtrace-launcher/tests` 28/28 OK、`xtrace-gui`（`npm ci --ignore-scripts` 后）211 pass / 0 fail。

### 7.5 launcher 链路（对应 E4）

`launcher-smoke-wTuzvt/`：`launcher.exit-code`/`validator.exit-code` 均 0；`validator.log` PASS（schema 2 + JSON.parse/stringify）；trace 5926 行；`chromium-commandlines-at-runtime.txt` 10 条进程命令行中 0 条含 `--remote-debugging-port`/`--remote-allow-origins`，6 条含 `--xtrace-causality=sync`。

### 7.6 关键时间线（mtimes 实测）

| 时刻 | 事件 |
| --- | --- |
| 18:07:10 | build-04 完成（50640/50640），app 写出 |
| 18:08:06 | 增量确认轮退出码 0（no work to do） |
| 18:12:19 | identity.json 采集（0001 摘要为修复前旧值的原因） |
| 18:16:12 | patches/0001 写入 V05 修复 |
| 18:17:42 | fix1 增量重建退出码 0；out 根 `libchrome_dll.dylib` mtime 18:17:40 |
| 其后 | hvdHaB 单案例复测通过 → 4gDtWa 全量 12/12 → launcher 冒烟通过 |

## 8. 冻结确认（2026-09-19，v1.1）

第 5 节 4 项已由执行层补齐并经本架构师核验通过：

- 5.1/5.2：`identity.json` 追加 `postFixSupplement` 段（修复后四补丁 SHA-256 + 6 个组件 dylib SHA-256 + 时间线）；我对磁盘文件独立重算，0001=`76ce5768…`、`libchrome_dll`=`75e95f54…`、`libv8`=`efb8c2d8…`、`libcontent`=`31d5214f…` 等全部一致；原顶层修复前摘要保留并注明时点，处理方式正确。
- 5.3：`integration-progress.json` 状态已先降为 `p1-evidence-complete-pending-r3`，未越门。
- 5.4：§4.2 浏览器路径行已改为现状描述，patched-repo/XTraceD8Verify 警示保留。
- 建议项 1–3 一并完成（fix1 表述改为日志可见 2 步、Worker 证据改引最终运行 4gDtWa 数值并注明首轮出处、三份回归日志已用 20:01 修复后运行覆盖存档）；建议 4（`.zcodeignore` 去留）留维护者裁决。

**P1 标记为完成（冻结）。** `integration-progress.json` 状态由架构师改为 `accepted-p1` 并附接受记录。下一阶段：P2 采集与写入基础，交接文档为 [chromium-p2-capture-foundation-handoff.md](chromium-p2-capture-foundation-handoff.md)。
