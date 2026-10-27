// Actions with side effects: launching the app (optionally injected / with console capture), waiting for traffic.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, loadSession, ROOT, SessionReader, type Entry, type SessionInfo } from './store.ts';
import { applyFilters, type Filters } from './views.ts';

export const DYLIB = process.env.SIMPEEK_DYLIB
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ios/build/SimPeek.dylib');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LaunchOptions = {
  device?: string;
  /** Inject SimPeek.dylib. Leave off for apps that link the SimPeek package. */
  inject?: boolean;
  /** Capture stdout/stderr (print, NSLog …) into ~/.simpeek/<bundle>/console/. */
  console?: boolean;
  /** Extra environment for the app process. */
  env?: Record<string, string>;
};

export type LaunchResult = { session?: SessionInfo; consoleFile?: string };

/** Relaunches `bundle` on a simulator; resolves once the app's SimPeek session appears (if any). */
export async function launch(bundle: string, o: LaunchOptions = {}): Promise<LaunchResult> {
  const device = o.device ?? 'booted';
  if (o.inject && !fs.existsSync(DYLIB)) throw new Error(`SimPeek.dylib not found at ${DYLIB}; run ios/scripts/build-dylib.sh`);
  const env: NodeJS.ProcessEnv = { ...process.env, SIMCTL_CHILD_SIMPEEK_DIR: ROOT };
  if (o.inject) env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = DYLIB;
  for (const [k, v] of Object.entries(o.env ?? {})) env[`SIMCTL_CHILD_${k}`] = v;

  const before = Date.now();
  spawnSync('xcrun', ['simctl', 'terminate', device, bundle], { stdio: 'ignore' });
  let consoleFile: string | undefined;
  if (o.console) {
    consoleFile = startConsoleCapture(bundle, device, env);
  } else {
    const res = spawnSync('xcrun', ['simctl', 'launch', device, bundle], { encoding: 'utf8', env });
    if (res.status !== 0) throw new Error(`simctl launch failed: ${(res.stderr || res.stdout).trim()}`);
  }

  for (let i = 0; i < 40; i++) {
    const s = listSessions(bundle).find((x) => x.mtimeMs >= before - 1000);
    if (s && Date.parse(String(s.meta.startedDateTime)) >= before - 1000) return { session: s, consoleFile };
    await sleep(250);
  }
  return { consoleFile };
}

/**
 * Launches with a pty attached so stdout is line-buffered, and prefixes every line with a local
 * timestamp. The pipeline is detached: it lives exactly as long as the app process.
 */
function startConsoleCapture(bundle: string, device: string, env: NodeJS.ProcessEnv): string {
  const dir = path.join(ROOT, bundle, 'console');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `${stamp}.log`);
  const perl = `$|=1; use POSIX qw(strftime); use Time::HiRes qw(time); s/\\r//g; my $t=time; printf("%s.%03d %s", strftime("%Y-%m-%dT%H:%M:%S", localtime($t)), ($t-int($t))*1000, $_);`;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `xcrun simctl launch --console-pty --terminate-running-process ${q(device)} ${q(bundle)} 2>&1 | perl -ne ${q(perl)} >> ${q(file)}`;
  const child = spawn('/bin/sh', ['-c', cmd], { env, detached: true, stdio: 'ignore' });
  child.unref();
  return file;
}

/** Waits until a request matching `filters` finishes after `sinceMs`; returns all such entries. */
export async function waitFor(
  opts: { bundle?: string; filters: Filters; timeoutMs: number; sinceMs: number },
): Promise<{ info?: SessionInfo; entries: Entry[] }> {
  const deadline = Date.now() + opts.timeoutMs;
  let reader: SessionReader | undefined;
  while (true) {
    const latest = listSessions(opts.bundle)[0];
    if (latest && latest.file !== reader?.info.file) reader = loadSession(latest);
    else reader?.poll();
    if (reader) {
      const done = reader.all().filter((e) => e.done && e.startMs + (e.time ?? 0) >= opts.sinceMs);
      const { kept } = applyFilters(done, reader.info, { ...opts.filters, since: undefined });
      if (kept.length) return { info: reader.info, entries: kept };
    }
    if (Date.now() >= deadline) return { info: reader?.info, entries: [] };
    await sleep(250);
  }
}
