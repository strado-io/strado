// Bird's-eye view of every pty session the daemon holds, with the CPU and
// memory of the process tree under each one. One `ps` sample per request;
// the rollup is pure so it can be pinned in tests.
import { execFile } from 'node:child_process';
import {
  claudeKey,
  codexKey,
  opencodeKey,
  piKey,
  shellKey,
  type LiveSession,
} from './terminalManager.js';

export type ProcSample = { pid: number; ppid: number; cpu: number; rssKb: number };

export type ProcTotals = { cpu: number; rssBytes: number; processes: number };

export type SessionMetric = LiveSession & {
  /** The TerminalManager key — what DELETE /api/sessions/:key takes. */
  key: string;
  pid: number | null;
} & ProcTotals;

export type AppProcMetric = { pid: number; cpu: number; rssBytes: number };

export type SessionMetrics = {
  sampledAt: number;
  app: { server: AppProcMetric; daemon: AppProcMetric | null };
  sessions: SessionMetric[];
};

/** Parse `ps -Ao pid=,ppid=,%cpu=,rss=` (rss in KB). Malformed lines are skipped. */
export function parsePsOutput(text: string): ProcSample[] {
  const out: ProcSample[] = [];
  for (const raw of text.split('\n')) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    const cpu = Number(cols[2]);
    const rssKb = Number(cols[3]);
    if (![pid, ppid, cpu, rssKb].every(Number.isFinite)) continue;
    out.push({ pid, ppid, cpu, rssKb });
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Totals for `rootPid` plus every descendant in the sample. */
export function subtreeTotals(procs: ProcSample[], rootPid: number): ProcTotals {
  const children = new Map<number, ProcSample[]>();
  const byPid = new Map<number, ProcSample>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  if (!byPid.has(rootPid)) return { cpu: 0, rssBytes: 0, processes: 0 };
  let cpu = 0;
  let rssKb = 0;
  let processes = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = byPid.get(pid);
    if (!p) continue;
    cpu += p.cpu;
    rssKb += p.rssKb;
    processes++;
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return { cpu: round1(cpu), rssBytes: rssKb * 1024, processes };
}

export function sessionKeyOf(s: LiveSession): string {
  switch (s.mode) {
    case 'shell': return shellKey(s.path, s.id);
    case 'codex': return codexKey(s.path, s.id);
    case 'opencode': return opencodeKey(s.path, s.id);
    case 'pi': return piKey(s.path, s.id);
    default: return claudeKey(s.path, s.id);
  }
}

export function buildSessionMetrics(input: {
  live: LiveSession[];
  pidOf: (key: string) => number | null;
  procs: ProcSample[];
  serverPid: number;
  daemonPid: number | null;
  now?: number;
}): SessionMetrics {
  const one = (pid: number): AppProcMetric => {
    const p = input.procs.find((x) => x.pid === pid);
    return { pid, cpu: round1(p?.cpu ?? 0), rssBytes: (p?.rssKb ?? 0) * 1024 };
  };
  const sessions: SessionMetric[] = input.live.map((s) => {
    const key = sessionKeyOf(s);
    const pid = input.pidOf(key);
    const totals = pid ? subtreeTotals(input.procs, pid) : { cpu: 0, rssBytes: 0, processes: 0 };
    return { ...s, key, pid, ...totals };
  });
  return {
    sampledAt: input.now ?? Date.now(),
    app: {
      server: one(input.serverPid),
      daemon: input.daemonPid ? one(input.daemonPid) : null,
    },
    sessions,
  };
}

/** One system-wide sample. Empty on platforms without `ps` (never throws). */
export function sampleProcesses(): Promise<ProcSample[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : parsePsOutput(stdout));
    });
  });
}
