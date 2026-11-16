// Rendering and the session pass: rows, filters, details and stats built from in-memory entries,
// or from session files written into the test's SIMPEEK_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, type Entry, type SessionInfo } from '../src/store.ts';
import { applyFilters, detail, openSession, opsTable, row, Session, tailLine, waitSelection } from '../src/views.ts';

const info: SessionInfo = { bundle: 'com.example.app', session: 's1', file: '', mtimeMs: 0, meta: {} };

function entry(id: number, postData: Entry['request']['postData'], responseText: string): Entry {
  return {
    id, startedDateTime: '2026-01-01T00:00:00.000Z', startMs: 0, done: true, time: 5,
    request: { method: 'POST', url: 'https://api.example.com/api/graphql', headers: [], queryString: [], postData },
    response: {
      status: 200, statusText: 'OK', httpVersion: 'h2', headers: [], redirectURL: '',
      content: { mimeType: 'application/json', text: responseText, size: responseText.length },
    },
  };
}

/** A session over entries built in memory. */
function memory(...entries: Entry[]): Session {
  return new Session(info, { entries: new Map(entries.map((e) => [e.id, e])), all: () => entries });
}

// ---------- phase 1: recognition failures ----------

test('an exception during recognition is shown as a failure', () => {
  const postData = { mimeType: 'application/json', get text(): string { throw new Error('boom'); } };
  const e = entry(1, postData, '{}');
  const s = memory(e);
  assert.match(row(e, s), /✗ recognition failed/);
  assert.equal(applyFilters([e], s, { status: 'error' }).kept.length, 1);
  const d = detail(e, s);
  assert.match(d, /recognition failed: boom/);
  assert.match(d, /request body: \(unreadable\)/);
});

test('a response whose errors is an object is a failure', () => {
  const e = entry(2, { mimeType: 'application/json', text: '{"query":"query Posts{posts{id}}"}' }, '{"errors":{"field":"msg"}}');
  assert.match(row(e, memory(e)), /Q Posts\s+✗/);
});

// ---------- phase 2: deferred responses ----------

const CT = 'multipart/mixed; boundary="-"; deferSpec=20220824';
const part = (json: string) => `---\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${json}\r\n`;
const query = { mimeType: 'application/json', text: '{"query":"query Posts{posts{id}}"}' };

function deferred(id: number, text: string): Entry {
  const e = entry(id, query, text);
  e.response!.content.mimeType = CT;
  return e;
}

test('a deferred response with an error in a later part', () => {
  const e = deferred(3, '\r\n' + part('{"data":{"posts":[]},"hasNext":true}')
    + part('{"incremental":[{"errors":[{"message":"x","extensions":{"code":"NOT_FOUND"}}],"path":["posts"]}],"hasNext":false}')
    + '-----\r\n');
  const s = memory(e);
  assert.match(row(e, s), /⚠ partial: NOT_FOUND/);
  assert.match(detail(e, s), /parts \(2, trimmed\):/);
  assert.match(detail(e, s, { select: '[1].incremental[0].path' }), /posts/);
});

test('a deferred response that is cut off', () => {
  const e = deferred(4, '\r\n' + part('{"data":{"posts":[]},"hasNext":true}') + '---\r\ncontent-type: application/json\r\n\r\n{"incremental":[{"da');
  const s = memory(e);
  assert.match(row(e, s), /⚠ partial: incomplete response/);
  assert.match(detail(e, s), /\(incomplete response\)/);
});

// ---------- phase 3: persisted queries and the session pass ----------

const H1 = 'ab12cd34ef567890'.repeat(4);
const H2 = 'cd34ab12ef567890'.repeat(4);
const pq = (hash: string) => ({ persistedQuery: { version: 1, sha256Hash: hash } });
const MISS = '{"errors":[{"message":"PersistedQueryNotFound","extensions":{"code":"PERSISTED_QUERY_NOT_FOUND"}}]}';
const OK = '{"data":{"posts":[]}}';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

/** A request: `body` is the JSON body; `start` and `end` are seconds after T0 (no end: in flight). */
type Req = { body: unknown; start: number; end?: number; response?: string; status?: number };

let sessionCounter = 0;

/** Writes a session file with these requests into the test's SIMPEEK_DIR and opens it. */
function sessionFile(reqs: Req[], name = `s${++sessionCounter}`): { s: Session; file: string; append: (r: Req) => void } {
  assert.ok(process.env.SIMPEEK_DIR, 'run through npm test, which sets SIMPEEK_DIR');
  const dir = path.join(ROOT, 'com.example.app');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.ndjson`);
  let id = 0;
  const lines = (r: Req) => {
    const n = ++id;
    const out = [{ _type: 'start', _id: n, startedDateTime: new Date(T0 + r.start * 1000).toISOString(), request: {
      method: 'POST', url: 'https://api.example.com/', headers: [], queryString: [],
      postData: { mimeType: 'application/json', text: JSON.stringify(r.body) },
    } }];
    if (r.end !== undefined) {
      const text = r.response ?? OK;
      out.push({ _type: 'end', _id: n, time: Math.round((r.end - r.start) * 1000), response: {
        status: r.status ?? 200, statusText: '', httpVersion: '', headers: [], redirectURL: '',
        content: { mimeType: 'application/json', text, size: text.length },
      } } as any);
    }
    return out.map((l) => JSON.stringify(l) + '\n').join('');
  };
  const session = JSON.stringify({ _type: 'session', _session: name, bundle: 'com.example.app', pid: 0, startedDateTime: new Date(T0).toISOString() }) + '\n';
  fs.writeFileSync(file, session + reqs.map(lines).join(''));
  const old = new Date(Date.now() - 3600_000 + sessionCounter * 1000); // keep later sessions newer
  fs.utimesSync(file, old, old);
  const s = openSession({ bundle: 'com.example.app', session: name, file, mtimeMs: old.getTime(), meta: {} });
  return { s, file, append: (r: Req) => fs.appendFileSync(file, lines(r)) };
}

const hashOnly = (hash = H1, name: string | undefined = 'Posts') => ({ ...(name ? { operationName: name } : {}), variables: { first: 2 }, extensions: pq(hash) });
const withDoc = (hash = H1) => ({ ...hashOnly(hash), query: 'query Posts($first: Int) { posts(first: $first) { id } }' });
const miss = (start = 0, end = 1, status?: number): Req => ({ body: hashOnly(), start, end, response: MISS, status });
const retry = (start = 1.001, end: number | undefined = 1.2): Req => ({ body: withDoc(), start, end });

test('a miss followed by its retry is not a failure, and learns its type', () => {
  const { s } = sessionFile([miss(), retry()]);
  const [m, r] = s.all();
  assert.match(row(m, s), /Q Posts\s+↻ not persisted/);
  assert.equal(applyFilters(s.all(), s, { type: 'query' }).kept.length, 2);
  assert.equal(applyFilters(s.all(), s, { status: 'error' }).kept.length, 0);
  assert.equal(applyFilters(s.all(), s, { status: 'gqlerror' }).kept.length, 0);
  assert.equal(applyFilters(s.all(), s, { status: 'ok' }).kept.length, 2);
  const table = opsTable(s.all(), s).split('\n');
  assert.equal(table.length, 2);
  assert.match(table[1], /^Q Posts\s+2\s+0\s/);
  assert.match(detail(m, s).split('\n')[0], /Q Posts/);
  assert.match(detail(m, s), /persisted \(sha256 ab12cd34ef56…\), document not sent/);
  assert.match(tailLine('end', m, s), /←/);
  assert.deepEqual(waitSelection(s, {}, 0).matches.map((e) => e.id), [r.id]);
});

test('a hash-only request alone has an unknown type', () => {
  const { s } = sessionFile([{ body: hashOnly(), start: 0, end: 0.1 }]);
  const [e] = s.all();
  assert.match(row(e, s), /\? Posts\s+ok/);
  assert.equal(applyFilters(s.all(), s, { type: 'query' }).kept.length, 0);
  assert.match(detail(e, s, { query: true }), /persisted \(sha256 ab12cd34ef56…\)/);
});

test('a miss with no later request is pending', () => {
  const { s } = sessionFile([miss()]);
  const [m] = s.all();
  assert.equal(s.missState(m), 'pending');
  assert.match(row(m, s), /↻ not persisted/);
  const w = waitSelection(s, {}, 0);
  assert.deepEqual([w.matches.length, w.pending.length], [0, 1]);
});

test('a miss is abandoned when another request starts after the window', () => {
  const { s } = sessionFile([miss(), { body: { query: '{ a }' }, start: 4, end: 4.1 }]);
  const [m] = s.all();
  assert.match(row(m, s), /✗ no retry: not persisted/);
  assert.equal(applyFilters(s.all(), s, { status: 'error' }).kept.length, 1);
  assert.deepEqual(waitSelection(s, {}, 0).matches.map((e) => e.id), [1, 2]);
});

test('a miss is abandoned when the app was launched again', () => {
  const { s } = sessionFile([miss()]);
  sessionFile([]); // a newer session of the same app
  s.poll();
  assert.equal(s.missState(s.all()[0]), 'abandoned');
});

test('a miss is abandoned when the next request with its hash sends the hash only', () => {
  const { s } = sessionFile([miss(), { body: hashOnly(), start: 1.5, end: 1.6 }]);
  assert.equal(s.missState(s.all()[0]), 'abandoned');
});

test('a retry that has started but not finished counts', () => {
  const { s } = sessionFile([miss(), retry(1.001, undefined)]);
  assert.equal(s.missState(s.all()[0]), 'retried');
});

test('two misses for the same hash and one retry', () => {
  const { s } = sessionFile([miss(0, 1), miss(0, 1), retry()]);
  const [a, b] = s.all();
  assert.deepEqual([s.missState(a), s.missState(b)], ['retried', 'retried']);
});

test('a miss without operationName learns the name from its retry', () => {
  const { s } = sessionFile([{ body: hashOnly(H1, undefined), start: 0, end: 1, response: MISS }, retry()]);
  assert.match(row(s.all()[0], s), /Q Posts\s+↻ not persisted/);
});

test('a miss answered with HTTP 404 is still a miss', () => {
  const { s } = sessionFile([miss(0, 1, 404), retry()]);
  assert.match(row(s.all()[0], s), /↻ not persisted/);
});

test('a miss read again after a poll in the same process', () => {
  const { s, append } = sessionFile([miss()]);
  const [m] = s.all();
  assert.match(row(m, s), /↻ not persisted/);
  append({ body: { query: '{ a }' }, start: 4, end: 4.1 });
  s.poll();
  assert.match(row(m, s), /✗ no retry: not persisted/);
});

test('a batch miss is retried only when every hash is', () => {
  const batch = [hashOnly(H1, 'A'), hashOnly(H2, 'B')];
  const batchMiss: Req = { body: batch, start: 0, end: 1, response: `[${MISS},${MISS}]` };
  const later: Req = { body: { query: '{ a }' }, start: 4, end: 4.1 };
  const one = sessionFile([batchMiss, { body: [withDoc(H1)], start: 1.01, end: 1.1 }, later]);
  assert.equal(one.s.missState(one.s.all()[0]), 'abandoned');
  const both = sessionFile([batchMiss, { body: [withDoc(H1), withDoc(H2)], start: 1.01, end: 1.1 }, later]);
  assert.equal(both.s.missState(both.s.all()[0]), 'retried');
});
