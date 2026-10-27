// Log sources of a simulator app, independent of network capture:
//   app  — log files the app writes into its data container (paths configured per bundle)
//   out  — stdout/stderr captured by `simpeek launch --console` (print, NSLog …)
//   os   — unified logging (os_log / NSLog) of the app process
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, ROOT } from '../store.ts';

export type Source = 'app' | 'out' | 'os';
export type LogLine = { t: number; source: Source; level?: string; text: string };

export type LogQuery = { bundle: string; device?: string; sources?: Source[]; sinceMs?: number; grep?: string; system?: boolean };

export function readLogs(q: LogQuery): LogLine[] {
  const sources = q.sources ?? ['app', 'out', 'os'];
  const lines: LogLine[] = [];
  if (sources.includes('app')) lines.push(...readAppFiles(q.bundle, q.device));
  if (sources.includes('out')) lines.push(...readConsole(q.bundle));
  if (sources.includes('os')) lines.push(...readUnified(q));
  const re = q.grep ? new RegExp(q.grep, 'i') : undefined;
  return lines
    .filter((l) => (q.sinceMs === undefined || l.t >= q.sinceMs) && (!re || re.test(l.text)))
    .sort((a, b) => a.t - b.t);
}

// ---------- app: files in the data container ----------

function container(bundle: string, device = 'booted', kind: 'data' | 'app' = 'data'): string | undefined {
  const res = spawnSync('xcrun', ['simctl', 'get_app_container', device, bundle, kind], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** Files matching the configured globs (`*` allowed in the last path component). */
export function appLogFiles(bundle: string, device?: string): string[] {
  const globs = readConfig().logs?.[bundle] ?? [];
  const root = globs.length ? container(bundle, device) : undefined;
  if (!root) return [];
  const files: string[] = [];
  for (const g of globs) {
    const dir = path.join(root, path.dirname(g));
    const re = new RegExp('^' + path.basename(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) if (re.test(n)) files.push(path.join(dir, n));
  }
  return files;
}

// Any line starting with a date-time, e.g. "2026-10-23 15:59:25 message" or "2026-10-23 15:59:25(tag).func(): message".
const LEADING_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\([^)]*\))?[.\s:]?(.*)$/;

function readAppFiles(bundle: string, device?: string): LogLine[] {
  const out: LogLine[] = [];
  for (const file of appLogFiles(bundle, device)) {
    let t = 0;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      const m = raw.match(LEADING_TIME);
      if (m) t = Date.parse(`${m[1]}T${m[2]}`);
      out.push({ t, source: 'app', text: m ? m[3] : raw });
    }
  }
  return out;
}

// ---------- out: console capture written by `simpeek launch --console` ----------

export function consoleFiles(bundle: string): string[] {
  const dir = path.join(ROOT, bundle, 'console');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort().map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function readConsole(bundle: string): LogLine[] {
  const out: LogLine[] = [];
  for (const file of consoleFiles(bundle).slice(-3)) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}) (.*)$/);
      if (m && m[2].trim()) out.push({ t: Date.parse(m[1]), source: 'out', text: m[2] });
    }
  }
  return out;
}

// ---------- os: unified logging ----------

export function executableName(bundle: string, device?: string): string | undefined {
  const app = container(bundle, device, 'app');
  if (!app) return undefined;
  const res = spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Info.plist')], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

type OsEvent = { timestamp: string; eventMessage: string; subsystem?: string; category?: string; messageType?: string; senderImagePath?: string };

function toLine(e: OsEvent, system: boolean): LogLine | undefined {
  const level = (e.messageType ?? '').toLowerCase();
  // Keep what the app's own code logged; system libraries only for errors (or with --system).
  const fromApp = (e.senderImagePath ?? '').includes('.app/') && !(e.subsystem ?? '').startsWith('com.apple.');
  if (!fromApp && !system && level !== 'error' && level !== 'fault') return undefined;
  if (!e.eventMessage?.trim()) return undefined;
  const tag = e.subsystem ? `[${e.subsystem}${e.category ? ':' + e.category : ''}] ` : '';
  // "2026-10-23 16:00:37.943071+0900" -> ISO
  const t = Date.parse(e.timestamp.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return { t, source: 'os', level: level === 'default' ? undefined : level, text: tag + e.eventMessage };
}

function readUnified(q: LogQuery): LogLine[] {
  const exe = executableName(q.bundle, q.device);
  if (!exe) return [];
  const minutes = q.sinceMs ? Math.max(1, Math.ceil((Date.now() - q.sinceMs) / 60000) + 1) : 10;
  const res = spawnSync('xcrun', ['simctl', 'spawn', q.device ?? 'booted', 'log', 'show', '--style', 'ndjson', '--info',
    '--last', `${minutes}m`, '--predicate', `process == "${exe}"`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out: LogLine[] = [];
  for (const raw of res.stdout.split('\n')) {
    if (!raw.startsWith('{')) continue;
    try {
      const line = toLine(JSON.parse(raw), !!q.system);
      if (line) out.push(line);
    } catch { /* partial line */ }
  }
  return out;
}

// ---------- follow ----------

/** Streams new log lines from all sources until the process exits. */
export function followLogs(q: LogQuery, onLine: (l: LogLine) => void) {
  const sources = q.sources ?? ['app', 'out', 'os'];
  const re = q.grep ? new RegExp(q.grep, 'i') : undefined;
  const emit = (l: LogLine) => { if (!re || re.test(l.text)) onLine(l); };

  const offsets = new Map<string, number>();
  const files = () => [
    ...(sources.includes('app') ? appLogFiles(q.bundle, q.device).map((f) => ['app', f] as const) : []),
    ...(sources.includes('out') ? consoleFiles(q.bundle).slice(-1).map((f) => ['out', f] as const) : []),
  ];
  for (const [, f] of files()) offsets.set(f, fs.statSync(f).size);
  setInterval(() => {
    for (const [source, f] of files()) {
      let size: number;
      try { size = fs.statSync(f).size; } catch { continue; }
      const from = offsets.get(f) ?? 0;
      if (size <= from) continue;
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      offsets.set(f, size);
      for (const raw of buf.toString('utf8').split('\n')) {
        if (!raw.trim()) continue;
        if (source === 'out') {
          const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}) (.*)$/);
          if (m) emit({ t: Date.parse(m[1]), source, text: m[2] });
        } else {
          const m = raw.match(LEADING_TIME);
          emit({ t: m ? Date.parse(`${m[1]}T${m[2]}`) : Date.now(), source, text: m ? m[3] : raw });
        }
      }
    }
  }, 300);

  if (sources.includes('os')) {
    const exe = executableName(q.bundle, q.device);
    if (!exe) return;
    const child = spawn('xcrun', ['simctl', 'spawn', q.device ?? 'booted', 'log', 'stream', '--style', 'ndjson', '--level', 'info',
      '--predicate', `process == "${exe}"`]);
    let partial = '';
    child.stdout.on('data', (d: Buffer) => {
      const parts = (partial + d.toString('utf8')).split('\n');
      partial = parts.pop() ?? '';
      for (const raw of parts) {
        if (!raw.startsWith('{')) continue;
        try {
          const line = toLine(JSON.parse(raw), !!q.system);
          if (line) emit(line);
        } catch { /* ignore */ }
      }
    });
    process.on('exit', () => child.kill());
  }
}
