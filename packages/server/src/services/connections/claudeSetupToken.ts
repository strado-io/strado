import { execFile } from 'node:child_process';
import * as pty from 'node-pty';
import { writeClaudeToken } from '../agentLogins/store.js';
import { defaultShell } from '../platform.js';

// "Connect Claude": run `claude setup-token` (it opens the browser itself and
// waits for the local callback) and keep the token it prints. In-process
// node-pty on purpose, never terminalManager or ptyd: their ring buffer,
// mirror and snapshots are readable by other routes. The output lives only in
// a local string here and is never logged, emitted or quoted in an error.

export type PtyLike = {
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  kill(signal?: string): void;
};
export type SpawnPty = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

export type SetupTokenPhase = 'opening-browser' | 'waiting-approval' | 'saving';

const TIMEOUT_MS = 10 * 60_000;
/** Wide enough that the token never wraps onto a second line. */
const COLS = 1000;
/** Only the tail matters: the token is the last thing printed. */
const MAX_BUFFER = 64 * 1024;
const ENV_KEYS = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR']);

const CANCELLED = 'Claude sign-in cancelled';
const TIMED_OUT = 'Claude sign-in timed out';
const NO_TOKEN = 'Claude sign-in finished without a token';
const NO_START = 'could not start claude setup-token';
const NO_SAVE = 'could not save the Claude token';
const NOT_INSTALLED = 'Claude Code is not installed on this Mac';
/** Every message a capture can fail with; anything else is not ours to show. */
export const SETUP_TOKEN_ERRORS: ReadonlySet<string> = new Set([CANCELLED, TIMED_OUT, NO_TOKEN, NO_START, NO_SAVE, NOT_INSTALLED]);

const realSpawn: SpawnPty = (file, args, opts) => pty.spawn(file, args, opts);

/** Terminal output → plain text. A cursor-forward is the gap Ink draws instead
 *  of a space, so it becomes one; every other escape is dropped. */
function plain(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\d*C/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

/** The token, once a non-token character follows it (a chunk can end mid-token);
 *  `final` accepts one at the very end, for output that stopped there. */
export function extractToken(raw: string, opts: { final?: boolean } = {}): string | null {
  const m = /sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/.exec(plain(raw))
    ?? (opts.final ? /sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.exec(plain(raw)) : null);
  return m ? m[0] : null;
}

function ownEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (ENV_KEYS.has(k) || k.startsWith('LC_'))) env[k] = v;
  }
  return { ...env, TERM: env.TERM || 'xterm-256color' };
}

/** Where `claude` is on the user's login PATH (the app may have been launched
 *  without it), or null. Only the lookup runs in the login shell; the capture
 *  itself execs the binary directly, so no rc file runs alongside the token. */
export function resolveClaude(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(defaultShell(), ['-l', '-c', 'command -v claude'], { env: ownEnv(), timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(null);
      // rc files may print first; the answer is the last absolute path.
      const line = String(stdout).split('\n').map((l) => l.trim()).filter((l) => /^\/\S+$/.test(l)).pop();
      resolve(line ?? null);
    });
  });
}

export async function captureSetupToken(opts: {
  onPhase(p: SetupTokenPhase): void;
  signal: AbortSignal;
  spawn?: SpawnPty;
  save?: (token: string) => Promise<void>;
  resolve?: () => Promise<string | null>;
  timeoutMs?: number;
}): Promise<void> {
  const { onPhase, signal, spawn = realSpawn, save = writeClaudeToken, resolve = resolveClaude, timeoutMs = TIMEOUT_MS } = opts;
  if (signal.aborted) throw new Error(CANCELLED);
  const claude = await resolve();
  if (signal.aborted) throw new Error(CANCELLED);
  if (!claude) throw new Error(NOT_INSTALLED);

  let term: PtyLike;
  try {
    term = spawn(claude, ['setup-token'], {
      name: 'xterm-256color', cols: COLS, rows: 40, cwd: process.env.HOME || '/', env: ownEnv(),
    });
  } catch {
    throw new Error(NO_START);
  }
  onPhase('opening-browser');

  let buffer = '';
  let waiting = false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const token = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null, tok?: string) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(tok!);
      };
      term.onData((d) => {
        buffer = (buffer + d).slice(-MAX_BUFFER);
        if (!waiting && /browser|paste code/i.test(plain(buffer))) {
          waiting = true;
          onPhase('waiting-approval');
        }
        const tok = extractToken(buffer);
        if (tok) finish(null, tok);
      });
      term.onExit(() => {
        const tok = extractToken(buffer, { final: true });
        finish(tok ? null : new Error(signal.aborted ? CANCELLED : NO_TOKEN), tok ?? undefined);
      });
      timer = setTimeout(() => finish(new Error(TIMED_OUT)), timeoutMs);
      onAbort = () => finish(new Error(CANCELLED));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    buffer = '';
    onPhase('saving');
    try {
      await save(token);
    } catch {
      throw new Error(NO_SAVE);
    }
  } finally {
    buffer = '';
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try { term.kill(); } catch { /* already gone */ }
  }
}

type Capture = (opts: { onPhase(p: SetupTokenPhase): void; signal: AbortSignal }) => Promise<void>;

/** One capture at a time, shared: a Connect on a second runner while the first
 *  is waiting joins it (one browser approval, one token) instead of opening
 *  another. Each joiner gets the phases, the latest replayed on join; the pty
 *  ends only when every joiner has cancelled. */
export function createSharedCapture(capture: Capture = captureSetupToken): Capture {
  type Run = { promise: Promise<void>; ac: AbortController; waiters: Set<(p: SetupTokenPhase) => void>; last: SetupTokenPhase | null };
  let current: Run | null = null;
  return ({ onPhase, signal }) => {
    if (signal.aborted) return Promise.reject(new Error(CANCELLED));
    if (!current) {
      const r: Run = { promise: Promise.resolve(), ac: new AbortController(), waiters: new Set(), last: null };
      r.promise = capture({
        onPhase: (p) => {
          r.last = p;
          for (const w of r.waiters) w(p);
        },
        signal: r.ac.signal,
      }).finally(() => {
        if (current === r) current = null;
      });
      r.promise.catch(() => undefined);
      current = r;
    }
    const r = current;
    const waiter = (p: SetupTokenPhase) => onPhase(p);
    r.waiters.add(waiter);
    if (r.last) onPhase(r.last);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        r.waiters.delete(waiter);
        if (!r.waiters.size) {
          if (current === r) current = null;
          r.ac.abort();
        }
        reject(new Error(CANCELLED));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      r.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
        r.waiters.delete(waiter);
      });
    });
  };
}
