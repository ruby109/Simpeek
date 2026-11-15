// Runs every fixture in fixtures/: one test per file. A fixture holds a request (and optionally a
// response) in the field names of the session file, and the expected operations and outcome.
// A fixture with a `todo` field describes behavior of a later phase and is reported, not failed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { outcome, recognize, type GqlOutcome, type Operation } from '../src/graphql.ts';
import type { Request, Response } from '../src/store.ts';

type Fixture = {
  source: string;
  todo?: string;
  request: Request;
  response?: Pick<Response, 'status' | 'content'>;
  expect: { ops: unknown[] | null; outcome: unknown | null };
};

const dir = path.join(import.meta.dirname, 'fixtures');

const opFacts = (o: Operation & { hash?: string }) => ({
  type: o.type ?? null,
  name: o.name,
  hash: o.hash ?? null,
  hasQuery: o.query !== undefined,
  variables: o.variables ?? null,
});

const outcomeFacts = (g: GqlOutcome & { parts?: unknown[]; incomplete?: boolean }) => ({
  status: g.status,
  codes: g.errors.map((e) => e.code ?? null),
  parts: g.parts?.length ?? null,
  incomplete: !!g.incomplete,
});

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const f: Fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  test(file.replace(/\.json$/, ''), { todo: f.todo }, () => {
    const ops = recognize(f.request, f.request.postData?.text);
    assert.deepEqual(ops?.map(opFacts) ?? null, f.expect.ops);
    const g = f.response && ops ? outcome(f.response, f.response.content.text, ops) : undefined;
    assert.deepEqual(g ? outcomeFacts(g) : null, f.expect.outcome);
  });
}
