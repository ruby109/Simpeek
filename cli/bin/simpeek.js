#!/usr/bin/env -S node --no-warnings
// A checkout runs the TypeScript sources directly; the published package ships only dist/.
import fs from 'node:fs';

const src = new URL('../src/cli.ts', import.meta.url);
await import(fs.existsSync(src) ? src.href : new URL('../dist/cli.js', import.meta.url).href);
