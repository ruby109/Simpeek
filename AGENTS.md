# AGENTS.md

You are the owner and long-term maintainer of this codebase, and its design is up to you.

Guidance for coding agents working in this repository. See README.md for what simpeek does and how it is used.

## Layout

```
ios/                  SimPeek, the in-app recorder (Swift)
  Sources/SimPeek/    URLProtocol interception, session swizzling, NDJSON writer
  Inject/inject.c     constructor that starts recording when the dylib is injected
  scripts/            build-dylib.sh → ios/build/SimPeek.dylib (simulator only, git-ignored)
cli/                  simpeek CLI and MCP server (TypeScript, run directly by Node 24+)
  src/store.ts        reads the session files
  src/graphql.ts      operation names and GraphQL outcomes
  src/sourcemap.ts    maps operation names to the files that define them
  src/views.ts        rows, filters, details, stats, redaction (shared by CLI and MCP)
  src/logs/           log sources and the network/log timeline
  src/actions.ts      simulator launch and wait helpers
  src/mcp.ts          MCP tools
  src/cli.ts          CLI commands
  scripts/build.js    builds the npm package: src/*.ts → dist/*.js, dylib → vendor/ (both git-ignored)
plugin/               Claude Code plugin: .mcp.json (runs the npm package through npx) and a skill
.claude-plugin/       marketplace manifest that makes this repository a plugin marketplace
.github/workflows/    publish.yml: publishes cli/ to npm when a v* tag is pushed
```

Data flow: the app (with SimPeek injected or linked) writes `~/.simpeek/<bundle>/<session>.ndjson`, one `start` and one `end` line per request, and bodies over 64KB as side files. The CLI and MCP server only read those files. Nothing listens on a port.

## Build and verify

```sh
ios/scripts/build-dylib.sh                         # after any change under ios/Sources or ios/Inject
cd cli && npm install                              # once
node --no-warnings cli/bin/simpeek.js --help       # CLI smoke test
```

End-to-end check (needs a booted simulator and an app that uses URLSession):

```sh
node --no-warnings cli/bin/simpeek.js launch <bundle-id> --console
node --no-warnings cli/bin/simpeek.js list --bundle <bundle-id>
```

A change to the recorder is verified only when the app still behaves normally, not just when requests appear in the list. Check that requests which depend on earlier responses (for example, calls made after login) are still sent.

MCP smoke test: pipe `initialize`, `notifications/initialized` and `tools/list` JSON-RPC messages into `node cli/bin/simpeek.js mcp` and check the tool list.

`swift build` on macOS currently fails because `ios/Package.swift` declares only iOS. Build through `build-dylib.sh` (iOS Simulator SDK) instead.

Package check: `cd cli && npm pack`, install the tarball into an empty directory, and run `simpeek --help` and the MCP smoke test from there. Node does not strip types under `node_modules`, so the package must run from `dist/` and must not import any `.ts` file. Plugin check: `claude plugin validate .` and `claude plugin validate ./plugin`.

There are no automated tests yet.

## Release

The version is written in four places and they must match: `cli/package.json`, `cli/package-lock.json`, the `McpServer` version in `cli/src/mcp.ts`, and `plugin/.claude-plugin/plugin.json` together with the `simpeek@<version>` argument in `plugin/.mcp.json`. Releases are published by `.github/workflows/publish.yml`: push `master`, then push the tag `v<version>`. The workflow builds the dylib on a macOS runner, checks that the tarball runs from `node_modules`, and publishes through npm trusted publishing (OIDC), so no npm token is stored anywhere. Do not run `npm publish` from a local machine. The plugin starts the MCP server with `npx simpeek@<version>`, so after pushing, check that the workflow succeeded: until it does, the new plugin version cannot start.

## Conventions

- Swift: everything except the public entry points (`SimPeek.start()` and the C symbol `simpeek_start`, both no-ops outside `DEBUG`) is compiled only in `DEBUG`, so release builds of apps that link the package contain no capture code. Keep it that way.
- Client callbacks are made from the forwarder session's serial delegate queue. Do not post them to the loading thread's run loop. An earlier version did that, and responses silently never reached the app.
- Each NDJSON line is written with a single write, so readers can tail the file. Keep the HAR 1.2 field names and prefix non-HAR fields with `_`.
- TypeScript runs through Node's type stripping: no enums, no namespaces, and no other syntax that needs a compiler. Import local files with the `.ts` extension.
- Keep dependencies minimal (currently `@modelcontextprotocol/sdk` and `zod`).
- CLI and MCP output is compact, one line per request, so that agents can read it without spending many tokens. Put errors first in details.
- Redact secrets in every view by default. Files on disk keep raw values with 0600/0700 permissions.

## Before committing

- Never commit identifiers, hostnames, bundle IDs, paths or sample data from a real app or a real machine. Use `com.example.app`, `path/to/app`, and so on. Check with `git grep` before committing.
- When you add or close a known gap, update the TODO section of README.md.
- Commit messages are short imperative English sentences (`Add …`, `Fix …`), one logical change per commit.
