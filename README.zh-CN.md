# simpeek

[English](README.md) | 简体中文

给人和 AI agent 看的 iOS 模拟器网络流量工具。能识别 GraphQL，数据只存在本地，可以实时流式查看。

```
ios/            SimPeek：记录 URLSession 流量（SPM 包，或启动时注入的 dylib）
cli/src/        网络模块：tail / list / get / ops / extract，以及 MCP 的 net_* 工具
cli/src/logs/   日志模块（与网络模块相互独立）：app 日志文件、stdout/stderr、统一日志；
                MCP 的 log_read，以及把日志和网络请求合并在一起的 `timeline`
```

不需要代理，不需要证书，也不用改 app 代码：simpeek 用 `DYLD_INSERT_LIBRARIES` 重新启动 app，
注入的 dylib 每次启动写一个 NDJSON 文件到 `~/.simpeek/<bundleId>/<session>.ndjson`
（每个请求一行 `start`、一行 `end`，字段沿用 HAR 1.2；超过 64KB 或不是合法 UTF-8 的 body 另存为
`~/.simpeek/<bundleId>/<session>/<id>.req|.res`）。每个 app 保留最近 20 次启动的记录。
详见[工作原理](#工作原理)。

## 安装

Claude Code plugin（包含 MCP server，以及一个教 agent 怎么用的 skill）：

```
/plugin install simpeek --marketplace ruby109/Simpeek
```

Claude Code 版本不支持这种一步安装时：先 `/plugin marketplace add ruby109/Simpeek`，再 `/plugin install simpeek@simpeek`。

npm（macOS，Node 24+；包里带有预编译的模拟器 dylib）：

```sh
npm install -g simpeek
claude mcp add -s user simpeek -- simpeek mcp     # 其他 MCP 客户端：命令 `simpeek`，参数 `mcp`
```

从源码运行：

```sh
ios/scripts/build-dylib.sh                         # → ios/build/SimPeek.dylib
cd cli && npm install                              # 直接运行 .ts 源码
cli/bin/simpeek.js --help
```

然后告诉 simpeek 这个 app 的 GraphQL operation 定义在哪个仓库：

```sh
simpeek project <bundle-id> <path/to/app/repo>
```

## 使用

```sh
simpeek launch com.example.app --console   # 重新启动 app 并开始记录；app 已链接 SimPeek 包时加 --no-inject
simpeek tail                          # 实时查看：→ 请求发出，← 成功，✗ 失败（包括 HTTP 200 但带 GraphQL errors 的响应）
simpeek list --status error           # 最近失败的请求
simpeek get 41                        # 详情：错误在最前，然后是 variables、裁剪后的 data、operation 所在的源文件
simpeek ops                           # 按 operation 统计调用次数 / 失败次数 / p50 / p95
simpeek logs --since -5m              # app 日志文件 + stdout（需要 --console）+ 统一日志
simpeek timeline --since my-mark      # 网络请求和日志按时间交错显示
simpeek extract --path /oauth/token --select refresh_token   # 输出原始值，方便脚本使用
```

app 日志文件按 app 配置，路径相对于它的数据容器：
`simpeek applog com.example.app "Library/Logs/*.log"`。
`os` 日志源只保留 app bundle 内代码打出的日志，以及系统框架的 error 和 fault（加 `--system` 显示全部）。

```
15:37:53.565 →  Q Posts  {first:20,after:"cursor-1"}  #6
15:37:53.621 ✗  Q Posts                            ✗ UNAUTHENTICATED  56ms    155B  #6
```

过滤条件（CLI 参数 / MCP 参数）：`op`（正则）、`type`、`host`、`path`、`method`、
`status`（`2xx`…`5xx`、具体状态码、`ok`、`error`、`gqlerror`、`pending`）、`minMs`、
`since`（`-5m`、`15:20`、ISO 时间，或一个 mark）、`all`（包含 Mixpanel / Firebase / Google 这类噪音请求）。

GraphQL operation 也可以从 persisted query（APQ）请求和 GET 参数中识别。`@defer` 响应按段读取。
persisted query 未命中且随后重试的，显示为 `↻ not persisted`，不算失败；`✗ no retry: not persisted`
表示客户端一直没有发送 document。类型显示为 `?` 表示请求只发了 hash，类型未知。

MCP 工具：`net_launch`、`net_sessions`、`net_list`（用 `cursor` 只取新增的请求）、
`net_get`（`select`、`query`、`include`、`raw`、`redact`）、`net_ops`、`net_mark`、`net_wait`、
`log_read`、`timeline`。

### Agent 的使用流程

1. 先调用一次 `net_launch`（或 `simpeek launch`）。
2. 实时查看：在后台运行 `simpeek tail`（Claude Code 的 Monitor），每一行都会作为一个事件送达。
   没有 Monitor 时：用带 `cursor` 的 `net_list`，或在 UI 操作之后立刻调用 `net_wait`。
3. 操作 UI（RocketSim），然后对标了 ✗ 或 ⚠ 的请求调用 `net_get <id>`。

敏感信息（Authorization、Cookie、token/password 字段）默认显示为 `***`，传 `redact=false` 才显示原值；
磁盘上的文件保留原始值，并且只有你自己可读（0600 / 0700）。

写入这个会话的 app 已经退出时，`list` 和 `net_list` 会提示会话已结束，避免把 app 退出后的空列表误当成「什么都没录到」。

## 工作原理

1. **带着 dylib 启动。** `simpeek launch <bundle>` 先结束 app，再用 `xcrun simctl launch` 重新启动，
   并设置 `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<路径>/SimPeek.dylib`。`simctl` 会去掉
   `SIMCTL_CHILD_` 前缀，把变量传给 app。模拟器里的 app 是 Mac 上的一个进程，所以 dylib 直接从
   Mac 的文件系统加载（npm 包里放在 `vendor/` 下）。真机不允许这样注入，所以 simpeek 只支持模拟器；
   dylib 只能在启动时加载，所以要重启 app。
2. **在 `main()` 之前启动。** dyld 会执行 dylib 里的构造函数（`ios/Inject/inject.c`），它调用
   `SimPeek.start()`：打开会话文件，用 method swizzling 把 `SimPeekURLProtocol` 插到每个 default 和
   ephemeral `URLSessionConfiguration` 的 protocol classes 最前面，并全局注册，覆盖
   `URLSession.shared`。如果 app 自己链接了 SimPeek 包并调用 `SimPeek.start()`，启动时加
   `--no-inject`。app 环境变量里设 `SIMPEEK=0` 可以关闭录制。
3. **拦截并转发。** `SimPeekURLProtocol` 接管每个 HTTP(S) 请求，写一行 `start`，再通过 SimPeek
   自己的 session 重新发出（它的配置没有被 swizzle，所以不会被自己再拦一次）。响应、数据和完成事件按顺序交还给 app，
   请求完成时写一行 `end`。CLI 和 MCP server 只读这些文件，不监听任何端口。

## 限制

- 只支持 URLSession。后台 session（`URLSessionConfiguration.background`）、WebSocket task，
  以及绕过 URLSession 的网络栈（Google Maps / Firestore gRPC）不会被记录。
- 请求由 SimPeek 自己的 session 重新发出（URLProtocol），所以认证质询走默认处理，
  重定向在内部跟随。响应从这个 session 的串行 delegate 队列交还给 app。
- 只支持模拟器（dylib 是为 iOS 模拟器编译的）。
- `@defer` 响应按段显示，不合并。不识别 GraphQL subscription 和上传。

## TODO

分发：

- [ ] Homebrew tap。
- [ ] 在仓库根目录放 `Package.swift`，让 app 可以通过 URL 添加 SimPeek 包。

抓取与存储：

- [ ] 只观察 app 自己发出的请求，不再重新发送，让认证质询、重定向和时序跟没有 SimPeek 时完全一致（见「限制」）。
- [ ] 不经 simpeek 重启也能录：把 `DYLD_INSERT_LIBRARIES` 设在模拟器的 `launchd` 上，之后启动的所有 app（包括扩展）从第一个请求起就被记录；因为影响整台模拟器，需要明确的开关和清理。
- [ ] 导出 HAR（`simpeek har -o file.har`），让录下来的会话能直接在 Charles、Proxyman 或浏览器开发者工具里打开。
- [ ] 单个会话的体积上限（总字节数、单个 body 的字节数），作为“保留最近 20 次启动”之外的限制。
- [ ] 对照一份更全的敏感 header 名单检查脱敏规则（`X-CSRFToken`、`x-apitoken`、`oidc`/`jwt`/`assertion` 前缀、`x-firebase-appcheck`、`x-amz-content-sha256`），同时检查 `keep-alive`、`:authority` 这类误伤。
- [ ] 在文档里写清楚脱敏覆盖什么、不覆盖什么（URL 路径里的秘密、名单之外的字段值），让用户知道什么时候输出可以直接分享。
- [ ] 崩溃后的残留：确认 app 被杀时读取端能容忍不完整的最后一行，并清理 session 文件已不存在的 body 目录。

GraphQL（Apollo iOS 及其他客户端）：

- [ ] session 里既没有类型 header 也没有 document 时，persisted query 的类型（目前显示为 `?`）。Apollo iOS 2.x 不发类型 header；它生成的代码里每个 operation 的 hash 就写在定义旁边，所以可以借助登记的源码目录查出类型。
- [ ] 基于 HTTP 的 subscription（`multipart/mixed`）：需要录制端在收到每一段时就写入。
- [ ] Multipart 上传：从 `operations` 字段读取 operation。
- [ ] `Content-Type: application/graphql`（body 就是 document 本身）。
- [ ] 同时通过 header 识别 GraphQL（`apollographql-client-name`、`Accept: application/graphql-response+json`），而不只靠 `/graphql` 路径或 `query` 字段。

REST：

- [ ] `ops` 统计按路由分组：把路径里的 ID 和 UUID 折叠掉（`/users/123` → `/users/:id`）。
- [ ] 可配置的规则，用来识别以 HTTP 2xx 返回的错误（例如 `{"error": …}`）。
- [ ] 把接口映射到调用它的源文件。
- [ ] 按 content-type 处理 body（XML、图片及其他二进制），而不是统一显示 `<binary …>`。
