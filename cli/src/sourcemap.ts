// Maps GraphQL operation names to where they are defined in the app's source tree.
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './store.ts';

const SKIP_DIRS = new Set(['.git', '.build', 'build', 'DerivedData', 'Pods', 'Carthage', 'node_modules', '.claude', '.swiftpm']);
const EXTENSIONS = new Set(['.swift', '.graphql', '.gql', '.m', '.kt', '.ts', '.js']);
const DEFINITION = /^\s*(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)\s*[({]/;

export type Location = { file: string; line: number };

const indexes = new Map<string, Map<string, Location[]>>();

export function projectRoot(bundle: string): string | undefined {
  return process.env.SIMPEEK_PROJECT || readConfig().projects?.[bundle];
}

export function findOperation(bundle: string, name: string): Location[] {
  const root = projectRoot(bundle);
  if (!root) return [];
  let index = indexes.get(root);
  if (!index) {
    index = buildIndex(root);
    indexes.set(root, index);
  }
  return index.get(name) ?? [];
}

function buildIndex(root: string): Map<string, Location[]> {
  const index = new Map<string, Location[]>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (EXTENSIONS.has(path.extname(e.name))) {
        let text: string;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (!/(query|mutation|subscription)\s/.test(text)) continue;
        text.split('\n').forEach((line, i) => {
          const m = line.match(DEFINITION);
          if (!m) return;
          const list = index.get(m[2]) ?? [];
          list.push({ file: path.relative(root, full), line: i + 1 });
          index.set(m[2], list);
        });
      }
    }
  };
  walk(root);
  return index;
}
