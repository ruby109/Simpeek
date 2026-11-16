// GraphQL awareness: operation names from the request body, outcome from the response `errors`.
import type { Request, Response } from './store.ts';

export type OpType = 'query' | 'mutation' | 'subscription';
export type Operation = { type: OpType; name: string; query: string; variables?: unknown };
export type GqlError = { message: string; path?: string; code?: string };
export type GqlOutcome = {
  status: 'ok' | 'errors' | 'partial' | 'invalid';
  errors: GqlError[];
  /** Readable parts of a multipart/mixed (deferred) response; set when there is at least one. */
  parts?: object[];
  /** A multipart response that is cut off, truncated, or has a part that cannot be read. */
  incomplete?: boolean;
};

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
  void ops; // used by the persisted-query rule
  if (text === undefined) return undefined;
  const mixed = multipart(response?.content.mimeType, text);
  if (mixed) return mixedOutcome(mixed, !!response?.content._truncated);
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

type Multipart = { readable: object[]; unreadable: number; closed: boolean };

/**
 * The parts of a multipart/mixed body, or undefined when the body is not one: another media type,
 * no boundary parameter, or no delimiter line (then it is read as a single document). Delimiters
 * are whole lines, `--<boundary>` and `--<boundary>--`, so a boundary of `-` (Apollo Server) works.
 */
function multipart(mimeType: string | undefined, text: string): Multipart | undefined {
  const [media, ...params] = (mimeType ?? '').split(';');
  if (media.trim().toLowerCase() !== 'multipart/mixed') return undefined;
  const param = params.map((p) => p.trim()).find((p) => /^boundary=/i.test(p));
  if (!param) return undefined;
  const boundary = param.slice('boundary='.length).replace(/^"(.*)"$/, '$1');
  const open = `--${boundary}`;
  const close = `--${boundary}--`;
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  if (!lines.includes(open)) return undefined;

  const pieces: string[][] = [];
  let current: string[] | undefined; // undefined before the first delimiter (preamble)
  let closed = false;
  for (const line of lines) {
    if (line === close) { closed = true; break; }
    if (line === open) { current = []; pieces.push(current); continue; }
    current?.push(line);
  }

  const result: Multipart = { readable: [], unreadable: 0, closed };
  for (const piece of pieces) {
    const blank = piece.indexOf('');
    if (blank < 0) continue; // no header block / body separator: not a part
    const body = piece.slice(blank + 1).join('\n').trim();
    if (!body) continue;
    let value: unknown;
    try { value = JSON.parse(body); } catch { value = undefined; }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.readable.push(value);
    else result.unreadable++;
  }
  return result;
}

function mixedOutcome(m: Multipart, truncated: boolean): GqlOutcome {
  if (m.readable.length === 0) return { status: 'invalid', errors: [] };
  const errors: GqlError[] = [];
  let hasData = false;
  for (const part of m.readable as any[]) {
    errors.push(...collectErrors(part.errors));
    if (part.data != null) hasData = true;
    if (Array.isArray(part.incremental)) {
      if (part.incremental.length) hasData = true;
      for (const item of part.incremental) errors.push(...collectErrors(item?.errors));
    }
  }
  const last = m.readable.at(-1) as any;
  const incomplete = m.unreadable > 0 || truncated || !m.closed || last.hasNext === true;
  const status = errors.length && !hasData ? 'errors' : errors.length || incomplete ? 'partial' : 'ok';
  return { status, errors, parts: m.readable, ...(incomplete ? { incomplete } : {}) };
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
