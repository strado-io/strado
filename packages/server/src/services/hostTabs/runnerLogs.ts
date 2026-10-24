// The runner's own log for the host Logs tab: the systemd journal of its unit
// when it runs under systemd, else the server.log the runner tees console
// output to (the same two places `strado-runner logs` reads).
//
// Only the runner's own lines and systemd's lines about the unit: podman and
// the one-shot containers log into the same unit, and their output can carry
// device codes and CLI chatter. Every line is redacted here, before it leaves
// the runner, and the grep filter runs on the redacted text so it cannot be
// used to probe for a secret.
import fsp from 'node:fs/promises';
import type { ExecFn } from '../sandbox/runtime.js';
import type { LogLine, LogPage, LogQuery } from './types.js';
import { lineRedactor } from './redact.js';

export type LogDeps = {
  exec: ExecFn;
  /** The runner process runs as a systemd unit (INVOCATION_ID is set). */
  underSystemd: boolean;
  /** ~/.strado/logs/server.log */
  logFile: string;
};

const UNIT = 'strado-runner';
const MAX_TEXT = 4000;
/** A filtered read looks this much further back, so it can still fill a page. */
const GREP_FACTOR = 20;
const MAX_READ = 20_000;
const FILE_TAIL_BYTES = 4 * 1024 * 1024;

type Level = LogLine['level'];

const fromPino = (n: number): Level => (n >= 50 ? 'error' : n >= 40 ? 'warn' : n >= 30 ? 'info' : 'debug');
const fromPriority = (p: number): Level => (p <= 3 ? 'error' : p === 4 ? 'warn' : p === 7 ? 'debug' : 'info');
/** Most runner lines are plain console.log at priority 6; read the words. */
const fromText = (t: string): Level | null =>
  /\b(error|failed|fatal|exception)\b/i.test(t) ? 'error' : /\b(warn|warning|refused)\b/i.test(t) ? 'warn' : null;

/** A pino JSON line (fastify's logger): its own level, time and msg. */
function pino(text: string): { level: Level; time: number | null; msg: string } | null {
  if (!text.startsWith('{"level":')) return null;
  try {
    const j = JSON.parse(text) as { level?: unknown; time?: unknown; msg?: unknown };
    if (typeof j.level !== 'number') return null;
    return { level: fromPino(j.level), time: typeof j.time === 'number' ? j.time : null, msg: String(j.msg ?? '') };
  } catch {
    return null;
  }
}

function line(ts: number, raw: string, base: Level, redact: (s: string) => string): LogLine {
  const p = pino(raw);
  // Redact the whole message, then cut: a cut first can leave the head of a
  // secret too short for its pattern.
  const text = redact(p ? p.msg : raw).slice(0, MAX_TEXT);
  const level = p ? p.level : base === 'info' ? fromText(text) ?? base : base;
  return { ts: p?.time ?? ts, level, text };
}

function finish(lines: LogLine[], q: LogQuery, n: number): LogLine[] {
  const g = q.grep?.trim().toLowerCase();
  const kept = lines.filter((l) => (q.since === undefined || l.ts > q.since) && (!g || l.text.toLowerCase().includes(g)));
  return kept.slice(-n);
}

async function fromJournal(q: LogQuery, n: number, exec: ExecFn): Promise<LogLine[] | null> {
  const read = q.grep ? Math.min(n * GREP_FACTOR, MAX_READ) : n;
  const args = ['--user', '-u', UNIT, '-t', UNIT, '-t', 'systemd', '-o', 'json', '--no-pager'];
  if (q.since !== undefined) args.push('--since', `@${Math.floor(q.since / 1000)}`);
  args.push('-n', String(read));
  let r: { code: number; stdout: string };
  try {
    r = await exec('journalctl', args, 15_000);
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  const out: LogLine[] = [];
  const redact = lineRedactor();
  for (const raw of r.stdout.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const j = JSON.parse(raw) as { __REALTIME_TIMESTAMP?: string; MESSAGE?: unknown; PRIORITY?: string };
      const msg = Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE as number[]).toString('utf8') : String(j.MESSAGE ?? '');
      const ts = Number(j.__REALTIME_TIMESTAMP) / 1000;
      if (!Number.isFinite(ts)) continue;
      out.push(line(ts, msg, fromPriority(Number(j.PRIORITY ?? 6)), redact));
    } catch {
      /* not a journal entry */
    }
  }
  return out;
}

async function fromFile(q: LogQuery, n: number, file: string): Promise<LogPage> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, 'r');
  } catch {
    return { lines: [], source: 'none', nextSince: null };
  }
  try {
    // A plain file has no cursor to follow from.
    if (q.since !== undefined) return { lines: [], source: 'file', nextSince: null };
    const { size, mtimeMs } = await fh.stat();
    const start = Math.max(0, size - FILE_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const raws = buf.toString('utf8').split('\n');
    if (start > 0) raws.shift(); // a partial first line
    // Lines carry no time unless pino wrote them; each takes the last known one.
    let ts = mtimeMs;
    let seen = false;
    const out: LogLine[] = [];
    const redact = lineRedactor();
    for (const raw of raws) {
      if (!raw.trim()) continue;
      const l = line(ts, raw, 'info', redact);
      const t = pino(raw)?.time;
      if (t != null) {
        ts = t;
        seen = true;
      } else if (seen) {
        l.ts = ts;
      }
      out.push(l);
    }
    return { lines: finish(out, q, n), source: 'file', nextSince: null };
  } finally {
    await fh.close();
  }
}

export async function readRunnerLogs(q: LogQuery, deps: LogDeps): Promise<LogPage> {
  const n = Math.min(1000, Math.max(1, Math.floor(q.lines ?? 300)));
  if (deps.underSystemd) {
    const all = await fromJournal(q, n, deps.exec);
    if (all) {
      const lines = finish(all, q, n);
      return { lines, source: 'journal', nextSince: lines.at(-1)?.ts ?? q.since ?? null };
    }
  }
  return fromFile(q, n, deps.logFile);
}
