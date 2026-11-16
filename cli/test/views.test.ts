// Rendering: rows, filters and details built from in-memory entries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry, SessionInfo } from '../src/store.ts';
import { applyFilters, detail, row } from '../src/views.ts';

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

test('an exception during recognition is shown as a failure', () => {
  const postData = { mimeType: 'application/json', get text(): string { throw new Error('boom'); } };
  const e = entry(1, postData, '{}');
  assert.match(row(e, info), /✗ recognition failed/);
  assert.equal(applyFilters([e], info, { status: 'error' }).kept.length, 1);
  const d = detail(e, info);
  assert.match(d, /recognition failed: boom/);
  assert.match(d, /request body: \(unreadable\)/);
});

test('a response whose errors is an object is a failure', () => {
  const e = entry(2, { mimeType: 'application/json', text: '{"query":"query Posts{posts{id}}"}' }, '{"errors":{"field":"msg"}}');
  assert.match(row(e, info), /Q Posts\s+✗/);
});

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
  assert.match(row(e, info), /⚠ partial: NOT_FOUND/);
  assert.match(detail(e, info), /parts \(2, trimmed\):/);
  assert.match(detail(e, info, { select: '[1].incremental[0].path' }), /posts/);
});

test('a deferred response that is cut off', () => {
  const e = deferred(4, '\r\n' + part('{"data":{"posts":[]},"hasNext":true}') + '---\r\ncontent-type: application/json\r\n\r\n{"incremental":[{"da');
  assert.match(row(e, info), /⚠ partial: incomplete response/);
  assert.match(detail(e, info), /\(incomplete response\)/);
});
