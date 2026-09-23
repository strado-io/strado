import type { EventBus } from '../events/bus.js';
import type { AgentRegistry } from './agentRegistry.js';
import {
  HOOK_PULL_LIMIT,
  PUSH_ENTER_DELAY_MS,
  PUSH_INPUT_QUIET_MS,
  PUSH_OUTPUT_QUIET_MS,
  PUSH_OUTPUT_RETRY_MS,
  PUSH_RETRY_MAX,
  PUSH_RETRY_MS,
} from './intercomSchema.js';
import { INTERCOM_CHANNEL, type IntercomStore } from './intercomStore.js';
import type { PtyActivity } from './ptyActivity.js';
import { sessionKeyFor, type TerminalManager } from './terminalManager.js';

export type PushReason = 'arrival' | 'stop';
export type SkipReason =
  | 'disabled' | 'unknown-agent' | 'unsupported-mode' | 'not-idle' | 'not-running'
  | 'inbox-empty' | 'already-pushed' | 'already-nudged' | 'input-busy' | 'output-busy' | 'retry-exhausted' | 'error';

export type IntercomPushDeps = {
  agents: Pick<AgentRegistry, 'list'>;
  intercom: Pick<IntercomStore, 'peek'>;
  /** Read lazily so the pusher and the registry's liveness check see the same manager. */
  terminal: () => Pick<TerminalManager, 'write' | 'status'>;
  activity: Pick<PtyActivity, 'quiet'>;
  bus: EventBus;
  enabled: () => boolean;
  /** Test seam for the quiet-gate retries and the deferred Enter. Production: setTimeout + unref. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (message: string, err: unknown) => void;
};

export type IntercomPush = {
  /** Never rejects. 'sent' when a nudge was written, else 'skipped' (with a push.skipped event, deduped per idle period). */
  consider(scopeId: string, agentId: string, trigger: PushReason): Promise<'sent' | 'skipped'>;
  /**
   * Force one line into a tab (step 9a: the fork hand-over nudge for harnesses
   * with no hook path). Neither the claude-only mode gate nor the once-per-idle
   * -period dedupe applies — the caller, not the inbox, decided this line is
   * owed. The kill switch, the typing guard and the repaint guard still do:
   * writing over someone's half-typed command, into a TUI mid-paint, or after
   * they turned pushing off, is what those protect. A skipped call never
   * schedules a write; the caller owns retries.
   */
  nudge(key: string, text: string): Promise<'sent' | 'skipped'>;
  /** The tab began a turn: clear its once-per-idle-period marker, skip dedupe and any pending retry.
   * The per-message marker (`already-nudged`) deliberately survives: a turn the nudge itself started must not re-arm it. */
  turnStarted(key: string): void;
  /** The tab exited: drop every per-key record (marker, skip dedupe for its agent, pending retry and pending Enter). */
  forget(key: string): void;
  /** Resolves when no consider() is in flight. Pending retries are not awaited (tests fire them through the seam). */
  settle(): Promise<void>;
};

/** The only text that ever crosses a Claude PTY. The messages themselves arrive through the UserPromptSubmit hook. */
export const NUDGE = (count: number): string =>
  `New intercom messages (${count}) from peers in this workspace. Read the strado-intercom block and act on them.`;
/** Codex, OpenCode and Pi have no hook to carry the block, so the nudge asks them to fetch it with the MCP tool (step 5b). */
export const MCP_NUDGE = (count: number): string =>
  `New intercom messages (${count}) from peers in this workspace. Call intercom_inbox and act on them.`;

const defaultSchedule: NonNullable<IntercomPushDeps['schedule']> = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { cancel: () => clearTimeout(t) };
};

export function createIntercomPush(deps: IntercomPushDeps): IntercomPush {
  const schedule = deps.schedule ?? defaultSchedule;
  const log = deps.log ?? (() => {});
  const pushed = new Set<string>();                        // tab keys nudged this idle period
  // Newest queued message id each tab was last nudged about. A nudge starts a
  // turn; the turn ends; a hook-less harness posts turn-complete, which is a
  // 'stop' trigger — so a tab that cannot act on its inbox (no MCP tool, or a
  // model that declines) would be nudged after every turn until the message
  // expired, each nudge starting the next turn. One nudge per inbox head: the
  // marker moves only when a newer message lands, and is dropped with the tab.
  const nudgedHead = new Map<string, string>();
  const skipped = new Set<string>();                       // `${agentId}\0${reason}` already reported this idle period
  const agentOfKey = new Map<string, string>();            // for clearing skip dedupe on turnStarted
  // One pending quiet-gate retry per key, with how many the chain has used. A
  // tab that is busy when a message lands (someone typing, a repaint) is not
  // busy for long; giving up after one look stranded messages for as long as
  // the tab stayed idle — a fresh session never re-triggers on its own.
  const pending = new Map<string, { handle: { cancel(): void }; tries: number }>();
  const enters = new Map<string, { cancel(): void }>();    // one pending "write Enter" timer per key
  const inflight = new Set<Promise<unknown>>();
  let turnEpoch = 0;                                       // bumped by turnStarted; catches a turn starting mid-await

  const emit = (type: 'push.sent' | 'push.skipped', data: Record<string, unknown>): void => {
    try {
      deps.bus.emit(INTERCOM_CHANNEL, { type, data });
    } catch (err) {
      log('intercom push: emit failed', err);
    }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  const cancelPending = (key: string): void => {
    pending.get(key)?.handle.cancel();
    pending.delete(key);
  };

  async function attempt(scopeId: string, agentId: string, trigger: PushReason, tries: number): Promise<'sent' | 'skipped'> {
    const skip = (reason: SkipReason): 'skipped' => {
      const k = `${agentId}\0${reason}`;
      if (!skipped.has(k)) {
        skipped.add(k);
        emit('push.skipped', { scopeId, agentId, trigger, reason });
        log(`intercom push: skipped ${agentId} (${reason}, on ${trigger})`, undefined);
      }
      return 'skipped';
    };
    // Both quiet gates are transient: look again later instead of giving up.
    // The first repaint check after a Stop still uses the short retry (a Stop
    // is often followed by one last repaint and reported nowhere); everything
    // after that is reported once, then retried on the slow cadence until the
    // budget runs out. A fresh consider() while a chain is pending is reported
    // but never starts a second chain for the same tab.
    const defer = (key: string, reason: 'input-busy' | 'output-busy'): 'skipped' => {
      if (tries === 0 && pending.has(key)) return skip(reason);
      if (tries >= PUSH_RETRY_MAX) { pending.delete(key); return skip('retry-exhausted'); }
      const quick = reason === 'output-busy' && tries === 0;
      if (!quick) skip(reason);
      pending.get(key)?.handle.cancel();
      pending.set(key, {
        tries: tries + 1,
        handle: schedule(() => {
          pending.delete(key);
          void track(attempt(scopeId, agentId, trigger, tries + 1));
        }, quick ? PUSH_OUTPUT_RETRY_MS : PUSH_RETRY_MS),
      });
      return 'skipped';
    };
    try {
      if (!deps.enabled()) return skip('disabled');
      const epoch = turnEpoch;
      const summary = (await deps.agents.list(scopeId)).find((a) => a.agentId === agentId);
      if (!summary) return skip('unknown-agent');
      const key = sessionKeyFor(summary.mode, summary.worktreePath, summary.sessionId);
      agentOfKey.set(key, agentId);
      // A shell tab is a person; typing a command into it is run_in_shell's job.
      if (summary.mode === 'shell') return skip('unsupported-mode');
      // Claude: 'idle' is posted by Stop (turn complete; Claude does not fire
      // Stop on a user interrupt), by SessionStart (the prompt is shown), or by
      // an idle_prompt Notification (the tab has sat at its prompt for a while —
      // see the hook script's Notification handling), so a booting Claude never
      // qualifies. The hook-less harnesses post nothing until their first turn
      // ends, so a fresh tab stays 'starting' — reachable here, with the quiet
      // gates below and the retry chain standing in for a "prompt shown" signal.
      const pushable = summary.mode === 'claude'
        ? summary.lifecycle === 'idle'
        : summary.lifecycle === 'idle' || summary.lifecycle === 'starting';
      if (!pushable) return skip('not-idle');
      const terminal = deps.terminal();
      if (terminal.status(key).status !== 'running') return skip('not-running');
      const rows = deps.intercom.peek(scopeId, agentId, HOOK_PULL_LIMIT);
      const queued = rows.length;
      if (queued === 0) return skip('inbox-empty');
      if (pushed.has(key)) return skip('already-pushed');
      // Ids are ULIDs: the lexicographic max is the newest message.
      const head = rows.reduce((max, m) => (m.id > max ? m.id : max), rows[0]!.id);
      if (nudgedHead.get(key) === head) return skip('already-nudged');
      const q = deps.activity.quiet(key);
      if (q.input < PUSH_INPUT_QUIET_MS) return defer(key, 'input-busy');
      if (q.output < PUSH_OUTPUT_QUIET_MS) return defer(key, 'output-busy');
      if (turnEpoch !== epoch) return skip('not-idle');
      cancelPending(key);
      terminal.write(key, summary.mode === 'claude' ? NUDGE(queued) : MCP_NUDGE(queued));
      pushed.add(key);
      nudgedHead.set(key, head);
      emit('push.sent', { scopeId, agentId, trigger, queued });
      // A single burst ending in `\r` can be treated as a paste and left
      // unsubmitted; write Enter as a separate, later write instead.
      enters.set(key, schedule(() => {
        enters.delete(key);
        if (deps.terminal().status(key).status === 'running') deps.terminal().write(key, '\r');
      }, PUSH_ENTER_DELAY_MS));
      return 'sent';
    } catch (err) {
      log(`intercom push: consider failed for ${agentId}`, err);
      return skip('error');
    }
  }

  const consider: IntercomPush['consider'] = (scopeId, agentId, trigger) =>
    track(attempt(scopeId, agentId, trigger, 0));

  /** The forced write. Shares the quiet gates and the deferred
   * Enter with `attempt`, and nothing else — no registry lookup (the caller
   * has the key), no inbox read, no `pushed` marker to consume. */
  async function force(key: string, text: string): Promise<'sent' | 'skipped'> {
    try {
      // The kill switch is not one of the gates a caller may force past: it is
      // the user saying nothing may type into their terminals.
      if (!deps.enabled()) return 'skipped';
      const terminal = deps.terminal();
      if (terminal.status(key).status !== 'running') return 'skipped';
      const q = deps.activity.quiet(key);
      if (q.input < PUSH_INPUT_QUIET_MS) return 'skipped';
      // The fork service owns retries. Returning skipped must not also queue
      // a hidden write, or both retry loops can submit the same prompt.
      if (q.output < PUSH_OUTPUT_QUIET_MS) return 'skipped';
      terminal.write(key, text);
      emit('push.sent', { key, forced: true });
      enters.set(key, schedule(() => {
        enters.delete(key);
        if (deps.terminal().status(key).status === 'running') deps.terminal().write(key, '\r');
      }, PUSH_ENTER_DELAY_MS));
      return 'sent';
    } catch (err) {
      log(`intercom push: nudge failed for ${key}`, err);
      return 'skipped';
    }
  }

  const nudge: IntercomPush['nudge'] = (key, text) => track(force(key, text));

  const turnStarted: IntercomPush['turnStarted'] = (key) => {
    turnEpoch += 1;
    pushed.delete(key);
    cancelPending(key);
    enters.get(key)?.cancel();
    enters.delete(key);
    const agentId = agentOfKey.get(key);
    if (agentId !== undefined) {
      for (const k of [...skipped]) if (k.startsWith(`${agentId}\0`)) skipped.delete(k);
    }
  };

  const forget: IntercomPush['forget'] = (key) => {
    cancelPending(key);
    enters.get(key)?.cancel();
    enters.delete(key);
    pushed.delete(key);
    nudgedHead.delete(key);
    const agentId = agentOfKey.get(key);
    if (agentId !== undefined) {
      for (const k of [...skipped]) if (k.startsWith(`${agentId}\0`)) skipped.delete(k);
    }
    agentOfKey.delete(key);
  };

  const settle: IntercomPush['settle'] = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };

  return { consider, nudge, turnStarted, forget, settle };
}
