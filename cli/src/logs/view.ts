// Text views for logs, and the timeline that interleaves logs with network requests.
import { listSessions, loadSession, resolveSession } from '../store.ts';
import { clock, isNoise, row } from '../views.ts';
import { readLogs, type LogLine, type Source } from './sources.ts';

export function logLine(l: LogLine): string {
  const level = l.level && l.level !== 'info' ? `${l.level.toUpperCase()} ` : '';
  return `${clock(l.t)}  ${l.source.padEnd(3)}  ${level}${l.text.length > 400 ? l.text.slice(0, 399) + '…' : l.text}`;
}

export type TimelineQuery = { bundle?: string; sinceMs: number; grep?: string; sources?: Source[]; all?: boolean; limit?: number };

/** Network rows (at request start) and log lines, merged by time. */
export function timeline(q: TimelineQuery): string[] {
  const bundle = q.bundle ?? listSessions()[0]?.bundle;
  if (!bundle) return [];
  const items: { t: number; text: string }[] = [];
  const re = q.grep ? new RegExp(q.grep, 'i') : undefined;

  const info = resolveSession({ bundle });
  if (info) {
    for (const e of loadSession(info).all()) {
      if (e.startMs < q.sinceMs || (!q.all && isNoise(e))) continue;
      const r = row(e, info);
      if (!re || re.test(r)) items.push({ t: e.startMs, text: `${clock(e.startMs)}  net  ${r.replace(/^#\d+\s+\S+\s+/, (m) => m.split(/\s+/)[0] + ' ')}` });
    }
  }
  for (const l of readLogs({ bundle, sources: q.sources, sinceMs: q.sinceMs, grep: q.grep })) {
    items.push({ t: l.t, text: logLine(l) });
  }
  const sorted = items.sort((a, b) => a.t - b.t).map((i) => i.text);
  return q.limit ? sorted.slice(-q.limit) : sorted;
}
