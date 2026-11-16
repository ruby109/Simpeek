// Text views shared by the CLI and the MCP server: one-line rows, filters, details, per-operation stats.
import { fromUrl, outcome, recognize, typeLetter, type GqlOutcome, type Operation, type OpType } from './graphql.ts';
import { findOperation } from './sourcemap.ts';
import { bodyText, findMark, listSessions, loadSession, readConfig, type Entry, type Header, type Line, type SessionInfo } from './store.ts';

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
  /** Message of an exception thrown while recognizing the request or reading its outcome. */
  recognitionError?: string;
  /** The operations were read from the URL, so its query string repeats the variables. */
  fromUrl?: boolean;
};

/**
 * A persisted-query miss is abandoned when no retry came: another request started this long after
 * the miss arrived. Phase 0 measured 0 to 7 ms from miss to retry (Apollo iOS 2.5.0).
 */
export const MISS_WINDOW_MS = 2000;
/** Times are rounded to milliseconds, so a retry can appear to start slightly before the miss arrived. */
const ARRIVAL_SLACK_MS = 10;

export type MissState = 'retried' | 'pending' | 'abandoned';

/** Where a session's entries come from: a SessionReader, or entries built in memory (tests). */
export type EntrySource = { entries: Map<number, Entry>; all(): Entry[]; poll?(): Line[] };

type Recognition = {
  done: boolean; ops?: Operation[]; fromUrl?: boolean; gql?: GqlOutcome; outcomeRead?: boolean; error?: string;
};

/**
 * The entries of one session plus what needs the whole session to know: types learned from other
 * requests with the same persisted-query hash, and whether each miss was retried. Every command
 * renders requests through a Session, so the session pass always runs before filters and rows.
 */
export class Session {
  readonly info: SessionInfo;
  private readonly source: EntrySource;
  private readonly recognitions = new WeakMap<Entry, Recognition>();
  private learned = new Map<string, { type: OpType; name: string }>();
  private misses = new Map<number, MissState>();

  constructor(info: SessionInfo, source: EntrySource) {
    this.info = info;
    this.source = source;
    this.pass();
  }

  all(): Entry[] { return this.source.all(); }
  get(id: number): Entry | undefined { return this.source.entries.get(id); }

  /** Reads appended lines (for a reader) and runs the session pass again. */
  poll(): Line[] {
    const lines = this.source.poll?.() ?? [];
    this.pass();
    return lines;
  }

  missState(e: Entry): MissState | undefined { return this.misses.get(e.id); }

  view(e: Entry): View {
    const r = this.recognition(e);
    const ops = r.ops?.map((o) => this.withLearned(o));
    const gql = r.gql;
    const label = ops?.length
      ? `${typeLetter(ops[0].type)} ${ops.map((o) => o.name).join('+')}`
      : `${e.request.method} ${shortUrl(e.request.url)}`;

    let state: string;
    let failed = false;
    const status = e.response?.status;
    if (!e.done) state = '…';
    else if (e.error) { state = `✗ ${e.error.message}`; failed = true; }
    else if (gql?.status === 'miss') {
      if (this.misses.get(e.id) === 'abandoned') { state = '✗ no retry: not persisted'; failed = true; }
      else state = '↻ not persisted';
    } else if (status !== undefined && status >= 400) { state = `✗ ${status}`; failed = true; }
    else if (r.error !== undefined) { state = '✗ recognition failed'; failed = true; }
    else if (gql && gql.status !== 'ok') {
      const first = gql.errors[0];
      const what = first
        ? [first.code, first.path ? `@${first.path}` : ''].filter(Boolean).join(' ') || trunc(first.message, 60)
        : gql.incomplete ? 'incomplete response' : 'invalid JSON';
      state = gql.status === 'partial' ? `⚠ partial: ${what}` : `✗ ${what}`;
      if (gql.errors.length > 1) {
        const same = gql.errors.every((x) => x.code === first.code && x.message === first.message);
        state += same ? ` ×${gql.errors.length}` : ` (+${gql.errors.length - 1})`;
      }
      failed = true;
    } else state = ops ? 'ok' : String(status ?? '');

    return { ops, gql, label, state, failed, recognitionError: r.error, fromUrl: r.fromUrl };
  }

  /** Operations are read once per entry (again when it finishes); the outcome only when needed. */
  private recognition(e: Entry, withOutcome = true): Recognition {
    let r = this.recognitions.get(e);
    if (!r || r.done !== e.done) {
      r = { done: e.done };
      try {
        const text = bodyText(this.info, e.request.postData);
        r.ops = recognize(e.request, text);
        r.fromUrl = fromUrl(text, r.ops);
      } catch (err) {
        r.error = message(err);
      }
      this.recognitions.set(e, r);
    }
    if (withOutcome && !r.outcomeRead && r.ops && e.done && r.error === undefined) {
      r.outcomeRead = true;
      try {
        r.gql = outcome(e.response, bodyText(this.info, e.response?.content, { lossy: true }), r.ops);
      } catch (err) {
        r.ops = undefined;
        r.error = message(err);
      }
    }
    return r;
  }

  private withLearned(o: Operation): Operation {
    if (o.type !== undefined || o.hash === undefined) return o;
    const l = this.learned.get(o.hash);
    return l ? { ...o, type: l.type, name: o.name === '(anonymous)' ? l.name : o.name } : o;
  }

  /**
   * Learns types from requests that carry a hash and its document, and decides for each miss
   * whether it was retried. Reads request bodies of all entries and responses of hash-only ones.
   */
  private pass() {
    const entries = this.all();
    const ops = entries.map((e) => this.recognition(e, false).ops ?? []);
    const learned = new Map<string, { type: OpType; name: string }>();
    entries.forEach((_, i) => {
      for (const o of ops[i]) if (o.hash && o.query !== undefined && o.type) learned.set(o.hash, { type: o.type, name: o.name });
    });

    const misses = new Map<number, MissState>();
    let newerSession: boolean | undefined;
    entries.forEach((m, i) => {
      if (!m.done || !ops[i].length || ops[i].some((o) => o.hash === undefined || o.query !== undefined)) return;
      if (this.recognition(m).gql?.status !== 'miss') return;
      const arrival = m.startMs + (m.time ?? 0);
      let abandoned = false;
      let unresolved = false;
      for (const o of ops[i]) {
        // The first later request with this hash decides: with the document it is the retry.
        const j = entries.findIndex((x, k) => k > i && x.startMs >= arrival - ARRIVAL_SLACK_MS && ops[k].some((p) => p.hash === o.hash));
        if (j < 0) unresolved = true;
        else if (ops[j].find((p) => p.hash === o.hash)!.query === undefined) abandoned = true;
      }
      if (!abandoned && unresolved) {
        if (newerSession === undefined) {
          const newest = listSessions(this.info.bundle)[0];
          newerSession = !!newest && newest.file !== this.info.file;
        }
        abandoned = newerSession || entries.some((x) => x.startMs >= arrival + MISS_WINDOW_MS);
        if (!abandoned) { misses.set(m.id, 'pending'); return; }
      }
      misses.set(m.id, abandoned ? 'abandoned' : 'retried');
    });
    this.learned = learned;
    this.misses = misses;
  }
}

export function openSession(info: SessionInfo): Session {
  return new Session(info, loadSession(info));
}

const message = (err: unknown) => String((err as Error)?.message ?? err);

/**
 * Requests that finished at or after `sinceMs` and match the filters, without persisted-query
 * misses that were retried or may still be (`matches`), and those still pending (`pending`).
 */
export function waitSelection(s: Session, f: Filters, sinceMs: number): { matches: Entry[]; pending: Entry[] } {
  const done = s.all().filter((e) => e.done && e.startMs + (e.time ?? 0) >= sinceMs);
  const { kept } = applyFilters(done, s, { ...f, since: undefined });
  const matches = kept.filter((e) => { const m = s.missState(e); return m !== 'pending' && m !== 'retried'; });
  const pending = kept.filter((e) => s.missState(e) === 'pending');
  return { matches, pending };
}

// ---------- rows ----------

export function row(e: Entry, s: Session): string {
  const v = s.view(e);
  const ms = e.done ? `${e.time}ms` : '';
  const size = e.response ? human(e.response.content.size ?? 0) : '';
  return [pad(`#${e.id}`, 5), clock(e.startMs), pad(v.label, 34), pad(v.state, 18), pad(ms, 7), size].join('  ').trimEnd();
}

/** Tail line for a start or end event. */
export function tailLine(kind: 'start' | 'end', e: Entry, s: Session): string {
  const v = s.view(e);
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

export function applyFilters(entries: Entry[], s: Session, f: Filters): { kept: Entry[]; hidden: number } {
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
    const v = s.view(e);
    if (opRe && !(v.ops ?? []).some((o) => opRe.test(o.name))) return false;
    if (f.type && !(v.ops ?? []).some((o) => o.type?.startsWith(f.type!.toLowerCase()))) return false;
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
    case 'gqlerror': return !!v.gql && v.gql.status !== 'ok' && !(v.gql.status === 'miss' && !v.failed);
    default:
      if (/^\dxx$/i.test(s)) return status !== undefined && Math.floor(status / 100) === Number(s[0]);
      return String(status) === s;
  }
}

// ---------- detail ----------

export type DetailOptions = { include?: 'summary' | 'headers' | 'all'; query?: boolean; select?: string; raw?: boolean; redact?: boolean };

export function detail(e: Entry, s: Session, o: DetailOptions = {}): string {
  const v = s.view(e);
  const info = s.info;
  const doRedact = o.redact !== false;
  const shape = (x: unknown) => {
    const r = doRedact ? redact(x) : x;
    return JSON.stringify(o.raw ? r : trim(r), null, 2);
  };
  const out: string[] = [];
  out.push(`#${e.id}  ${v.label}  ${v.state}  ${e.done ? `${e.time}ms` : '(in flight)'}`);
  if (v.recognitionError !== undefined) out.push(`recognition failed: ${trunc(v.recognitionError, 100)}`);
  const q = e.request.url.indexOf('?');
  // A GET operation's query string holds the document and the unredacted variables, shown below.
  out.push(`${e.request.method} ${v.fromUrl && q >= 0 ? `${e.request.url.slice(0, q)}?…` : e.request.url}`);
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
      if (op.query === undefined) out.push('', `query${tag}: persisted (sha256 ${op.hash?.slice(0, 12)}…), document not sent`);
      else if (o.query || o.include === 'all') out.push('', `query${tag}:`, op.query.trim());
      else out.push('', `query${tag}: ${op.query.trim().split('\n').length} lines (pass query=true to show)`);
    });
  } else if (e.request.postData) {
    let reqText: string | undefined;
    let readable = true;
    try { reqText = bodyText(info, e.request.postData); } catch { readable = false; }
    out.push('', readable ? `request body:\n${bodyBlock(reqText, shape, doRedact)}` : 'request body: (unreadable)');
  }

  const resText = bodyText(info, e.response?.content);
  const parts = v.gql?.parts;
  if (parts) {
    if (o.select) out.push('', `response ${o.select}:`, shape(pick(parts, o.select)));
    else {
      out.push('', o.raw ? `parts (${parts.length}):` : `parts (${parts.length}, trimmed):`);
      parts.forEach((part, i) => out.push(...(i ? [''] : []), shape(part)));
    }
    if (v.gql?.incomplete && !e.response?.content._truncated) out.push('(incomplete response)');
    if (e.response?.content._truncated) out.push('(response body capped at 10MB)');
  } else if (resText !== undefined) {
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

export function opsTable(entries: Entry[], s: Session): string {
  const groups = new Map<string, { n: number; failed: number; times: number[] }>();
  for (const e of entries) {
    if (!e.done) continue;
    const v = s.view(e);
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
