# XTrace 项目梳理报告——增强版 Chromium 的生成链路

> 分析日期:2026-08-27
> 分析对象:本仓库(`xtrace`)全部脚本、4 个补丁文件、launcher/GUI 消费端与文档
> 核心问题:**项目是如何生成一个"增强版 Chromium"的?**

---

## 1. 项目定位与核心思路

XTrace 是一套**内建于打过补丁的 Chromium/V8 中的原生运行时追踪工具**,面向 JavaScript 虚拟机保护(JSVMP)与重度混淆代码的分析:正常加载一个页面(无需断点、无需改目标源码),即可产出一份结构化的 **schema v1 NDJSON** 日志,记录被保护代码实际执行的 API 调用、调用栈、参数值、加密材料与 JSVMP hook 家族命中。

**生成增强版 Chromium 的核心思路是"补丁 + 构建脚本",而非 fork 分发:**

- 仓库中只包含 **4 个 patch 文件(共约 26,939 行)** 与构建脚本;
- `chromium/`(完整 Chromium 检出)与 `depot_tools/` 均被 gitignore,**只在本机生成**;
- 用户在本机执行四步流水线:拉取固定 revision 的官方源码 → 打补丁 → GN 配置 → ninja 编译,得到 `chromium/src/out/XTrace/Chromium.app`。

这样做的直接收益:仓库体积极小(不含 Chromium 树)、补丁可审查、可对齐到精确的上游 revision、增强点全部落在本地构建产物上。

---

## 2. 总体架构

增强版浏览器内部的事件数据通路:

```
              ┌──────────────────────────────────────────────────────┐
              │        增强版 Chromium.app(本机由 patches/ 构建)        │
              │                                                        │
              │   渲染进程(沙箱保持开启)             浏览器进程          │
              │   ┌────────────────────────┐          ┌────────────┐ │
   任意页面 ──▶│   │ Blink API 插桩(0001)      │──Mojo──▶ │ XTraceHost │ │──▶ trace.ndjson
              │   │ V8 hooks(0002)           │  IPC     │ 持有文件句柄│ │    + assets/
              │   │ 因果栈(0003)              │          │ 盖 global_seq│ │     manifest
              │   └────────────────────────┘          └────────────┘ │
              │            ▲                                     ▲      │
              │            └── event_logger 通道(字符串编码事件)      ──┘   │
              │                浏览器网络栈插桩(0001/0004)直接在浏览器进程落盘  │
              └──────────────────────────────────────────────────────┘
                                              │
              xtrace-launcher(Python CLI)  ┌───┴────────────┐
              xtrace-gui(Electron 工作台)   │ 校验·分析·对比 │
                                          └────────────────┘
```

三个关键架构决策:

1. **渲染器沙箱不关**:渲染进程不直接写文件,事件经 `blink.mojom.XTraceHost`(Mojo IPC)传出,由**浏览器进程**持有 trace 文件句柄负责落盘。
2. **V8 与 Blink 通过 event_logger 通道解耦**:V8 侧(独立 git 树、独立补丁)不依赖任何 Blink 头文件,只通过 V8 既有的 `isolate->event_logger()` 回调以字符串前缀事件输出,由 Blink 侧注册的回调解析归类。
3. **插桩常驻、运行期配置**:浏览器二进制内只有 instrumentation,是否记录、记录多少(categories / values / assets / causality)全部由启动时的命令行开关或环境变量决定。

---

## 3. 生成流水线详解(四步)

### 3.1 第一步:`scripts/bootstrap_chromium.sh` —— 拉取固定版本源码

- 克隆 `depot_tools` 到 `./depot_tools`(已存在则 `git pull --ff-only`);
- `fetch --nohooks chromium` 检出到 `./chromium/src`;
- **钉死 revision**:`73088b4e50b1dc69eaa0bdb14a8e4592813174fd`(补丁只对该精确版本干净应用;可用环境变量 `CHROMIUM_REVISION` 覆盖);
  该 commit 对应 **Chromium 151.0.7917.0**,main 分支 tip,提交日期 2026-06-27(`Cr-Commit-Position refs/heads/main@{#1653617}`),与设计文档 `2026-06-27-chromium-xtrace-design.md` 同日——即"设计当天锁定的 main HEAD";
- `git checkout --detach <rev>` → `gclient sync -D --revision src@<rev>` → `gclient runhooks`。
  V8 位于 `chromium/src/v8`,由 `gclient sync` 按 DEPS 同步到匹配版本——它是**独立的 git checkout**,这一点决定了后面补丁要分两棵树应用。

### 3.2 第二步:`scripts/apply_patches.sh` —— 打补丁

补丁与目标树的对应关系:

| 补丁 | 行数 | 目标树 | 内容 |
|------|------|--------|------|
| `0001-xtrace-native-logger.patch` | 13,229 | `chromium/src` | Blink / chrome / content 原生日志通路 |
| `0002-xtrace-v8-vmp-hooks.patch` | 13,232 | `chromium/src/v8` | V8 内建函数 / runtime JSVMP hooks |
| `0003-xtrace-schema-v2-renderer.patch` | 412 | `chromium/src` | 渲染器同步因果身份(opt-in) |
| `0004-xtrace-schema-v2-browser.patch` | 66 | `chromium/src` | 浏览器网络事件 external 因果标记 |

脚本对每个补丁做 **preflight 三态检测**:

1. `git apply --check` 通过 → 正常应用(`apply`);
2. `git apply --reverse --check` 通过 → 说明**已经打过**,跳过(`applied`),保证脚本可重复执行;
3. 两者都不行 → 退到 `git apply --3way` 三方合并(`merge`);再失败则报错退出。

应用顺序:0001(native)→ 0003(因果-渲染器)→ 0004(因果-浏览器)→ 0002(V8,单独树)。脚本会先验证 `chromium/src` 与 `chromium/src/v8` 都是 standalone git checkout。

### 3.3 第三步:`scripts/gn_gen_xtrace.sh` —— GN 配置

输出目录 `out/XTrace`,GN 参数:

```gn
is_debug=true
is_component_build=true     # 组件化:改一个编译单元只需重链 dylib,迭代补丁快
symbol_level=1
blink_symbol_level=1
treat_warnings_as_errors=false
use_siso=false
use_reclient=false          # 不依赖分布式编译,本机可复现
proprietary_codecs=true     # 打开常见视频编解码,媒体重的站点才能真实渲染
ffmpeg_branding="Chrome"
rtc_use_h264=true
```

脚本细节:优先把 `depot_tools/python-bin` 放进 `PATH`(要求 Python ≥ 3.10)、`unset GOROOT GOTOOLDIR`、若 `xcodebuild` 不可用且存在完整 Xcode 则自动设置 `DEVELOPER_DIR`。

### 3.4 第四步:`scripts/build_chromium.sh` —— 编译

标准 `ninja -C out/XTrace chrome`,产出 **`chromium/src/out/XTrace/Chromium.app`**(支持 `NINJA_BIN` 环境变量覆盖 ninja 路径)。

**前置条件**(见 `docs/chromium-build.md`):macOS + 完整 Xcode(Command Line Tools 不够,Metal 工具链需要)、约 **100 GB** 空闲磁盘、干净构建约数小时(参考机器 ~5h,增量重建为秒到分钟级);可能需要一次性 `xcodebuild -downloadComponent MetalToolchain`。

---

## 4. 四个补丁深度解析(增强的本质)

### 4.1 `0001` 原生日志器——Blink 与浏览器进程的数据通路

**新增的核心文件(补丁内为 new file):**

| 文件 | 角色 |
|------|------|
| `third_party/blink/public/mojom/xtrace/xtrace.mojom` | 定义 `blink.mojom.XTraceHost` 接口:`Log(string)` / `LogBatch(array<string>)` / `LogAsset(string, string, string)` |
| `third_party/blink/renderer/platform/xtrace/xtrace_logger.{h,cc}` | 渲染器侧静态 logger(实现约 580 行),全部插桩点的统一入口 |
| `content/browser/xtrace/xtrace_host_impl.{h,cc}` | 浏览器进程侧接收端(约 300 行),持有文件句柄、落盘 |

**渲染器侧 `XTraceLogger` 的职责:**

- 配置读取:命令行开关优先(`--xtrace-enable` / `--xtrace-file` / `--xtrace-categories` / `--xtrace-capture-values` / `--xtrace-capture-assets`),否则回退环境变量(`XTRACE_ENABLE` / `XTRACE_FILE` / …);默认 `categories=reverse,fingerprint`、`capture_values=full`、`capture_assets=full`;`enabled` 由"能否解析出 trace 文件路径"决定;
- 每次调用生成 `session_id`(`<pid>-<wall_time_us>`,进程级缓存)与原子递增的 `seq`;
- **调用栈捕获**:`v8::StackTrace::CurrentStackTrace(isolate, 16, kDetailed)`,逐帧序列化 function / url / line / column / script_id / is_eval / is_constructor;
- 值引用:`Sha1Ref()` 对大值生成 `"sha1:<hex>"` 引用而非全文;
- 资产去重:thread-local 已发送集合,同一资产(如脚本源码)只发一次;
- 事件在渲染器内**预先序列化成完整 NDJSON 行**再过 Mojo(浏览器进程不做 JSON 重构,只做序号戳记与追加写)。
- 说明:Mojo 接口里的 `LogBatch` 已实现于浏览器侧,但渲染器当前**逐条 `Log` 发送**(`LogBatch` 为预留,补丁内有注释说明)。

**浏览器进程侧 `XTraceHostImpl`:**

- 由 `RenderProcessHostImpl::RegisterMojoInterfaces()` 注册(receiver 绑定到 `XTraceHostImpl::Create`),每个渲染进程都可连;
- 跑在专用序列化线程池(`MayBlock` + `SKIP_ON_SHUTDOWN` + `USER_VISIBLE`),避免阻塞 UI 线程、也不因关机丢尾部事件;
- `StampGlobalSequenceForWrite()`:用一个手写的轻量 JSON 顶层键扫描器(逐字符括号/字符串状态机)检查是否已有 `global_seq`,没有则在对象末尾插入——**跨进程的全局单调序号**在落盘前盖 here;
- 资产落盘:渲染器发来的 `LogAsset(content_path, manifest_json, content)` 经 `IsSafeRelativeContentPath()` 防路径穿越校验后,内容写入 `logs/assets/<trace_stem>/` 下,清单追加到 `manifest.ndjson`。

**Blink 插桩面(约 100 个文件,全部改为调用 `XTraceLogger::Log*` 静态函数):**

- 网络/fetch:`fetch/`(body、global_fetch、headers、request、response)、`xmlhttprequest`;
- 加密:`crypto/`(crypto、subtle_crypto、crypto_result_impl)——捕获 SubtleCrypto 的明文输入与输出;
- 编解码:`encoding/`(text_encoder、text_decoder);
- 存储:`storage_area`(localStorage)、`indexeddb/`(factory/database/objectstore/cursor/index/request)、`cookie_store`;
- 指纹面:`canvas/`(html_canvas_element、base_rendering_context_2d)、`webgl/`、`webaudio/`(audio_context、analyser_node、audio_buffer、offline_audio_context)、`navigator*`(含 ua_data、device_memory、language、concurrent_hardware)、`screen`、`plugins/`、`mediastream`、`netinfo`、`peerconnection`;
- 并发/消息:`workers/`(dedicated/shared)、`messaging/`(message_port/channel)、`broadcastchannel`、`service_worker/`(container/clients/fetch_event 等);
- 脚本:`script/`(classic_script、js_module_script、dynamic_module_resolver)、`html_script_element`、v8_script_runner 中的 evaluate 记录;
- 其它:`dom_timer`(反调试计时)、`performance`、`dom_url`/`url_search_params`、`form_data`、`speech_synthesis`、`permissions`、`location`。

**浏览器进程网络插桩**(同样在 0001 中):`chrome/browser/chrome_content_browser_client.cc` 包装 URLLoader / URLLoaderClient,直接在浏览器进程记录请求/响应头与 body(`browser-network:` 前缀的 event_id),支持 `--xtrace-max-body-bytes` / `--xtrace-max-header-value-bytes` / `--xtrace-capture-response-body` 限额。

**与 V8 的握手(本补丁最关键的一处):** `v8_initializer.cc` 在主线程 isolate 初始化时:

```cpp
isolate->SetData(kXTraceEmbedderDataSlot /*=3*/,
                 reinterpret_cast<void*>(0x5854524143450ULL));  // ASCII "XTRACE"
isolate->SetEventLogger(XTraceV8EventLogger);
```

`XTraceV8EventLogger` 按字符串前缀分流三类 V8 事件:

- `xtrace:vmp-runtime:` → 解析出 `API:JSON`,归入 `reverse` 类别(以 `.get` 结尾的 API 记 phase=`get`);
- `xtrace:dynamic-code:` → eval / Function 动态代码,连带源码文本走资产通道;
- `xtrace:fingerprint:` → Intl.DateTimeFormat 等指纹事件,归入 `fingerprint` 类别。

### 4.2 `0002` V8 JSVMP hooks——三层插桩汇入一个出口

V8 是独立 git 树,补丁触及约 120 个文件。**所有插桩最终汇入同一个出口**:

```cpp
isolate->event_logger()(("xtrace:vmp-runtime:" + api + ":" + args_json).c_str(),
                        v8::LogEventStatus::kLog);
```

**三层插桩手段:**

1. **Torque 层(约 100 个 `.tq` 文件)**:在 `src/builtins/base.tq` 声明
   `extern runtime XTraceVmpRuntime(Context, String, String, JSAny, JSAny, JSAny, JSAny): JSAny;`
   之后在 Array/String/TypedArray/Promise/RegExp/DataView/Reflect/Object/Proxy 等 Torque 内建中直接调用
   `XTraceVmpRuntime(context, 'API名', 'shape名', 实参…)`;
2. **CSA 层(`builtins-*-gen.cc`)**:`CallRuntime(Runtime::kXTraceVmpRuntime, …)` 的内联 lambda(如 ArrayPrototypePop);
3. **arm64 汇编层(`builtins-arm64.cc`)**:手写汇编 trampoline `XTraceLogArm64DispatchBuiltin` / `XTraceLogArm64DispatchResultBuiltin`——内部 `FrameScope(INTERNAL)` 建栈帧、`SmiTag(x0)` 保证 GC 安全、`UseScratchRegisterScope` 排除被观察寄存器、压入 `(code_id, subject, value1..4)` 后 `CallRuntime(Runtime::kXTraceVmpRuntimeDispatch)`。用于 `Function.prototype.call/apply`、`Reflect.apply/construct` 等**动态派发点**(code 1=Reflect.apply,2=Function.prototype.call,3=Function.prototype.apply,4=Reflect.construct)。

**新增的三个 runtime 函数**(注册于 `src/runtime/runtime.h`):

| 函数 | 签名 | 用途 |
|------|------|------|
| `Runtime_XTraceVmpRuntime` | F(…, 6, 1) | Torque/CSA 通用入口(api、shape、subject、value1..3) |
| `Runtime_XTraceVmpRuntimeDispatch` | F(…, 6, 1) | 汇编层派发点入口(code + 5 个值) |
| `Runtime_XTraceVmpRuntimeDispatchResult` | F(…, 2, 1) | 派发返回值记录,与 pending source 配对 |

**启用门闸(`XTraceVmpRuntimeLoggingEnabled`)**——必须同时满足:

1. `isolate->event_logger()` 非空(即 Blink 侧 0001 已注册回调);
2. embedder data slot 3 == `0x5854524143450` 标记(即 0001 设置的 "XTRACE" 暗号);
3. `!isolate->serializer_enabled()`(snapshot 序列化期间不记录)。

这就是两个补丁之间的**协议**:0002 不知道 Blink 的存在,只认 event_logger + 暗号;因此 V8 补丁可以独立于 Chromium 补丁审查与测试。

**数据流溯源(provenance)机制:** 派发点 runtime 函数用 `XTraceCompactRef()` 生成紧凑值引用,`XTraceRememberValueSource()` / `XTraceRememberPendingDispatchSource()` 记录"寄存器来源 / handler 返回值"的引用链(`handler_arg:` / `register:` / `handler_return:` 前缀),使**派发结果能关联回输入**,支撑后续的输入→运算→输出分析。

**WASM 边界(`src/wasm/wasm-js.cc`)**:在 `WebAssembly.compile / compileStreaming / Module / Instance / instantiate / instantiateStreaming / Memory` 的 JS-API 入口加纯 C++ 回调 `XTraceWasmBoundary`(记录 argc 与字节长度,使 WASM 签名器可见),同样走 event_logger 通道。

**覆盖的九个 JSVMP hook 家族:**
`base64` · `text_codec` · `byte_buffer` · `dynamic_dispatch` · `proxy_trap` · `hash_crypto` · `int_bitwise` · `anti_debug_timing` · `source_probe`
(Proxy 陷阱经由 `proxy-*.tq` 的 hook;字符串/数组/TypedArray 家族经由对应 builtins。)

### 4.3 `0003` 渲染器因果身份(schema v2,opt-in)

- 在 `v8_script_runner.cc` 的 `CompileAndRunScript`(经典脚本)与 `EvaluateModule`(模块脚本)外包裹 RAII 对象 **`XTraceActivationScope`**;
- 该 scope 维护渲染器线程内的因果栈:进入 evaluate 时压栈并分配 `call_id`,栈内发生的所有事件自动带 `parent_id`(父即当前脚本 evaluate)与 `depth`;
- 脚本结束时按 `ScriptEvaluationResult::ResultType` 映射终止 phase(`kSuccess/kNotRun` → `return`,`kException/kAborted` → `exception`),形成**成对 call/return**;
- 由 `--xtrace-causality=sync`(或 `XTRACE_CAUSALITY=sync`)开启,默认 `off`;开启时完整保留 schema v1 字段。

### 4.4 `0004` 浏览器进程 external 标记(schema v2)

小补丁(66 行):当 causality=sync 时,给浏览器网络事件(`CreateXTraceBrowserNetwork*Json` 三个构造器)统一附加:

```json
{"schema_version": 2, "call_id": null, "parent_id": null, "depth": 0,
 "causality_kind": "external", "duration_us": null}
```

即:网络边界事件不属于任何渲染器因果链,显式标记为 `external`,避免与渲染器内同步因果混淆。

---

## 5. 端到端事件数据流

以一次 `crypto.subtle.sign` 调用为例的完整旅程:

```
页面 JS 调 subtle.sign(key, data)
  └─ Blink 插桩(0001: subtle_crypto.cc)
       └─ XTraceLogger::LogCall("reverse", "SubtleCrypto.sign", args_json)
            ├─ 读配置(开关/env)· 类别过滤(reverse)
            ├─ CaptureJavaScriptStack() 抓 16 帧栈
            ├─ 拼装 NDJSON 行(event_id/session_id/seq/t/api/args/stack/pid/tid/…)
            └─ mojo::Remote<blink::mojom::XTraceHost>→Log(line)
                 └─ [Mojo IPC,渲染器沙箱内]
                      └─ 浏览器进程 XTraceHostImpl::Log(0001)
                           ├─ StampGlobalSequenceForWrite() 盖 global_seq
                           └─ 追加写 trace.ndjson
```

V8 内建函数(如 `String.prototype.charCodeAt`)则是:

```
Torque .tq → XTraceVmpRuntime(...) → Runtime_XTraceVmpRuntime(0002)
  └─ 门闸(event_logger + "XTRACE" 暗号 + 非 snapshot)
       └─ isolate->event_logger()("xtrace:vmp-runtime:API:JSON", kLog)
            └─ Blink XTraceV8EventLogger(0001: v8_initializer.cc)按前缀解析
                 └─ XTraceLogger::LogEventNoStack("reverse", …) →(同上通路)
```

**Schema v1 字段**(详见 `docs/trace-schema-v1.md`):

- 兼容字段:`t`、`api`、`args`、`stack`、`pid`、`tid`;
- 扩展字段:`event_id`、`session_id`、`seq`、`wall_time_us`、`mono_time_us`、`category`、`phase`、`frame_url`、`origin`、`result`、`error`、`truncated`;
- 落盘前追加:`global_seq`(浏览器进程跨进程单调);
- schema v2(opt-in)追加:`call_id`、`parent_id`、`depth`、`causality_kind`、`duration_us`。

---

## 6. 运行期配置面(增强版的"开关面板")

增强只装了仪表,开机与否由启动参数决定。命令行开关与环境变量**双通道等价**(渲染器、浏览器进程各自读取;开关优先于环境变量):

| 配置 | 开关 | 环境变量 | 取值(默认) |
|------|------|----------|--------------|
| 启用 + 输出路径 | `--xtrace-enable` + `--xtrace-file=<path>` | `XTRACE_ENABLE=1` + `XTRACE_FILE=<path>` | 未设置即关闭 |
| 类别 | `--xtrace-categories` | `XTRACE_CATEGORIES` | `reverse,fingerprint`(支持 `all`) |
| 值捕获 | `--xtrace-capture-values` | `XTRACE_CAPTURE_VALUES` | `full` / `summary` / `args-only` |
| 资产捕获 | `--xtrace-capture-assets` | `XTRACE_CAPTURE_ASSETS` | `full` / `summary` / `off` |
| 因果 schema | `--xtrace-causality` | `XTRACE_CAUSALITY` | `off` / `sync` |
| 响应体捕获 | `--xtrace-capture-response-body` | `XTRACE_CAPTURE_RESPONSE_BODY` | 0/1 |
| body 上限 | `--xtrace-max-body-bytes` | `XTRACE_MAX_BODY_BYTES` | — |
| 头值上限 | `--xtrace-max-header-value-bytes` | `XTRACE_MAX_HEADER_VALUE_BYTES` | — |

> 隐私注意:默认 `full` 保真捕获,请求头/Cookie/令牌/请求体可能明文出现在 trace 中;`logs/` 已 gitignore,原始 NDJSON 未经审阅勿外发。

---

## 7. 消费生态(增强版浏览器的使用方)

| 组件 | 技术 | 作用 |
|------|------|------|
| `xtrace-launcher/` | Python 3.10+(仅标准库) | CLI:`run` 子命令启动增强 Chromium 并传全量开关/env,定时捕获,可选 `--validate-after-exit`;`validate` 子命令按 profile(默认 `generic-vmp` + `--strict-capture`)严格校验 |
| `xtrace-gui/` | Electron | 图形工作台:选浏览器/URL/日志目录,启停捕获,列出 NDJSON,按 category/API 实时过滤(live-tail) |
| `scripts/validate_trace.py` | Python | 严格校验器:schema v1/v2、`--require-vmp-family`(九家族)、`--require-vmp-family-evidence`(必须带值/引用/结果证据)、`--require-complete-values`、`--require-material-refs`、`--require-signature-param-materialization` |
| `scripts/analyze_vmp_trace.py` | Python | 按 profile 汇总分析,输出 JSON 摘要 |
| `scripts/sign_pipeline.py` 等 | Python | 签名分析流水线(输入→运算→输出报告);`--inject-api-hooks` 注入 JS 层免补丁 API hook 并与时钟对齐 |
| `test-pages/` | HTML/JS | 自包含测试页:混淆 / 指纹 / VMP / 因果 / worker / fetch 变体 |

launcher 传参示例(摘自 `xtrace_launcher/cli.py`):

```python
"--xtrace-enable", f"--xtrace-file={log_path}",
f"--xtrace-categories={categories}",
f"--xtrace-capture-values={capture_values}",
f"--xtrace-capture-assets={capture_assets}",
f"--xtrace-causality={causality}",
# 同时镜像到环境变量 XTRACE_*
```

---

## 8. 构建变体与进阶工具

| 脚本 | 用途 |
|------|------|
| `scripts/gn_gen_xtrace.sh` + `build_chromium.sh` | 默认 debug + 组件化构建(`out/XTrace`),适合改补丁迭代 |
| `scripts/build_xtrace_release.sh` | 同一份打过补丁的源码,release 参数(`is_debug=false`、非组件化)构建到 `out/XTrace-release`(可用 `OUT_DIR` 覆盖)——debug 构建跑 JS 慢约一个数量级,重 SPA 会"白屏爬行" |
| `scripts/solink_xtrace_dylibs.py` | ninja 图损坏但目标文件完好时,只重编 XTrace 触及的编译单元并 solink 出 `libv8.dylib` / `libchrome_dll.dylib`,免完整重建 |
| `scripts/relink_chromium_runtime.sh` | 运行时重链辅助 |
| `scripts/build_xtrace_release.sh`(注) | 补丁打在源码树而非 out 目录,故多 out 目录共存、均带全量插桩 |

---

## 9. 仓库结构

```
patches/           # 0001 原生日志器 · 0002 V8 JSVMP hooks · 0003/0004 因果 schema v2
scripts/           # bootstrap / apply_patches / gn_gen / build / release / solink / serve / validate / analyze / sign_pipeline / run_tests
xtrace-launcher/   # Python CLI:run + validate
xtrace-gui/        # Electron 抓取 + 审阅工作台
test-pages/        # 本地测试 HTML(混淆 / 逆向 / VMP 场景)
docs/              # 设计 spec、schema v1/v2、构建说明、复现指南、recipe
tests/             # 脚本 / 分析器单元测试
# gitignore(本机生成,不入库):chromium/ · depot_tools/ · logs/ · local/
```

---

## 10. 关键设计决策解读

1. **补丁而非 fork**:仓库只承载 ~2.7 万行 diff,可审查、可对齐固定 revision、不含 Chromium 源码(许可与体积都干净);代价是上游 revision 漂移后需要重做补丁(3-way merge 是缓冲)。
2. **浏览器进程持有文件句柄**:渲染器沙箱保持开启是安全底线,Mojo IPC 是唯一出口;同时 `global_seq` 在落盘前统一盖,天然获得跨进程全序。
3. **渲染器预序列化 NDJSON**:Mojo 上传的是已成型的 JSON 行,浏览器进程只做"查重→插序号→追加写",把 JSON 构造成本留在渲染器、把文件 IO 隔离在 `MayBlock` 线程池。
4. **event_logger + 暗号的双补丁协议**:V8 补丁零依赖 Blink 头文件,两个补丁可独立审查;`serializer_enabled` 检查保证 snapshot 生成期不产生脏事件;没有 Blink 侧注册时 hook 是纯 no-op,对普通构建零语义影响。
5. **插桩分层**(Torque → CSA → 手写汇编):跟随 V8 各内建的实现层级选择最小侵入点;汇编层 trampoline 显式处理 GC 安全(SmiTag 参数计数)与寄存器借用(scratch 排除),这是最容易出稳定性的地方,补丁注释也明确 WASM 边界选择纯 C++ 回调以"不破坏引擎稳定"。
6. **配置全部运行期化**:同一个二进制既可全保真抓取也可 summary/args-only,还可限额 body/头值——增强版浏览器的"增强度"是每次启动可选的。
7. **可验证性优先**:校验器不仅查字段,还要求每个 VMP 家族命中**携带真实证据**(值/引用/结果),拒绝截断值与不透明引用——工具的产出本身被设计成可审计的。

---

## 11. 快速命令备忘(端到端)

```bash
# 生成增强版 Chromium
scripts/bootstrap_chromium.sh
scripts/apply_patches.sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/gn_gen_xtrace.sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/build_chromium.sh
# → chromium/src/out/XTrace/Chromium.app

# 抓一条 trace
python3 scripts/serve_test_page.py --port 8765
cd xtrace-launcher
PYTHONPATH=. python3 -m xtrace_launcher run \
  --chromium ../chromium/src/out/XTrace/Chromium.app \
  --url http://127.0.0.1:8765/reverse-smoke.html \
  --log-dir ../logs --capture-seconds 60 --validate-after-exit

# 严格校验(九家族 + 证据)
python3 scripts/validate_trace.py --profile reverse --schema-version 1 \
  --require-vmp-family base64 … --require-vmp-family-evidence \
  logs/your-capture.ndjson
```

---

## 12. 补丁可移植性与新版 Chromium 适配

### 12.1 通用性结论:**不通用,是 revision 锁定的**

四个补丁按 `diff` 上下文行精确匹配,只对 `73088b4e…`(Chromium 151.0.7917.0,2026-06-27 main)干净应用。各补丁的脆弱度分层:

| 补丁 | 脆弱度 | 原因 |
|------|--------|------|
| `0002`(V8) | **高** | 触及 ~120 个 V8 文件:Torque `.tq` 内建(上游重排频繁)、CSA lambda、**arm64 手写汇编 trampoline**(寄存器约定/栈布局一变即错)、`runtime.h` 的 F() 宏列表落点、V8 内部 API(`DirectHandle`/`Cast<>` 等代际变迁) |
| `0001`(Blink) | 中 | ~100 个文件多为"在既有函数里插一行 Log 调用",上游函数签名/重构会造成上下文漂移;mojom 接口、BUILD.gn、receiver 注册相对稳定 |
| `0003`/`0004` | 低 | 小而局部,基本可 3-way 自动合并 |

两个实证:`apply_patches.sh` 专门写了三态 preflight(干净应用 / 已应用 / 三方合并)就是为版本漂移兜底;`docs/chromium-build.md` 记载 `Reflect.apply` / `Function.prototype.call/apply` 的直接 arm64 hook 曾因冒烟测试渲染器崩溃而禁用——**但补丁实测 6 个汇编调用点全部活跃且无任何编译/运行期开关**,更可能是文档滞后于补丁迭代(trampoline 里"保持内部帧槽 GC 安全"的注释正是崩溃修复的痕迹)。无论哪种情况,这都印证了汇编层的脆弱性(且该层仅存在于 arm64 构建,Torque/CSA 层才是跨架构的)。

### 12.2 适配新版的步骤

1. **换 revision**:`CHROMIUM_REVISION=<新rev> scripts/bootstrap_chromium.sh`(或直接改脚本默认值),`gclient sync` 连 V8 一起对齐;
2. **打补丁**:`scripts/apply_patches.sh`,preflight 失败自动退 `--3way`;合不上的 hunk 以冲突标记/失败告终,逐个手动处理;
3. **重新导出补丁**:解决完在两棵树各 `git diff > 新 patch`。建议在 `chromium/src` 与 `chromium/src/v8` 各建一个长期分支提交补丁,之后用 `git rebase` + `format-patch` 维护,比手工维护静态 patch 文件轻松得多;
4. **重点核对清单**(按冲突概率排序):
   - V8:`base.tq` 的 `extern runtime XTraceVmpRuntime` 签名;`runtime.h` 三行 `F(XTraceVmp…)` 落点;`runtime-typedarray.cc` 的 RUNTIME_FUNCTION 插入点;`builtins-arm64.cc` trampoline 的寄存器/栈布局;
   - Blink:`v8_initializer.cc` 的 `SetEventLogger`/`SetData` 调用点;`render_process_host_impl_receiver_bindings.cc` 的 registry API;各插桩文件函数签名;
   - mojom:`xtrace.mojom` 在 `BUILD.gn` 的注册路径;
5. **验证闭环**:debug 组件化重建(最快)→ `scripts/serve_test_page.py` + launcher `run --validate-after-exit` → `validate_trace.py` 验九家族与证据。注意 **CI(`ci.yml`)只覆盖免构建组件**(launcher/validator/analyzer/GUI 逻辑跑合成 fixture),补丁可应用性必须本机构建验证;
6. **过渡期替代**:launcher 的 `--inject-api-hooks` 是 JS 层免补丁注入,不依赖重建,可在移植期间顶上原生 hook 的部分能力。

### 12.3 按原理移植 vs 重锚定:两条路线

锚定的本质是**静态 git diff**:每个 hunk 带 3 行上下文与 `index <旧blob>..<新blob>` 哈希。这带来一个重要性质——`git apply --3way` 以旧 blob 为合并基,**只要目标仓库历史里可达该 blob(151 的后代版本天然可达,bootstrap 拉的是全量历史),跨小版本升级就有真实三方合并可用**,冲突只出现在上游改过同区域的地方。

把 0001 的 13,229 行按性质拆开,可移植性完全不同:

| 成分 | 体量 | 可移植性 |
|------|------|----------|
| 自包含新文件(logger/host/mojom/BUILD.gn 片段) | ~1,000 行 | ≈原样搬运,仅需随 base API 微调 |
| 桥接点(`v8_initializer.cc` 一处 SetEventLogger + SetData) | ~100 行 | event_logger 接口多年稳定,高度可移植 |
| Blink 既有函数内的插桩 hunk | ~12,000 行 | 机械性重锚定,但每处含"在哪个语义点、抓什么值"的决策 |
| V8 Torque/CSA 调用点(0002) | ~13,000 行 | 机制稳定(base.tq extern + runtime + event_logger),调用点需重找 |
| arm64 汇编 trampoline | ~200 行 | 汇编本身可读懂;难在它依赖**无契约的隐式 ABI**(入口寄存器含义、值的 tagged 性、帧的 GC 可走性、scratch 池不冲突),这些不变量无文档、无编译检查、随版本静默变化——移植错误不报编译错,而是 GC/分层编译时机下的偶现渲染器崩溃。仅覆盖 4 个派发 API,移植优先级最低——可先放弃,后续按文档建议改在跨架构 CSA/Torque 或调用点实现 |

结论:**架构(原理)是版本无关的,但"只要写代码就行"需要三个校准**——难点不在代码量而在插桩点的语义选择(需读懂 Blink/V8 内部);汇编层无法机械移植;配套验证资产(校验器、九家族证据要求、测试页)是原理的一半,没有它无法证明移植正确。路线选择:近版本(151 后代)走 3-way 重锚定,天级成本;跨大版本走按原理重写(新文件 → 桥接点 → Blink 清单 → Torque/CSA → 跳过 asm → `validate_trace.py` 闭环),周级成本。

---



| 输入 | 输出 |
|------|------|
| `depot_tools/`(克隆) | `chromium/src`(固定 revision 检出,含 DEPS 同步的 `src/v8`) |
| `patches/0001` → `chromium/src` | Blink/浏览器插桩 + `xtrace_logger` + `xtrace_host_impl` + `xtrace.mojom` |
| `patches/0002` → `chromium/src/v8` | 三层内建 hook + 3 个 runtime 函数 + WASM 边界 + provenance |
| `patches/0003`/`0004` → `chromium/src` | `XTraceActivationScope` 因果栈 + 网络事件 external 标记 |
| GN 参数(debug 组件化 或 release) | `out/XTrace/`(或 `out/XTrace-release/`) |
| `ninja … chrome` | **`Chromium.app`(增强版浏览器)** |

> 报告基于对仓库脚本与补丁的静态分析写成;行数为 `wc -l` 实测,文件清单为 `diff --git` 头实测。构建耗时/磁盘数字引自 `docs/chromium-build.md`。
