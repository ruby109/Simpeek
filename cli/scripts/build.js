// Builds the published package: strips types from src/**/*.ts into dist/**/*.js (Node refuses to
// strip types under node_modules) and copies the simulator dylib into vendor/.
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const dylib = path.resolve(root, '../ios/build/SimPeek.dylib');

fs.rmSync(dist, { recursive: true, force: true });
for (const rel of fs.readdirSync(src, { recursive: true })) {
  if (!rel.endsWith('.ts')) continue;
  const js = stripTypeScriptTypes(fs.readFileSync(path.join(src, rel), 'utf8'))
    .replace(/(\b(?:from\s+|import\s*\(\s*)['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2');
  const out = path.join(dist, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, js);
}

if (!fs.existsSync(dylib)) throw new Error(`${dylib} not found; run ios/scripts/build-dylib.sh`);
fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
fs.copyFileSync(dylib, path.join(root, 'vendor/SimPeek.dylib'));
for (const f of ['README.md', 'LICENSE']) fs.copyFileSync(path.join(root, '..', f), path.join(root, f));
