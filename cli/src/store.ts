// Reads the NDJSON session files written by the SimPeek dylib (see ios/Sources/SimPeek/Recorder.swift).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = process.env.SIMPEEK_DIR || path.join(os.homedir(), '.simpeek');

export type Header = { name: string; value: string };
export type Body = { mimeType?: string; text?: string; _file?: string; size?: number; _truncated?: boolean };
export type Request = { method: string; url: string; headers: Header[]; queryString: Header[]; postData?: Body };
export type Response = {
  status: number; statusText: string; httpVersion: string; headers: Header[]; content: Body; redirectURL: string;
};
export type NetError = { domain: string; code: number; message: string };

export type Entry = {
  id: number;
  startedDateTime: string;
  startMs: number;
  request: Request;
  response?: Response;
  timings?: Record<string, number>;
  time?: number;
  error?: NetError;
  done: boolean;
};

export type SessionInfo = {
  bundle: string;
  session: string;
  file: string;
  mtimeMs: number;
  meta: Record<string, unknown>;
};

export type Line =
  | { _type: 'session'; [k: string]: unknown }
  | { _type: 'start'; _id: number; startedDateTime: string; request: Request }
  | { _type: 'end'; _id: number; time: number; response?: Response; timings?: Record<string, number>; _error?: NetError };

export function listBundles(): string[] {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Sessions newest first, optionally limited to one app. */
export function listSessions(bundle?: string): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const b of bundle ? [bundle] : listBundles()) {
    const dir = path.join(ROOT, b);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.ndjson')) continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      out.push({ bundle: b, session: name.slice(0, -'.ndjson'.length), file, mtimeMs: stat.mtimeMs, meta: readFirstLine(file) });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readFirstLine(file: string): Record<string, unknown> {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    return line ? JSON.parse(line) : {};
  } catch {
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveSession(opts: { bundle?: string; session?: string }): SessionInfo | undefined {
  const sessions = listSessions(opts.bundle);
  if (!opts.session || opts.session === 'latest') return sessions[0];
  return sessions.find((s) => s.session === opts.session || s.session.startsWith(opts.session!));
}

/** Incrementally reads one session file; call poll() to pick up appended lines. */
export class SessionReader {
  readonly info: SessionInfo;
  readonly entries = new Map<number, Entry>();
  private offset = 0;
  private partial = '';

  constructor(info: SessionInfo) {
    this.info = info;
  }

  /** Reads new complete lines, applies them, and returns them in file order. */
  poll(): Line[] {
    let size: number;
    try { size = fs.statSync(this.info.file).size; } catch { return []; }
    if (size <= this.offset) return [];
    const fd = fs.openSync(this.info.file, 'r');
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;

    const chunks = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = chunks.pop() ?? '';
    const lines: Line[] = [];
    for (const raw of chunks) {
      if (!raw.trim()) continue;
      let line: Line;
      try { line = JSON.parse(raw); } catch { continue; }
      this.apply(line);
      lines.push(line);
    }
    return lines;
  }

  private apply(line: Line) {
    if (line._type === 'session') {
      // The file may have been listed before the app wrote its first line.
      Object.assign(this.info.meta, line);
    } else if (line._type === 'start') {
      this.entries.set(line._id, {
        id: line._id,
        startedDateTime: line.startedDateTime,
        startMs: Date.parse(line.startedDateTime),
        request: line.request,
        done: false,
      });
    } else if (line._type === 'end') {
      const e = this.entries.get(line._id);
      if (!e) return;
      e.done = true;
      e.time = line.time;
      e.response = line.response;
      e.timings = line.timings;
      e.error = line._error;
    }
  }

  all(): Entry[] {
    return [...this.entries.values()].sort((a, b) => a.id - b.id);
  }
}

export function loadSession(info: SessionInfo): SessionReader {
  const reader = new SessionReader(info);
  reader.poll();
  return reader;
}

/** Full text of a body, reading the side file when the body was too large to inline. */
export function bodyText(info: SessionInfo, body?: Body): string | undefined {
  if (!body) return undefined;
  if (body.text !== undefined) return body.text;
  if (body._file) {
    try {
      const buf = fs.readFileSync(path.join(ROOT, info.bundle, body._file));
      const text = buf.toString('utf8');
      return text.includes('�') ? `<binary ${buf.length} bytes: ${path.join(ROOT, info.bundle, body._file)}>` : text;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---- marks: named points in time for "since" filters ----

const MARKS = path.join(ROOT, 'marks.ndjson');

export function addMark(name: string): { name: string; time: string } {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const mark = { name, time: new Date().toISOString() };
  fs.appendFileSync(MARKS, JSON.stringify(mark) + '\n');
  return mark;
}

export function findMark(name: string): number | undefined {
  try {
    const lines = fs.readFileSync(MARKS, 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      const m = JSON.parse(l);
      if (m.name === name) return Date.parse(m.time);
    }
  } catch { /* no marks yet */ }
  return undefined;
}

// ---- config: bundle id -> project root, for GraphQL source lookup ----

const CONFIG = path.join(ROOT, 'config.json');

export type Config = { projects?: Record<string, string>; exclude?: string; logs?: Record<string, string[]> };

export function readConfig(): Config {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

export function writeConfig(config: Config) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
}
