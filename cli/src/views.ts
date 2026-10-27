// Text views shared by the CLI and the MCP server: one-line rows, filters, details, per-operation stats.
import { outcome, parseOperations, typeLetter, type GqlOutcome, type Operation } from './graphql.ts';
import { findOperation } from './sourcemap.ts';
import { bodyText, findMark, readConfig, type Entry, type Header, type SessionInfo } from './store.ts';

// ---------- noise ----------

const DEFAULT_EXCLUDE =
  '(^|\\.)(mixpanel\\.com|googleapis\\.com|app-measurement\\.com|app-analytics-services\\.com|google\\.com|gstatic\\.com|crashlytics\\.com|firebaseio\\.com)$';

let excludeRe: RegExp | undefined;
function exclude(): RegExp {
  excludeRe ??= new RegExp(process.env.SIMPEEK_EXCLUDE || readConfig().exclude || DEFAULT_EXCLUDE, 'i');
  return excludeRe;
}

export function isNoise(e: Entry): boolean {
  return exclude().test(hostOf(e.request.url));
}

// ---------- derived facts ----------

export type View = {
  ops?: Operation[];
  gql?: GqlOutcome;
  label: string; // "M UpdatePost" or "POST host/path"
  state: string; // ok / 401 / ✗ FORBIDDEN @path / pending …
  failed: boolean;
};

const views = new WeakMap<Entry, View>();

export function view(e: Entry, info: SessionInfo): View {
  const cached = views.get(e);
  if (cached && (!e.done || cached.state !== '…')) return cached;
  const ops = parseOperations(e, bodyText(info, e.request.postData));
  const gql = ops && e.done ? outcome(bodyText(info, e.response?.content)) : undefined;
  const label = ops?.length
    ? `${typeLetter(ops[0].type)} ${ops.map((o) => o.name).join('+')}`
    : `${e.request.method} ${shortUrl(e.request.url)}`;

  let state: string;
  let failed = false;
  const status = e.response?.status;
  if (!e.done) state = '…';
  else if (e.error) { state = `✗ ${e.error.message}`; failed = true; }
  else if (status !== undefined && status >= 400) { state = `✗ ${status}`; failed = true; }
  else if (gql && gql.status !== 'ok') {
    const first = gql.errors[0];
    const what = first ? [first.code, first.path ? `@${first.path}` : ''].filter(Boolean).join(' ') || trunc(first.message, 60) : 'invalid JSON';
    state = gql.status === 'partial' ? `⚠ partial: ${what}` : `✗ ${what}`;
    if (gql.errors.length > 1) {
      const same = gql.errors.every((x) => x.code === first.code && x.message === first.message);
      state += same ? ` ×${gql.errors.length}` : ` (+${gql.errors.length - 1})`;
    }
    failed = true;
  } else state = ops ? 'ok' : String(status ?? '');

  const v = { ops, gql, label, state, failed };
  views.set(e, v);
  return v;
}

// ---------- rows ----------

export function row(e: Entry, info: SessionInfo): string {
  const v = view(e, info);
  const ms = e.done ? `${e.time}ms` : '';
  const size = e.response ? human(e.response.content.size ?? 0) : '';
  return [pad(`#${e.id}`, 5), clock(e.startMs), pad(v.label, 34), pad(v.state, 18), pad(ms, 7), size].join('  ').trimEnd();
}

/** Tail line for a start or end event. */
export function tailLine(kind: 'start' | 'end', e: Entry, info: SessionInfo): string {
  const v = view(e, info);
  if (kind === 'start') {
    const vars = v.ops?.[0]?.variables;
    const args = vars && typeof vars === 'object' && Object.keys(vars).length ? '  ' + trunc(compactJson(redact(vars)), 80) : '';
    return `${clock(e.startMs)} →  ${v.label}${args}  #${e.id}`;
  }
  const arrow = v.failed ? '✗' : '←';
  const size = e.response ? human(e.response.content.size ?? 0) : '';
  return `${clock(e.startMs + (e.time ?? 0))} ${arrow}  ${pad(v.label, 34)} ${pad(v.state, 18)} ${pad(`${e.time}ms`, 7)} ${size}  #${e.id}`.trimEnd();
}

// ---------- filters ----------

export type Filters = {
  op?: string;
  type?: string;
  host?: string;
  path?: string;
  method?: string;
  status?: string;
  minMs?: number;
  since?: string;
  afterId?: number;
  all?: boolean;
};

export function sinceToMs(since: string): number | undefined {
  const rel = since.match(/^-(\d+)(s|m|h)$/);
  if (rel) return Date.now() - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5 }[rel[2] as 's' | 'm' | 'h'];
  const hm = since.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0);
    return d.getTime();
  }
  const iso = Date.parse(since);
  if (!Number.isNaN(iso)) return iso;
  return findMark(since);
}

export function applyFilters(entries: Entry[], info: SessionInfo, f: Filters): { kept: Entry[]; hidden: number } {
  let hidden = 0;
  const sinceMs = f.since ? sinceToMs(f.since) : undefined;
  if (f.since && sinceMs === undefined) throw new Error(`unknown since "${f.since}" (use -5m, 15:20, ISO time, or a mark name)`);
  const opRe = f.op ? new RegExp(f.op, 'i') : undefined;
  const pathRe = f.path ? new RegExp(f.path, 'i') : undefined;
  const kept = entries.filter((e) => {
    if (f.afterId !== undefined && e.id <= f.afterId) return false;
    if (sinceMs !== undefined && e.startMs < sinceMs) return false;
    if (!f.all && !f.host && isNoise(e)) { hidden++; return false; }
    if (f.host && !hostOf(e.request.url).includes(f.host)) return false;
    if (pathRe && !pathRe.test(pathOf(e.request.url))) return false;
    if (f.method && e.request.method.toUpperCase() !== f.method.toUpperCase()) return false;
    if (f.minMs !== undefined && (e.time ?? Infinity) < f.minMs) return false;
    const v = view(e, info);
    if (opRe && !(v.ops ?? []).some((o) => opRe.test(o.name))) return false;
    if (f.type && !(v.ops ?? []).some((o) => o.type.startsWith(f.type!.toLowerCase()))) return false;
    if (f.status && !matchStatus(e, v, f.status)) return false;
    return true;
  });
  return { kept, hidden };
}

function matchStatus(e: Entry, v: View, s: string): boolean {
  const status = e.response?.status;
  switch (s) {
    case 'pending': return !e.done;
    case 'error': case 'failed': return v.failed;
    case 'ok': return e.done && !v.failed;
    case 'gqlerror': return !!v.gql && v.gql.status !== 'ok';
    default:
      if (/^\dxx$/i.test(s)) return status !== undefined && Math.floor(status / 100) === Number(s[0]);
      return String(status) === s;
  }
}

// ---------- detail ----------

export type DetailOptions = { include?: 'summary' | 'headers' | 'all'; query?: boolean; select?: string; raw?: boolean; redact?: boolean };

export function detail(e: Entry, info: SessionInfo, o: DetailOptions = {}): string {
  const v = view(e, info);
  const doRedact = o.redact !== false;
  const shape = (x: unknown) => {
    const r = doRedact ? redact(x) : x;
    return JSON.stringify(o.raw ? r : trim(r), null, 2);
  };
  const out: string[] = [];
  out.push(`#${e.id}  ${v.label}  ${v.state}  ${e.done ? `${e.time}ms` : '(in flight)'}`);
  out.push(`${e.request.method} ${e.request.url}`);
  const meta = [`started ${clock(e.startMs)}`, `session ${info.session}`];
  if (e.response) meta.push(`http ${e.response.status}${e.response.httpVersion ? ' ' + e.response.httpVersion : ''}`, human(e.response.content.size ?? 0));
  out.push(meta.join('  '));
  if (e.timings) out.push('timings ' + Object.entries(e.timings).filter(([, t]) => t >= 0).map(([k, t]) => `${k}=${t}`).join(' '));

  for (const op of v.ops ?? []) {
    const where = findOperation(info.bundle, op.name);
    if (where.length) out.push(`source ${where.map((l) => `${l.file}:${l.line}`).join(', ')}`);
  }

  if (e.error) out.push('', `transport error: ${e.error.domain} ${e.error.code} ${e.error.message}`);

  if (v.gql?.errors.length) {
    out.push('', `errors (${v.gql.errors.length}):`);
    const counts = new Map<string, number>();
    for (const err of v.gql.errors) {
      const key = `${[err.code, err.path ? `@${err.path}` : ''].filter(Boolean).join(' ')}${err.code || err.path ? ': ' : ''}${err.message}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, n] of counts) out.push(`  - ${key}${n > 1 ? `  ×${n}` : ''}`);
  }

  if (v.ops) {
    v.ops.forEach((op, i) => {
      const tag = v.ops!.length > 1 ? ` [${i}] ${op.name}` : '';
      if (op.variables !== undefined) out.push('', `variables${tag}:`, shape(op.variables));
      if (o.query || o.include === 'all') out.push('', `query${tag}:`, op.query.trim());
      else out.push('', `query${tag}: ${op.query.trim().split('\n').length} lines (pass query=true to show)`);
    });
  } else if (e.request.postData) {
    out.push('', 'request body:', bodyBlock(bodyText(info, e.request.postData), shape, doRedact));
  }

  const resText = bodyText(info, e.response?.content);
  if (resText !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(resText); } catch { parsed = undefined; }
    if (o.select && parsed !== undefined) {
      out.push('', `response ${o.select}:`, shape(pick(parsed, o.select)));
    } else if (v.ops && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.push('', o.raw ? 'data:' : 'data (trimmed):', shape((parsed as any).data));
    } else {
      out.push('', o.raw ? 'response body:' : 'response body (trimmed):', bodyBlock(resText, shape, doRedact));
    }
    if (e.response?.content._truncated) out.push('(response body capped at 10MB)');
  }

  if (o.include === 'headers' || o.include === 'all') {
    out.push('', 'request headers:', headerBlock(e.request.headers, doRedact));
    if (e.response) out.push('', 'response headers:', headerBlock(e.response.headers, doRedact));
  }
  return out.join('\n');
}

function bodyBlock(text: string | undefined, shape: (x: unknown) => string, doRedact: boolean): string {
  if (text === undefined) return '(none)';
  try { return shape(JSON.parse(text)); } catch { /* not JSON */ }
  if (doRedact && /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(text.trim())) {
    const params = new URLSearchParams(text.trim());
    for (const [k] of params) if (SECRET_KEY.test(k) || FORM_SECRET_KEY.test(k)) params.set(k, '***');
    return trunc(decodeURIComponent(params.toString().replace(/\+/g, ' ')), 2000);
  }
  return trunc(text, 2000);
}

function headerBlock(headers: Header[], doRedact: boolean): string {
  return headers.map((h) => `  ${h.name}: ${doRedact && SECRET_HEADER.test(h.name) ? '***' : trunc(h.value, 200)}`).join('\n');
}

/** "data.viewer.records[0].name" */
export function pick(value: unknown, selector: string): unknown {
  const parts = selector.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = value;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ---------- per-operation stats ----------

export function opsTable(entries: Entry[], info: SessionInfo): string {
  const groups = new Map<string, { n: number; failed: number; times: number[] }>();
  for (const e of entries) {
    if (!e.done) continue;
    const v = view(e, info);
    const key = v.ops?.length ? v.label : `${e.request.method} ${hostOf(e.request.url)}${pathOf(e.request.url)}`;
    const g = groups.get(key) ?? { n: 0, failed: 0, times: [] };
    g.n++;
    if (v.failed) g.failed++;
    g.times.push(e.time ?? 0);
    groups.set(key, g);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
  const lines = [`${pad('operation', 40)}  ${pad('n', 4)}  ${pad('fail', 4)}  ${pad('p50', 7)}  p95`];
  for (const [key, g] of rows) {
    const t = g.times.sort((a, b) => a - b);
    const q = (p: number) => `${t[Math.min(t.length - 1, Math.floor(p * t.length))]}ms`;
    lines.push(`${pad(key, 40)}  ${pad(String(g.n), 4)}  ${pad(String(g.failed), 4)}  ${pad(q(0.5), 7)}  ${q(0.95)}`);
  }
  return lines.join('\n');
}

// ---------- helpers ----------

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|token|secret/i;
// OAuth form fields; not applied to JSON, where `code` is usually an error code.
const FORM_SECRET_KEY = /^(code|code_verifier|assertion|client_assertion)$/i;
const SECRET_KEY = /^(password|passwd|pass|secret|client_?secret|token|access_?token|refresh_?token|id_?token|authorization|api_?key|cookie)$/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '***' : redact(v);
    return out;
  }
  return value;
}

/** Keeps structure, drops bulk: arrays to 3 items, strings to 300 chars, depth 8, no __typename. */
export function trim(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return trunc(value, 300);
  if (Array.isArray(value)) {
    if (depth >= 8) return `[array(${value.length})]`;
    const head = value.slice(0, 3).map((x) => trim(x, depth + 1));
    if (value.length > 3) head.push(`… +${value.length - 3} more (${value.length} total)`);
    return head;
  }
  if (value && typeof value === 'object') {
    if (depth >= 8) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== '__typename') out[k] = trim(v, depth + 1);
    return out;
  }
  return value;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value)?.replace(/"([^"]+)":/g, '$1:') ?? '';
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return trunc(u.host + u.pathname + (u.search.length > 1 ? u.search : ''), 70);
  } catch {
    return trunc(url, 70);
  }
}

export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
