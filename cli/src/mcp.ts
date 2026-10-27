// MCP server (stdio). Tools return compact text: list first, then drill into one request.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { launch, waitFor } from './actions.ts';
import { readLogs, type Source } from './logs/sources.ts';
import { logLine, timeline } from './logs/view.ts';
import { addMark, listSessions, loadSession, resolveSession } from './store.ts';
import { applyFilters, clock, detail, opsTable, row, sinceToMs } from './views.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const target = {
  bundle: z.string().optional().describe('App bundle id, e.g. com.example.app. Default: the most recently active app.'),
  session: z.string().optional().describe('Session id (one app launch). Default: latest.'),
};

const filters = {
  op: z.string().optional().describe('GraphQL operation name (regex, case-insensitive)'),
  type: z.enum(['query', 'mutation', 'subscription']).optional(),
  host: z.string().optional().describe('Substring of the host; also disables the noise filter'),
  path: z.string().optional().describe('Regex on the URL path'),
  method: z.string().optional(),
  status: z.string().optional().describe('2xx|3xx|4xx|5xx|<code>|ok|error (HTTP, transport or GraphQL errors)|gqlerror|pending'),
  minMs: z.number().optional().describe('Only requests slower than this'),
  since: z.string().optional().describe('-30s / -5m / 15:20 / ISO time / a mark name from net_mark'),
  all: z.boolean().optional().describe('Include analytics/SDK noise (Mixpanel, Firebase, Google) hidden by default'),
};

export async function serve() {
  const server = new McpServer({ name: 'simpeek', version: '0.1.0' });

  server.registerTool('net_launch', {
    description: 'Relaunch an app on the iOS Simulator with network recording on (and stdout/stderr captured for log_read). Run this before reproducing a bug.',
    inputSchema: {
      bundle: z.string(),
      device: z.string().optional().describe('Simulator UDID, default "booted"'),
      inject: z.boolean().optional().describe('Inject SimPeek.dylib (default true). Set false for apps that link the SimPeek package.'),
      console: z.boolean().optional().describe('Capture stdout/stderr (default true)'),
    },
  }, async ({ bundle, device, inject, console }) => {
    try {
      const r = await launch(bundle, { device, inject: inject ?? true, console: console ?? true });
      const s = r.session;
      const lines = [s ? `recording ${s.bundle} session ${s.session} (${String(s.meta.device)} iOS ${String(s.meta.os)})` : `launched ${bundle}, but no SimPeek session appeared (inject=false on an app without SimPeek?)`];
      if (r.consoleFile) lines.push(`console: ${r.consoleFile}`);
      return text(lines.join('\n'));
    } catch (e) {
      return fail(String((e as Error).message));
    }
  });

  server.registerTool('net_sessions', {
    description: 'List recorded app launches (sessions), newest first.',
    inputSchema: { bundle: target.bundle, limit: z.number().optional() },
  }, async ({ bundle, limit }) => {
    const sessions = listSessions(bundle).slice(0, limit ?? 10);
    if (!sessions.length) return text('no sessions recorded yet; start one with net_launch');
    return text(sessions.map((s) => `${s.session}  ${s.bundle}  ${String(s.meta.device ?? '')} iOS ${String(s.meta.os ?? '')}  v${String(s.meta.appVersion ?? '')}  last write ${clock(s.mtimeMs)}`).join('\n'));
  });

  server.registerTool('net_list', {
    description: 'One line per request: id, time, GraphQL op (Q/M + name) or METHOD host/path, outcome (GraphQL errors count as failures even on HTTP 200), duration, size. Pass cursor (the previous nextCursor) to get only newer requests.',
    inputSchema: { ...target, ...filters, cursor: z.number().optional(), limit: z.number().optional().describe('Default 30 (most recent)') },
  }, async (a) => {
    const info = resolveSession(a);
    if (!info) return text('no sessions recorded yet; start one with net_launch');
    try {
      const reader = loadSession(info);
      const { kept, hidden } = applyFilters(reader.all(), info, { ...a, afterId: a.cursor });
      const limit = a.limit ?? 30;
      const shown = a.cursor !== undefined ? kept.slice(0, limit) : kept.slice(-limit);
      const lastId = reader.all().at(-1)?.id ?? a.cursor ?? 0;
      const nextCursor = a.cursor !== undefined && shown.length ? shown.at(-1)!.id : lastId;
      const lines = shown.map((e) => row(e, info));
      const foot = [`session ${info.session} (${info.bundle})`, `showing ${shown.length}/${kept.length}`];
      if (hidden) foot.push(`${hidden} noise hidden (all=true)`);
      foot.push(`nextCursor ${nextCursor}`);
      return text([...lines, '', foot.join(' · ')].join('\n'));
    } catch (e) {
      return fail(String((e as Error).message));
    }
  });

  server.registerTool('net_get', {
    description: 'Details of one request. GraphQL: errors first, then variables, then trimmed data, plus the source file defining the operation. Bodies are trimmed (arrays to 3 items) and secrets redacted unless raw/redact=false.',
    inputSchema: {
      ...target,
      id: z.number(),
      include: z.enum(['summary', 'headers', 'all']).optional(),
      query: z.boolean().optional().describe('Show the GraphQL document'),
      select: z.string().optional().describe('Only this part of the response JSON, e.g. data.viewer.records[0]'),
      raw: z.boolean().optional().describe('Do not trim bodies'),
      redact: z.boolean().optional().describe('false to show tokens/cookies'),
    },
  }, async (a) => {
    const info = resolveSession(a);
    if (!info) return fail('no sessions recorded yet');
    const entry = loadSession(info).entries.get(a.id);
    if (!entry) return fail(`no request #${a.id} in session ${info.session}`);
    return text(detail(entry, info, a));
  });

  server.registerTool('net_ops', {
    description: 'Per-operation stats for a session: calls, failures, p50/p95 latency. Spots duplicate fetches, slow or failing operations.',
    inputSchema: { ...target, since: filters.since, all: filters.all },
  }, async (a) => {
    const info = resolveSession(a);
    if (!info) return text('no sessions recorded yet');
    const { kept } = applyFilters(loadSession(info).all(), info, a);
    return text(opsTable(kept, info));
  });

  server.registerTool('net_mark', {
    description: 'Record a named point in time (e.g. "before-login-tap"); use it later as since=<name>.',
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const m = addMark(name);
    return text(`mark "${m.name}" at ${clock(Date.parse(m.time))}`);
  });

  server.registerTool('net_wait', {
    description: 'Block until a request matching the filters finishes (default: any non-noise request), then return it. Use right after a UI action, e.g. op="UpdatePost".',
    inputSchema: { bundle: target.bundle, ...filters, timeoutSec: z.number().optional().describe('Default 15') },
  }, async (a) => {
    const sinceMs = a.since ? sinceToMs(a.since) ?? Date.now() : Date.now();
    const { info, entries } = await waitFor({ bundle: a.bundle, filters: a, timeoutMs: (a.timeoutSec ?? 15) * 1000, sinceMs });
    if (!info || !entries.length) return text(`timed out after ${a.timeoutSec ?? 15}s with no matching request`);
    return text(entries.map((e) => row(e, info)).join('\n'));
  });

  // ---------- logs (separate from network capture) ----------

  server.registerTool('log_read', {
    description: 'App logs from the simulator: app = log files the app writes (configured via `simpeek applog`), out = stdout/stderr captured by net_launch, os = unified logging from the app\'s own code plus system errors.',
    inputSchema: {
      bundle: target.bundle,
      source: z.array(z.enum(['app', 'out', 'os'])).optional().describe('Default all'),
      since: z.string().optional().describe('-5m (default -10m) / 15:20 / ISO / mark name'),
      grep: z.string().optional().describe('Regex, case-insensitive'),
      system: z.boolean().optional().describe('Include all system framework logs'),
      limit: z.number().optional().describe('Default 200 (most recent)'),
    },
  }, async (a) => {
    const bundle = a.bundle ?? listSessions()[0]?.bundle;
    if (!bundle) return fail('pass bundle');
    const sinceMs = a.since ? sinceToMs(a.since) : Date.now() - 10 * 60_000;
    if (sinceMs === undefined) return fail(`unknown since "${a.since}"`);
    const lines = readLogs({ bundle, sources: a.source as Source[] | undefined, sinceMs, grep: a.grep, system: a.system });
    return text(lines.slice(-(a.limit ?? 200)).map(logLine).join('\n') || 'no log lines');
  });

  server.registerTool('timeline', {
    description: 'Network requests and app logs merged in time order. The fastest way to see what happened around a UI action or a failure.',
    inputSchema: { bundle: target.bundle, since: z.string().optional().describe('Default -5m'), grep: z.string().optional(), all: filters.all, limit: z.number().optional().describe('Default 300') },
  }, async (a) => {
    const sinceMs = a.since ? sinceToMs(a.since) : Date.now() - 5 * 60_000;
    if (sinceMs === undefined) return fail(`unknown since "${a.since}"`);
    return text(timeline({ bundle: a.bundle, sinceMs, grep: a.grep, all: a.all, limit: a.limit ?? 300 }).join('\n') || 'nothing in this window');
  });

  await server.connect(new StdioServerTransport());
}
