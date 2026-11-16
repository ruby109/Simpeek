// The document scanner: which top-level operations a document defines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanDocument } from '../src/graphql.ts';

const cases: [string, string[]][] = [
  ['query A { a }', ['query A']],
  ['{ a }', ['query']],
  ['query { a }', ['query']],
  ['query @live { a }', ['query']],
  ['query A { a } mutation B { b }', ['query A', 'mutation B']],
  ['fragment F on T { x } mutation B { ...F }', ['mutation B']],
  ['mutation B { ...F } fragment F on T { x }', ['mutation B']],
  ['fragment query on Query { x } query A { a }', ['query A']],
  ['query S($query: String = "x", $f: F = {a: 1}) @d(arg: {a: 1}) { s }', ['query S']],
  ['"""mutation X { x }""" query A { a }', ['query A']],
  ['# query Y { y }\nquery A { a }', ['query A']],
  ['query A { a(x: "} mutation Fake {") }', ['query A']],
  ['query A { a(x: ")") } mutation B { b }', ['query A', 'mutation B']],
  ['query A { a(x: "#") } mutation B { b }', ['query A', 'mutation B']],
  ['query A { a(x: "\\")") } mutation B { b }', ['query A', 'mutation B']],
  ['mutation Foo', ['mutation Foo']],
  ['query A query B { b }', ['query A']],
  ['Query A { a }', []],
  ['query A { a(x: "unterminated', ['query A']],
  ['query A {', ['query A']],
  ['} ) @ $ query A { a }', ['query A']],
  ['', []],
];

for (const [doc, expected] of cases) {
  test(JSON.stringify(doc), () => {
    assert.deepEqual(scanDocument(doc).map((d) => (d.name ? `${d.type} ${d.name}` : d.type)), expected);
  });
}
