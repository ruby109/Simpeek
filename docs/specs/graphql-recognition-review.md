# Review of `graphql-recognition.md` (drafts 1 to 3)

*   **Date:** 2026-11-13
*   **Method:** EGM Goldfish review (plugin `egm` 0.1.1), consolidated run. Eight reviewers, each in
    a fresh context with no access to the drafting conversation: zoom-out, inventive catalyst,
    comprehension, design critic, structural, style, implementation readiness, codebase details.
*   **Deviations from the EGM protocol:** the reviewers of all stages ran at the same time, because
    the document was not edited between stages. Stage 8 (second zoom-out) was skipped for the same
    reason. The reviewers were general-purpose agents told to read the EGM persona files, because
    the plugin's agent types load only in a new session.
*   **Result:** draft 1 had one Blocker; drafts 2 and 3 had none, but each had Major findings
    about what the previous revision added. Draft 4 applies the decisions of all three rounds and
    has not been reviewed.

# Round 1 (draft 1)

## Consolidated findings and decisions

"Raised by" uses: ZO zoom-out, IC inventive catalyst, CO comprehension, DC design critic,
ST structural, SY style, IR implementation readiness, CD codebase details.

### Blocker

| # | Finding | Raised by | Decision |
|---|---|---|---|
| B1 | The document scanner, as written, pushes an anonymous query for the `{` of a fragment, so a fragment-first document is still `Q (anonymous)`. It also reads `$query` inside variable definitions as a second operation. The plan fails its own fixture. | IR, CD, ZO, CO | Fixed. The scanner is specified as rules (definitions, parentheses, selection set required) and pinned by a list of test cases, not by pseudo-code. |

### Major: the design created new wrong output

| # | Finding | Raised by | Decision |
|---|---|---|---|
| M1 | Detecting GraphQL by request header makes every non-JSON response of an app that sets `apollographql-client-name` on all requests show `✗ invalid JSON`. | DC | Accepted. Header-based detection is removed. Recognition by body or URL already works on any path. Headers are used only to name and type an operation that was already recognized. |
| M2 | The GET guard accepts `/search?query=mutation testing` as `M testing` and `?query={"brand":"x"}` as `Q (anonymous)`. This breaks REST lines that 0.1.0 shows correctly. | DC, IR | Accepted. An operation counts only when its selection set opens, and a bare `{` counts only when a name follows it. Negative fixtures added. |
| M3 | A `multipart/mixed` response with a truncated or unparseable part is reported `ok`. The `_truncated` flag never reaches `outcome`. | IC, DC, CO | Accepted. Unreadable parts are counted, `_truncated` is passed in, and the row shows `⚠ partial: N part(s) unreadable`. |
| M4 | CUJ 2 is not achievable: the miss is `? Posts`, the retry is `Q Posts`, and `ops` groups by label, so it shows two rows. | IC, CO, DC, ZO, IR, CD | Accepted. See "Type of a hash-only operation" below. |
| M5 | `net_wait` returns the miss row and stops, with no data. | DC, CD | Accepted. `net_wait` skips misses and keeps waiting. |
| M6 | A multipart subscription stays `…` while open and ends as `✗ cancelled` when the app closes it, because the recorder writes the response only at completion. | DC, ZO, IC, CO | Accepted as a limit. Subscriptions over HTTP are moved to Non-Goals and stay in the README TODO. The `payload` wrapper and its fixtures are removed. |
| M7 | With GET, variables are printed unredacted in the URL line of `net_get`, directly above the redacted `variables:` block. The Privacy claim was false. | DC, ZO, CD | Accepted. When operations were read from the URL, the query string is not printed. |
| M8 | `outcome` throws on a non-array `errors` (existing bug, confirmed by CD with `node -e`), and one such response aborts `simpeek list`. Wider recognition makes it more reachable. | CD, IR | Accepted. Fixed in phase 1 with a fixture; `view()` also catches any exception from recognition. |

### Major: scope and evidence

| # | Finding | Raised by | Decision |
|---|---|---|---|
| M9 | Scope follows the TODO list, not observed traffic. Fixtures and code come from the same reading of the specifications, so the tests cannot show that a real client is recognized. | ZO, IC, SY | Accepted in part. Phase 0 records an Apollo iOS sample app and is a gate for the release claims. Fixtures now use the field names of the session file, so a recorded request can be copied into a fixture after scrubbing. |
| M10 | `application/graphql` and the subscription wrapper are speculative for iOS clients. | ZO | Accepted. Both removed from scope and left in the README TODO. |
| M11 | The source index as a fallback for the type costs a synchronous walk of the app's source tree in `list` and `tail`, makes `view()` depend on the filesystem, and its looser pattern matches prose. | ZO, IC, DC, CD | Accepted. The source index is no longer used for the type. Its pattern change is limited to definitions that directly follow a quote character. |
| M12 | The Apollo header question was open but hard-coded in the steps. | SY, IR, CD, CO | Resolved by reading the Apollo iOS source. See below. |

### Major: document quality

| # | Finding | Raised by | Decision |
|---|---|---|---|
| M13 | No "Risks & Mitigations" section. | ST, DC | Added. |
| M14 | "Rejected by author:" attributes rejections to the maintainer without a link. | ST, DC | Prefix removed. |
| M15 | Claims stronger than the evidence: the title ("every common transport"), "exactly the same output", "proof", "every row has a fixture", "under five seconds", "most other users will have Apollo iOS". | SY, CO, ZO | Reworded to what is checked. |
| M16 | "As today" is used as the baseline, but today's behavior is not described. Output symbols have no legend. | CO | A "Current behavior" section and a legend were added. |
| M17 | Half the document is expression-level pseudo-code that already disagrees with the architecture section. | ZO | Accepted. The plan now gives files, signatures, rules and a full fixture table. |
| M18 | The fixture schema cannot express variables or part counts, expected values are missing for several fixtures, and the malformed-input rule is not met. | IR, CD, SY | Schema extended. Every fixture has expected values. |
| M19 | `views.test.ts` reads the developer's real `~/.simpeek/config.json` and environment. | IR, CD | The `test` script sets `SIMPEEK_DIR` to an empty temporary directory and clears the two other variables. |
| M20 | Files whose text describes the changed behavior are missing from the plan: tool descriptions in `mcp.ts`, the `AGENTS.md` layout line for workflows. `simpeek extract` on a multi-part response is unspecified. | CD | Added to the plan. `extract` is stated as unchanged. |

### Nits applied

Heading levels, counts ("nine rows", "three changes"), CI trigger wording, links for the external
specifications, `formField` matching `filename="operations"`, the HTTP 4xx case of an APQ miss,
the note that a missing retry is not flagged, `select` on multi-part responses, `bodyText` reading
a whole upload file, uncommitted README edits, and the one-commit-per-phase rule.

### Not applied

| Finding | Raised by | Reason |
|---|---|---|
| Persist the source index under `~/.simpeek/` with invalidation. | IC | No longer needed: the index is not used on the `list` path. |
| A `simpeek fixture <id>` command that scrubs a recorded entry into a fixture. | IC | Deferred to Future Improvements. A wrong scrubber would put real identifiers into the repository. Copying by hand keeps a person in that step. |
| A cross-session table of persisted-query hashes. | IC | A hash can map to different documents across app versions. The per-session table covers the miss-then-retry case. |
| Emit one NDJSON line per multipart chunk from the recorder. | IC | Recorder change; belongs to the capture rewrite. |
| Drop `RequestFacts` entirely and pass `Entry`. | ZO | Partly applied: `recognize` takes the existing `Request` type plus the body, so there is no parallel request type. |

## Type of a hash-only operation

Six reviewers found that CUJ 2 could not hold. The cause was that draft 1 gave a hash-only request
its type only from Apollo headers (unverified at the time) or from the source index.

Checked against the Apollo iOS source on 2026-11-13:

*   **1.15.0**, `Sources/Apollo/HTTPRequest.swift`, adds `X-APOLLO-OPERATION-NAME`,
    `X-APOLLO-OPERATION-TYPE` (`String(describing: Operation.operationType)`),
    `X-APOLLO-OPERATION-ID`, `apollographql-client-name` and `apollographql-client-version`.
    `JSONRequest.swift` omits the document on the first attempt when `autoPersistQueries` is on,
    and uses GET when `useGETForQueries` or `useGETForPersistedQueryRetry` applies. Mutations are
    always POST.
*   **`main` (2.x)**: `HTTPRequest.swift` no longer exists, and the `X-APOLLO-OPERATION-*` headers
    do not appear in `JSONRequest.swift`. Their removal from the whole repository was not
    confirmed. The client name and version headers remain.
*   Not confirmed from source: the lower-case spelling of the type value, the body keys built by
    the request body creator, and the multipart boundary and `deferSpec` strings.

Decision: the headers alone are not enough, because 2.x may not send them. Draft 2 uses, in order:
the document, the `X-APOLLO-OPERATION-TYPE` header, a per-session table from hash to type that is
filled when a request carries both a hash and a document, and then `?`. The table lives in
`views.ts`, next to the existing view cache, so `recognize` stays a function of one request. This
reverses the rejection of Alternative C in draft 1 for the single-session case.

## Checked and found correct by reviewers

*   All references to current code (function names, signatures, line-level behavior).
*   `node --test "test/**/*.test.ts"` runs TypeScript tests on Node 24.0.1 without warnings.
*   Tests are not published (`files` in `package.json`, `build.js` reads only `src/`).
*   The four version locations, the 10 MB response cap, and the full `Content-Type` (with
    `boundary`) in the recorded `mimeType`.
*   Phase 1 does not change behavior.
*   No existing multipart parser, document scanner or test harness in `cli/src` to reuse.
*   Rejecting the `graphql` package, and using `node --test`, fit the project conventions.

# Round 2 (draft 2)

Six reviewers: zoom-out, inventive catalyst, comprehension, design critic, implementation
readiness, codebase details. Structural and style were not run again, because the design was
still changing. All except comprehension received the round 1 report and were asked to verify
that its decisions were applied.

No Blocker. The round 1 Blocker is resolved: implementation readiness walked all 17 scanner cases
and all 48 fixture rows through the rules by hand, and codebase details ran the `test` script, the
second source pattern and the 0.1.0 behavior claims under Node 24.0.1.

## Findings and decisions

### Major

| # | Finding | Raised by | Decision in draft 3 |
|---|---|---|---|
| R1 | The hash-to-type table was filled while rendering. The claim that `list`, `ops` and `net_list` render the whole session first is false: filters run before rendering. The same request showed `?` or `Q` depending on filters, on the command (`get`, `timeline`) and, in the MCP server, on earlier calls. `list --type query` dropped a miss that plain `list` showed as `Q`. | IC, CO, ZO, DC, IR, CD | Accepted. One explicit session pass runs over all entries before any filter, in every command that has the session. `tail` is the stated exception. The "do not cache" rule is gone. Draft 2's approach is recorded as Alternative B. |
| R2 | A miss that is never retried was shown as a non-failure everywhere, and `net_wait` timed out with nothing. For a client that sends registered hashes only, the miss is the final error. | DC, IC | Accepted. The session pass marks a miss as retried or, after five seconds, abandoned. An abandoned miss is `✗ not persisted, no retry`, is failed, and is returned by `net_wait`. |
| R3 | A non-array `errors` was "ignored", which turned the crash into a false `ok`. | DC | Accepted. It counts as one error. |
| R4 | The miss rule sat behind the HTTP status check, so a server that answers a miss with 4xx still produced a false failure. | DC, IC | Accepted. The rule applies below HTTP 500 and is checked before the status. |
| R5 | GET on paths other than `/graphql`: `?query={shoes}` passed the guard and became `✗ invalid JSON`. No client is shown to send documents by GET to such a path. | ZO | Accepted. The URL carrier needs a `/graphql` path or a persisted-query hash. The selection-set rule of the scanner, which existed only as this guard, is removed. |
| R6 | `{"query":"mutation Foo"}` changed from `M Foo` to `Q (anonymous)` under the stricter scanner. | DC | Fixed by the same change: an operation no longer needs an open selection set. Fixture `post-json-no-braces`. |
| R7 | Uploads need their own byte-level parser, a file reader and binary fixtures, for a label on requests whose errors are already detected. The claim that they reuse the carrier code was wrong. | ZO | Accepted. Uploads are a Non-Goal and stay in the README TODO. `bodyHead`, `formField`, `bodyBase64` and `store.test.ts` are removed. |
| R8 | Phase 0 was numbered first, ran last and gated nothing; its questions decide design, not wording. No sample app was named and the outcomes were undefined. | ZO, CO, IR | Accepted. Phase 0 runs first, is limited to half a day, and has three defined results per shape: recorded, taken from a published wire example, or removed from the release. |
| R9 | The test for the `try` could not pass: the URL is read again outside the `try`. | IR, CD | Fixed. The throw is injected through `postData.text`, the `try` covers reading the body, and the message is kept and shown by `get`. |
| R10 | A catch that falls back to a plain line hides a defect as a false OK. | IC | Accepted: `get` prints `recognition failed: …`. |
| R11 | Compatibility goal contradicted the changes; the baseline step came after the work it must precede; the session for the `diff` was not pinned and could be deleted by the recorder. | CO, CD | Fixed. The goal names its exceptions. The baseline is taken in Phase 0 from a copy of the session, with `--bundle` and `--session`. |
| R12 | The plan was still expression-level detail and repeated rules that had already drifted apart. Fixture schema could not express "no variables"; several rows lacked expected values; header lookup did not state case handling. | ZO, IR, CD, CO | Accepted. Rules are stated once, in the Technical Plan. The plan gives signatures, files, complete fixture tables and case lists. Fixtures compare whole objects. |

### Smaller points applied

*   Boundary must be at the start of a line (fixture `defer-boundary-in-string`).
*   "N parts unreadable" replaced by a single "incomplete response" flag.
*   Learned types are keyed by hash and operation name.
*   The `X-APOLLO-OPERATION-NAME` fallback was removed as speculative.
*   Scanner: "word" is defined, keywords are case-sensitive, and the undecided inputs
    (`query @live`, `query A query B`, stray characters) have rules and cases.
*   "Current behavior" corrected: path match, `ops` grouping, the `query:` line of `get`, the
    exact 0.1.0 output of row 5, the recorder's replay and limits.
*   The source-index sentence no longer claims that comments cannot match.
*   No test writes outside a directory it created.
*   The release notes location and the version files are named.

### Not applied

| Finding | Raised by | Reason |
|---|---|---|
| Learn types from older sessions of the same app. | IC | Deferred (Alternative E) until Phase 0 shows whether current clients send the type header. The round 1 reason given for rejecting it was wrong: a hash identifies one document. |
| Drop type learning entirely and accept `?`. | ZO | The session pass is needed for retried misses anyway (R2); learning types in the same pass costs little once it exists. |
| Describe every existing function the plan names. | CO | The plan is written for a reader who has the repository. "Current behavior" covers what is needed to follow the design. |
| Collect `payload.errors` for subscriptions that the server ends normally. | DC | Subscriptions are a Non-Goal; such a response is shown by the multipart rules without those errors. Listed under "Open in draft 3". |
| Show `✗ truncated at 10MB` for a capped single document. | DC | Separate small change; not part of the six rows. |

# Round 3 (draft 3)

All eight reviewers. No Blocker. Three said Phase 0 can start (zoom-out, design critic, and
implementation readiness with "not ready" for the later phases). Implementation readiness walked
all 19 scanner cases and every fixture row by hand; codebase details ran the current code on the
"Current behavior" claims, the Problem rows and the Phase 1 fixtures, all confirmed.

## Findings and decisions

### Major

| # | Finding | Raised by | Decision in draft 4 |
|---|---|---|---|
| T1 | The view cache stores label, state and `failed`. `waitFor` and `tail` keep the same Entry objects across polls, so a miss cached as `↻` never became abandoned, and CUJ 3 could not happen. | DC, IR, CD | The cache holds only recognition (operations, outcome). Label, state and `failed` are computed on every read from the latest pass result. Test that reads a miss before and after a `poll()`. |
| T2 | Abandonment depended on the time the command ran: `list` on an unchanged file gave different output over time; a debugger pause or a finished session read days later looked like an abandoned miss. | IC, ZO, DC | Decided from the files only: the first later request with the same hash (started after the miss's arrival) decides retried or abandoned; with none, a request starting W seconds later or a newer session decides abandoned; otherwise pending. Recorded as Alternative D. |
| T3 | Nothing forced a command to run the pass; `tail --history` and `extract` were missing from the list. | IC, ZO, CD, IR | All rendering goes through a `Session` from `openSession`, which runs the pass. `tail` (history and live) and `extract` included. Call sites listed. |
| T4 | `tail` never corrected a miss later found abandoned; `net_wait` with a short timeout reported "nothing happened" during a pending miss. | IC, DC | `tail` prints a correction line; `net_wait` returns pending misses with a note on timeout. |
| T5 | The false-failure fixes came last, so the session pass entered for type learning alone. | ZO | Phases reordered: tests and crash, then row 4, then rows 1 and 2 with the pass, then rows 3, 5, 6. A release can follow Phase 3. |
| T6 | A recognition exception rendered as a plain HTTP line, a false success; non-array values inside deferred parts could trigger it. The test for it could not pass because `detail()` read the throwing body again. | DC, ZO, IR, CD | `✗ recognition failed`, counted as failed. The non-array rule covers parts and `incremental`. `detail()` guards the body read. |
| T7 | Retry detection undefined for batches, for "later", for concurrent misses, and for a hash-only request without `operationName`. | DC, IR | Defined per hash, by id after the miss's arrival (`startMs + time`); a batch is retried when every hash is. The name is learned from the retry's document. Mixed batch (miss plus data) stays `partial`, stated. |
| T8 | Deferred responses: cut right at a delimiter showed `ok`; empty header blocks were not parts; a 10 MB cut inside a character became the `<binary>` placeholder and `✗ invalid JSON`; a mislabeled single document lost its error. | DC, CD | Incomplete also when the closing delimiter is missing or the last part has `hasNext: true`; empty header blocks allowed; lossy decoding for responses; no delimiter line means read as a single document. Fixtures for each. |
| T9 | The list of allowed output changes disagreed in three places and missed rows 1, 3, 4. | SY, ST, ZO, CO, CD | One list, "intended changes", in Goals; NFR and the Verification Plan refer to it. |
| T10 | Phase 0 had no outcome for a recording that contradicts a rule, no row dependencies, and unconditional shipped texts. | IR, CO | Four outcomes; row 2 requires row 1; a table gives each text per row, Chinese included. W is derived from the measured interval. |
| T11 | The README TODO removed "Detect GraphQL by headers", which was rejected, not done; a risk pointed at a TODO item that does not exist. | ST, CO, IR | The item stays; the goal says rejected items stay. The pointer is removed. |
| T12 | Hand-written fixtures versus the ship rule were unrelated; hashes were not 64 characters. | CO | Each fixture has a `source`; the ship rule names which sources count. Hashes are 64 hex characters. |
| T13 | Unsupported numbers and claims: five seconds, 200 ms, half a day, "Apollo sends this header", "no client is known". | SY | W is provisional and measured in Phase 0; 200 ms is called a judgment, with session, runs and the action when exceeded; half a day has an end rule; the header is "source read, not recorded"; the GET path rule is stated as a trade-off. |

### Smaller points applied

The miss rule requires at least one operation; scanner reads strings first (three new cases);
"next token" defined; URL parameters come from `request.url`; `fromUrl` uses the same text as the
carrier; the `waitFor` selection is named (`waitSelection`); `get` in the baseline is pinned to the
session; timing covers `get` and `timeline`; the test script removes its directory; the release
notes command is named; CUJ 2 states which filters it covers; CUJ 7 includes `npm ci`.

### Not applied

| Finding | Raised by | Reason |
|---|---|---|
| `CLAUDE.md` repeats the old text and must be updated. | ST | It contains only `@AGENTS.md`. |
| Fall back to the 0.1.0 head rule when the scanner finds nothing. | DC | Already the behavior for JSON bodies (`query` with no operation is a query); `post-json-no-braces` pins it. |
| Show a distinct state when the session ended within W of a miss. | DC | The newer-session rule marks it abandoned, which is accurate: the client did not retry before it was terminated. |

## Open in draft 4

*   Draft 4 has not been reviewed. Its new parts are the `Session` object, the file-based
    abandonment rule, the `tail` correction line, the `net_wait` timeout note and the phase order.
*   A session that goes silent after a miss and is not relaunched keeps the miss pending in `list`.
*   Batched persisted queries with mixed results show `partial`.
*   Whether the sample app for Phase 0 builds, and W, are unknown until Phase 0.
