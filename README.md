# simpeek

English | [简体中文](README.zh-CN.md)

iOS Simulator network traffic for humans and AI agents. GraphQL-aware, stored locally, streamable.

```
ios/            SimPeek — records URLSession traffic (SPM package, or a dylib injected at launch)
cli/src/        network module: tail / list / get / ops / extract, MCP net_* tools
cli/src/logs/   logs module (separate from network): app log files, stdout/stderr, unified log;
                MCP log_read, and `timeline` which merges logs with network requests
```

No proxy, no certificates, no app code changes: the app is relaunched with
`DYLD_INSERT_LIBRARIES`, and the dylib writes one NDJSON file per launch to
`~/.simpeek/<bundleId>/<session>.ndjson` (HAR 1.2-shaped `start` / `end` lines; bodies over 64KB
go to `~/.simpeek/<bundleId>/<session>/<id>.req|.res`). The newest 20 launches per app are kept.

## Install

Claude Code plugin (the MCP server and a skill that teaches the agent loop):

```
/plugin install simpeek --marketplace ruby109/Simpeek
```

On Claude Code versions without the one-step form: `/plugin marketplace add ruby109/Simpeek`, then `/plugin install simpeek@simpeek`.

npm (macOS, Node 24+; the package includes the prebuilt simulator dylib):

```sh
npm install -g simpeek
claude mcp add -s user simpeek -- simpeek mcp     # other MCP clients: command `simpeek`, argument `mcp`
```

From a checkout:

```sh
ios/scripts/build-dylib.sh                         # → ios/build/SimPeek.dylib
cd cli && npm install                              # runs the .ts sources directly
cli/bin/simpeek.js --help
```

Then tell simpeek where the app's GraphQL operations are defined:

```sh
simpeek project <bundle-id> <path/to/app/repo>
```

## Use

```sh
simpeek launch com.example.app --console   # relaunch with recording on; add --no-inject if the app links SimPeek
simpeek tail                          # live: → request sent, ← ok, ✗ failed (incl. GraphQL errors on HTTP 200)
simpeek list --status error           # recent failures
simpeek get 41                        # errors first, variables, trimmed data, source file of the operation
simpeek ops                           # per-operation calls / failures / p50 / p95
simpeek logs --since -5m              # app log files + stdout (with --console) + unified log
simpeek timeline --since my-mark      # network and logs interleaved
simpeek extract --path /oauth/token --select refresh_token   # raw value, for scripts
```

App log files are configured per app, relative to its data container:
`simpeek applog com.example.app "Library/Logs/*.log"`.
The `os` source keeps logs emitted by code inside the app bundle, plus errors and faults from system frameworks (`--system` for everything).

```
15:37:53.565 →  Q Posts  {first:20,after:"cursor-1"}  #6
15:37:53.621 ✗  Q Posts                            ✗ UNAUTHENTICATED  56ms    155B  #6
```

Filters (CLI flags / MCP args): `op` (regex), `type`, `host`, `path`, `method`,
`status` (`2xx`…`5xx`, a code, `ok`, `error`, `gqlerror`, `pending`), `minMs`,
`since` (`-5m`, `15:20`, ISO, or a mark), `all` (include Mixpanel / Firebase / Google noise).

GraphQL operations are also read from persisted-query (APQ) requests and GET parameters.
`@defer` responses are read part by part. A persisted-query miss that is retried is shown as
`↻ not persisted` and is not a failure; `✗ no retry: not persisted` means the client never sent the
document. A type shown as `?` means the request sent only a hash and the type is not known.

MCP tools: `net_launch`, `net_sessions`, `net_list` (with `cursor` for "what's new"),
`net_get` (`select`, `query`, `include`, `raw`, `redact`), `net_ops`, `net_mark`, `net_wait`,
`log_read`, `timeline`.

### Agent loop

1. `net_launch` (or `simpeek launch`) once.
2. Live view: run `simpeek tail` in the background (Claude Code Monitor) — each line arrives as an event.
   Without Monitor: `net_list` with `cursor`, or `net_wait` right after a UI action.
3. Drive the UI (RocketSim), then `net_get <id>` on anything marked ✗ or ⚠.

Secrets (Authorization, Cookie, token/password fields) are shown as `***` unless `redact=false`;
files on disk keep the raw values and are readable only by you (0600 / 0700).

## Limits

- URLSession only. Background sessions (`URLSessionConfiguration.background`), WebSocket tasks,
  and stacks that bypass URLSession (Google Maps / Firestore gRPC) are not recorded.
- Requests are replayed through SimPeek's own session (URLProtocol), so auth challenges use default
  handling and redirects are followed internally. Responses are handed back to the app from that
  session's serial delegate queue.
- Simulator only (the dylib is built for the iOS Simulator).
- Deferred responses are shown part by part, not merged. GraphQL subscriptions and uploads are not
  recognized.

## TODO

Distribution:

- [ ] Homebrew tap.
- [ ] `Package.swift` at the repository root, so that apps can add the SimPeek package by URL.

Capture and storage:

- [ ] Record without relaunching through simpeek: set `DYLD_INSERT_LIBRARIES` on the simulator's `launchd`, so that every app started afterwards is recorded from its first request (including extensions), with an explicit on/off switch and cleanup, since it affects the whole simulator.
- [ ] HAR export (`simpeek har -o file.har`), so that a recorded session can be opened in Charles, Proxyman or browser developer tools.
- [ ] Size limits per session (total bytes, and bytes per body), in addition to keeping the newest 20 launches.
- [ ] Review the redaction rules against a wider list of secret header names (`X-CSRFToken`, `x-apitoken`, `oidc`/`jwt`/`assertion` prefixes, `x-firebase-appcheck`, `x-amz-content-sha256`), and check for false matches such as `keep-alive` and `:authority`.
- [ ] Document what redaction covers and what it does not (secrets in URL paths, values under unlisted names), so that users know when output is safe to share.
- [ ] Leftovers after a crash: confirm that readers tolerate a truncated last line when the app is killed, and remove body directories whose session file is gone.

GraphQL (Apollo iOS and other clients):

- [ ] Type of a persisted query when neither a type header nor the document is in the session (shown as `?`). Apollo iOS 2.x sends no type header; its generated code holds each operation's hash next to its definition, so the registered source directory could supply the type.
- [ ] Subscriptions over HTTP (`multipart/mixed`): needs the recorder to write parts as they arrive.
- [ ] Multipart uploads: read the operation from the `operations` field.
- [ ] `Content-Type: application/graphql` (the body is the document itself).
- [ ] Detect GraphQL by headers as well (`apollographql-client-name`, `Accept: application/graphql-response+json`), not only by a `/graphql` path or a `query` field.

REST:

- [ ] Group `ops` stats by route: collapse IDs and UUIDs in paths (`/users/123` → `/users/:id`).
- [ ] Configurable rules for errors returned with HTTP 2xx (e.g. `{"error": …}`).
- [ ] Map endpoints to the source files that call them.
- [ ] Content-type aware bodies (XML, images, other binary) instead of `<binary …>`.
