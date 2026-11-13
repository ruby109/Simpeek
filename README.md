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

## TODO

Distribution:

- [ ] Homebrew tap.
- [ ] `Package.swift` at the repository root, so that apps can add the SimPeek package by URL.

GraphQL (Apollo iOS and other clients):

- [ ] Persisted queries / APQ: requests without `query` (only `operationName` and `extensions.persistedQuery`) are not recognized, and the expected first `PersistedQueryNotFound` response is shown as a failure.
- [ ] GET requests: read `query`, `operationName` and `variables` from the URL (Apollo `useGETForQueries`, APQ retries over GET).
- [ ] `multipart/mixed` responses (`@defer`, subscriptions over HTTP): parse the parts instead of reporting invalid JSON as a failure.
- [ ] Multipart uploads: read the operation from the `operations` field.
- [ ] `Content-Type: application/graphql` (the body is the document itself).
- [ ] Documents that start with fragment definitions: find the operation definition for the name and type.
- [ ] Source lookup for single-line documents, e.g. `"query Foo { … }"` in a string literal.
- [ ] Detect GraphQL by headers as well (`apollographql-client-name`, `Accept: application/graphql-response+json`), not only by a `/graphql` path or a `query` field.

REST:

- [ ] Group `ops` stats by route: collapse IDs and UUIDs in paths (`/users/123` → `/users/:id`).
- [ ] Configurable rules for errors returned with HTTP 2xx (e.g. `{"error": …}`).
- [ ] Map endpoints to the source files that call them.
- [ ] Content-type aware bodies (XML, images, other binary) instead of `<binary …>`.
