# Patched Chromium 构建与浏览器集成实施交接

- 文档版本：v0.1。
- 状态快照：2026-09-19 15:40:23，UTC+08:00；进程、日志和磁盘数据均为该时刻快照，不是持续更新的状态。
- 项目根目录：`/Users/luoyy/work/github/GitHub/xtrace`。
- 当前阶段：迁移方案 P1，完整 patched Chromium 构建进行中，浏览器集成尚未验收。
- 分工：用户指定执行层 agent 接手实施；本会话转为总架构师，负责证据 review、方案边界、优先级和纠偏，不并行启动另一套构建或新子 agent。
- 设计依据：[迁移增强方案草稿](chromium-migration-enhancement-draft.md)。本文件负责实施状态、接管顺序和验收要求；状态冲突以现场证据为准。

## 1. 接手先做什么

1. 阅读本文件第 2–4 节，确认固定版本和正在运行的 Ninja。
2. **不要重新下载源码、重复应用四补丁、清空输出目录或同时再启动 Ninja。** 原源码工作树已应用补丁，不再是干净原版。
3. 优先接管现有构建，等待其结束。失败时按第 5 节分类处理，保留首次失败证据。
4. 完整 `chrome` 目标成功后，运行本次生成的 Chromium，而不是 `/Applications/Chromium.app` 或系统 Google Chrome。
5. 执行 12 组浏览器矩阵、launcher 端到端补验及回归检查，再提交证据供架构 review。

当前没有要求实施新的 writer、CDP XTrace 域、结构化 observer 或 Agent Host。不要把 P1 构建验证扩成 P2–P7 重构。

## 2. 固定基线与工作树状态

| 项目 | 已核实状态 |
| --- | --- |
| 平台 | macOS / arm64，64 GiB 内存、18 核 |
| Chromium 版本 | `151.0.7917.0` |
| Chromium HEAD | `73088b4e50b1dc69eaa0bdb14a8e4592813174fd` |
| V8 HEAD | `af6aa2ec5047676cfb3150b46449faac7578be7e`，来自上述 Chromium 的 DEPS |
| DevTools HEAD | `07482123637227aa4c1afef4b1b80abb66683063` |
| XTrace HEAD | `787d13ac80307e280c92bfd09852b6d6aa8c6d6d`，分支 `enhance` |
| 源码状态 | Chromium/V8 已顺序应用四补丁；尚无本轮额外 C++ 修复 |
| 工作树快照 | Chromium `git status --short` 为 93 条，V8 为 126 条；目录折叠意味着这不是精确修改文件数 |
| 主仓库状态 | 创建本交接文档前干净；不能据此认定 nested Chromium/V8 也干净 |
| Xcode | 26.6 / 17F113 |
| Metal | 官方组件已安装；`xcrun metal --version` 为 `32023.883` |
| Python / Node | 系统 Python 3.13.11；Node 24.18.0；Blink 单测用隔离 Python 3.11.16 |
| 磁盘 | 剩余约 128 GiB；完整构建目录约 3.4 GiB，旧 d8 目录约 3.1 GiB |

补丁应用顺序为 `0001 → 0003 → 0004 → 0002`，前 3 个作用于 Chromium，最后一个作用于独立 V8 工作树；本轮未使用 3-way 回退。

本会话没有提交或推送代码。接手后先检查现场，保留用户或其他执行者产生的更改，不根据本表执行 reset/clean。

## 3. 已完成与未完成

| 事项 | 结果 | 证据 / 边界 |
| --- | --- | --- |
| 固定 Chromium 与 V8 下载同步 | 完成 | 不升级版本 |
| 四补丁临时索引顺序验证 | 通过 | 旧 d8 验证目录中的 baseline evidence |
| 四补丁应用到真实工作树 | 通过 | [apply-patches.log](../chromium/src/out/XTraceIntegration/validation/apply-patches.log) |
| 主项目 Python 测试 | 338/338 | 实际已打补丁源码上的本轮结果 |
| launcher Python 测试 | 28/28 | 单测，不是 launcher 真实启动验收 |
| GUI 逻辑测试 | 211/211 | 不是 Electron UI 交互验收 |
| schema v2 golden fixture | 上轮通过 | 不能替代本次浏览器输出 |
| Blink 上游 bindings 单测 | 上轮 Python 3.11 中 57/57 | Python 3.13 的 6 个旧 unittest 别名错误保留在原日志中 |
| 未打补丁固定 d8 构建 | 上轮成功 | 3443 步；**不是 patched Chromium** |
| d8 字节码 / tier 样本 | 10 + 4 组通过 | 2120 条目标 Entry；上游 tracing.js 也通过 |
| 完整 Chromium GN | 成功 | 31344 targets / 4812 files |
| 完整 `chrome` 编译 | 运行中 | 尚无完整成功退出码 |
| 浏览器集成脚本 | 已准备 12 组 | 真实 patched Chromium 尚未运行 |
| 原版 Chrome 脚本自检 | 4 组关闭采集样本通过 | Chrome/153.0.8010.50；只证明测试驱动可用，不算固定版本验收 |
| launcher 端到端采集 | 待执行 | 测试驱动直接启动 Chromium，尚未覆盖 launcher 启动链路 |
| 最终复现与证据 review | 待执行 | 不得提前标记 P1 完成 |

### 3.1 当前运行中的构建

- 输出目录：[out/XTraceIntegration](../chromium/src/out/XTraceIntegration/)。
- 当前日志：[chromium-build-04.log](../chromium/src/out/XTraceIntegration/validation/chromium-build-04.log)。
- 本会话后台任务 ID：`b7hobluly`；执行层不一定能访问此会话的任务 API，应以本机进程与日志为准。
- 快照中的 Ninja PID：`29930`，父进程 PID：`29928`；PID 可能退出或被复用，操作前必须核验完整命令。
- 命令：`ninja -C chromium/src/out/XTraceIntegration -j 10 -k 0 chrome`。
- 快照进度：`[4887/50640]`；这是**当前增量轮次**，不能解释为首次完整构建的百分比。
- 快照中本轮 `FAILED:` 为 0；这不等于构建已成功。
- `-k 0` 用来继续独立目标并汇总错误，不屏蔽失败，最终仍必须获得完整目标的成功退出码。

```bash
ps -p 29930 -o pid,ppid,etime,command
```

不要仅凭 PID 消失认定成功；应检查最终日志和产物，并在确认旧 Ninja 已结束后做一次正常增量 `chrome` 构建，保存退出码。

### 3.2 已解决的环境阻塞

| 轮次 | 问题 | 已完成处理 |
| --- | --- | --- |
| build.log | 缺 `gpu/webgpu/DAWN_VERSION` | 按固定 DEPS 运行 Dawn、GPU lists、Skia 的 lastchange 生成步骤 |
| build-02.log | 缺 `@rollup/rollup-darwin-arm64` | 使用已下载 CIPD 库，执行 DevTools `scripts/deps/sync_rollup_libs.py`；版本仍为 4.60.4 |
| build-03.log | `metal` 入口存在，但实际 Metal Toolchain 缺失 | 执行 `xcodebuild -downloadComponent MetalToolchain`，退出 0；随后实际运行 `metal --version` 成功 |
| build-04.log | 当前构建 | 正在运行；不覆盖前面失败日志 |

不要删除 lockfile/node_modules 来“重装最新版”；不要禁用 Metal、GPU 或原有采集 hook 来绕过错误。元数据和组件处理不要求升级 Chromium/V8。

## 4. 文件与文件夹导航

以下相对链接均以本文所在 `docs/` 为基准；`chromium/` 和构建产物为本机 git-ignored 数据，换机器不会随主仓库自动携带。

### 4.1 设计、实现与源码

| 用途 | 链接 |
| --- | --- |
| 项目根目录 | [xtrace](../) |
| 总体方案与 P0–P7 | [迁移增强草稿](chromium-migration-enhancement-draft.md) |
| XTrace 当前报告 | [XTRACE-REPORT.md](../XTRACE-REPORT.md) |
| Firefox 迁移分析 | [chromium-migration-analysis.md](/Users/luoyy/work/github/GitHub/firefox-reverse/docs/chromium-migration-analysis.md) |
| 构建说明 | [chromium-build.md](chromium-build.md) |
| 四补丁 | [patches/](../patches/) |
| 补丁应用入口 | [apply_patches.sh](../scripts/apply_patches.sh) |
| 原项目 GN / 构建入口 | [gn_gen_xtrace.sh](../scripts/gn_gen_xtrace.sh)、[build_chromium.sh](../scripts/build_chromium.sh) |
| Chromium / V8 | [chromium/src/](../chromium/src/)、[v8/](../chromium/src/v8/) |
| Chromium DEPS | [DEPS](../chromium/src/DEPS) |
| Blink core 开发约束 | [AGENTS.md](../chromium/src/third_party/blink/renderer/core/AGENTS.md) |
| 配置转发与 browser 网络事件 | [chrome_content_browser_client.cc](../chromium/src/chrome/browser/chrome_content_browser_client.cc) |
| browser 写入端 | [xtrace_host_impl.cc](../chromium/src/content/browser/xtrace/xtrace_host_impl.cc) |
| renderer 日志与资产 | [xtrace_logger.cc](../chromium/src/third_party/blink/renderer/platform/xtrace/xtrace_logger.cc) |
| 日志 Mojo 接口 | [xtrace.mojom](../chromium/src/third_party/blink/public/mojom/xtrace/xtrace.mojom) |
| 启动器 | [xtrace-launcher/](../xtrace-launcher/)、[cli.py](../xtrace-launcher/xtrace_launcher/cli.py) |
| 测试页面与服务 | [test-pages/](../test-pages/)、[serve_test_page.py](../scripts/serve_test_page.py) |
| 校验器 / 分析器 | [validate_trace.py](../scripts/validate_trace.py)、[analyze_vmp_trace.py](../scripts/analyze_vmp_trace.py) |
| schema 定义 | [v1](trace-schema-v1.md)、[v2](trace-schema-v2.md) |
| 仓库测试 | [tests/](../tests/)、[test_build_scripts.py](../tests/test_build_scripts.py) |

### 4.2 当前构建与验证证据

| 用途 | 链接 |
| --- | --- |
| 完整构建目录 | [XTraceIntegration/](../chromium/src/out/XTraceIntegration/) |
| 实际构建参数 | [args.gn](../chromium/src/out/XTraceIntegration/args.gn) |
| 完整构建证据目录 | [validation/](../chromium/src/out/XTraceIntegration/validation/) |
| 进度清单 | [integration-progress.json](../chromium/src/out/XTraceIntegration/validation/integration-progress.json)；不是验收凭证，接手后更新 |
| 集成测试驱动 | [browser-integration.cjs](../chromium/src/out/XTraceIntegration/validation/browser-integration.cjs) |
| 构建失败日志 | [首轮](../chromium/src/out/XTraceIntegration/validation/chromium-build.log)、[第二轮](../chromium/src/out/XTraceIntegration/validation/chromium-build-02.log)、[第三轮](../chromium/src/out/XTraceIntegration/validation/chromium-build-03.log) |
| 当前构建日志 | [第四轮](../chromium/src/out/XTraceIntegration/validation/chromium-build-04.log) |
| Metal 安装日志 | [metal-toolchain-install.log](../chromium/src/out/XTraceIntegration/validation/metal-toolchain-install.log) |
| 本轮回归日志 | [repository](../chromium/src/out/XTraceIntegration/validation/repository-tests.log)、[launcher](../chromium/src/out/XTraceIntegration/validation/launcher-tests.log)、[GUI](../chromium/src/out/XTraceIntegration/validation/gui-tests.log) |
| 原版 Chrome 驱动自检 | [JSON](../chromium/src/out/XTraceIntegration/validation/browser-run-IzTLTk/)、[reverse + fingerprint](../chromium/src/out/XTraceIntegration/validation/browser-run-3M90bD/)、[business](../chromium/src/out/XTraceIntegration/validation/browser-run-lFbeQ8/) |
| 旧 d8 构建及证据 | [XTraceD8Verify/](../chromium/src/out/XTraceD8Verify/)、[validation/](../chromium/src/out/XTraceD8Verify/validation/) |
| 旧基线版本/补丁/二进制摘要 | [baseline-evidence.json](../chromium/src/out/XTraceD8Verify/validation/baseline-evidence.json) |
| 原始临时验证材料 | [/tmp/xtrace-verify-hpq3yjuu/](/tmp/xtrace-verify-hpq3yjuu/)；可能被系统清理 |

预期浏览器路径为 `chromium/src/out/XTraceIntegration/Chromium.app/Contents/MacOS/Chromium`，**快照时尚不存在**。不要用旧 d8 的 `patched-repo` 物化副本编译整个浏览器，也不要在当前已打补丁源码上重建 `XTraceD8Verify`，以免覆盖未打补丁的 P0 证据。

## 5. 执行任务与依赖

### E1：接管并完成完整构建（最高优先级）

- [ ] 核验两个 HEAD、工作树、Ninja 命令和剩余磁盘；不清理已有补丁与产物。
- [ ] 等当前 Ninja 完成；失败时保存首个错误及相关命令，区分依赖准备、上游工具兼容、补丁 C++/生成代码、链接/打包四类。
- [ ] 对真实问题做最小修复；先复现，不改测试预期掩盖故障。
- [ ] 修复先验证失败的最小目标，再继续完整 `chrome` 目标；不把局部编译通过当作完成。
- [ ] 获得完整构建成功退出码，并确认 app、Framework、资源和启动均正常。

以下命令从项目根目录执行。**只在确认同一输出目录没有运行中的 Ninja 后运行**；采用新的日志文件保留历史。

```bash
ROOT=/Users/luoyy/work/github/GitHub/xtrace
RUN_LOG=$(mktemp "$ROOT/chromium/src/out/XTraceIntegration/validation/chromium-build-next-XXXXXX")
if env -u GOROOT -u GOTOOLDIR \
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  "$ROOT/chromium/src/third_party/ninja/ninja" \
  -C "$ROOT/chromium/src/out/XTraceIntegration" -j 10 chrome \
  > "$RUN_LOG" 2>&1; then
  BUILD_EXIT=0
else
  BUILD_EXIT=$?
fi
printf '%s\n' "$BUILD_EXIT" > "$RUN_LOG.exit-code"
```

应保留当前 debug/component 参数。`symbol_level=0` 是控制体积的选择，不是关闭 renderer 沙箱。若必须更改构建模式，先交架构 review，不能为省时悄悄切换不同基线。

当前 `args.gn`：

```gn
is_debug = true
is_component_build = true
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
treat_warnings_as_errors = false
use_siso = false
use_remoteexec = false
proprietary_codecs = true
ffmpeg_branding = "Chrome"
rtc_use_h264 = true
```

本次直接使用 Chromium 自带 GN/Ninja 和系统 Python，避免尚未初始化的 depot_tools Python shim；`use_remoteexec=false` 是本基线已经接受的参数。不要盲目照抄旧脚本的 `use_reclient` 后忽略 unused-args 错误。

### E2：验证本次产物身份和基本启动（依赖 E1）

- [ ] 记录构建参数、Chromium/V8 SHA、四补丁摘要、app 可执行文件及实际承载代码的 Framework 摘要。
- [ ] 用该 app 的绝对路径启动独立临时 profile，不复用用户日常浏览器资料。
- [ ] 记录 CDP `Browser.getVersion`；必须对应固定 Chromium 151 系列，而不是自检所用 Chrome 153。
- [ ] 检查启动崩溃、组件动态库缺失、资源装载错误及子进程异常。
- [ ] 保留 renderer 沙箱；不得加入 `--no-sandbox`、关闭 web security 或开启公网调试端口。

### E3：运行并审查 12 组浏览器集成（依赖 E2）

```bash
node chromium/src/out/XTraceIntegration/validation/browser-integration.cjs \
  chromium/src/out/XTraceIntegration/Chromium.app/Contents/MacOS/Chromium
```

脚本会启动自己的 loopback 测试服务和隔离 profile，使用 CDP pipe；每次运行创建新的 `browser-run-*` 目录。可在末尾传案例名复测，但最终必须核对完整 12 组，而不是只看某次子集的退出 0。

| 案例 | 验收目的 |
| --- | --- |
| disabled-json | 关闭采集时 JSON 语义正常且不产出 trace |
| disabled-reverse | 关闭采集时 storage、编码、crypto、动态脚本等语义正常 |
| disabled-fingerprint | 关闭采集时 canvas、随机数、基础环境读取正常 |
| disabled-business | 关闭采集时 GET/POST、query、header、body 到达本地服务 |
| json-v1 | 原生 JSON.parse/stringify 事件及 v1 schema |
| causality-v2 | 启动器等价环境变量配置下的同步因果 v2 |
| causality-switch-only | 清除 XTRACE 环境变量后，仅命令行传参是否正确生效 |
| worker-v1 | Worker fetch/Body.text 与 v1 事件 |
| worker-v2 | Worker 路径与 v2 契约 |
| business-v2 | browser 网络事件与业务页的请求材料，使用现有 business-api validator |
| reverse-v1 | 原生采集与 9 类 VMP 相关 API 家族出现；不是证明通用 VMP 还原 |
| fingerprint-v1 | 已明确调用的 canvas、crypto、Navigator、Screen 等入口 |

每个真实运行目录应有 `command.json`、`version.json`、页面结果、截图、CDP 事件和 stdout/stderr；采集开启时还应有 trace、validator 日志、资产 manifest 和实际内容。

额外 review 要求：

- [ ] 12 个名字齐全、无失败，且每个版本与命令都指向本次 app；空集合或跳过失败项不算通过。
- [ ] 页面预期值、实际网络响应、未捕获异常与 renderer crash 分开检查。
- [ ] Worker 事件核对线程/上下文或来源证据，不以主页面同名 `fetch` 充数；现有脚本的聚合 API 断言不单独证明线程归属。
- [ ] 资产长度、SHA-1、manifest 中 source 与内容文件一致；不要只验证文件存在。
- [ ] 检查 v2 是否混入 v1、引用关系是否被 validator 覆盖，以及异常退出是否被误报正常。
- [ ] 检查 Browser.close 后日志；当前只能证明样本关闭后的可用产物，不能证明不存在未知尾部丢失。

脚本是新准备的验证工具，不是已认证的测试框架。`Browser.close` 应答与断连竞态、失败时子进程清理、页面完成等待、API 预期和资产格式都需结合真实运行审查；修驱动错误可以，但必须保留此前失败并解释原因，不能降低产品断言制造通过。

### E4：补验实际 launcher 链路（依赖 E2，可在 E3 后复用产物）

现有 Node 驱动直接启动 Chromium，28 项 launcher 单测也不能代替真实启动，因此单独执行一次 launcher → 本地页面 → 产物 → validator。

在单独终端启动本地测试服务；确认 8765 未被其他服务占用，结束后只关闭本次创建的服务：

```bash
python3 scripts/serve_test_page.py --port 8765
```

另一个终端从项目根目录运行：

```bash
ROOT=/Users/luoyy/work/github/GitHub/xtrace
RUN_DIR=$(mktemp -d "$ROOT/chromium/src/out/XTraceIntegration/validation/launcher-smoke-XXXXXX")
PYTHONPATH="$ROOT/xtrace-launcher" PYTHONDONTWRITEBYTECODE=1 \
  python3 -m xtrace_launcher run \
  --chromium "$ROOT/chromium/src/out/XTraceIntegration/Chromium.app" \
  --url http://127.0.0.1:8765/json-parse-smoke.html \
  --log-dir "$RUN_DIR" \
  --xtrace-causality sync \
  --xtrace-categories reverse,fingerprint \
  --xtrace-capture-values full \
  --xtrace-capture-assets full \
  --extra-arg=--headless=new \
  --capture-seconds 30 \
  > "$RUN_DIR/launcher.log" 2>&1
```

对该目录实际生成的唯一 `trace_*.ndjson` 运行 `scripts/validate_trace.py --schema-version 2 --expect JSON.parse --expect JSON.stringify <实际trace路径>`。保存命令和退出码，不启用 `--inject-api-hooks` 来代替原生能力。

`cli.py:150–167` 的超时路径使用 terminate/kill，且可返回 0；所以 launcher 的 0 退出码不能单独证明浏览器正常退出或日志完整。review 应结合浏览器 stderr、页面/事件和 validator，明确这是现有定时采集路径的验收，不宣称实现了可靠 stop 协议。

### E5：修复入补丁并回归（发生产品代码修复时必做）

- [ ] 每个问题留“复现 → 根因 → 最小修复 → 原断言复测”证据。
- [ ] 不能只改 ignored 的 `chromium/src`；修复应回写到职责对应的受跟踪补丁，并补回归测试。
- [ ] 不将全部已应用修改整体塞入某一补丁，破坏 `0001 → 0003 → 0004 → 0002` 分层。
- [ ] 在独立临时索引/副本重新验证固定基线上的顺序适用性；不得 reset 当前运行树来验证。
- [ ] 回归主项目、launcher、GUI、golden schema；涉及 Blink 生成器时补 bindings 单测和生成 C++ 编译；涉及网页行为时按 Blink 指南补相应运行测试。
- [ ] 重建完整 chrome，并重跑失败案例及相关矩阵；报告实际新增/变更测试数量。

本轮不自动提交或推送，不升级依赖，不修改测试 expectations 隐藏真实行为故障。

### E6：形成验收包并提交架构 review（依赖 E1–E5）

- [ ] 更新本实施文档、设计草稿中的状态及 `integration-progress.json`，消除历史残留表述。
- [ ] 保存构建命令、退出码、版本、最终补丁/二进制摘要和环境修复步骤。
- [ ] 汇总 12 组真实浏览器结果与 launcher 端到端结果，附可点击目录。
- [ ] 列出未覆盖能力、已发现但不属于 P1 的缺口，明确“已验证 / 未验证 / 设计要求”。
- [ ] 总架构师核验原始证据后，才将 P1 标为完成。

## 6. 需要架构师重点纠偏的事项

1. **命令行因果开关转发。** `chrome_content_browser_client.cc:3143–3152` 的 renderer 复制列表缺 `xtrace-causality`。必须先通过 switch-only 案例获得运行证据；不允许靠 launcher 镜像环境变量或把测试改为 v1 掩盖问题。
2. **关闭语义。** `xtrace_host_impl.cc:143–147` 使用 `SKIP_ON_SHUTDOWN`，现有 mojom 无 watermark/ACK。正常退出及 validator 通过不等于“可靠排空已实现”；新停止协议属于 P2/P3。
3. **summary 资产模式。** `xtrace_logger.cc:318–375` 仍可在 manifest/event 附带完整 source。当前矩阵采用 full，不能借此宣称 summary 已验证或具备脱敏保证。
4. **执行层限制。** d8 已证明 `--max-opt=0` 可被显式 Sparkplug 参数覆盖；后续精细模式必须校验真实 tier。当前 P1 不扩成 observer 或全 JIT 覆盖工程。
5. **测试范围。** 聚合 API 名字、单个 profile 名称和逻辑测试绿灯不是所有浏览器行为的证明；特别审查 Worker 来源、网络材料、异常路径和实际产物身份。
6. **已知样本边界。** reverse 页面访问固定 `ws://127.0.0.1:8765/xtrace-smoke`，现有服务器不提供 WebSocket 握手；可能出现预期连接错误，不能宣称 WebSocket 成功通信已验证，也不能吞掉其他网络错误。
7. **补丁与构建效率。** 一次处理同类根因，先最小目标后全量；只在确认版本或工具链不匹配后考虑调整，不每次失败都重跑 sync/清空 out。

## 7. 分工、review 关卡与回报格式

| 关卡 | 执行层提交 | 总架构师 review / 纠偏 |
| --- | --- | --- |
| R1：完整构建 | 最终日志、退出码、app/Framework 路径、版本、修复 diff | 是否确为固定版四补丁，是否靠关闭功能绕过问题，修复能否复现 |
| R2：真实浏览器 | 12 组矩阵、launcher、截图、trace、资产、失败复现 | 测试是否覆盖宣称的行为，是否以原版/旧产物或弱断言冒充成功 |
| R3：P1 冻结 | 补丁顺序复验、回归日志、完整证据包、剩余缺口 | 是否可以进入 P2；区分阻断缺陷与后续架构工作，不提前宣告 P0–P7 完成 |

执行层日常不必每一步等待审批；局部构建/运行缺陷按本文件范围推进。更换基线、关闭沙箱、删改已有 hook、扩大到新采集协议/宿主迁移，先提交影响说明，由架构师 review 并在需要时请用户裁决。

每次回报保持以下结构，不只给“已完成”：

```text
阶段 / 当前进度：
本次变更文件与原因：
实际执行命令、退出码、日志目录：
浏览器与补丁身份：
失败复现和修复后的对照证据：
剩余阻塞 / 未验证边界：
下一步及需要架构师裁决的事项：
```

接管后执行层负责维护本文件的状态表；总架构师基于代码 diff、原始日志和实际产物 review，不以 agent 自述或摘要文件的绿色状态替代验收。

## 8. 完成定义

只有以下条件全部成立，当前“完整 patched Chromium 构建及浏览器集成”目标才完成：

- 固定 Chromium/V8 与四补丁身份可追溯，完整 `chrome` 构建成功且本次 app 实际运行。
- 12 组集成矩阵和实际 launcher 路径均有真实执行证据，必要的驱动缺口已补验；所有失败都有闭环或明确判定为非目标行为的证据。
- 必要修复可通过受跟踪补丁重现，相关回归通过，renderer 沙箱保留。
- 文档、进度清单和原始证据一致，不将原版自检、d8、静态测试或正常退出夸大为完整浏览器能力。
- 剩余 P2–P7 设计工作明确列出，由总架构师完成本阶段 review。

交接不等于完成；目前仍处于 E1，原构建任务继续运行。总架构师不再并行推进新的执行任务，由用户指定的执行层接管后续实施。
