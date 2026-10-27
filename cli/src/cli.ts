// simpeek CLI. Network: tail, list, get, ops, sessions, mark, extract, project. Logs: logs, timeline, applog.
import { parseArgs } from 'node:util';
import { launch } from './actions.ts';
import { followLogs, readLogs, type Source } from './logs/sources.ts';
import { logLine, timeline } from './logs/view.ts';
import { addMark, bodyText, listSessions, loadSession, readConfig, resolveSession, SessionReader, writeConfig, type SessionInfo } from './store.ts';
import { applyFilters, clock, detail, opsTable, pick, row, sinceToMs, tailLine, type Filters } from './views.ts';

const USAGE = `simpeek — iOS Simulator network traffic for humans and agents

  simpeek launch <bundle> [--device UDID] [--no-inject] [--console] [--env K=V]...
                                           relaunch app (inject SimPeek unless it links the package;
                                           --console captures stdout/stderr for \`simpeek logs\`)
  simpeek tail [filters] [--history N]      stream requests as they happen
  simpeek list [filters] [--limit N]        recent requests, one per line
  simpeek get <id> [--headers] [--query] [--select PATH] [--raw] [--no-redact]
  simpeek ops [filters]                     per-operation calls / failures / latency
  simpeek sessions                          recorded app launches
  simpeek mark <name>                       named point in time for --since
  simpeek extract --path REGEX --select P   raw value from the newest matching JSON response
  simpeek project <bundle> <dir>            source root used to locate GraphQL operations

  simpeek logs [--source app,out,os] [--since -5m] [--grep RE] [--follow] [--system] [--limit N]
  simpeek timeline [--since -5m] [--grep RE] [--limit N]   network + logs, merged by time
  simpeek applog <bundle> <glob>            app log files, relative to the data container

  simpeek mcp                               run the MCP server on stdio

filters: --bundle ID --session ID --op REGEX --type query|mutation --host S --path REGEX
         --method M --status 4xx|error|gqlerror|pending|... --min-ms N --since -5m|15:20|mark --all`;

// parseArgs rejects values that start with "-", so accept `--since -5m` as `--since=-5m`.
const argv = process.argv.slice(2).flatMap((a, i, all) =>
  a === '--since' && all[i + 1]?.startsWith('-') ? [] : all[i - 1] === '--since' && a.startsWith('-') ? [`--since=${a}`] : [a]);

const { values: o, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    bundle: { type: 'string' }, session: { type: 'string' }, device: { type: 'string' },
    op: { type: 'string' }, type: { type: 'string' }, host: { type: 'string' }, path: { type: 'string' },
    method: { type: 'string' }, status: { type: 'string' }, 'min-ms': { type: 'string' }, since: { type: 'string' },
    all: { type: 'boolean' }, limit: { type: 'string' }, history: { type: 'string' },
    headers: { type: 'boolean' }, query: { type: 'boolean' }, select: { type: 'string' }, raw: { type: 'boolean' },
    'no-redact': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    'no-inject': { type: 'boolean' }, console: { type: 'boolean' }, env: { type: 'string', multiple: true },
    source: { type: 'string' }, grep: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, system: { type: 'boolean' },
  },
});

const filters: Filters = {
  op: o.op, type: o.type, host: o.host, path: o.path, method: o.method, status: o.status,
  minMs: o['min-ms'] ? Number(o['min-ms']) : undefined, since: o.since, all: o.all,
};

function session(): SessionInfo {
  const info = resolveSession({ bundle: o.bundle, session: o.session });
  if (!info) die('no sessions recorded yet; run: simpeek launch <bundle>');
  return info!;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function tail() {
  let reader: SessionReader | undefined;
  const history = Number(o.history ?? 0);
  const attach = (info: SessionInfo, replay: boolean) => {
    reader = new SessionReader(info);
    const lines = reader.poll();
    console.log(`── ${info.bundle} session ${info.session} (${String(info.meta.device ?? '')}) ──`);
    if (replay) {
      const { kept } = applyFilters(reader.all(), info, filters);
      for (const e of history > 0 ? kept.slice(-history) : []) console.log(row(e, info));
    } else {
      emit(lines);
    }
  };
  const emit = (lines: ReturnType<SessionReader['poll']>) => {
    for (const line of lines) {
      if (line._type !== 'start' && line._type !== 'end') continue;
      const e = reader!.entries.get(line._id);
      if (!e || !applyFilters([e], reader!.info, filters).kept.length) continue;
      console.log(tailLine(line._type, e, reader!.info));
    }
  };
  const latest = listSessions(o.bundle)[0];
  if (latest) attach(latest, true);
  else console.log('waiting for a SimPeek session… (simpeek launch <bundle>)');
  setInterval(() => {
    const newest = listSessions(o.bundle)[0];
    if (newest && newest.file !== reader?.info.file) attach(newest, false);
    else if (reader) emit(reader.poll());
  }, 250);
}

/** Newest response (across sessions) matching the filters whose JSON has a value at `selector`. */
function extract(selector: string): unknown {
  for (const info of listSessions(o.bundle)) {
    const { kept } = applyFilters(loadSession(info).all(), info, { ...filters, all: true });
    for (const e of kept.reverse()) {
      try {
        const v = pick(JSON.parse(bodyText(info, e.response?.content) ?? ''), selector);
        if (v !== undefined && v !== null) return v;
      } catch { /* not JSON */ }
    }
  }
  return undefined;
}

const [cmd, ...args] = positionals;
if (!cmd || o.help) {
  console.log(USAGE);
} else if (cmd === 'mcp') {
  const { serve } = await import('./mcp.ts');
  await serve();
} else if (cmd === 'tail') {
  await tail();
} else if (cmd === 'launch') {
  if (!args[0]) die('usage: simpeek launch <bundle> [--device UDID] [--no-inject] [--console] [--env K=V]');
  const env = Object.fromEntries((o.env ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const r = await launch(args[0], { device: o.device, inject: !o['no-inject'], console: o.console, env }).catch((e: Error) => die(e.message));
  console.log(r.session ? `recording ${r.session.bundle} session ${r.session.session} → ${r.session.file}` : `launched ${args[0]} (no SimPeek session: app neither links SimPeek nor was injected?)`);
  if (r.consoleFile) console.log(`console → ${r.consoleFile}`);
} else if (cmd === 'logs') {
  const bundle = o.bundle ?? listSessions()[0]?.bundle ?? die('pass --bundle');
  const q = { bundle, device: o.device, sources: o.source?.split(',') as Source[] | undefined, grep: o.grep, system: o.system,
    sinceMs: o.since ? sinceToMs(o.since) ?? die(`unknown --since ${o.since}`) : Date.now() - 10 * 60_000 };
  if (o.follow) followLogs(q, (l) => console.log(logLine(l)));
  else for (const l of readLogs(q).slice(-Number(o.limit ?? 200))) console.log(logLine(l));
} else if (cmd === 'timeline') {
  const sinceMs = o.since ? sinceToMs(o.since) ?? die(`unknown --since ${o.since}`) : Date.now() - 5 * 60_000;
  for (const l of timeline({ bundle: o.bundle, sinceMs, grep: o.grep, all: o.all, limit: Number(o.limit ?? 300) })) console.log(l);
} else if (cmd === 'applog') {
  if (args.length < 2) die('usage: simpeek applog <bundle> <glob relative to data container>');
  const config = readConfig();
  config.logs = { ...config.logs, [args[0]]: [...new Set([...(config.logs?.[args[0]] ?? []), args[1]])] };
  writeConfig(config);
  console.log(`${args[0]} app logs: ${config.logs[args[0]].join(', ')}`);
} else if (cmd === 'extract') {
  if (!o.select) die('usage: simpeek extract --path REGEX --select PATH [--bundle ID]');
  const value = extract(o.select);
  if (value === undefined) die('no matching response');
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
} else if (cmd === 'list') {
  const info = session();
  const { kept, hidden } = applyFilters(loadSession(info).all(), info, filters);
  for (const e of kept.slice(-Number(o.limit ?? 30))) console.log(row(e, info));
  console.log(`\nsession ${info.session} (${info.bundle}) · ${kept.length} shown${hidden ? ` · ${hidden} noise hidden (--all)` : ''}`);
} else if (cmd === 'get') {
  const info = session();
  const e = loadSession(info).entries.get(Number(args[0]));
  if (!e) die(`no request #${args[0]} in session ${info.session}`);
  console.log(detail(e!, info, { include: o.headers ? 'headers' : 'summary', query: o.query, select: o.select, raw: o.raw, redact: !o['no-redact'] }));
} else if (cmd === 'ops') {
  const info = session();
  console.log(opsTable(applyFilters(loadSession(info).all(), info, filters).kept, info));
} else if (cmd === 'sessions') {
  for (const s of listSessions(o.bundle)) console.log(`${s.session}  ${s.bundle}  ${String(s.meta.device ?? '')}  last write ${clock(s.mtimeMs)}`);
} else if (cmd === 'mark') {
  if (!args[0]) die('usage: simpeek mark <name>');
  const m = addMark(args[0]);
  console.log(`mark "${m.name}" at ${clock(Date.parse(m.time))}`);
} else if (cmd === 'project') {
  if (args.length < 2) die('usage: simpeek project <bundle> <dir>');
  const config = readConfig();
  config.projects = { ...config.projects, [args[0]]: args[1] };
  writeConfig(config);
  console.log(`${args[0]} → ${args[1]}`);
} else {
  die(USAGE);
}
