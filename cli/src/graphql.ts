// GraphQL awareness: operation names from the request body, outcome from the response `errors`.
import type { Entry } from './store.ts';

export type OpType = 'query' | 'mutation' | 'subscription';
export type Operation = { type: OpType; name: string; query: string; variables?: unknown };
export type GqlError = { message: string; path?: string; code?: string };
export type GqlOutcome = { status: 'ok' | 'errors' | 'partial' | 'invalid'; errors: GqlError[] };

const GRAPHQL_PATH = /\/graphql\/?$/i;

/** Operations carried by a request, or undefined when it is not GraphQL. Handles batched arrays. */
export function parseOperations(entry: Entry, bodyText?: string): Operation[] | undefined {
  const text = bodyText ?? entry.request.postData?.text;
  let pathname = '';
  try { pathname = new URL(entry.request.url).pathname; } catch { /* keep empty */ }
  if (!text) return GRAPHQL_PATH.test(pathname) ? [] : undefined;

  let body: unknown;
  try { body = JSON.parse(text); } catch { return GRAPHQL_PATH.test(pathname) ? [] : undefined; }
  const items = Array.isArray(body) ? body : [body];
  const ops: Operation[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof (item as any).query !== 'string') continue;
    const { query, variables, operationName } = item as { query: string; variables?: unknown; operationName?: string };
    const parsed = parseHead(query, operationName);
    ops.push({ ...parsed, query, variables });
  }
  if (ops.length === 0 && !GRAPHQL_PATH.test(pathname)) return undefined;
  return ops;
}

function parseHead(query: string, operationName?: string): { type: OpType; name: string } {
  const stripped = query.replace(/#[^\n]*/g, '');
  const m = stripped.match(/^\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/);
  const type = (m?.[1] as OpType) ?? 'query';
  return { type, name: operationName || m?.[2] || '(anonymous)' };
}

export function outcome(responseText?: string): GqlOutcome | undefined {
  if (responseText === undefined) return undefined;
  let body: any;
  try { body = JSON.parse(responseText); } catch { return { status: 'invalid', errors: [] }; }
  const results = Array.isArray(body) ? body : [body];
  const errors: GqlError[] = [];
  let hasData = false;
  for (const r of results) {
    if (r && r.data != null) hasData = true;
    for (const e of (r?.errors ?? []) as any[]) {
      errors.push({
        message: String(e?.message ?? ''),
        path: Array.isArray(e?.path) ? e.path.join('.') : undefined,
        code: e?.extensions?.code ?? e?.extensions?.errorCode ?? e?.code,
      });
    }
  }
  if (errors.length === 0) return { status: 'ok', errors };
  return { status: hasData ? 'partial' : 'errors', errors };
}

export const typeLetter = (t: OpType) => (t === 'mutation' ? 'M' : t === 'subscription' ? 'S' : 'Q');
