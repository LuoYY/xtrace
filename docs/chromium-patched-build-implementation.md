# Patched Chromium 构建与浏览器集成实施交接

- 文档版本：v0.4（review §5 四项证据补齐完成；P1 经总架构师 R3 核验通过并冻结；后续阶段见 P2 交接文档）。
- 状态快照：2026-09-19 19:05 前后完成执行；构建于当日 18:07:22 成功结束，矩阵与 launcher 验证随后完成；review 补齐 20:01 完成，架构师冻结确认于当日作出。
- 项目根目录：`/Users/luoyy/work/github/GitHub/xtrace`。
- 当前阶段：迁移方案 **P1 已完成并通过 R3 核验冻结（2026-09-19）**；下一阶段 P2（采集与写入基础）按 [chromium-p2-capture-foundation-handoff.md](chromium-p2-capture-foundation-handoff.md) 执行。
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
| XTrace HEAD | `787d13ac80307e280c92bfd09852b6d6aa8c6d6d`，分支 `enhance`；其后仅有文档自身的提交（如 47d6994），不计入基线差异 |
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
| 完整 `chrome` 编译 | **成功** | `chromium-build-04.log` 50640/50640、0 FAILED，18:07:22 结束；增量轮 `chromium-build-next-nvU5ax` 退出码 0（存 `.exit-code`） |
| V05 因果开关转发修复 | **完成** | 首轮矩阵 `causality-switch-only` 失败→定位→补丁 0001 修复→增量重建（退出码 0，日志可见 CXX+SOLINK 2 步）→复测通过（详见 E5） |
| 浏览器集成脚本 | **12/12 通过** | 最终运行 [browser-run-4gDtWa](../chromium/src/out/XTraceIntegration/validation/browser-run-4gDtWa/)；首轮 [browser-run-SLcEOM](../chromium/src/out/XTraceIntegration/validation/browser-run-SLcEOM/) 11/12 |
| 原版 Chrome 脚本自检 | 4 组关闭采集样本通过 | Chrome/153.0.8010.50；只证明测试驱动可用，不算固定版本验收；与 §4.2 三个 browser-run 目录的对账：IzTLTk=disabled-json、3M90bD=disabled-reverse+disabled-fingerprint、lFbeQ8=disabled-business（4 样本分布在 3 个目录，全部 pass、traceRecords=0） |
| E2 产物身份与基本启动 | **通过** | [e2-identity/](../chromium/src/out/XTraceIntegration/validation/e2-identity/)：Chrome/151.0.7917.0、干净退出、无崩溃签名、无沙箱破坏开关 |
| launcher 端到端采集 | **通过** | [launcher-smoke-wTuzvt/](../chromium/src/out/XTraceIntegration/validation/launcher-smoke-wTuzvt/)：validator PASS（schema 2 + JSON.parse/stringify）、5926 条记录、运行时反向断言 0 违禁开关 |
| 最终复现与证据 review | **已通过 R3（2026-09-19 冻结）** | 架构师 review 见 [chromium-p1-architecture-review.md](chromium-p1-architecture-review.md)；`integration-progress.json` 状态 `accepted-p1` |

### 3.1 构建收尾记录（v0.3 更新）

- 第四轮 Ninja（PID 29930）于 **2026-09-19 18:07:22 正常结束**：`chromium-build-04.log` 终态 `[50640/50640]`，`^FAILED` 计数 0（日志中 7 处 `error:` 匹配均为 `webui_js_error` 目标名误匹配）。
- 按本节要求在确认旧 Ninja 结束后执行了正常增量 `chrome` 构建：`chromium-build-next-nvU5ax`，**退出码 0**（"no work to do"），退出码存于同名 `.exit-code` 文件。
- V05 修复后增量重建：`chromium-build-fix1-dkZZLs`，**退出码 0**；日志可见 2 步（`chrome_content_browser_client.o` 重编 + `libchrome_dll.dylib` SOLINK，其余规划步骤被 restat 剪枝、无 bundle 复制——组件构建经 `@rpath` 从 out 根加载该 dylib）。修复生效以运行时证据为准（switch-only 复测 + renderer 命令行实测，见 E4/E5）。
- 产物：`out/XTraceIntegration/Chromium.app`（版本化框架布局 `Versions/151.0.7917.0`；`--version` 输出 `Chromium 151.0.7917.0`；首次启动约 15 秒属全新 bundle 的常规校验开销，非故障）。

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
| 增量确认轮（退出码存档） | [chromium-build-next-nvU5ax](../chromium/src/out/XTraceIntegration/validation/chromium-build-next-nvU5ax)（+ `.exit-code`） |
| V05 修复增量轮 | [chromium-build-fix1-dkZZLs](../chromium/src/out/XTraceIntegration/validation/chromium-build-fix1-dkZZLs)（+ `.exit-code`） |
| E2 身份与启动证据 | [e2-identity/](../chromium/src/out/XTraceIntegration/validation/e2-identity/)（identity.json 含补丁/二进制摘要、HEAD、getVersion） |
| 矩阵最终运行（12/12） | [browser-run-4gDtWa/](../chromium/src/out/XTraceIntegration/validation/browser-run-4gDtWa/) |
| 矩阵首轮（11/12，含 V05 失败证据） | [browser-run-SLcEOM/](../chromium/src/out/XTraceIntegration/validation/browser-run-SLcEOM/) |
| switch-only 修复复测 | [browser-run-hvdHaB/](../chromium/src/out/XTraceIntegration/validation/browser-run-hvdHaB/) |
| launcher 端到端 | [launcher-smoke-wTuzvt/](../chromium/src/out/XTraceIntegration/validation/launcher-smoke-wTuzvt/) |
| E4 反向断言 | [e4-launcher-static-assert.json](../chromium/src/out/XTraceIntegration/validation/e4-launcher-static-assert.json)、运行时抓取见 launcher-smoke 目录 `chromium-commandlines-at-runtime.txt` |
| Metal 安装日志 | [metal-toolchain-install.log](../chromium/src/out/XTraceIntegration/validation/metal-toolchain-install.log) |
| 本轮回归日志 | [repository](../chromium/src/out/XTraceIntegration/validation/repository-tests.log)、[launcher](../chromium/src/out/XTraceIntegration/validation/launcher-tests.log)、[GUI](../chromium/src/out/XTraceIntegration/validation/gui-tests.log) |
| 原版 Chrome 驱动自检 | [JSON](../chromium/src/out/XTraceIntegration/validation/browser-run-IzTLTk/)、[reverse + fingerprint](../chromium/src/out/XTraceIntegration/validation/browser-run-3M90bD/)、[business](../chromium/src/out/XTraceIntegration/validation/browser-run-lFbeQ8/) |
| 旧 d8 构建及证据 | [XTraceD8Verify/](../chromium/src/out/XTraceD8Verify/)、[validation/](../chromium/src/out/XTraceD8Verify/validation/) |
| 旧基线版本/补丁/二进制摘要 | [baseline-evidence.json](../chromium/src/out/XTraceD8Verify/validation/baseline-evidence.json) |
| 原始临时验证材料 | [/tmp/xtrace-verify-hpq3yjuu/](/tmp/xtrace-verify-hpq3yjuu/)；可能被系统清理 |

浏览器路径为 `chromium/src/out/XTraceIntegration/Chromium.app/Contents/MacOS/Chromium`，已于 2026-09-19 18:07 构建产出并通过 E2/E3/E4 验收（版本化框架布局 `Versions/151.0.7917.0`；承载补丁代码的组件 dylib 在 out 根目录，摘要见 `e2-identity/identity.json` 的 `postFixSupplement` 段）。警示仍然有效：不要用旧 d8 的 `patched-repo` 物化副本编译整个浏览器，也不要在当前已打补丁源码上重建 `XTraceD8Verify`，以免覆盖未打补丁的 P0 证据。

## 5. 执行任务与依赖

### E1：接管并完成完整构建（最高优先级）

- [x] 核验两个 HEAD、工作树、Ninja 命令和剩余磁盘；未清理已有补丁与产物（HEAD 与 §2 一致；剩余磁盘约 115 GiB）。
- [x] 等 Ninja 完成：18:07:22 正常结束，50640/50640、`^FAILED` 0（日志中 7 处 `error:` 均为 `webui_js_error` 目标名误匹配）；无依赖/工具链/C++/链接类失败，无需保留失败分类证据。
- [x] 本轮构建无真实失败；后续产品修复（V05）见 E5 的“复现→根因→最小修复→复测”记录。
- [x] 增量 `chrome` 构建获得成功退出码 0：`chromium-build-next-nvU5ax.exit-code`（"no work to do"）。
- [x] app、Framework（版本化布局 `Versions/151.0.7917.0`）、资源与启动均正常：`--version` 输出 `Chromium 151.0.7917.0`；E2 启动验证通过。

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

- [x] 记录构建参数、Chromium/V8 SHA、四补丁摘要、app 可执行文件及 Framework 摘要（[e2-identity/identity.json](../chromium/src/out/XTraceIntegration/validation/e2-identity/identity.json)）。
- [x] 用该 app 绝对路径启动独立临时 profile（`xtrace-e2-profile-*`，不复用日常资料）。
- [x] CDP `Browser.getVersion` = `Chrome/151.0.7917.0`，对应固定 151 系列（自检用的 Chrome 153 仅限驱动自检）。注：`revision` 为全零——本地构建未盖章 LASTCHANGE，非版本异常；git HEAD 以 identity.json 为准。
- [x] 启动无崩溃：stderr 无 `CRASHED`/`dyld: Library not loaded`/`Check failed`/`Fatal error` 签名；干净退出（exit 0）。首次启动约 15 s 属新 bundle 常规校验开销。
- [x] renderer 沙箱保留：启动参数断言不含 `--no-sandbox`/`--disable-web-security`/`--remote-debugging-port`。

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

- [x] 12 个名字齐全、无失败（最终运行 browser-run-4gDtWa 12/12，驱动退出码 0）；每个 `version.json`/`command.json` 指向本次 app。首轮 browser-run-SLcEOM 11/12，`causality-switch-only` 失败即 V05 运行证据，修复后单独复测（browser-run-hvdHaB）并全量重跑；失败证据保留未删。
- [x] 页面预期值（verifyPage 断言）、实际网络响应（`Network.responseReceived` 且状态 200）、未捕获异常（`Runtime.exceptionThrown` = 0）、renderer crash（进程干净退出 exit 0）分开检查。
- [x] Worker 线程来源：驱动新增 per-`pid:tid` API 集合证据（`worker-context.json`）。最终运行 4gDtWa 实测（worker-v1）：`Body.text`=2 与 worker `fetch`=1 落在 pid 46894 / tid 68989929，该 tid 的 API 集合无任何 DOM 入口；同进程主 tid（68989768）只有 DOM 类事件。首轮 SLcEOM 为 43839/68976564 vs 主 tid 68976380，两次结构结论一致。不以主页面同名 `fetch` 充数。
- [x] 资产一致性：驱动逐资产断言 `content_path` 不越界、`size` 与实际一致、内容与 manifest `source` 全等、SHA-1 匹配、`truncated=false`。
- [x] v2 不混 v1：驱动断言每条记录 `schema_version === 2`；引用关系（call_id/parent_id/depth/paired 闭合）由 validator `--schema-version 2` 覆盖；本轮无异常退出被误报（所有案例 exit 0）。
- [x] Browser.close 后日志检查：样本关闭后产物可用；`closeEvidence` 字段明确记录“无 watermark 协议存在”，不宣称未知尾部零丢失。
- [x] 基线数据：驱动已扩展采集 traceRecords/traceBytes/wallClockMs/peakRSSKB（进程树 RSS 按 case 私有 user-data-dir 匹配求和），写入 summary.json；12 组数据已汇总入 `integration-progress.json` baseline_metrics。注意：debug component 构建数据，仅作 §12.2 定标输入，不作 release 性能结论。
- [x] 无无法解释的 renderer crash；未触发符号化重建预案（`blink_symbol_level=1` 预案保留备用）。

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

- [x] 反向断言（静态半）：`e4-launcher-static-assert.py` 直接调用 `build_chromium_command`（E4 同参数、无 `--inject-api-hooks`），断言命令行与环境均无 `--remote-debugging-port`/`--remote-allow-origins`；证据 `e4-launcher-static-assert.json`（12 个 argv，0 违禁）。
- [x] 反向断言（运行时半）：launcher 冒烟运行中抓取 10 条真实进程命令行（`chromium-commandlines-at-runtime.txt`），0 条含违禁开关；5 个 renderer 进程全部携带 `--xtrace-causality=sync`（V05 修复在 launcher 链路同样生效）。
- [x] launcher 退出码 0；唯一 `trace_*.ndjson` 经 `validate_trace.py --schema-version 2 --expect JSON.parse --expect JSON.stringify` 校验 **PASS**（退出码存 `validator.exit-code`），5926 条记录；命令与退出码保存在 [launcher-smoke-wTuzvt/](../chromium/src/out/XTraceIntegration/validation/launcher-smoke-wTuzvt/)。
- [x] 浏览器 stderr 审查：仅本地未签名 debug 构建的常规噪声（quarantine 属性移除、GCM DEPRECATED_ENDPOINT、关停期 waitpid/mach port），无 XTrace 相关错误。按约定明确：这是现有定时采集路径（terminate/kill 可返回 0）的验收，不宣称可靠 stop 协议（P2 范围）。测试服务 8765 用毕即关。

### E5：修复入补丁并回归（发生产品代码修复时必做）

- [x] 复现→根因→最小修复→复测：首轮矩阵 `causality-switch-only` 失败（trace 全为 `schema_version:1`，我的新断言 "v1 record mixed into v2 trace" 捕获）；根因 = `ChromeContentBrowserClient::AppendExtraCommandLineSwitches` 的 renderer 复制列表缺 `xtrace-causality`（设计稿 V05 已登记的缺口，本次获得运行证据）；最小修复 = 该列表加一行 `"xtrace-causality",`；复测通过（6645 条记录、schema 2）。
- [x] 修复回写受跟踪补丁 `patches/0001-xtrace-native-logger.patch`（该 hunk 行数 13→14），并在 `tests/test_build_scripts.py` 的既有测试中补回归断言（钉住列表相邻行 `"xtrace-categories",\n        "xtrace-causality",\n        "xtrace-enable",`，避免被浏览器侧同名常量误通过）。
- [x] 修复落在职责对应的 0001（该文件/hunk 本就由 0001 引入），未触碰其他补丁，分层不变。
- [x] 独立临时索引（`GIT_INDEX_FILE` 指向 /tmp 索引、从两树 HEAD `read-tree`）复验顺序适用性：0001→0003→0004（Chromium）与 0002（V8）全部 `apply --cached --check` + `apply --cached` 干净通过；未 reset 运行树。
- [x] 回归：主项目 338/338（含新断言与 golden fixture）、launcher 28/28、GUI 211/211，全绿；未涉及 Blink 生成器与网页行为 expectations。
- [x] 重建完整 chrome（增量退出码 0；日志可见 CXX+SOLINK 2 步，其余规划步骤被 restat 剪枝），重跑失败案例（通过）及完整 12 组矩阵（12/12）；测试数量变化：0 新增测试方法（1 个既有方法内新增断言）。

本轮不自动提交或推送，不升级依赖，不修改测试 expectations 隐藏真实行为故障。

### E6：形成验收包并提交架构 review（依赖 E1–E5）

- [x] 本实施文档（v0.3）、设计草稿状态（§2.3/§15）及 `integration-progress.json` 已更新，历史残留表述已消除（构建"进行中"等）。
- [x] 构建命令、退出码、版本、补丁/二进制摘要和环境修复步骤：`integration-progress.json`（attempts/product_fixes/e2_identity）+ `e2-identity/identity.json` + 各 `.exit-code` 文件。
- [x] 12 组结果（browser-run-4gDtWa）与 launcher 端到端（launcher-smoke-wTuzvt）已汇总，可点击目录见 §4.2。
- [x] 12 组基线数据入验收包（`integration-progress.json` baseline_metrics；debug 构建，仅作 §12.2 定标输入）。
- [x] 文档勘误完成：`docs/chromium-build.md` arm64 hook 表述已改为"当前补丁中 6 个汇编调用点全部活跃且无开关，旧'已禁用'状态不存在"；§3 自检对账已写入（IzTLTk=disabled-json、3M90bD=disabled-reverse+disabled-fingerprint、lFbeQ8=disabled-business，4 样本 3 目录、全 pass、traceRecords=0）。
- [x] 缺口清单见下方 E6.1；含迁移草稿 v0.4 全部新登记项。
- [ ] 总架构师核验原始证据后，才将 P1 标为完成（本文件不自行宣告）。

#### E6.1 P1 剩余缺口清单（已验证 / 未验证 / 设计要求）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 四补丁构建 + 12 组矩阵 + launcher 链路 | 已验证 | 本轮证据；fixed 151.0.7917.0 |
| V05 因果开关命令行转发 | 已验证（已修复） | 补丁 0001 修复并复测；设计稿 V05 条目同步更新 |
| 可靠 stop / 排空协议 | 未验证（设计要求 P2/P3） | `SKIP_ON_SHUTDOWN`、mojom 无 watermark/ACK；本轮仅证明样本关闭后产物可用，不证明零尾部丢失 |
| summary 资产模式脱敏 | 未验证（设计要求） | `xtrace_logger.cc:318–375` full 条件外仍附完整 source；矩阵全部采用 full，不宣称 summary 已验证 |
| browser-network 私有写入并轨（`g_xtrace_browser_network_sequence`、逐事件 `AppendToFile`） | 未验证（设计要求 P2） | producer 完整清单与计数守恒归 P2 |
| §6.6 旧缺陷逐条收口（result/error 恒空、裸 seq、truncation 双形态、frame_url/origin 恒空、限额不生效、validator 仅查存在） | 未验证（设计要求 P2，schema v3） | 本轮 v1/v2 契约按现状验收 |
| code cache warm profile 字节码元数据 | 未验证（设计要求 P4 冻结点） | 本轮不含 warm profile 场景 |
| 证据索引存储决策（SQLite/文件、与 LedgerBackend 关系、重建流程） | 设计要求（P6 启动前冻结） | 本轮只读原始产物，未建索引 |
| 指纹伪装层 | 显式暂缓 P7 | 首期只记录不改值；本轮 fingerprint-v1 仅验证采集 |
| 完整环境管理器 | 显式暂缓 P7 | 首期最小 env 集 P6 |
| release 构建性能基线 | 未验证 | 本轮为 debug component 构建；release 数据须 `scripts/build_xtrace_release.sh` 另测（草稿 §12.3） |
| 原版 Chrome/153 自检 | 已验证（仅驱动可用性） | 不计入 patched 浏览器验收 |
| WebSocket 通信 | 边界披露 | reverse 页访问 `ws://127.0.0.1:8765/xtrace-smoke`，测试服务无 WS 握手，出现预期连接错误；未宣称 WS 验证 |
| 66 工具迁移 | 未开始（前置清单已完成） | 见 [tool-inventory.md](tool-inventory.md)；P6 按清单冻结首批 |

### E7：（可并行，纯文档）66 工具逐项能力清单

只读任务，不修改任何代码、不启动浏览器，可在构建等待期间进行；随时可中断，不与“P1 不扩成 P2–P7 实施”冲突——这是清单编制，不是工具迁移。

- [x] 阅读 Firefox-Reverse 的 `additions/browser/components/agent-sidebar/modules/Tools.sys.mjs` 及关联模块，产出 66 项工具逐项清单：名称、目标分组（A 证据只读 / B 实验控制 / C 页面调试 / D 宿主执行）、依赖的后端或特权 API、迁移状态预判（完整/部分/不可用及原因）。
- [x] 产出落在 `docs/tool-inventory.md`（分组统计 A 13 / B 22 / C 16 / D 15，含 P6 首批冻结建议与 4 项不可用工具的 P7 依赖说明），作为 P6 前置交付物；P6 启动时按此清单冻结首批 A 组工具范围。

## 6. 需要架构师重点纠偏的事项

1. **命令行因果开关转发（已闭环）。** `chrome_content_browser_client.cc:3143–3152` 的 renderer 复制列表缺 `xtrace-causality`——switch-only 案例已获得运行证据（首轮失败，v1 记录混入），随后在补丁 0001 内最小修复、干净索引复验、增量重建、复测与全量矩阵通过；未靠 launcher 镜像环境变量或改回 v1 掩盖问题。launcher 链路实测 renderer 进程携带 `--xtrace-causality=sync`。
2. **关闭语义。** `xtrace_host_impl.cc:143–147` 使用 `SKIP_ON_SHUTDOWN`，现有 mojom 无 watermark/ACK。正常退出及 validator 通过不等于“可靠排空已实现”；新停止协议属于 P2/P3。
3. **summary 资产模式。** `xtrace_logger.cc:318–375` 仍可在 manifest/event 附带完整 source。当前矩阵采用 full，不能借此宣称 summary 已验证或具备脱敏保证。
4. **执行层限制。** d8 已证明 `--max-opt=0` 可被显式 Sparkplug 参数覆盖；后续精细模式必须校验真实 tier。当前 P1 不扩成 observer 或全 JIT 覆盖工程。
5. **测试范围。** 聚合 API 名字、单个 profile 名称和逻辑测试绿灯不是所有浏览器行为的证明；特别审查 Worker 来源、网络材料、异常路径和实际产物身份。
6. **已知样本边界。** reverse 页面访问固定 `ws://127.0.0.1:8765/xtrace-smoke`，现有服务器不提供 WebSocket 握手；可能出现预期连接错误，不能宣称 WebSocket 成功通信已验证，也不能吞掉其他网络错误。
7. **补丁与构建效率。** 一次处理同类根因，先最小目标后全量；只在确认版本或工具链不匹配后考虑调整，不每次失败都重跑 sync/清空 out。
8. **基线与诊断。** 12 组矩阵同时承担性能基线采集（事件数/字节/墙钟/RSS），漏采则 P2 性能目标无从定标；renderer 崩溃按 E3 的符号化预案重建复现，不在无符号条件下猜修补丁。

## 7. 分工、review 关卡与回报格式

| 关卡 | 执行层提交 | 总架构师 review / 纠偏 |
| --- | --- | --- |
| R1：完整构建 | 最终日志、退出码、app/Framework 路径、版本、修复 diff | 是否确为固定版四补丁，是否靠关闭功能绕过问题，修复能否复现 |
| R2：真实浏览器 | 12 组矩阵、launcher、截图、trace、资产、失败复现 | 测试是否覆盖宣称的行为，是否以原版/旧产物或弱断言冒充成功 |
| R3：P1 冻结 | 补丁顺序复验、回归日志、完整证据包、剩余缺口 | 是否可以进入 P2；区分阻断缺陷与后续架构工作，不提前宣告 P0–P7 完成 |

执行层日常不必每一步等待审批；局部构建/运行缺陷按本文件范围推进。更换基线、关闭沙箱、删改已有 hook、扩大到新采集协议/宿主迁移，先提交影响说明，由架构师 review 并在需要时请用户裁决。

**本轮 R1–R3 审查结论见 [P1 架构 review](chromium-p1-architecture-review.md)（2026-09-19）：实质通过、附条件冻结——先完成该文档第 5 节的 4 项证据补齐，再由架构师确认 P1 完成。**

**Review §5 补齐执行记录（执行层，2026-09-19 20:01 完成）：**

- 5.1+5.2 已完成：`e2-identity/identity.json` 追加 `postFixSupplement` 段——修复后四补丁 SHA-256（0001=`76ce5768…`，原顶层 `patchSha256` 保留并注明为 18:12 修复前旧值）+ out 根 6 个组件 dylib（`libchrome_dll`/`libv8`/`libcontent`/`libblink_core`/`libblink_platform`/`libblink_modules`）SHA-256，含完整时间线；`integration-progress.json` 同步引用。
- 5.3 已完成：`integration-progress.json` 状态改为 `p1-evidence-complete-pending-r3`（accepted 由架构师确认后改）。
- 5.4 已完成：§4.2 浏览器路径行改为现状描述，保留 patched-repo/XTraceD8Verify 警示。
- 建议 1/2/3 一并执行：§3.1、§3 表与 E5 的 fix1 表述改为"日志可见 2 步（CXX+SOLINK）、退出码 0、生效以运行时证据为准"；E3 Worker 证据改引最终运行 4gDtWa 数值（46894/68989929，主 tid 68989768）并注明首轮出处；三份回归日志已用修复后运行覆盖存档（20:01：338 OK / 28 OK / 211 pass）。
- 建议 4（`.zcodeignore` 是否移 `.git/info/exclude`）留维护者裁决；建议 5 无需行动。

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

- [x] 固定 Chromium/V8 与四补丁身份可追溯（e2-identity 摘要 + HEAD），完整 `chrome` 构建成功（退出码 0 存档）且本次 app 实际运行（E2 + 矩阵 + launcher）。
- [x] 12 组集成矩阵（12/12）和实际 launcher 路径均有真实执行证据；唯一失败（causality-switch-only=V05）已闭环修复并全量重跑通过；WebSocket 预期连接错误已判为非目标行为并披露。
- [x] 必要修复（V05）已回写受跟踪补丁 0001 并经干净索引顺序复验；回归 338/28/211 全绿；renderer 沙箱全程保留。
- [x] 12 组基线数据已记录（integration-progress.json baseline_metrics，debug 构建口径已注明）；`docs/chromium-build.md` 勘误与自检对账完成。
- [x] 文档、进度清单和原始证据一致；原版自检、d8、静态测试均按其边界表述，未夸大为完整浏览器能力。
- [x] 剩余 P2–P7 设计工作已在 E6.1 缺口清单明确列出，待总架构师 R3 review 后将 P1 标为完成。

执行层 E1–E7 已全部执行完毕（2026-09-19）；review §5 四项证据补齐于同日完成并经架构师核验。**P1 于 2026-09-19 通过 R3 核验并冻结**；本文件为验收包入口，原始证据目录见 §4.2，后续阶段见 [P2 交接文档](chromium-p2-capture-foundation-handoff.md)。
