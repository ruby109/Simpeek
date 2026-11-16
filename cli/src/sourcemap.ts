// Maps GraphQL operation names to where they are defined in the app's source tree.
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './store.ts';

const SKIP_DIRS = new Set(['.git', '.build', 'build', 'DerivedData', 'Pods', 'Carthage', 'node_modules', '.claude', '.swiftpm']);
const EXTENSIONS = new Set(['.swift', '.graphql', '.gql', '.m', '.kt', '.ts', '.js']);
const DEFINITION = /^\s*(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)\s*[({]/;
/**
 * A definition in a one-line string literal, e.g. `"query Foo { … }"` or Apollo's generated
 * `#"query Foo($id: ID!) { … }"#`. Needs a quote right before the keyword, so prose and comments
 * rarely match; a quoted definition in a comment or a log message still does.
 */
const QUOTED_DEFINITION = /["'`]\s*(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)\s*[({@]/g;

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

/** Operation name → definitions in the source tree under `root`. Exported for tests. */
export function buildIndex(root: string): Map<string, Location[]> {
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
          const names = new Set<string>();
          const m = line.match(DEFINITION);
          if (m) names.add(m[2]);
          for (const q of line.matchAll(QUOTED_DEFINITION)) names.add(q[2]);
          for (const name of names) {
            const list = index.get(name) ?? [];
            list.push({ file: path.relative(root, full), line: i + 1 });
            index.set(name, list);
          }
        });
      }
    }
  };
  walk(root);
  return index;
}
