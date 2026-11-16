// GraphQL awareness: operation names from the request body, outcome from the response `errors`.
import type { Request, Response } from './store.ts';

export type OpType = 'query' | 'mutation' | 'subscription';
/**
 * One operation of a request. `type` is undefined when the request sent only a persisted-query
 * hash and no header names the type. `query` is undefined for a hash-only operation.
 */
export type Operation = { type?: OpType; name: string; query?: string; variables?: unknown; hash?: string };
export type GqlError = { message: string; path?: string; code?: string };
export type GqlOutcome = {
  status: 'ok' | 'errors' | 'partial' | 'invalid' | 'miss';
  errors: GqlError[];
  /** Readable parts of a multipart/mixed (deferred) response; set when there is at least one. */
  parts?: object[];
  /** A multipart response that is cut off, truncated, or has a part that cannot be read. */
  incomplete?: boolean;
};

const GRAPHQL_PATH = /\/graphql\/?$/i;

/**
 * Operations carried by a request, or undefined when it is not GraphQL. Handles batched arrays.
 * `text` is the request body as text. A request with a body is read from the body (JSON); one
 * without, from its URL parameters (GET).
 */
export function recognize(request: Request, text: string | undefined): Operation[] | undefined {
  let url: URL | undefined;
  try { url = new URL(request.url); } catch { /* not a URL */ }
  const graphqlPath = GRAPHQL_PATH.test(url?.pathname ?? '');

  let raw: unknown[] = [];
  if (text) {
    try {
      const body: unknown = JSON.parse(text);
      raw = Array.isArray(body) ? body : [body];
    } catch { /* not JSON: no operations */ }
  } else if (url) {
    raw = urlItems(url, graphqlPath);
  }

  const items = raw.map(operationItem).filter((x) => x !== undefined);
  const headerType = items.length === 1 ? typeFromHeader(request) : undefined;
  const ops: Operation[] = items.map(({ query, variables, operationName, hash }) => {
    if (query !== undefined) return { ...documentHead(query, operationName), query, variables, ...(hash ? { hash } : {}) };
    return { ...(headerType ? { type: headerType } : {}), name: operationName ?? '(anonymous)', variables, hash };
  });
  if (ops.length === 0 && !graphqlPath) return undefined;
  return ops;
}

/**
 * The operation in the URL parameters of a request without a body (GraphQL over HTTP GET). Used on
 * a `/graphql` path, or when `extensions` is a JSON object: Apollo iOS 2.x sends one with every
 * request, and Apollo Server's default path is `/`. A REST `query` parameter alone is not enough.
 */
function urlItems(url: URL, graphqlPath: boolean): unknown[] {
  const p = url.searchParams;
  const json = (v: string | null): unknown => {
    if (v === null) return undefined;
    try { return JSON.parse(v); } catch { return undefined; }
  };
  const extensions = json(p.get('extensions'));
  const extensionsObject = extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions);
  if (!graphqlPath && !extensionsObject) return [];
  return [{
    query: p.get('query') ?? undefined,
    operationName: p.get('operationName') ?? undefined,
    variables: json(p.get('variables')),
    extensions,
  }];
}

/** True when the request's operations were read from its URL (so the URL repeats the variables). */
export function fromUrl(text: string | undefined, ops: Operation[] | undefined): boolean {
  return !!ops?.length && !text;
}

type Item = { query?: string; variables?: unknown; operationName?: string; hash?: string };

/** An operation object: one with a `query` string, or with a persisted-query hash. */
function operationItem(item: unknown): Item | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as any;
  const query = typeof o.query === 'string' ? o.query : undefined;
  const h = o.extensions?.persistedQuery?.sha256Hash;
  const hash = typeof h === 'string' ? h : undefined;
  if (query === undefined && hash === undefined) return undefined;
  const operationName = typeof o.operationName === 'string' && o.operationName ? o.operationName : undefined;
  return { query, variables: o.variables, operationName, hash };
}

/** The type named by the X-APOLLO-OPERATION-TYPE header (Apollo iOS 1.x), if any. */
function typeFromHeader(request: Request): OpType | undefined {
  const h = request.headers?.find((x) => x.name.toLowerCase() === 'x-apollo-operation-type');
  const v = h?.value.trim().toLowerCase();
  return v === 'query' || v === 'mutation' || v === 'subscription' ? v : undefined;
}

/**
 * Type and name of the operation a document runs: the one named `operationName`, else the first.
 * A document in which no operation is found counts as a query, as in 0.1.0.
 */
function documentHead(query: string, operationName?: string): { type: OpType; name: string } {
  const defs = scanDocument(query);
  const selected = (operationName ? defs.find((d) => d.name === operationName) : undefined) ?? defs[0];
  return { type: selected?.type ?? 'query', name: operationName ?? selected?.name ?? '(anonymous)' };
}

const WORD_START = /[_A-Za-z]/;
const WORD = /[_0-9A-Za-z]/;

/**
 * The operations defined at the top level of a GraphQL document, in order. Not a parser: it skips
 * strings, block strings, comments and anything in parentheses or brackets, and classifies each
 * top-level definition by its first word. A definition ends at the brace that closes its first `{`.
 * Never throws; unterminated input ends the scan with what was found.
 */
export function scanDocument(doc: string): { type: OpType; name?: string }[] {
  const out: { type: OpType; name?: string }[] = [];
  const n = doc.length;
  let i = 0;
  let inDefinition = false;
  let depth = 0; // brace depth inside the current definition
  let nesting = 0; // parentheses and brackets
  const wordEnd = (from: number) => { let j = from; while (j < n && WORD.test(doc[j])) j++; return j; };

  while (i < n) {
    const c = doc[i];
    if (c === '"') { // strings first: they may contain any of the characters below
      if (doc.startsWith('"""', i)) { const j = doc.indexOf('"""', i + 3); i = j < 0 ? n : j + 3; continue; }
      i++;
      while (i < n && doc[i] !== '"' && doc[i] !== '\n') i += doc[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '#') { const j = doc.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (c === '(' || c === '[') { nesting++; i++; continue; }
    if (c === ')' || c === ']') { if (nesting) nesting--; i++; continue; }
    if (nesting) { i++; continue; }

    if (inDefinition) {
      if (c === '{') depth++;
      else if (c === '}' && depth > 0 && --depth === 0) inDefinition = false;
      i++;
      continue;
    }
    if (c === '{') { // a bare selection set is an anonymous query
      out.push({ type: 'query' });
      inDefinition = true;
      depth = 1;
      i++;
      continue;
    }
    if (WORD_START.test(c)) {
      const end = wordEnd(i);
      const word = doc.slice(i, end);
      inDefinition = true;
      depth = 0;
      i = end;
      if (word === 'query' || word === 'mutation' || word === 'subscription') {
        let k = i;
        while (k < n && /\s/.test(doc[k])) k++;
        if (k < n && WORD_START.test(doc[k])) {
          const nameEnd = wordEnd(k);
          out.push({ type: word, name: doc.slice(k, nameEnd) });
          i = nameEnd;
        } else {
          out.push({ type: word });
        }
      }
      continue;
    }
    i++; // anything else outside a definition is ignored
  }
  return out;
}

/**
 * Outcome of a GraphQL response. `text` is the response body as text; `ops` are the request's
 * operations.
 */
export function outcome(
  response: Pick<Response, 'status' | 'content'> | undefined, text: string | undefined, ops: Operation[],
): GqlOutcome | undefined {
  if (text === undefined) return undefined;
  const mixed = multipart(response?.content.mimeType, text);
  if (mixed) return mixedOutcome(mixed, !!response?.content._truncated);
  let body: any;
  try { body = JSON.parse(text); } catch { return { status: 'invalid', errors: [] }; }
  const result = singleOutcome(body);
  return isMiss(result, response?.status, ops) ? { ...result, status: 'miss' } : result;
}

function singleOutcome(body: any): GqlOutcome {
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
 * A persisted-query miss: the request sent only hashes, and every error says the server does not
 * know the hash. Clients answer it by sending the request again with the document.
 */
function isMiss(g: GqlOutcome, status: number | undefined, ops: Operation[]): boolean {
  if (g.status !== 'errors' || (status !== undefined && status >= 500)) return false;
  if (ops.length === 0 || ops.some((o) => o.hash === undefined || o.query !== undefined)) return false;
  return g.errors.length > 0
    && g.errors.every((e) => e.code === 'PERSISTED_QUERY_NOT_FOUND' || e.message === 'PersistedQueryNotFound');
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

export const typeLetter = (t?: OpType) => (t === undefined ? '?' : t === 'mutation' ? 'M' : t === 'subscription' ? 'S' : 'Q');
