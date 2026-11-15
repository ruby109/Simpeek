# GraphQL recognition for persisted queries, GET and deferred responses, with the first automated tests

*   **Author:** ruby109
*   **Status:** Draft 4 (revised after three review rounds, see [the review](graphql-recognition-review.md))
*   **Date:** 2026-11-13

--------------------------------------------------------------------------------

## Overview

simpeek records the URLSession traffic of an app in the iOS Simulator and shows it one line per
request. For GraphQL it replaces `POST host/graphql` with the operation (`Q Posts`), and treats a
response that carries `errors` as a failure even when the HTTP status is 200.

Version 0.1.0 reads one request shape (a POST whose JSON body has a `query` string, single or
batched) and one response shape (a single JSON document). This spec adds the shapes in the table
under "The Problem", fixes one crash, and adds the project's first automated tests. It ships as
0.2.0. The two false failures (rows 2 and 4) are implemented first.

## Current behavior

This section describes 0.1.0. Later sections say "as today" for anything described here.

**Recorder.** A recorder inside the app sends each request again through its own URLSession and
passes the response back to the app. It writes one session file per launch
(`~/.simpeek/<bundle>/<session>.ndjson`) with a `start` line when a request begins and an `end`
line when it completes, using the field names of HAR 1.2. The `end` line is written before the app
receives the response, and both lines use the host clock. A body larger than 64 KB, or not valid
UTF-8, goes to a side file, and the line holds its relative path in `_file`. A response body is cut
at 10 MB and then marked `_truncated`. The newest 20 sessions per app are kept.

**Reader.** The CLI and the MCP server only read these files. `store.ts` reads entries and bodies;
`bodyText` returns a side file as text, or the placeholder `<binary N bytes: path>` when the bytes
are not valid UTF-8. A reader object (`SessionReader`) creates an entry on its `start` line and
updates the same object on its `end` line; `tail` and `net_wait` keep one reader and poll it every
250 ms. `graphql.ts` derives the operations of a request and the outcome of its response.
`views.ts` renders lines and details and applies filters; it caches each entry's rendered view
(label, state, failed) once the entry has finished. `sourcemap.ts` maps an operation name to the
file that defines it, in the source directory registered with `simpeek project <bundle-id> <dir>`
(or the one in `SIMPEEK_PROJECT`).

**Recognition.** A request is GraphQL when its body parses as JSON and is an object with a `query`
string, or an array in which at least one element is such an object; or when its URL path ends in
`/graphql` (any letter case, with or without a trailing slash). The method is not checked. The type
is the first word of the document after comments: `query`, `mutation` or `subscription`, and
anything else counts as `query`. The name is `operationName` from the body, else the word after a
type keyword, else `(anonymous)`. A request on a `/graphql` path with no readable operation is
GraphQL with zero operations and keeps the label `METHOD host/path`.

**Outcome.** For a finished GraphQL request, including one with zero operations, the response body
is parsed as JSON. If parsing fails the outcome is `invalid`. Otherwise errors are collected from
`errors` (of the object, or of each element of an array), each with `message`, `path` and a code
from `extensions.code`, `extensions.errorCode` or `code`. No errors gives `ok`. Errors with a
non-null `data` give `partial`. Errors without data give `errors`. An `errors` value that is an
object, a number or `true` makes this code throw; a string is iterated per character.

**Output.** One line per request:

```
#6     15:37:53.565  Q Posts                             ✗ UNAUTHENTICATED   56ms     155B
```

| Text | Meaning |
|---|---|
| `Q` / `M` / `S` before a name | query / mutation / subscription. A batch is `Q A+B`. |
| `ok`, or an HTTP status for non-GraphQL requests | The request did not fail. |
| `✗ …` | Failed. Checked in this order: transport error (`✗ <message>`), HTTP status 400 or above (`✗ <status>`), GraphQL `errors` without data (`✗ <code> @<path>`, or the message when there is no code or path, plus `×N` or `(+N)` for several errors), `✗ invalid JSON`. |
| `⚠ partial: …` | GraphQL `errors` together with `data`. Also counted as failed. |
| `…` | Still in flight. |
| `→` / `←` / `✗` in `simpeek tail` | Request sent / finished without failure / finished with failure. |

Each rendered request has one `failed` flag. `--status error`, `--status ok`, the arrow in `tail`
and the failure count in `simpeek ops` read that flag. `--status gqlerror` selects GraphQL outcomes
other than `ok`. `--type` selects by operation type (prefix match) and `--op` by name.
`simpeek ops` groups finished requests that have operations by label, and others by method, host
and path.

`simpeek get <id>` (MCP: `net_get`) prints the label and state, the URL, errors, variables, a line
`query: N lines (pass query=true to show)`, and the response `data` shortened ("trimmed"; the `raw`
option turns this off). It prints a `source` line when the operation name is found in the
registered source directory. Its `select` option prints one path of a JSON response.
`simpeek extract` prints one value from the newest matching JSON response, searching up to 20
sessions. `simpeek timeline` and the MCP `timeline` tool merge request lines with log lines.
`net_wait` (MCP) blocks until requests that match the filters finish, and returns them, or times out
(default 15 s). The agent loop in the README is: launch once, watch `tail` or call `net_wait`, then
call `net_get` on anything marked ✗ or ⚠.

## The Problem

0.1.0 was developed against one app with a hand-written client. The shapes below are defined by the
GraphQL over HTTP specification, the Apollo persisted-query protocol and Apollo's format for
deferred responses. 0.1.0 shows them wrongly:

| # | Shape | 0.1.0 shows | Correct |
|---|---|---|---|
| 1 | Persisted query (APQ): `operationName` and `extensions.persistedQuery`, no `query` | `POST host/graphql` | `Q Posts`, or `? Posts` when the type cannot be known |
| 2 | APQ miss: the server answers `PersistedQueryNotFound`, the client retries with the document | `✗ PERSISTED_QUERY_NOT_FOUND` | Not a failure when the retry follows |
| 3 | GET to a `/graphql` path with `query`, `operationName`, `variables` in the URL | `GET host/graphql?query=…` (the full query string) | `Q Posts` |
| 4 | `@defer` response as `multipart/mixed` | `✗ invalid JSON` | `ok`; or a failure when a part carries an error or the response is incomplete |
| 5 | Document that starts with `fragment` definitions | `Q (anonymous)`, or `Q UpdatePost` when `operationName` is sent: the letter is wrong for a mutation | `M UpdatePost` |
| 6 | Operation defined on one line in a string literal, `"query Foo { … }"` | No `source` line in `get` | `source` line |

Row 2 always sends the agent to a request where nothing is wrong; row 4 does so whenever the
deferred response is complete and carries no error.

A separate defect: a response whose `errors` is an object, a number or `true` (for example
`{"errors":{"field":"msg"}}`) makes the outcome code throw, and `list`, `ops`, `get` and `timeline`
exit with a stack trace.

There are no automated tests.

## Goals

*   Rows 1, 3 and 5 show the operation name, and the type when it can be determined.
*   Row 2: a miss followed by its retry is not a failure. A miss whose retry is known not to have
    come is a failure and says so.
*   Row 4 is a failure only when a part carries an error, the response is incomplete, or nothing in
    it can be read.
*   Row 6 gets its `source` line.
*   A response with a non-array `errors` is shown as a failure. If recognition throws for any other
    input, the request is shown as failed with `✗ recognition failed`.
*   **Output changes only for these requests** (the *intended changes*; Compatibility and the
    Verification Plan refer to this list): requests that match rows 1 to 5; responses whose
    `errors` is present and not an array; the URL line of `get` for requests whose operations were
    read from the URL; and `source` lines under row 6 when a source directory is registered. All
    other output is identical to 0.1.0.
*   `cd cli && npm test` runs without a simulator, network access or new dependencies. CI runs it
    on pushes to `master`, on pull requests and before every npm publish.
*   The README TODO loses the items that are done. Items not done, including those this spec
    decides against, stay.

## Non-Goals

*   No change to the recorder (`ios/`), the session file format or the dylib.
*   No uploads (`multipart/form-data` with an `operations` field): they need a separate byte-level
    parser, and on a `/graphql` path their errors are already detected. Stays in the TODO.
*   No subscriptions, over WebSocket or HTTP. The recorder writes a response only when the request
    completes, so a live subscription has no outcome. Stays in the TODO.
*   No `Content-Type: application/graphql` bodies.
*   No detection of GraphQL by request headers.
*   No GET recognition on paths that do not end in `/graphql`, unless the URL carries a
    persisted-query hash. This is a trade-off: a client configured with another endpoint path and
    `useGETForQueries` stays a REST line, in exchange for no REST request ever being taken for
    GraphQL because of a `query` parameter. Phase 0 records the endpoint path the sample uses.
*   No merging of incremental payloads into one result.
*   No REST items from the TODO.

## Open Questions

*   **Sample app for Phase 0**: the candidate is Apollo's iOS tutorial app. Whether it builds with
    the installed Xcode, which Apollo iOS version it uses, and whether its server supports
    persisted queries and `@defer` are unknown. Phase 0 has a fixed outcome when it cannot be used.
*   **Apollo iOS 2.x**: Apollo iOS 1.15.0 adds `X-APOLLO-OPERATION-TYPE` in `HTTPRequest.swift`
    (source read, not recorded; the spelling of the value is not confirmed). It was not found in
    the request code on `main` (2.x).
*   **Miss-to-retry interval**: the window W in "Retried and abandoned misses" is set to 5 seconds
    without a measurement. Phase 0 records the interval.
*   **Servers that answer a miss with HTTP 4xx**: not checked. The design does not depend on it.

## Critical User Journeys (CUJs)

### CUJ 1: Persisted query, server already knows the hash

*   **Given**: An app that sends hash-only requests, and a server that knows the hash.
*   **When**: The app sends
    ```json
    {"operationName":"Posts","variables":{"first":20},
     "extensions":{"persistedQuery":{"version":1,"sha256Hash":"ab12cd34ef567890…"}}}
    ```
    and the server answers `{"data":{…}}`.
*   **Then**: `simpeek list` shows `Q Posts  ok` when the request has the header
    `X-APOLLO-OPERATION-TYPE` with a type name, or when another request of the same session carried
    this hash with its document. Otherwise it shows `? Posts  ok`. `get` shows the variables and
    `query: persisted (sha256 ab12cd34ef56…), document not sent`.

### CUJ 2: Persisted query, first use

*   **Given**: The same app, without Apollo headers. The server does not know the hash.
*   **When**: The app sends the hash-only request, the server answers
    `{"errors":[{"message":"PersistedQueryNotFound","extensions":{"code":"PERSISTED_QUERY_NOT_FOUND"}}]}`,
    and the app sends the request again with the `query` included.
*   **Then**: `simpeek list` shows two lines for `Q Posts`: the first `↻ not persisted`, the second
    `ok`. Labels and states are the same with or without `--type query` and `--since`.
    `simpeek list --status error` shows neither line. `simpeek ops` shows one row, `Q Posts`, with
    2 calls and 0 failures. `simpeek get` on the first request shows `Q Posts`. `net_wait` with
    `op: "Posts"` returns the second request. `simpeek tail` prints the finish line of the first
    request as `←  ? Posts  ↻ not persisted`, before the retry exists.

### CUJ 3: Persisted query that is never retried

*   **Given**: A client that sends only registered hashes and has no document to retry with.
*   **When**: The server answers with `PERSISTED_QUERY_NOT_FOUND` and the client sends no retry.
*   **Then**: As soon as the session shows that no retry came (another request starts at least W
    seconds after the miss, or the app is relaunched), `list` shows `✗ no retry: not persisted` and
    counts it as failed, and a running `tail` prints a correction line for it. Until then the miss
    shows `↻ not persisted`. `net_wait` that times out while such a miss is pending returns it with
    the note `persisted-query miss, retry not seen yet`.

### CUJ 4: Deferred response with an error in a later part

*   **Given**: An app that uses `@defer`.
*   **When**: The `multipart/mixed` response has an initial part with `data` and a second part
    whose `incremental[0].errors` has one error with the code `NOT_FOUND`.
*   **Then**: The list shows `⚠ partial: NOT_FOUND`. `get` prints the error first, then
    `parts (2, trimmed):` and both parts.

### CUJ 5: Mutation with a fragment-first document on an unusual path

*   **Given**: A client that POSTs
    `fragment PostFields on Post { id } mutation UpdatePost($id: ID!) { updatePost(id: $id) { ...PostFields } }`
    as `query` in a JSON body to `https://api.example.com/v2/gateway`.
*   **When**: The server answers HTTP 200 with `{"errors":[{"message":"no","extensions":{"code":"FORBIDDEN"}}]}`.
*   **Then**: The list shows `M UpdatePost  ✗ FORBIDDEN`.

### CUJ 6: REST search request

*   **Given**: An app that calls `GET https://api.example.com/search?query={shoes}` and gets HTML.
*   **Then**: `simpeek list` shows the same line as 0.1.0: a `GET` line with the HTTP status.

### CUJ 7: Maintainer changes the recognition code

*   **Given**: A checkout with Node 24, after `npm ci` in `cli/`.
*   **When**: The maintainer runs `npm test`.
*   **Then**: Each fixture file is reported as its own test, and a regression fails the run with the
    file's name.

## Technical Plan (Architecture)

### Where the code lives

```text
session file ──► store.ts ──► views.ts: Session ──────────────► CLI / MCP output
                               (openSession: reader + session pass;
                                view = cached recognition + pass result)
                                   │
                           graphql.ts            sourcemap.ts
                           recognize(request)    + definitions after a quote
                           outcome(response)
```

`graphql.ts` stays a set of functions of one request and one response. Two facts need the whole
session: whether a miss was retried, and the type of a hash-only operation whose document appears
elsewhere. Both come from a *session pass* inside a new `Session` object in `views.ts`. Every
command reaches entries only through a `Session`, so no command can render without the pass.

Files that change: `cli/src/graphql.ts`, `views.ts`, `store.ts` (lossy decoding), `sourcemap.ts`,
`actions.ts`, `cli.ts`, `mcp.ts`, `logs/view.ts`; new `cli/test/`; `cli/package.json`,
`cli/package-lock.json`; `.github/workflows/test.yml` (new) and `publish.yml`; `AGENTS.md`;
`README.md` and `README.zh-CN.md`; `plugin/skills/simpeek/SKILL.md`,
`plugin/.claude-plugin/plugin.json` and `plugin/.mcp.json`.

### Recognizing the request

**Carriers.** Operations are read from one carrier, chosen by the body. There is no fall-through.

| Carrier | Chosen when | Operations come from |
|---|---|---|
| JSON | The request body text is not empty | The body as JSON: one object or an array of objects. As today. |
| URL | No body, or an empty body | The parameters of `request.url`, parsed with `URLSearchParams` (first occurrence of each name; the HAR `queryString` field is not used): `query`, `operationName`, `variables`, `extensions`. The last two are JSON; a value that does not parse is treated as absent. |

The URL carrier is used only when the path ends in `/graphql`, or `extensions` holds a
persisted-query hash.

In either carrier, an object is an operation when it has a `query` string (of any content, as
today), or when `extensions.persistedQuery.sha256Hash` is a string.

If the carrier yields no operation, the request is GraphQL with zero operations when its path ends
in `/graphql`, and not GraphQL otherwise, as today.

**Document scanner.** The scanner lists the operations defined at the top level of a document. It
reads the document once from left to right. A *word* is `[_A-Za-z][_0-9A-Za-z]*`; keywords are
case-sensitive.

1.  A `"` starts a string that ends at the next `"` not preceded by `\`; `"""` starts a block
    string that ends at the next `"""`. A `#` outside a string starts a comment that ends at the end
    of the line. Strings and comments are skipped and take precedence over everything below.
2.  Text inside parentheses or square brackets is skipped, including braces in it.
3.  Outside any definition, a word or a `{` starts a definition.
4.  A definition that starts with `query`, `mutation` or `subscription` is an operation. Its name
    is the word that follows after optional whitespace; if anything other than whitespace comes
    first (for example `@` or `(`), it has no name.
5.  A definition that starts with `{` is an anonymous query.
6.  A definition that starts with any other word is not an operation.
7.  A definition ends at the brace that closes its first `{`, or at the end of the input.
    Characters outside a definition that are not words or `{` are ignored. The scanner never
    throws.

The *selected operation* is the one whose name equals `operationName`, or the first one.

**Name.** `operationName` when it is a non-empty string; else the selected operation's name; else
`(anonymous)`.

**Type.** The selected operation's type. When the item has a `query` string in which the scanner
finds no operation, the type is `query`, as today. For a hash-only item, see below.

### Type of a hash-only operation

The first of:

1.  The request header `X-APOLLO-OPERATION-TYPE` (name compared without regard to case, first
    occurrence), when the request has exactly one operation and the value, lower-cased, is a type
    name.
2.  Learned by the session pass: another entry of the same session carries the same hash with a
    document. The type, and the name when the hash-only item had no `operationName`, are taken from
    that document's selected operation.
3.  Unknown, shown as `?`. An unknown type matches no `--type` filter.

### Reading the response

`outcome` receives the HTTP status, the response content type, the `_truncated` flag, the body text
and the operations of the request. Response text is read with lossy decoding (invalid UTF-8
becomes U+FFFD) instead of the `<binary …>` placeholder, so a body cut in the middle of a character
is still parsed.

*   **Non-array values.** Wherever errors are collected (`errors`, and `incremental[].errors` in
    parts), a value that is neither absent, `null` nor an array counts as one error whose message is
    the value as JSON, cut to 200 characters. A non-array `incremental` is ignored.
*   **Single document**: as today, with the rule above.
*   **`multipart/mixed`** (media type compared without regard to case): the boundary is the
    `boundary` parameter (name without regard to case, quotes removed). A *delimiter* is a line that
    starts with `--<boundary>`. If there is no boundary parameter or no delimiter line, the body is
    read as a single document. Otherwise each piece between delimiters that contains a blank line
    is a *part*; its header block may be empty; its body is the text after the first blank line,
    trimmed. A part with an empty body is ignored. A part is *readable* when its body parses as a
    JSON object.
    *   No readable part: `invalid`.
    *   The response is *incomplete* when a part is not readable, `_truncated` is set, the closing
        `--<boundary>--` is missing, or the last readable part has `"hasNext": true`.
    *   Errors come from `errors` and `incremental[].errors` of readable parts. There is data when a
        readable part has a non-null `data` or a non-empty `incremental` array.
    *   Checked in order: errors and no data give `errors`; errors and data, or an incomplete
        response, give `partial`; otherwise `ok`.
*   **APQ miss**: outcome `miss` when the HTTP status is below 500, the request has at least one
    operation, every operation has a hash and no document, there is at least one error, and every
    error is a persisted-query miss (`extensions.code` is `PERSISTED_QUERY_NOT_FOUND`, or the
    message is `PersistedQueryNotFound`). The same error on a request that included a document
    stays `errors`; so does `PERSISTED_QUERY_NOT_SUPPORTED`. A batch in which some elements miss
    and others return data is `partial`, as today (accepted; batched persisted queries were not
    found in Apollo iOS).

### Session pass

`openSession(info)` in `views.ts` loads the session and returns a `Session`. The `Session` holds
the reader, runs the pass on creation and after every `poll()`, and keeps the results in its own
maps (nothing is kept at module level). Each run replaces the previous results.

*   **Recognition cache.** The operations and the outcome of an entry are cached per entry and
    recomputed when the entry finishes. The pass reads them from this cache; it reads request
    bodies of all entries and response bodies only of entries whose operations are all hash-only.
*   **Learned types**, keyed by hash: from every operation that has a hash and a document.
*   **Retried and abandoned misses.** For a miss M, its *arrival* is `startMs + time`. For each hash
    of M, look at the first entry with a higher id that carries that hash and started after M's
    arrival:
    *   if it carries a document, that hash is retried (the retry need not have finished);
    *   if it is hash-only, M is abandoned.
    M is *retried* when all its hashes are retried. When some hash has no such entry, M is
    *abandoned* if another entry of the session started at least W seconds after M's arrival, or a
    newer session of the same app exists; otherwise M is *pending*.
    W is 5 seconds, a provisional value until Phase 0 measures the interval.

The result depends only on the session files, not on the time the command runs.

`view(e)` on a `Session` combines the cached recognition and the latest pass result, and computes
label, state and `failed` on every call; it is not cached.

Every command that renders requests uses a `Session`: `list`, `ops`, `get`, `extract` (one per
session searched), `tail` (history and live), `timeline` (CLI and MCP), `net_list`, `net_get`,
`net_ops`, `net_wait`.

### Rendering

*   **Miss, retried or pending**: state `↻ not persisted`, not failed. Checked before the HTTP
    status. `--status gqlerror` excludes it.
*   **Miss, abandoned**: state `✗ no retry: not persisted`, failed. Checked before the HTTP status.
*   **Incomplete deferred response without errors**: `⚠ partial: incomplete response`.
*   **Recognition threw**: state `✗ recognition failed`, failed. `get` prints
    `recognition failed: <message, cut to 100 characters>` under the first line; if reading the
    request body throws again there, it prints `request body: (unreadable)`.
*   **Hash-only operation** in `get`: `query: persisted (sha256 <first 12 characters>…), document
    not sent`, with or without the `query` option.
*   **Parts** in `get`: `parts (<n>, trimmed):` (`parts (<n>):` in raw mode), then each readable
    part as JSON separated by an empty line, then `(incomplete response)` when it applies. `select`
    is evaluated against the array of parts (`[1].incremental[0].data`).
*   **Operations read from the URL**: `get` prints the URL up to `?`, then `?…`.
*   **`tail`**: prints a line when a request finishes, from the pass result at that moment. When a
    miss it printed as pending later becomes abandoned, it prints one more line for the same id:
    `✗  ? Posts  no retry: not persisted  #12`.
*   **`net_wait`**: does not return a miss that is retried or pending. If it times out and a pending
    miss matched the filters, it returns that miss with the line
    `persisted-query miss, retry not seen yet` instead of reporting that nothing happened.
*   `simpeek extract` still reads single JSON documents only.

### Source index

In addition to definitions at the start of a line, a definition is found when
`query|mutation|subscription`, whitespace, a name, optional whitespace and then `(`, `{` or `@`
directly follow a quote character (`"`, `'` or a backtick) and optional whitespace. All matches in
a line count. This can also match a quoted definition in a comment or log message, which then adds
a `source` line for an operation of that name. The index is used only by `get`, as today.

### Tests

Tests use Node's built-in runner and run the TypeScript sources directly. A fixture is one JSON
file with a `request` and an optional `response` in the field names of the session file, an
`expect` block, and a `source` field that says where its content comes from. Each fixture file is
one test. Separate files cover the scanner, the source index and rendering. The `test` script uses
an empty temporary `SIMPEEK_DIR`, clears `SIMPEEK_PROJECT` and `SIMPEEK_EXCLUDE`, and removes the
directory afterwards.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Fixtures and code come from the same reading of a protocol. | Phase 0 runs first. Rows 1 to 4 ship only with at least one fixture whose `source` is a recording or a wire example published in a document under "Additional Resources". Hand-written fixtures are added beside them. |
| A REST request is taken for GraphQL. | The only new recognition off `/graphql` paths is a request carrying `extensions.persistedQuery.sha256Hash`. Fixtures `get-rest-search`, `get-rest-braces`, `get-document-other-path`, `post-rest`. |
| The scanner disagrees with GraphQL syntax in a case not listed. | It reads top-level structure only and never throws. A wrong result gives a wrong letter or name, which also affects `--type`, `ops` grouping and the types learned from that document. `scan.test.ts` lists the cases. |
| A miss is shown as a non-failure although the client gave up. | It becomes a failure once the session shows that no retry came. A silent session that is not relaunched keeps it pending; `net_wait` returns it with a note on timeout. |
| W is wrong for a client. | Too short: a slow retry shows the miss as failed until the session is read again after the retry. Too long: an abandoned miss stays pending longer. Phase 0 measures; the value is one constant. |
| The pass adds work to every command. | It reads request bodies (which `list` already reads) and responses of hash-only requests only. Measured in Phase 3; see the Verification Plan for the limit and what happens if it is exceeded. |
| Hash-only requests show `?` when there is no type header and the document never appears in the session. | Accepted for 0.2.0 and written in the README. Alternative E is the follow-up. |
| Secrets in a GET URL. | The query string is not printed when operations were read from it. Other query strings are printed as today. |
| The first tests give false confidence about the recorder. | `AGENTS.md` states that the recorder and simulator actions have no automated tests. |

## Alternatives Considered

### Alternative A: Use the `graphql` npm package to parse documents

*   **Pros**: Exact parsing.
*   **Cons**: A third runtime dependency, against the project convention. It covers row 5 only, and
    rejects documents with syntax the installed version does not know.
*   **Reason for Rejection**: simpeek needs the type and name of one operation. The scanner gives
    that for the listed cases; other cases are covered by the scanner risk.

### Alternative B: Learn types while rendering, without a session pass (draft 2)

*   **Cons**: Filters run before rendering, so output depended on filters, request order and, in the
    MCP server, earlier calls.
*   **Reason for Rejection**: Output must not depend on which command ran before.

### Alternative C: Treat every miss as a non-failure

*   **Cons**: For a client that sends registered hashes only, the miss is the final error, and it
    would be hidden from `--status error`, `ops` and `net_wait`.
*   **Reason for Rejection**: It replaces a false failure with a false success.

### Alternative D: Decide abandonment by the time the command runs (draft 3)

*   **Pros**: A pending miss turns into a failure after W seconds even when the app is idle.
*   **Cons**: The same unchanged file gave different output depending on when `list` ran, and
    in-process caches kept the first answer.
*   **Reason for Rejection**: Output must depend on the files only. The idle case is covered by
    `net_wait`'s timeout note.

### Alternative E: Learn types from older sessions of the same app

For APQ the hash is the SHA-256 of the document, so a hash has one type, and the 20 kept sessions
may hold the request that registered it.

*   **Cons**: One session's output depends on other files, which rotate out.
*   **Reason for Rejection**: Deferred until Phase 0 shows whether current clients send the type
    header.

### Alternative F: Detect GraphQL by headers, or accept GET documents on any path

*   **Cons**: An app can set `apollographql-client-name` on every request, and
    `/search?query={shoes}` looks like a document. Both would turn REST responses into
    `✗ invalid JSON`.
*   **Reason for Rejection**: It creates false failures.

### Alternative G: Include uploads

*   **Cons**: A byte-level multipart parser and binary fixtures for a label on requests whose errors
    are already detected.
*   **Reason for Rejection**: Separate cost; nothing here depends on it.

### Alternative H: Rewrite capture first

*   **Reason for Rejection**: Not rejected. It is the next spec.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Privacy**: Fixtures contain no data from a real app; hosts are `example.com`, and names and
    values are invented. A query string from which operations were read is not printed.
*   **Robustness**: Recognition errors are caught per entry and shown as `✗ recognition failed`.
*   **Performance**: No source tree is read by `list`, `tail` or `ops`. The pass has the limit in
    the Verification Plan.
*   **Compatibility**: Output differs from 0.1.0 only for the intended changes listed in Goals.
*   **Rollback**: `npm install -g simpeek@0.1.0`. Session files are not modified.

--------------------------------------------------------------------------------

## Additional Resources

*   `README.md` ("Limits", "TODO", "Agent loop") and `AGENTS.md` ("Conventions", "Build and verify",
    "Release")
*   [GraphQL over HTTP](https://graphql.github.io/graphql-over-http/draft/)
*   [Automatic persisted queries](https://www.apollographql.com/docs/apollo-server/performance/apq)
*   [Apollo's multipart format for `@defer`](https://www.apollographql.com/docs/graphos/routing/operations/defer)
*   Apollo iOS source, tag 1.15.0: `Sources/Apollo/HTTPRequest.swift`, `Sources/Apollo/JSONRequest.swift`
*   [The review of drafts 1 to 3](graphql-recognition-review.md)

## Future Improvements

*   Uploads, subscriptions over HTTP, `application/graphql` (README TODO).
*   Types from older sessions (Alternative E).
*   A command that turns a recorded request into a scrubbed fixture.
*   A merged view of deferred responses, and the newer incremental delivery format.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

The rules are in "Technical Plan". This plan gives the order, signatures, files and test cases.
Commits follow the project rule of one logical change each.

**First**: commit the pending edits to `README.md` and `README.zh-CN.md` (TODO block "Capture and
storage" / "抓取与存储") as their own commit.

The phases put the false failures first. Each phase leaves `npm test` passing. A release can be
cut after Phase 3; Phase 4 can follow in 0.2.x.

### Phase 0: Baseline and recordings (half a day; when it runs out, unrecorded shapes take outcome 2 or 3)

**Baseline.** Choose one session recorded with 0.1.0 that has at least one `ok`, one `✗` and one
REST request, and the largest session available. Copy each `.ndjson` file and its body directory
into a directory `B/<bundle>/` outside the repository. With the 0.1.0 code and `SIMPEEK_DIR=B`,
save the output of `list`, `ops`, `timeline --limit 200` and `get <n>` for three ids, all with
`--bundle <bundle> --session <id>`. Time each of these commands five times on the largest session
and keep the medians.

**Recordings.** Build the sample app and record it with `simpeek launch`:

1.  A query and a mutation with default settings.
2.  The same with automatic persisted queries on, launched twice (first use, then known hash).
3.  A query sent by GET.
4.  A `@defer` query, if the server supports it.

For each, note the Apollo iOS version, request headers starting with `X-APOLLO-` or
`apollographql-`, the endpoint path, the body or URL keys, the time from a miss's response to the
start of its retry, and for item 4 the response `Content-Type` and the raw first two parts. Copy
the recorded sessions into `B`.

**Outcome per row 1 to 4:**

1.  *Recorded and matching the rules*: add fixtures from the recording (suffix `-recorded`,
    `source` naming the recording) with host, header values, names and data replaced.
2.  *Recorded and contradicting a rule*: change the rule in this document and the affected
    fixtures before the phase that implements the row, and list the change under "Phase 0
    results".
3.  *Not recorded, but a published wire example exists*: add a fixture from it, `source` naming
    the page.
4.  *Neither*: the row is removed. Row 2 requires row 1; removing row 1 removes Phase 3.

Rows 5 and 6 need no recording. Add a section "Phase 0 results" to this document with the outcome
per row, the measured miss-to-retry interval (W is set to twice the largest measured interval,
at least 2 s), and any rule changes.

### Phase 1: Tests, signatures, crash fix

*   **`cli/src/store.ts`**: `bodyText(info, body, opts?: { lossy?: boolean })`; with `lossy`, a side
    file is decoded with replacement characters and never replaced by the placeholder.
*   **`cli/src/graphql.ts`**:
    `recognize(request: Request, text: string | undefined): Operation[] | undefined` replaces
    `parseOperations`.
    `outcome(response: { status?: number; content?: { mimeType?: string; _truncated?: boolean } } | undefined, text: string | undefined, ops: Operation[]): GqlOutcome | undefined`
    replaces `outcome(text)`. Logic as today, plus the non-array rule.
*   **`cli/src/views.ts`**: recognition runs inside a `try`; a throw sets `recognitionError` and the
    state `✗ recognition failed`. `detail()` prints the message and guards the request-body read.
    Response text is read with `lossy`.
*   **`cli/package.json`**: script
    `"test": "d=$(mktemp -d); SIMPEEK_DIR=\"$d\" SIMPEEK_PROJECT= SIMPEEK_EXCLUDE= node --no-warnings --test \"test/**/*.test.ts\"; s=$?; rm -rf \"$d\"; exit $s"`.
*   **`cli/test/fixtures.test.ts`**, **`cli/test/fixtures/*.json`**, **`cli/test/views.test.ts`**
    (below).
*   **`.github/workflows/test.yml`**: on `push` to `master` and `pull_request`;
    `permissions: contents: read`; job on `macos-latest`, `working-directory: cli`:
    `actions/checkout@v5`, `actions/setup-node@v5` (Node 24), `npm ci`, `npm test`.
*   **`.github/workflows/publish.yml`**: `- run: npm test` after `- run: npm ci`.
*   **`AGENTS.md`**: layout lines for `cli/test/` and both workflows; replace "There are no automated
    tests yet." with: "`cd cli && npm test` runs the unit tests (Node's built-in runner). Add a
    fixture in `cli/test/fixtures/` for every request or response shape you add or fix. The
    recorder and the simulator actions have no automated tests; verify them end to end as described
    above."; add "runs the unit tests," to the sentence about the publish workflow.

**Fixture format.**

```json
{
  "source": "0.1.0 behavior",
  "request": { "method": "POST", "url": "https://api.example.com/api/graphql",
               "headers": [{ "name": "Content-Type", "value": "application/json" }],
               "queryString": [],
               "postData": { "mimeType": "application/json", "text": "…" } },
  "response": { "status": 200, "content": { "mimeType": "application/json", "text": "…" } },
  "expect": {
    "ops": [{ "type": "query", "name": "Posts", "hash": null, "hasQuery": true,
              "variables": { "first": 20 } }],
    "outcome": { "status": "ok", "codes": [], "parts": null, "incomplete": false }
  }
}
```

The test calls `recognize(request, request.postData?.text)`, and, when `response` is present and
`ops` is not `null`, `outcome(response, response.content.text, ops)`. It compares whole objects:
per operation `{ type: type ?? null, name, hash: hash ?? null, hasQuery: query !== undefined, variables: variables ?? null }`;
for the outcome `{ status, codes: errors.map(e => e.code ?? null), parts: parts?.length ?? null, incomplete: !!incomplete }`.
`expect.outcome` is `null` when there is no response or `ops` is `null`. Every key is written in
every fixture. Fixtures are read from `path.join(import.meta.dirname, 'fixtures')`.

In the tables: POST, path `/api/graphql`, `application/json`, status 200, unless stated; unlisted
values are `hash: null`, `hasQuery: true`, `variables: null`, `codes: []`, `parts: null`,
`incomplete: false`; `—` means `outcome: null`. `H1` is
`ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890` and `H2` is the same with `ab`
and `cd` swapped. Hand-written fixtures have `source` `"rules"`.

**Phase 1 fixtures** (`source` `"0.1.0 behavior"`, except `post-json-errors-*`: `"rules"`):

| File (`.json`) | Request body | Response body | → ops | → outcome |
|---|---|---|---|---|
| `post-json-named` | `{"query":"query Posts($first:Int){posts(first:$first){id}}","variables":{"first":20}}` | `{"data":{"posts":[]}}` | `query Posts`, variables `{"first":20}` | `ok` |
| `post-json-operation-name` | `{"query":"query A{a}","operationName":"B"}` | none | `query B` | — |
| `post-json-anonymous` | `{"query":"{ viewer { id } }"}` | none | `query (anonymous)` | — |
| `post-json-no-braces` | `{"query":"mutation Foo"}` | none | `mutation Foo` | — |
| `post-json-mutation-errors` | `{"query":"mutation UpdatePost{updatePost{id}}"}` | `{"errors":[{"message":"no","extensions":{"code":"FORBIDDEN"}}]}` | `mutation UpdatePost` | `errors`, `["FORBIDDEN"]` |
| `post-json-partial` | `{"query":"query Posts{posts{id}}"}` | `{"data":{"posts":null},"errors":[{"message":"x","path":["posts"]}]}` | `query Posts` | `partial`, `[null]` |
| `post-json-batch` | `[{"query":"query A{a}"},{"query":"query B{b}"}]` | `[{"data":{"a":1}},{"data":{"b":2}}]` | `query A`, `query B` | `ok` |
| `post-json-comment-first` | `{"query":"# note\nmutation M{m}"}` | none | `mutation M` | — |
| `post-json-invalid-response` | as `post-json-named` | `<html>`, `text/html` | as `post-json-named` | `invalid` |
| `post-json-errors-object` | as `post-json-named` | `{"errors":{"field":"msg"}}` | as `post-json-named` | `errors`, `[null]` |
| `post-json-errors-string` | as `post-json-named` | `{"errors":"boom"}` | as `post-json-named` | `errors`, `[null]` |
| `post-json-errors-null` | as `post-json-named` | `{"data":{"posts":[]},"errors":null}` | as `post-json-named` | `ok` |
| `post-rest` | path `/api/login`, `{"user":"a"}` | `{"ok":true}` | `null` | — |
| `post-graphql-path-unreadable` | path `/graphql`, `not json` | none | `[]` | — |
| `post-graphql-path-trailing-slash` | path `/GraphQL/`, `not json` | none | `[]` | — |
| `post-other-path` | path `/v2/gateway`, `{"query":"query Q{q}"}` | none | `query Q` | — |

**`views.test.ts`, phase 1.** Entries are built in memory (`done: true` when they have a response)
and rendered through `openSession` on a `SessionInfo` in the test's temporary directory; Phase 1
adds `openSession` as a thin wrapper without the pass.

*   `postData.text` is a getter that throws: `row` contains `✗ recognition failed`;
    `applyFilters` with `status: 'error'` keeps it; `detail()` contains `recognition failed:` and
    `request body: (unreadable)`.
*   `post-json-errors-object` as an entry: `row` contains `✗`.

### Phase 2: Deferred responses (row 4)

*   **`cli/src/graphql.ts`**: `GqlOutcome` gains `parts?: object[]` (set only when there is at
    least one readable part) and `incomplete?: boolean`. `outcome` follows "Reading the response"
    for `multipart/mixed`.
*   **`cli/src/views.ts`**: the `⚠ partial: incomplete response` state; parts in `detail()`;
    `select` on parts.
*   **`cli/src/mcp.ts`**: append to the `net_get` description: "Deferred (multipart) responses are
    shown as parts; select then starts at the part index, e.g. [1].incremental[0].data."

**Phase 2 fixtures.** Request `post-json-named`; content type
`multipart/mixed; boundary="graphql"; deferSpec=20220824` (provisional until Phase 0); each part has
the header line `content-type: application/json; charset=utf-8`; CRLF line ends; part 1 is
`{"data":{"posts":[]},"hasNext":true}` and the body ends with `--graphql--`, unless stated.

| File (`.json`) | Response | → outcome |
|---|---|---|
| `defer-ok` | part 2 `{"incremental":[{"data":{"x":1},"path":["posts"]}],"hasNext":false}` | `ok`, parts 2 |
| `defer-incremental-error` | part 2 `{"incremental":[{"errors":[{"message":"x","extensions":{"code":"NOT_FOUND"}}],"path":["posts"]}],"hasNext":false}` | `partial`, `["NOT_FOUND"]`, parts 2 |
| `defer-errors-no-data` | one part `{"errors":[{"message":"x","extensions":{"code":"FORBIDDEN"}}],"hasNext":false}` | `errors`, `["FORBIDDEN"]`, parts 1 |
| `defer-errors-object-in-part` | part 2 `{"errors":{"x":"y"},"hasNext":false}` | `partial`, `[null]`, parts 2 |
| `defer-incremental-not-array` | part 2 `{"incremental":{"data":{}},"hasNext":false}` | `ok`, parts 2 |
| `defer-cut-part` | part 2 is `{"incremental":[{"da`, no closing delimiter | `partial`, parts 1, incomplete |
| `defer-cut-at-delimiter` | after part 1 only `\r\n--graphql\r\n` | `partial`, parts 1, incomplete |
| `defer-has-next` | part 1 only, then `--graphql--` | `partial`, parts 1, incomplete |
| `defer-truncated-flag` | `defer-ok` with `"_truncated": true` in `content` | `partial`, parts 2, incomplete |
| `defer-null-part` | part 2 is `null` | `partial`, parts 1, incomplete |
| `defer-empty-headers` | `defer-ok` with no header lines in either part | `ok`, parts 2 |
| `defer-boundary-in-string` | one part `{"data":{"s":"a --graphql b"},"hasNext":false}` | `ok`, parts 1 |
| `defer-no-boundary` | content type `multipart/mixed`, body `{"errors":[{"message":"no","extensions":{"code":"FORBIDDEN"}}]}` | `errors`, `["FORBIDDEN"]` |
| `mixed-unparseable` | two parts with the bodies `hello` and `world` | `invalid` |

At least one of these must also exist with `source` from Phase 0 outcome 1 or 3.

**`views.test.ts`, phase 2:** `defer-incremental-error`: `row` contains `⚠ partial: NOT_FOUND`,
`detail()` contains `parts (2, trimmed):`, with `select: '[1].incremental[0].path'` it contains
`posts`. `defer-cut-part`: `row` contains `⚠ partial: incomplete response` and `detail()` contains
`(incomplete response)`.

### Phase 3: Persisted queries (rows 1 and 2)

*   **`cli/src/graphql.ts`**: `Operation` becomes
    `{ type?: OpType; name: string; query?: string; variables?: unknown; hash?: string }`;
    `typeLetter(undefined)` is `'?'`; `recognize` accepts hash-only objects in the JSON carrier and
    applies type rule 1; `outcome` adds `miss`. The type of an operation with a document still comes
    from today's first-word rule until Phase 4.
*   **`cli/src/views.ts`**:
    *   `export function openSession(info: SessionInfo): Session`, where `Session` has `info`,
        `all(): Entry[]`, `poll(): Entry[]` (new entries), `view(e): View`, and the pass state.
    *   `row`, `tailLine`, `detail`, `applyFilters`, `opsTable` take a `Session` instead of a
        `SessionInfo`.
    *   `export function waitSelection(s: Session, filters: Filters, sinceMs: number): { matches: Entry[]; pending: Entry[] }`:
        finished entries since `sinceMs` that pass the filters, without retried or pending misses
        (`matches`), and the pending misses among them (`pending`).
    *   The "newer session exists" check uses `listSessions(info.bundle)[0]`.
*   **Call sites** (replace `loadSession`/`SessionReader` use with `openSession`):
    `cli.ts` `tail` (`attach`, history and poll loop; print the correction line), `extract` (inside
    the loop over sessions), `list`, `get` (keep the session, then `view` the one entry), `ops`;
    `mcp.ts` `net_list`, `net_get`, `net_ops`; `logs/view.ts` `timeline`; `actions.ts` `waitFor`
    (call `waitSelection` after each `poll`; on timeout return `pending` with the note).
*   **`cli/src/mcp.ts`**, appended to descriptions. `net_list`: "Type letter Q/M/S, or ? when a
    persisted query's type is unknown. `↻ not persisted` is the first step of a persisted query, not
    a failure; `✗ no retry: not persisted` means the client never sent the document." `net_wait`:
    "Persisted-query misses are not returned while a retry is expected; on timeout, a pending miss
    is returned with a note."

**Phase 3 fixtures** (defaults as in Phase 1):

| File (`.json`) | Request | Response | → ops | → outcome |
|---|---|---|---|---|
| `apq-hash-only` | `{"operationName":"Posts","variables":{"first":20},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"H1"}}}` | none | type `null`, `Posts`, hash `H1`, `hasQuery: false`, variables `{"first":20}` | — |
| `apq-hash-only-type-header` | the same, header `x-apollo-operation-type: Mutation` | none | `mutation Posts`, otherwise the same | — |
| `apq-hash-only-other-path` | the `apq-hash-only` body, path `/v2/gateway` | none | as `apq-hash-only` | — |
| `apq-with-query` | the `apq-hash-only` body plus `"query":"query Posts{posts{id}}"` | none | `query Posts`, hash `H1`, `hasQuery: true`, variables `{"first":20}` | — |
| `apq-batch-type-header-ignored` | `[{"operationName":"A","extensions":{"persistedQuery":{"version":1,"sha256Hash":"H1"}}},{"operationName":"B","extensions":{"persistedQuery":{"version":1,"sha256Hash":"H2"}}}]`, header `X-APOLLO-OPERATION-TYPE: query` | none | type `null` `A` hash `H1`, type `null` `B` hash `H2`, both `hasQuery: false` | — |
| `apq-miss` | `apq-hash-only` | `{"errors":[{"message":"PersistedQueryNotFound","extensions":{"code":"PERSISTED_QUERY_NOT_FOUND"}}]}` | as `apq-hash-only` | `miss`, `["PERSISTED_QUERY_NOT_FOUND"]` |
| `apq-miss-message-only` | `apq-hash-only` | `{"errors":[{"message":"PersistedQueryNotFound"}]}` | as `apq-hash-only` | `miss`, `[null]` |
| `apq-miss-http-404` | `apq-hash-only` | the `apq-miss` body, status 404 | as `apq-hash-only` | `miss`, `["PERSISTED_QUERY_NOT_FOUND"]` |
| `apq-miss-http-500` | `apq-hash-only` | the `apq-miss` body, status 500 | as `apq-hash-only` | `errors`, `["PERSISTED_QUERY_NOT_FOUND"]` |
| `apq-not-found-with-query` | `apq-with-query` | the `apq-miss` body | as `apq-with-query` | `errors`, `["PERSISTED_QUERY_NOT_FOUND"]` |
| `apq-not-supported` | `apq-hash-only` | `{"errors":[{"message":"PersistedQueryNotSupported","extensions":{"code":"PERSISTED_QUERY_NOT_SUPPORTED"}}]}` | as `apq-hash-only` | `errors`, `["PERSISTED_QUERY_NOT_SUPPORTED"]` |
| `apq-batch-miss` | `apq-batch-type-header-ignored` without the header | `[` the `apq-miss` body `,` the `apq-miss` body `]` | as `apq-batch-type-header-ignored` | `miss`, `["PERSISTED_QUERY_NOT_FOUND","PERSISTED_QUERY_NOT_FOUND"]` |
| `apq-batch-one-miss` | as `apq-batch-miss` | `[` the `apq-miss` body `,{"data":{"b":1}}]` | as `apq-batch-type-header-ignored` | `partial`, `["PERSISTED_QUERY_NOT_FOUND"]` |
| `zero-ops-miss-body` | path `/graphql`, `not json` | the `apq-miss` body | `[]` | `errors`, `["PERSISTED_QUERY_NOT_FOUND"]` |

**`views.test.ts`, phase 3.** A helper writes entries as `start`/`end` lines into a session file in
the test's `SIMPEEK_DIR` and returns `openSession(info)`; times are given as offsets in seconds.
`M` is `apq-miss` (hash `H1`, arrival at 1 s), `R` is `apq-with-query` with an `ok` response.

*   `[M at 0–1, R at 1.1–1.3]`: `row(M)` contains `Q Posts` and `↻ not persisted`; `applyFilters`
    with `type: 'query'` keeps both; with `status: 'error'` and `status: 'gqlerror'` drops `M`;
    with `status: 'ok'` keeps it; `opsTable` has one row `Q Posts` with 2 calls and 0 failures;
    `detail(M)` first line contains `Q Posts`; `tailLine('end', M)` contains `←`.
*   `[M]` alone: pending: `↻ not persisted`; `waitSelection` returns it in `pending`, not in
    `matches`.
*   `[M, another request starting at 7 s]`: abandoned: `row(M)` contains
    `✗ no retry: not persisted`; `waitSelection` returns it in `matches`.
*   `[M]` and a newer session file of the same bundle: abandoned.
*   `[M, hash-only H1 again at 2 s]`: abandoned.
*   `[M, R starting at 1.1 s but not finished]`: retried.
*   Two misses on `H1` both starting at 0 s and arriving at 1 s, then `R` at 1.1 s: both retried.
*   `[M with no operationName, R]`: `row(M)` contains `Q Posts`.
*   Pending then abandoned in one process: open the session with `[M]`, read `row(M)`
    (`↻ not persisted`), append a request starting at 7 s, `poll()`, read `row(M)` again
    (`✗ no retry: not persisted`).
*   `[M with status 404, R]`: `↻ not persisted`, not failed.
*   Batch `apq-batch-miss` followed by a retry with documents for `H1` only, then a request at 7 s:
    abandoned; with documents for both: retried.

### Phase 4: GET, fragment-first documents, source lookup (rows 3, 5, 6)

*   **`cli/src/graphql.ts`**: the URL carrier;
    `export function scanDocument(doc: string): { type: OpType; name?: string }[]`; type and name
    from the selected operation; `export function fromUrl(request: Request, text: string | undefined, ops: Operation[] | undefined): boolean`,
    true when `ops` is not empty and `text` is `undefined` or `''`.
*   **`cli/src/views.ts`**: shortened URL line in `detail()`.
*   **`cli/src/sourcemap.ts`**: the second pattern; export `buildIndex`.

**Phase 4 fixtures** (defaults as in Phase 1; GET requests have no `postData`; hashes in URLs are
written out in full):

| File (`.json`) | Request | → ops |
|---|---|---|
| `get-query` | GET `/graphql?query=query%20Posts(%24first%3AInt)%7Bposts(first%3A%24first)%7Bid%7D%7D&variables=%7B%22first%22%3A20%7D` | `query Posts`, variables `{"first":20}` |
| `get-apq` | GET `/graphql?operationName=Posts&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22H1%22%7D%7D` | type `null`, `Posts`, hash `H1`, `hasQuery: false` |
| `get-apq-other-path` | the same parameters on `/v2/gateway` | as `get-apq` |
| `get-bad-variables` | GET `/graphql?query=%7Bviewer%7Bid%7D%7D&variables=not-json` | `query (anonymous)` |
| `get-bad-extensions` | GET `/graphql?extensions=not-json` | `[]` |
| `get-document-other-path` | GET `/v2/gateway?query=%7Bviewer%7Bid%7D%7D` | `null` |
| `get-rest-search` | GET `/api/items?query=shoes` | `null` |
| `get-rest-braces` | GET `/search?query=%7Bshoes%7D` | `null` |
| `post-empty-body-url-query` | POST `/graphql?query=%7Bviewer%7Bid%7D%7D`, `postData.text` `""` | `query (anonymous)` |
| `fragment-first` | path `/v2/gateway`, the document of CUJ 5; response of CUJ 5 | `mutation UpdatePost`; outcome `errors`, `["FORBIDDEN"]` |
| `fragment-first-operation-name` | the same document with `"operationName":"UpdatePost"` | `mutation UpdatePost` |
| `two-operations-selected` | `{"query":"query A{a} mutation B{b}","operationName":"B"}` | `mutation B` |
| `variable-named-query` | `{"query":"query Search($query: String!){search(q:$query){id}}"}` | `query Search` |
| `string-with-braces` | `{"query":"query Q{a(x:\"} mutation Fake {\"){id}}"}` | `query Q` |
| `string-with-paren` | `{"query":"query A { a(x: \")\") } mutation B { b }","operationName":"B"}` | `mutation B` |

In the URLs, `H1` stands for its 64 characters. Until this phase, a retry sent by GET
(`useGETForPersistedQueryRetry`) is not recognized, so a miss followed by a GET retry stays pending
or becomes abandoned; Phase 4 fixes that without changes to the session pass.

**`cli/test/scan.test.ts`**, input → result:

*   `query A { a }` → `[query A]`
*   `{ a }` → `[query]`
*   `query { a }` → `[query]`
*   `query @live { a }` → `[query]`
*   `query A { a } mutation B { b }` → `[query A, mutation B]`
*   `fragment F on T { x } mutation B { ...F }` → `[mutation B]`
*   `mutation B { ...F } fragment F on T { x }` → `[mutation B]`
*   `fragment query on Query { x } query A { a }` → `[query A]`
*   `query S($query: String = "x", $f: F = {a: 1}) @d(arg: {a: 1}) { s }` → `[query S]`
*   `"""mutation X { x }""" query A { a }` → `[query A]`
*   `# query Y { y }`, newline, `query A { a }` → `[query A]`
*   `query A { a(x: "} mutation Fake {") }` → `[query A]`
*   `query A { a(x: ")") } mutation B { b }` → `[query A, mutation B]`
*   `query A { a(x: "#") } mutation B { b }` → `[query A, mutation B]`
*   `query A { a(x: "\")") } mutation B { b }` → `[query A, mutation B]`
*   `mutation Foo` → `[mutation Foo]`
*   `query A query B { b }` → `[query A]`
*   `Query A { a }` → `[]`
*   `query A { a(x: "unterminated` → `[query A]`
*   `query A {` → `[query A]`
*   `} ) @ $ query A { a }` → `[query A]`
*   empty string → `[]`

**`cli/test/sourcemap.test.ts`**: in a directory from `fs.mkdtempSync`, removed in `after`, write
`a.graphql` with `query Posts {` on line 1; `b.swift` with
`let q = "mutation UpdatePost($id: ID!) { updatePost(id: $id) { id } }"` on line 3; `c.swift` with
`// this query returns { id }`, `// subscription expires (soon)` and `// see the requery Thing {`;
`d.swift` with `log("query failed (\(code))")`. `buildIndex(dir)` has exactly `Posts` (`a.graphql`,
1), `UpdatePost` (`b.swift`, 3) and `failed` (`d.swift`, 1; the documented false match).

**`views.test.ts`, phase 4:** a GET to `/graphql?query=…&variables={"token":"s3cret"}`: no line of
`detail()` contains `s3cret`, and its URL line ends with `?…`. `fragment-first`: `row` contains
`M UpdatePost  ✗ FORBIDDEN`.

### Texts and release

Text depends on which rows shipped. "Both" means both READMEs; the Chinese text is given.

| Row | `README` "Use" phrase | `README` TODO change | `SKILL.md`, "Reading results" |
|---|---|---|---|
| 1 | "persisted-query (APQ) requests" / "persisted query（APQ）请求" | Add "Type of a persisted query when neither a type header nor the document is in the session (shown as `?`)." / "session 里既没有类型 header 也没有 document 时，persisted query 的类型（目前显示为 `?`）。" | "A type shown as `?` means the request sent only a hash." |
| 2 | sentence "A persisted-query miss that is retried is shown as `↻ not persisted` and is not a failure." / "persisted query 未命中且随后重试的，显示为 `↻ not persisted`，不算失败。" | With row 1: remove "Persisted queries / APQ". | "`↻ not persisted` is the first step of a persisted query; the retry with the same hash carries the result, and `net_wait` skips it. `✗ no retry: not persisted` means the client never sent the document." |
| 3 | "GET parameters" / "GET 参数" | Remove "GET requests". | — |
| 4 | "`@defer` responses are read part by part" / "`@defer` 响应按段读取" | Replace "`multipart/mixed` responses" with "Subscriptions over HTTP (`multipart/mixed`): needs the recorder to write parts as they arrive." / "基于 HTTP 的 subscription（`multipart/mixed`）：需要录制端在收到每一段时就写入。"; add to "Limits": "Deferred responses are shown part by part, not merged." / "`@defer` 响应按段显示，不合并。" | — |
| 5 | — | Remove "Documents that start with fragment definitions". | — |
| 6 | — | Remove "Source lookup for single-line documents". | — |

*   "Use", after the paragraph that starts with "Filters (CLI flags / MCP args)": "GraphQL
    operations are also read from " + the row 1 and 3 phrases joined by " and " + "." Then the row 4
    phrase as its own sentence, capitalized, and the row 2 sentence. Chinese: "GraphQL operation
    也可以从" + phrases joined by "和" + "中识别。" A part without any shipped row is left out.
*   Always, in "Limits": "GraphQL subscriptions and uploads are not recognized." / "不识别 GraphQL
    subscription 和上传。"
*   The items "Multipart uploads", "`Content-Type: application/graphql`" and "Detect GraphQL by
    headers" stay.
*   **Release**: version `0.2.0` in `cli/package.json`, `cli/package-lock.json`, the `McpServer`
    version in `cli/src/mcp.ts`, `plugin/.claude-plugin/plugin.json` and `plugin/.mcp.json`; release
    as in `AGENTS.md`, section "Release"; then `gh release create v0.2.0 --notes-file <file>`, the
    notes listing each shipped row with the `source` of its fixtures.

### Verification Plan

*   **Compilation/Build**: `cd cli && npm run build` (run `ios/scripts/build-dylib.sh` first on a
    fresh checkout).
*   **Unit Tests**: `cd cli && npm test`.
*   **Static Analysis & Linting**: None exists and none is added.
*   **Test Coverage Requirement**: Every shipped row has at least one fixture or test case, and rows
    1 to 4 at least one whose `source` is a recording or a published example. The JSON and URL
    carriers each have a malformed-input fixture. No percentage target.
*   **E2E/Integration**, before the release:
    *   With `SIMPEEK_DIR=B` and `SIMPEEK_PROJECT` unset, run the Phase 0 baseline commands and
        `diff` them with the saved outputs. Every difference must be one of the intended changes in
        Goals.
    *   With the same session, time `list`, `get` and `timeline` five times each. The median may
        exceed the baseline median by at most 200 ms (a judgment: these commands run after every UI
        action in the agent loop). If exceeded, stop and revise this spec.
    *   The package check from `AGENTS.md`: `npm pack`, install into an empty directory,
        `simpeek --help`, MCP `tools/list`.
    *   Launch the app used during 0.1.0 development with `simpeek launch` and check that requests
        made after login are sent and listed.
    *   Call `net_wait` through the MCP server after a UI action; confirm that it returns.
    *   Show the Phase 0 recordings in `B` with `list` and `get`.
