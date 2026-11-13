---
name: simpeek
description: Inspect the network requests and logs of an app running in the iOS Simulator with simpeek. Use when debugging an iOS app's API or GraphQL calls, checking what a screen or action sends, finding why a request fails, or correlating app logs with requests.
---

# simpeek

simpeek records the URLSession traffic of an app running in the iOS Simulator and lets you query it.
It needs no proxy, certificate or app change: it relaunches the app with a recorder injected.
Use the `net_*`, `log_read` and `timeline` MCP tools. The same commands exist on the command line as
`npx -y simpeek <command>` (`npx -y simpeek --help` lists them).

## Loop

1. Start recording once with `net_launch` and the app's bundle id. This relaunches the app, so
   requests made before it are not recorded. The simulator must be booted and the app installed.
   Pass `inject: false` only if the app links the SimPeek package itself.
2. Watch traffic while you or the user drive the UI:
   - With a background monitor available, run `npx -y simpeek tail` in it. Each line is one event:
     `→` sent, `←` succeeded, `✗` failed.
   - Otherwise call `net_mark` before an action and `net_wait` right after it, or call `net_list`
     with the `cursor` from the previous call to get only new requests.
3. Call `net_get` with the id of any request marked `✗` or `⚠`. Errors come first, then variables,
   trimmed data and the source file that defines the GraphQL operation.

## Reading results

- A GraphQL response with `errors` counts as a failure even when the HTTP status is 200. Filter
  with `status: "gqlerror"`, or `status: "error"` for every kind of failure.
- Analytics and SDK requests are hidden by default. Pass `all: true` when you need them.
- `net_get` trims large bodies. Use `select` with a path to read one part in full.
- Secrets (Authorization, Cookie, token and password fields) are shown as `***`. Pass
  `redact: false` only when the task needs the real value, and do not repeat that value in your
  answer.
- `net_ops` gives calls, failures, p50 and p95 per operation. Use it for "what is slow" and
  "what fails most".
- `timeline` merges requests and logs by time. Use it when a log line and a request need to be
  put in order.

## Limits

Only URLSession traffic in the simulator is recorded. Background sessions, WebSocket tasks and
stacks that bypass URLSession (gRPC, for example) do not appear. If an expected request is
missing, check these before concluding that the app did not send it.
