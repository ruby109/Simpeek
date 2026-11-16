// The source index: where operations are defined in an app's source tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildIndex } from '../src/sourcemap.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simpeek-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('definitions at line start and in one-line strings', () => {
  fs.writeFileSync(path.join(dir, 'a.graphql'), 'query Posts {\n  posts { id }\n}\n');
  fs.writeFileSync(path.join(dir, 'b.swift'), '// b\n\nlet q = "mutation UpdatePost($id: ID!) { updatePost(id: $id) { id } }"\n');
  fs.writeFileSync(path.join(dir, 'c.swift'), '// this query returns { id }\n// subscription expires (soon)\n// see the requery Thing {\n');
  fs.writeFileSync(path.join(dir, 'd.swift'), 'log("query failed (\\(code))")\n');
  const index = buildIndex(dir);
  assert.deepEqual(Object.fromEntries([...index].map(([name, locs]) => [name, locs])), {
    Posts: [{ file: 'a.graphql', line: 1 }],
    UpdatePost: [{ file: 'b.swift', line: 3 }],
    failed: [{ file: 'd.swift', line: 1 }], // documented false match: a quoted log message
  });
});
