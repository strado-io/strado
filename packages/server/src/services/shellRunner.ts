import { randomBytes } from 'node:crypto';
import type { EventBus } from '../events/bus.js';
import { RUN_INPUT_QUIET_MS, RUN_MARKER_PREFIX, RUN_OUTPUT_MAX, RUN_TRUNCATED_MARKER } from './intercomSchema.js';
import { INTERCOM_CHANNEL } from './intercomStore.js';
import type { PtyActivity } from './ptyActivity.js';
import type { TerminalManager } from './terminalManager.js';
import { stripAnsi, tailBytes } from './terminalText.js';

export type ShellRunResult = { output: string; settled: boolean; durationMs: number };
export type ShellRunErrorCode = 'BUSY' | 'INPUT_BUSY' | 'NOT_RUNNING';

export class ShellRunError extends Error {
  constructor(readonly code: ShellRunErrorCode) {
    super(code);
    this.name = 'ShellRunError';
  }
}

export type ShellRunnerDeps = {
  /** Read lazily so the runner and the registry's liveness check see the same manager. */
  terminal: () => Pick<TerminalManager, 'write' | 'status' | 'subscribe'>;
  activity: Pick<PtyActivity, 'quiet'>;
  bus: EventBus;
  now?: () => number;
  /** Test seam for the cap timer. Production: setTimeout + unref. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  /** Test seam for the per-run completion sentinel. Production: a fresh nonce. */
  marker?: () => string;
  log?: (message: string, err: unknown) => void;
};

export type ShellRunner = {
  /** Write `command`, a completion sentinel (`; echo <sentinel>`) and Enter
   * into the tab, and resolve with everything the PTY printed. `settled` is
   * true when the sentinel came back anywhere past the echoed command line —
   * the shell reached the end of the command — and false when `timeoutMs`
   * elapsed first (still running, an interactive program, a tab not at a
   * shell prompt). Output that does not end in a newline puts the sentinel
   * mid-line (`printf abc` → `abc<sentinel>`) and settles just the same.
   * Rejects with ShellRunError: BUSY (a run is in flight for this key), INPUT_BUSY
   * (user keystrokes within RUN_INPUT_QUIET_MS), NOT_RUNNING (tab not
   * running, write failed, or the tab exited mid-run). The caller clamps
   * `timeoutMs`. */
  run(key: string, command: string, opts: { timeoutMs: number }): Promise<ShellRunResult>;
  /** The tab exited: reject its pending run with NOT_RUNNING and free the key. No-op otherwise. */
  forget(key: string): void;
};

const defaultSchedule: NonNullable<ShellRunnerDeps['schedule']> = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { cancel: () => clearTimeout(t) };
};

const defaultMarker = (): string => `${RUN_MARKER_PREFIX}${randomBytes(4).toString('hex')}__`;

const ECHO_PREFIX = '; echo ';
/** How far back the echo guard looks. Comfortably more than ECHO_PREFIX, so a
 * line editor's wrap breaks inside it are still covered. */
const PRE_WINDOW = 24;

/** True when this sentinel occurrence is the copy inside the echoed command
 * line rather than one the shell printed. A command wider than the tab can be
 * echoed back with real line breaks in it, so the breaks are ignored here:
 * `…; ec\nho <marker>` is still the echo. */
function isEchoedSentinel(text: string, at: number): boolean {
  return text.slice(Math.max(0, at - PRE_WINDOW), at).replace(/\n/g, '').endsWith(ECHO_PREFIX);
}

export function createShellRunner(deps: ShellRunnerDeps): ShellRunner {
  const schedule = deps.schedule ?? defaultSchedule;
  const newMarker = deps.marker ?? defaultMarker;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  // One in-flight run per tab key; the value aborts it.
  const active = new Map<string, (err: ShellRunError) => void>();

  const emit = (data: Record<string, unknown>): void => {
    try {
      deps.bus.emit(INTERCOM_CHANNEL, { type: 'shell.run', data });
    } catch (err) {
      log('shell run: emit failed', err);
    }
  };

  const run: ShellRunner['run'] = async (key, command, opts) => {
    if (active.has(key)) throw new ShellRunError('BUSY');
    const terminal = deps.terminal();
    if (terminal.status(key).status !== 'running') throw new ShellRunError('NOT_RUNNING');
    if (deps.activity.quiet(key).input < RUN_INPUT_QUIET_MS) throw new ShellRunError('INPUT_BUSY');

    const marker = newMarker();
    const echoed = `${ECHO_PREFIX}${marker}`;
    const carryMax = marker.length + PRE_WINDOW;
    const started = now();
    return new Promise<ShellRunResult>((resolve, reject) => {
      // Bounded while the run is in flight: a command that prints forever
      // (`yes`) would otherwise retain everything the PTY printed until the
      // cap fired. The in-flight slice is by CHARS, not bytes — a cheap upper
      // bound that always keeps at least RUN_OUTPUT_MAX bytes, so `finish`
      // still has enough text for the byte-exact tail.
      let buf = '';
      let cut = false;
      let cap: { cancel(): void } | null = null;
      let unsub: () => void = () => {};
      let done = false;
      // Detection state: the tail of the ANSI-stripped stream seen so far (so a
      // sentinel split across two chunks is still found), a trailing CR held
      // back from the previous chunk, and whether the first line break — the
      // end of the echoed command — has gone by.
      let carry = '';
      let pendingCR = '';
      let echoLineDone = false;

      const finish = (settled: boolean, err?: ShellRunError): void => {
        if (done) return;
        done = true;
        unsub();
        cap?.cancel();
        active.delete(key);
        const durationMs = now() - started;
        if (err) { reject(err); return; }
        let text = stripAnsi(buf);
        // The sentinel we appended is not part of what the caller asked to run.
        const at = text.indexOf(echoed);
        if (at >= 0) text = text.slice(0, at) + text.slice(at + echoed.length);
        // Settled: drop the sentinel and everything after it (the prompt). The
        // cut is at the sentinel itself, not at its line start, so output that
        // ended without a newline keeps ending without one.
        if (settled) {
          const nl = text.indexOf('\n');
          let end = text.indexOf(marker, nl >= 0 ? nl + 1 : 0);
          while (end >= 0 && isEchoedSentinel(text, end)) end = text.indexOf(marker, end + marker.length);
          if (end >= 0) text = text.slice(0, end);
        }
        let output = tailBytes(text, RUN_OUTPUT_MAX, RUN_TRUNCATED_MARKER);
        // Dropped in flight but the retained tail happens to fit: say so anyway.
        if (cut && !output.startsWith(RUN_TRUNCATED_MARKER)) output = RUN_TRUNCATED_MARKER + output;
        emit({ key, settled, durationMs, outputBytes: Buffer.byteLength(output, 'utf8') });
        resolve({ output, settled, durationMs });
      };

      active.set(key, (err) => finish(false, err));
      // Subscribe first so the command echo is part of the output.
      unsub = terminal.subscribe(key, (data) => {
        // Detect on stripped text: a prompt that interleaves escapes inside the
        // sentinel line must not hide it. Anywhere past the first line break
        // counts — a command whose output has no trailing newline leaves the
        // sentinel mid-line. The echoed command line holds the sentinel too
        // (after `; echo `), so a match there is ignored — including when the
        // line editor wrapped that echo across a break.
        // A chunk that ends on a bare CR would be erased by stripAnsi's
        // carriage-return overwrite (its lookahead cannot see the LF that has
        // not arrived yet), taking the sentinel with it. Hold that CR back and
        // give it to the next chunk. `buf` still gets the raw data: `finish`
        // strips the whole buffer at once and never sees a split.
        const raw = pendingCR + data;
        pendingCR = raw.endsWith('\r') ? '\r' : '';
        const view = stripAnsi(carry + (pendingCR ? raw.slice(0, -1) : raw));
        let breakAt = -1;
        if (!echoLineDone) {
          breakAt = view.indexOf('\n');
          if (breakAt >= 0) echoLineDone = true;
        }
        let hit = false;
        let examined = 0;   // nothing before this is ever looked at again
        for (let i = view.indexOf(marker); i >= 0; i = view.indexOf(marker, i + marker.length)) {
          examined = i + marker.length;
          if (!echoLineDone || i < breakAt) continue;   // still on the echoed command line
          if (isEchoedSentinel(view, i)) continue;      // the echo, wrapped across a break
          hit = true;
          break;
        }
        // The carry keeps enough left context for the guard and for a sentinel
        // split across chunks, but never reaches back over one already judged.
        carry = view.slice(Math.max(examined, view.length - carryMax));
        buf += data;
        if (buf.length > 2 * RUN_OUTPUT_MAX) { buf = buf.slice(-RUN_OUTPUT_MAX); cut = true; }
        if (hit) finish(true);
      });
      cap = schedule(() => finish(false), opts.timeoutMs);
      try {
        terminal.write(key, `${command}${echoed}\r`);
      } catch (err) {
        log(`shell run: write failed for ${key}`, err);
        finish(false, new ShellRunError('NOT_RUNNING'));
      }
    });
  };

  const forget: ShellRunner['forget'] = (key) => {
    active.get(key)?.(new ShellRunError('NOT_RUNNING'));
  };

  return { run, forget };
}
