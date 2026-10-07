import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeKey, type LiveSession } from './terminalManager.js';

// Parking an idle Claude tab: its `claude` process (~300 MB each) is stopped,
// but the tab stays in the list and remembers which conversation it was
// showing. The next keystroke in that tab respawns it with
// `claude --resume <id>`, so the conversation comes back where it was.
//
// Only Claude tabs park: Claude persists every conversation to a transcript
// and Strado's status hook already records the conversation id per tab
// (agentSessions). Shells, dev servers and other agents have nothing to
// resume, so killing them would lose work.
//
// A tab nobody has typed into yet parks too (~225 MB for an empty Claude):
// it has no conversation, so waking it just starts a fresh `claude`.

export const PARK_BANNER = '[strado:parked]';

export type ParkedSession = {
  path: string;
  sessionId: string;
  /** Absent for a tab that was parked before any conversation started. */
  providerSessionId?: string;
  transcriptPath?: string;
  parkedAt: string;
};

export type ParkStore = {
  get(key: string): ParkedSession | null;
  /** Claude tab ids parked under one worktree, for the session payloads. */
  idsFor(worktreePath: string): string[];
  add(entry: ParkedSession): void;
  remove(key: string): void;
  removeUnder(pathPrefix: string): void;
};

export function parkMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STRADO_PARK_IDLE_MINUTES;
  if (raw === undefined || raw === '') return 15;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15;
}

/**
 * In-memory map persisted to disk, so a parked tab survives a Strado restart
 * (the pty daemon keeps live sessions across restarts; a parked one has no
 * pty, so this file is the only thing that remembers it).
 */
export function createParkStore(filePath: string): ParkStore {
  const entries = new Map<string, ParkedSession>();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { parked?: ParkedSession[] };
    for (const e of parsed.parked ?? []) {
      if (e && typeof e.path === 'string' && typeof e.sessionId === 'string') {
        entries.set(claudeKey(e.path, e.sessionId), e);
      }
    }
  } catch {
    // missing or malformed: nothing parked
  }

  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify({ parked: [...entries.values()] }, null, 2);
    writing = writing.then(async () => {
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, filePath);
      } catch {
        // best-effort: losing it only means a parked tab disappears on restart
      }
    });
  };

  return {
    get: (key) => entries.get(key) ?? null,
    idsFor: (worktreePath) =>
      [...entries.values()].filter((e) => e.path === worktreePath).map((e) => e.sessionId),
    add(entry) {
      entries.set(claudeKey(entry.path, entry.sessionId), entry);
      persist();
    },
    remove(key) {
      if (entries.delete(key)) persist();
    },
    removeUnder(pathPrefix) {
      let changed = false;
      for (const [key, e] of entries) {
        if (e.path === pathPrefix || e.path.startsWith(pathPrefix + path.sep)) {
          entries.delete(key);
          changed = true;
        }
      }
      if (changed) persist();
    },
  };
}

// Claude writes one <conversation>.jsonl per conversation under
// <config>/projects/<cwd with every non-alphanumeric as '-'>.
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** True when no conversation file in `dir` was written at or after `sinceMs`. */
export async function noTranscriptSince(dir: string, sinceMs: number): Promise<boolean> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      if ((await fsp.stat(path.join(dir, name))).mtimeMs >= sinceMs) return false;
    } catch {
      return false; // unreadable: assume it is in use
    }
  }
  return true;
}

/** Start time of a process (ms since epoch), or null if it can't be read. */
export function processStartMs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (err, stdout) => {
      const t = err ? NaN : Date.parse(stdout.trim());
      resolve(Number.isFinite(t) ? t : null);
    });
  });
}

// Every command Claude's Bash tool runs — foreground or run_in_background —
// is a shell that first sources Claude's shell snapshot. MCP servers and
// Claude's own helpers (caffeinate, bg-spare) are started directly, so this
// marker separates "work Claude left running" from plumbing.
const CLAUDE_SHELL_MARKER = '/shell-snapshots/snapshot-';

/**
 * True when anything under `rootPid` is a command Claude started (a dev
 * server, a long test run, a watcher). Parking stops `claude` and everything
 * under it, so such a tab must stay up. If the process table can't be read,
 * answers true: unsure means leave it running.
 */
export function hasBackgroundJobs(rootPid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(true); return; }
      resolve(jobsUnder(rootPid, stdout));
    });
  });
}

export function jobsUnder(rootPid: number, psOutput: string): boolean {
  const children = new Map<number, Array<{ pid: number; command: string }>>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push({ pid: Number(m[1]), command: m[3]! });
    children.set(ppid, list);
  }
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (child.command.includes(CLAUDE_SHELL_MARKER)) return true;
      stack.push(child.pid);
    }
  }
  return false;
}

// `ps lstart` has 1-second resolution; anything this close to the start
// counts as belonging to the running process.
const START_SLACK_MS = 2_000;

export function startClaudeParkSweep(opts: {
  liveSessions: () => LiveSession[];
  lastActivity: (key: string) => number | null;
  /** Claude's own state for that tab; a working turn is never parked. */
  status: (worktreePath: string, sessionId: string) => string | undefined;
  /** Something Claude started is still running under the tab (never parked). */
  backgroundJobs: (key: string) => Promise<boolean>;
  /** When the tab's current process started; null = unknown, never parked. */
  processStart: (key: string) => Promise<number | null>;
  conversation: (worktreePath: string, sessionId: string) =>
    Promise<{ providerSessionId: string; transcriptPath?: string; updatedAt: string } | null>;
  /** No conversation file for this folder written since `sinceMs`. */
  unusedSince: (worktreePath: string, sinceMs: number) => Promise<boolean>;
  park: (key: string, entry: ParkedSession) => void;
  idleMs: number;
  intervalMs?: number;
  now?: () => number;
}): { stop(): void; tick(): Promise<void> } {
  const now = opts.now ?? Date.now;
  // Sessions already running when Strado (re)started have no recorded
  // activity; first sight counts as activity so a restart never parks a tab
  // the user was just looking at.
  const firstSeen = new Map<string, number>();
  let running = false;

  // What waking this tab should do, or null to leave it running.
  async function plan(s: LiveSession, key: string): Promise<Omit<ParkedSession, 'parkedAt'> | null> {
    const started = await opts.processStart(key);
    if (started === null) return null;
    const since = started - START_SLACK_MS;
    const convo = await opts.conversation(s.path, s.id).catch(() => null);
    // The tab-id → conversation mapping outlives the process (it is kept for
    // handoffs), so a recorded id from before this process started belongs to
    // an EARLIER Claude in this tab. Resuming it would swap conversations.
    if (convo && Date.parse(convo.updatedAt) >= since) {
      // Transcript gone: resuming would open a blank Claude — leave it.
      if (convo.transcriptPath && !fs.existsSync(convo.transcriptPath)) return null;
      return {
        path: s.path,
        sessionId: s.id,
        providerSessionId: convo.providerSessionId,
        ...(convo.transcriptPath ? { transcriptPath: convo.transcriptPath } : {}),
      };
    }
    // No current conversation on record. Park it only if Claude hasn't
    // written ANY conversation for this folder since the process started:
    // a conversation whose hook reported elsewhere (another Strado) would
    // show up there, and a tab with an unknown conversation must not be
    // replaced by a fresh one.
    if (await opts.unusedSince(s.path, since).catch(() => false)) {
      return { path: s.path, sessionId: s.id };
    }
    return null;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const live = opts.liveSessions().filter((s) => s.mode === 'claude');
      const liveKeys = new Set(live.map((s) => claudeKey(s.path, s.id)));
      for (const key of firstSeen.keys()) if (!liveKeys.has(key)) firstSeen.delete(key);

      for (const s of live) {
        const key = claudeKey(s.path, s.id);
        let last = opts.lastActivity(key);
        if (last === null) {
          if (!firstSeen.has(key)) firstSeen.set(key, now());
          last = firstSeen.get(key)!;
        }
        if (now() - last < opts.idleMs) continue;
        if (opts.status(s.path, s.id) === 'working') continue;
        // Claude can finish its reply while a command it started keeps
        // running (run_in_background: a dev server, a test watcher). The tab
        // looks idle, but parking would kill that job.
        if (await opts.backgroundJobs(key).catch(() => true)) continue;
        const entry = await plan(s, key);
        if (!entry) continue;
        opts.park(key, { ...entry, parkedAt: new Date(now()).toISOString() });
        firstSeen.delete(key);
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
