// GraphQL awareness: operation names from the request body, outcome from the response `errors`.
import type { Request, Response } from './store.ts';

export type OpType = 'query' | 'mutation' | 'subscription';
export type Operation = { type: OpType; name: string; query: string; variables?: unknown };
export type GqlError = { message: string; path?: string; code?: string };
export type GqlOutcome = { status: 'ok' | 'errors' | 'partial' | 'invalid'; errors: GqlError[] };

const GRAPHQL_PATH = /\/graphql\/?$/i;

/**
 * Operations carried by a request, or undefined when it is not GraphQL. Handles batched arrays.
 * `text` is the request body as text.
 */
export function recognize(request: Request, text: string | undefined): Operation[] | undefined {
  let pathname = '';
  try { pathname = new URL(request.url).pathname; } catch { /* keep empty */ }
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

/**
 * Outcome of a GraphQL response. `text` is the response body as text; `ops` are the request's
 * operations.
 */
export function outcome(
  response: Pick<Response, 'status' | 'content'> | undefined, text: string | undefined, ops: Operation[],
): GqlOutcome | undefined {
  void response; void ops; // used by the multipart and persisted-query rules
  if (text === undefined) return undefined;
  let body: any;
  try { body = JSON.parse(text); } catch { return { status: 'invalid', errors: [] }; }
  const results = Array.isArray(body) ? body : [body];
  const errors: GqlError[] = [];
  let hasData = false;
  for (const r of results) {
    if (r && r.data != null) hasData = true;
    errors.push(...collectErrors(r?.errors));
  }
  if (errors.length === 0) return { status: 'ok', errors };
  return { status: hasData ? 'partial' : 'errors', errors };
}

/**
 * Errors of an `errors` value. A value that is neither absent, null nor an array counts as one
 * error whose message is the value as JSON.
 */
function collectErrors(value: unknown): GqlError[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [{ message: (JSON.stringify(value) ?? '').slice(0, 200) }];
  return value.map((e: any) => ({
    message: String(e?.message ?? ''),
    path: Array.isArray(e?.path) ? e.path.join('.') : undefined,
    code: e?.extensions?.code ?? e?.extensions?.errorCode ?? e?.code,
  }));
}

export const typeLetter = (t: OpType) => (t === 'mutation' ? 'M' : t === 'subscription' ? 'S' : 'Q');
