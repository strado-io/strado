import path from 'node:path';
import { AppError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry, AgentSummary } from './agentRegistry.js';
import type { AgentSessionRegistry } from './agentSessionRegistry.js';
import type { AgentMode, SpawnAgentTab } from './agentSpawn.js';
import { renderDiarySummary, renderForkPackage } from './forkPackage.js';
import type { IntercomPush } from './intercomPush.js';
import {
  FORK_DIARY_TURNS, FORK_NUDGE, FORK_SUMMARY_TIMEOUT_MS, FORK_TURNS, HUMAN_AGENT_ID, STRADO_SENDER_ID,
} from './intercomSchema.js';
import { INTERCOM_CHANNEL, type Actor, type Fork, type ForkTarget, type IntercomStore } from './intercomStore.js';
import { repoSnapshot } from './repoSnapshot.js';

// Step 9a: the state machine behind a cross-agent fork. The store owns the
// row and its transitions; this service owns the *decisions* — who to ask for
// a summary, when to give up on the ask, what the package says, and how the
// target learns it has one. Nothing here throws into a bus handler or a timer.

/** How long the nudge keeps trying to reach a freshly spawned non-Claude tab,
 * and how often. A new harness paints its banner and may still be starting, so
 * the first attempt usually loses to the repaint gate. */
export const FORK_NUDGE_RETRY_MS = 1000;
export const FORK_NUDGE_WINDOW_MS = 30_000;
const NUDGE_ATTEMPTS = Math.max(1, Math.round(FORK_NUDGE_WINDOW_MS / FORK_NUDGE_RETRY_MS));

/** Longest first line of the notes that can stand in as a fork's name. */
export const FORK_LABEL_MAX = 120;

export const SUMMARY_PROMPT = (label: string, targetLabel: string): string =>
  `Strado is forking your work on ${label} to ${targetLabel}. In under 2000 characters, summarise: `
  + 'goal, what is done, what is in progress, open questions, files touched. '
  + 'Reply with intercom_send kind=reply replyTo=<this message id>.';

/** What the package, the summary ask and the UI all call this hand-over. The
 * notes are the asker's own words for the work, so their first line names it
 * better than anything derivable; with no notes, the worktree stands in. */
export function forkLabel(fork: Pick<Fork, 'notes' | 'source'>): string {
  const firstLine = fork.notes.split('\n')[0]?.trim() ?? '';
  if (firstLine.length > 0) return firstLine.slice(0, FORK_LABEL_MAX);
  return path.basename(fork.source.worktreePath);
}

/** `alias ?? agentId` once the target has an identity; a description of the tab
 * about to be opened before it does. */
export function forkTargetLabel(target: ForkTarget, peers: AgentSummary[]): string {
  const named = (agentId: string): string => peers.find((p) => p.agentId === agentId)?.alias ?? agentId;
  if (target.kind === 'peer') return named(target.agentId);
  return target.agentId === null
    ? `a new ${target.mode} tab in ${path.basename(target.worktreePath)}`
    : named(target.agentId);
}

/** The context items a package carries. Narrower than `ContextItem` because
 * the renderer only knows how to label a file or a reference. */
type ForkReference = { kind: 'file' | 'reference'; value: string; label?: string };

export type ForkServiceDeps = {
  store: IntercomStore;
  agents: Pick<AgentRegistry, 'list'>;
  sessions: Pick<AgentSessionRegistry, 'get'>;
  push: () => IntercomPush;
  bus: EventBus;
  spawn: SpawnAgentTab;
  snapshot?: typeof repoSnapshot;
  now?: () => number;
  /** Test seam for the summary deadline and the nudge retries. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (message: string, err?: unknown) => void;
};

export type ForkCreateInput = {
  scopeId: string;
  from: Actor;
  source: { agentId: string };
  target: { kind: 'peer'; agentId: string } | { kind: 'new'; mode: AgentMode; worktreePath: string };
  notes: string;
  taskId: string | null;
};

export type ForkService = {
  /** Open a fork: resolve the source, insert the row, and either ask the source
   * to summarise or fall straight back to its turn diary. Delivery happens off
   * the bus, so this returns as soon as the fork is on record. */
  create(input: ForkCreateInput): Promise<Fork>;
  /** Read one fork, advancing it past an elapsed summary deadline first — the
   * timer does not survive a server restart, the deadline does. */
  poll(scopeId: string, id: string): Fork;
  /** Resume queued deliveries and overdue summaries. Returns summaries advanced. */
  sweepStale(): Promise<number>;
  /** Resolves once no delivery or nudge is in flight. Pending retries are not
   * awaited — tests fire those through the schedule seam. */
  settle(): Promise<void>;
};

const defaultSchedule: NonNullable<ForkServiceDeps['schedule']> = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { cancel: () => clearTimeout(t) };
};

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createForkService(deps: ForkServiceDeps): ForkService {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? defaultSchedule;
  const snapshot = deps.snapshot ?? repoSnapshot;
  const log = deps.log ?? (() => {});
  const inflight = new Set<Promise<unknown>>();
  // One delivery per fork at a time. `fork.queued` can be seen twice (the
  // source's reply and a racing diary fallback both emit it), and the status
  // check alone would not stop two concurrent deliveries from both reading
  // `queued` before either wrote `delivered`.
  const delivering = new Set<string>();
  const timers = new Map<string, { cancel(): void }>();
  const STRADO: Actor = { agentId: STRADO_SENDER_ID, executionId: STRADO_SENDER_ID };

  const forkKey = (scopeId: string, id: string): string => `${scopeId}\0${id}`;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  const clearTimer = (scopeId: string, id: string): void => {
    const k = forkKey(scopeId, id);
    timers.get(k)?.cancel();
    timers.delete(k);
  };

  /** Stand the turn diary in for a summary the source never gave. A no-op once
   * a summary exists or the fork has moved past `queued`, so the deadline
   * timer, `poll` and `sweepStale` can all call it without coordinating.
   * Returns whether this call is the one that moved the row, so a sweep can
   * report work done rather than rows looked at. */
  const finishWithDiary = (scopeId: string, id: string): boolean => {
    try {
      const fork = deps.store.getFork(scopeId, id);
      if (fork.status !== 'summarising' && fork.status !== 'queued') return false;
      if (fork.summarySource !== null) return false;
      const turns = deps.store.listTurns(scopeId, fork.source.agentId, { limit: FORK_DIARY_TURNS });
      const text = renderDiarySummary(turns.slice().reverse());
      deps.store.forkSetSummary(scopeId, id, turns.length > 0 ? 'diary' : 'none', text.length > 0 ? text : null);
      return true;
    } catch (err) {
      log(`fork ${id}: diary fallback failed`, err);
      return false;
    } finally {
      clearTimer(scopeId, id);
    }
  };

  const references = async (fork: Fork): Promise<ForkReference[]> => {
    const refs: ForkReference[] = [];
    if (fork.source.mode !== 'shell') {
      try {
        const ref = await deps.sessions.get(fork.source.mode as AgentMode, fork.source.worktreePath, fork.source.sessionId);
        if (ref?.transcriptPath) refs.push({ kind: 'file', value: ref.transcriptPath, label: 'source transcript' });
      } catch (err) {
        log(`fork ${fork.id}: transcript lookup failed`, err);
      }
    }
    refs.push({ kind: 'reference', value: `intercom_diary agent=${fork.source.agentId}`, label: 'turn diary' });
    refs.push({ kind: 'reference', value: fork.source.worktreePath, label: 'worktree' });
    if (fork.taskId !== null) refs.push({ kind: 'reference', value: `task ${fork.taskId}`, label: 'task' });
    return refs;
  };

  /** Type the one line a harness without a hook path needs to find its inbox.
   * Keeps trying while the tab is busy starting up, then gives up quietly —
   * the hand-over is already in the inbox either way. */
  const nudgeUntilSent = (key: string, attempt: number): void => {
    void track((async () => {
      try {
        if (await deps.push().nudge(key, FORK_NUDGE) === 'sent') return;
      } catch (err) {
        log(`fork nudge failed for ${key}`, err);
        return;
      }
      if (attempt + 1 >= NUDGE_ATTEMPTS) {
        log(`fork nudge gave up for ${key} after ${NUDGE_ATTEMPTS} attempts`);
        return;
      }
      schedule(() => nudgeUntilSent(key, attempt + 1), FORK_NUDGE_RETRY_MS);
    })());
  };

  async function deliverInner(scopeId: string, id: string): Promise<void> {
    const fork = deps.store.getFork(scopeId, id);
    if (fork.status !== 'queued') return;
    clearTimer(scopeId, id);

    const peers = await deps.agents.list(scopeId);
    const snap = await snapshot(fork.source.worktreePath);
    const refs = await references(fork);
    const turns = deps.store.listTurns(scopeId, fork.source.agentId, { limit: FORK_TURNS })
      .slice().reverse()
      .map((t) => ({ endedAt: t.endedAt, prompt: t.prompt, reply: t.reply }));
    const render = (targetLabel: string) => renderForkPackage({
      label: forkLabel(fork),
      sourceAgent: fork.source.agentId,
      sourceMode: fork.source.mode,
      targetLabel,
      notes: fork.notes,
      taskId: fork.taskId,
      summary: { source: fork.summarySource ?? 'none', text: fork.summary ?? '' },
      turns,
      repository: {
        worktreePath: snap.worktreePath,
        branch: snap.branch,
        head: snap.head,
        status: snap.status,
        // The snapshot never throws; a failure arrives as `error` and the
        // package says so in place of the diff rather than shipping a lie.
        diffStat: snap.error === undefined ? snap.diffStat : `(unavailable: ${snap.error})`,
      },
      references: refs,
    });
    /** True once the package is in the target's inbox. */
    const handOver = (toAgentId: string, text: string): boolean => {
      // Re-read: a human can cancel the fork while the spawn above is awaited,
      // and a cancelled hand-over must not reach the target's inbox.
      if (deps.store.getFork(scopeId, id).status !== 'queued') return false;
      return deps.store.deliverFork(scopeId, id, toAgentId, text, refs).status === 'delivered';
    };

    const target = fork.target;
    if (target.kind === 'peer') {
      const peer = peers.find((p) => p.agentId === target.agentId);
      if (!peer || !peer.live) {
        deps.store.forkFailed(scopeId, id, 'target gone');
        return;
      }
      const pkg = render(forkTargetLabel(target, peers));
      handOver(peer.agentId, pkg.text);
      return;
    }

    let spawned;
    try {
      spawned = await deps.spawn({ wsId: scopeId, mode: target.mode, worktreePath: target.worktreePath });
    } catch (err) {
      deps.store.forkFailed(scopeId, id, `could not start ${target.mode}: ${reason(err)}`);
      return;
    }
    const agentId = spawned.execution.agentId;
    const pkg = render(agentId);
    // A cancel that landed while the spawn was awaited stops the hand-over but
    // deliberately leaves the tab open. Closing a tab the human may already be
    // looking at (and typing into) is the riskier default, and the spec only
    // promises the tab is "left in place".
    if (!handOver(agentId, pkg.text)) return;
    // Claude reads its inbox at SessionStart through the hook; the others have
    // no such path, so the tab is told out loud, once.
    if (target.mode !== 'claude') nudgeUntilSent(spawned.key, 0);
  }

  const deliver = async (scopeId: string, id: string): Promise<void> => {
    const k = forkKey(scopeId, id);
    if (delivering.has(k)) return;
    delivering.add(k);
    try {
      await deliverInner(scopeId, id);
    } catch (err) {
      log(`fork ${id}: delivery failed`, err);
      // A fork stuck at `queued` would be invisible forever; record why.
      try { deps.store.forkFailed(scopeId, id, reason(err)); } catch { /* already closed */ }
    } finally {
      delivering.delete(k);
    }
  };

  /** Close the loop for an agent that asked for the hand-over: it has no event
   * stream to watch, so acceptance arrives in its inbox as an ordinary
   * `message`. A human asker needs nothing — the UI is already on the bus. */
  const noticeAccepted = (scopeId: string, id: string): void => {
    try {
      const fork = deps.store.getFork(scopeId, id);
      if (fork.status !== 'accepted') return;
      const asker = fork.from.agentId;
      if (asker === HUMAN_AGENT_ID || asker === STRADO_SENDER_ID) return;
      const target = fork.target.agentId;
      if (target === null) return;
      deps.store.send({
        scopeId,
        fromAgentId: STRADO.agentId,
        fromExecutionId: STRADO.executionId,
        toAgentId: asker,
        kind: 'message',
        body: `fork ${id} accepted by ${target}`,
        context: [],
        forkId: id,
      });
    } catch (err) {
      log(`fork ${id}: acceptance notice failed`, err);
    }
  };

  // `fork.queued` is the one delivery trigger — `fork.created` is NOT: the
  // store inserts a fork as `queued` before anyone has been asked to
  // summarise, so reacting to creation would ship a package with no summary in
  // it. `fork.accepted` fires once per fork (every ack path funnels through the
  // store's own guard), so the notice below is sent once.
  deps.bus.on(INTERCOM_CHANNEL, (evt) => {
    if (evt.type !== 'fork.queued' && evt.type !== 'fork.accepted') return;
    const data = evt.data as { scopeId?: unknown; id?: unknown };
    if (typeof data.scopeId !== 'string' || typeof data.id !== 'string') return;
    if (evt.type === 'fork.accepted') noticeAccepted(data.scopeId, data.id);
    else void track(deliver(data.scopeId, data.id));
  });

  const create: ForkService['create'] = async (input) => {
    const peers = await deps.agents.list(input.scopeId);
    const src = peers.find((p) => p.agentId === input.source.agentId);
    if (!src) throw new AppError('NOT_FOUND', `no agent "${input.source.agentId}" in this workspace`);
    const target: ForkTarget = input.target.kind === 'peer'
      ? { kind: 'peer', agentId: input.target.agentId }
      : { kind: 'new', mode: input.target.mode, worktreePath: input.target.worktreePath, agentId: null };
    const fork = deps.store.createFork({
      scopeId: input.scopeId,
      from: input.from,
      source: { agentId: src.agentId, worktreePath: src.worktreePath, mode: src.mode, sessionId: src.sessionId },
      target,
      notes: input.notes,
      taskId: input.taskId,
    });

    // A live harness knows its own thread better than any transcript reader,
    // so it gets first refusal. A shell tab has no agent to ask.
    if (src.live && src.mode !== 'shell') {
      try {
        const ask = deps.store.send({
          scopeId: input.scopeId,
          fromAgentId: STRADO.agentId,
          fromExecutionId: STRADO.executionId,
          toAgentId: src.agentId,
          kind: 'request',
          body: SUMMARY_PROMPT(forkLabel(fork), forkTargetLabel(target, peers)),
          context: [],
          // The ask is worthless once the fork stops waiting for it, so it
          // lapses on the same deadline rather than lingering in the inbox.
          expiresInMs: FORK_SUMMARY_TIMEOUT_MS,
          forkId: fork.id,
        });
        const asked = deps.store.forkSummaryRequested(input.scopeId, fork.id, ask.receipt.id, now() + FORK_SUMMARY_TIMEOUT_MS);
        const k = forkKey(input.scopeId, fork.id);
        timers.set(k, schedule(() => {
          timers.delete(k);
          finishWithDiary(input.scopeId, fork.id);
        }, FORK_SUMMARY_TIMEOUT_MS));
        return asked;
      } catch (err) {
        // Backpressure, or a store that just went away. Falling through is the
        // only safe answer: a fork left `queued` with no deadline has no timer
        // and otherwise has to wait for the next recovery sweep.
        log(`fork ${fork.id}: summary ask failed`, err);
      }
    }

    finishWithDiary(input.scopeId, fork.id);
    return deps.store.getFork(input.scopeId, fork.id);
  };

  const poll: ForkService['poll'] = (scopeId, id) => {
    const fork = deps.store.getFork(scopeId, id);
    if (fork.status === 'queued') {
      if (fork.summarySource === null) finishWithDiary(scopeId, id);
      else void track(deliver(scopeId, id));
      return deps.store.getFork(scopeId, id);
    }
    if (fork.status === 'summarising' && fork.summaryDeadline !== null && fork.summaryDeadline <= now()) {
      finishWithDiary(scopeId, id);
      return deps.store.getFork(scopeId, id);
    }
    return fork;
  };

  const sweepStale: ForkService['sweepStale'] = async () => {
    let advanced = 0;
    for (const fork of deps.store.staleSummarising(now())) {
      if (finishWithDiary(fork.scopeId, fork.id)) advanced += 1;
    }
    for (const fork of deps.store.queuedForks()) {
      if (fork.summarySource === null) finishWithDiary(fork.scopeId, fork.id);
      else await track(deliver(fork.scopeId, fork.id));
    }
    return advanced;
  };

  const settle: ForkService['settle'] = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };

  return { create, poll, sweepStale, settle };
}
