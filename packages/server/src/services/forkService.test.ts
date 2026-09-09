import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import { createEventBus, type BusEvent } from '../events/bus.js';
import type { AgentRegistry, AgentSummary } from './agentRegistry.js';
import type { AgentSessionRegistry } from './agentSessionRegistry.js';
import type { SpawnAgentTabResult } from './agentSpawn.js';
import { FORK_NUDGE, FORK_SUMMARY_TIMEOUT_MS, STRADO_SENDER_ID } from './intercomSchema.js';
import { createIntercomStore, INTERCOM_CHANNEL, type IntercomStore, type Message } from './intercomStore.js';
import { createIntercomPush, type IntercomPush } from './intercomPush.js';
import type { RepoSnapshot } from './repoSnapshot.js';
import { FORK_NUDGE_RETRY_MS, FORK_NUDGE_WINDOW_MS, createForkService, type ForkService } from './forkService.js';
import { codexKey } from './terminalManager.js';

const A = 'claude-1@repo';        // the source thread
const B = 'codex-2@repo';         // the peer target, and the agent a new tab registers as
const WT = '/w/repo';
const HUMAN_ACTOR = { agentId: 'human', executionId: 'human' };

let dir: string;
let store: IntercomStore;
/** `store` with a per-test fault seam in front of it: the service only ever
 * sees this one, so a test can make one write fail without a second store. */
let faulty: IntercomStore;
let service: ForkService;
let events: BusEvent[];
let clock: { now: number };
let scheduled: { fn: () => void; ms: number; cancelled: boolean }[];
let nudges: [string, string][];
let spawns: { wsId: string; mode: string; worktreePath: string }[];
let logs: string[];
let state: {
  sourceLive: boolean;
  sourceMode: AgentSummary['mode'];
  peerLive: boolean;
  transcriptPath: string | undefined;
  spawnThrows: string | null;
  /** Held by the fake spawn so a test can act while the spawn is pending. */
  spawnGate: Promise<void> | null;
  nudgeResults: ('sent' | 'skipped')[];
  snapshotError: string | undefined;
  /** How many of the next `store.send` calls throw (BACKPRESSURE, a full queue). */
  sendThrows: number;
  /** How many of the next `store.forkSetSummary` calls throw. */
  setSummaryThrows: number;
};

// A fresh bus per test: the service subscribes to fork.queued for its lifetime,
// and a survivor from an earlier test would try to deliver into a closed store.
let bus: ReturnType<typeof createEventBus>;

const summary =(over: Partial<AgentSummary>): AgentSummary => ({
  agentId: A, alias: null, scopeId: 'ws', mode: 'claude', worktreePath: WT, sessionId: '1',
  lifecycle: 'idle', executionId: 'exA', live: true, ...over,
});

const agentList = (): AgentSummary[] => [
  summary({ agentId: A, mode: state.sourceMode, live: state.sourceLive, executionId: state.sourceLive ? 'exA' : null }),
  summary({ agentId: B, mode: 'codex', sessionId: '2', live: state.peerLive, executionId: state.peerLive ? 'exB' : null }),
];

function build(pushOverride?: IntercomPush): ForkService {
  const agents = { list: async () => agentList() } as unknown as AgentRegistry;
  const sessions = {
    get: async () => (state.transcriptPath === undefined
      ? null
      : { mode: 'claude' as const, worktreePath: WT, sessionId: '1', providerSessionId: 'p1', transcriptPath: state.transcriptPath, updatedAt: 'now' }),
  } as unknown as AgentSessionRegistry;
  const push = pushOverride ?? {
    nudge: async (key: string, text: string) => {
      nudges.push([key, text]);
      return state.nudgeResults.shift() ?? 'sent';
    },
  } as unknown as IntercomPush;
  return createForkService({
    store: faulty,
    agents,
    sessions,
    push: () => push,
    bus,
    spawn: async (input): Promise<SpawnAgentTabResult> => {
      spawns.push({ wsId: input.wsId, mode: input.mode, worktreePath: input.worktreePath });
      if (state.spawnGate) await state.spawnGate;
      if (state.spawnThrows) throw new Error(state.spawnThrows);
      return {
        key: codexKey(input.worktreePath, '2'),
        sessionId: '2',
        execution: { key: codexKey(input.worktreePath, '2'), scopeId: input.wsId, agentId: B, executionId: 'exB', token: 't', spawnedAt: 'now' },
      };
    },
    snapshot: async (worktreePath): Promise<RepoSnapshot> => (state.snapshotError === undefined
      ? { worktreePath, branch: 'main', head: 'abc123', status: [' M src/a.ts'], diffStat: '1 file changed' }
      : { worktreePath, branch: null, head: '', status: [], diffStat: '', error: state.snapshotError }),
    now: () => clock.now,
    schedule: (fn, ms) => { const e = { fn, ms, cancelled: false }; scheduled.push(e); return { cancel: () => { e.cancelled = true; } }; },
    log: (m) => { logs.push(m); },
  });
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fork-service-'));
  clock = { now: 1_700_000_000_000 };
  events = []; scheduled = []; nudges = []; spawns = []; logs = [];
  state = {
    sourceLive: true, sourceMode: 'claude', peerLive: true, transcriptPath: '/tmp/transcript.jsonl',
    spawnThrows: null, spawnGate: null, nudgeResults: [], snapshotError: undefined,
    sendThrows: 0, setSummaryThrows: 0,
  };
  bus = createEventBus();
  store = await createIntercomStore({ file: path.join(dir, 'intercom.sqlite'), bus, now: () => clock.now });
  faulty = {
    ...store,
    send: (input) => {
      if (state.sendThrows > 0) { state.sendThrows -= 1; throw new AppError('BACKPRESSURE', 'too many queued messages'); }
      return store.send(input);
    },
    forkSetSummary: (scopeId, id, source, text) => {
      if (state.setSummaryThrows > 0) { state.setSummaryThrows -= 1; throw new AppError('UNAVAILABLE', 'write failed'); }
      return store.forkSetSummary(scopeId, id, source, text);
    },
  };
  bus.on(INTERCOM_CHANNEL, (e) => events.push(e));
  service = build();
});

afterEach(async () => {
  await service.settle();
  store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

const types = () => events.map((e) => e.type);
const peerFork = () => service.create({
  scopeId: 'ws', from: HUMAN_ACTOR, source: { agentId: A },
  target: { kind: 'peer', agentId: B }, notes: 'take over the retry work', taskId: null,
});
const newTabFork = (mode: 'claude' | 'codex' | 'opencode' | 'pi' = 'codex') => service.create({
  scopeId: 'ws', from: HUMAN_ACTOR, source: { agentId: A },
  target: { kind: 'new', mode, worktreePath: WT }, notes: '', taskId: null,
});
const inbox = (agentId: string): Message[] => store.peek('ws', agentId, 20);
const fromStrado = (agentId: string): Message | undefined => inbox(agentId).find((m) => m.from.agentId === STRADO_SENDER_ID);
const recordDiary = (count: number): void => {
  store.recordTurns('ws', A, 'p1', Array.from({ length: count }, (_, i) => ({
    turnIndex: i,
    prompt: `diary prompt ${i}`,
    promptTruncated: false,
    reply: `diary reply ${i}`,
    replyTruncated: false,
    startedAt: clock.now - 1000 * (count - i),
    endedAt: clock.now - 900 * (count - i),
  })));
};

describe('forkService.create', () => {
  it('rejects an unknown source', async () => {
    await expect(service.create({
      scopeId: 'ws', from: HUMAN_ACTOR, source: { agentId: 'ghost@repo' },
      target: { kind: 'peer', agentId: B }, notes: '', taskId: null,
    })).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('asks a live source for its summary, then delivers the package on its reply', async () => {
    recordDiary(2);
    const fork = await peerFork();
    expect(fork.status).toBe('summarising');
    expect(fork.source).toMatchObject({ agentId: A, worktreePath: WT, mode: 'claude', sessionId: '1' });
    expect(types().filter((t) => t !== 'turn.recorded')).toEqual(['fork.created', 'message.queued', 'fork.summarising']);

    const ask = fromStrado(A)!;
    expect(ask.kind).toBe('request');
    expect(ask.forkId).toBe(fork.id);
    expect(ask.body).toContain('In under 2000 characters');
    expect(ask.body).toContain('replyTo=<this message id>');
    expect(store.getFork('ws', fork.id).summaryDeadline).toBe(clock.now + FORK_SUMMARY_TIMEOUT_MS);
    // The ask itself lapses with the fork's deadline: an answer after it is
    // no longer wanted, and a dead ask must not sit in the source's inbox.
    expect(ask.expiresAt).toBe(clock.now + FORK_SUMMARY_TIMEOUT_MS);
    // The deadline is also armed as a timer, so a quiet source still ships.
    expect(scheduled.some((s) => s.ms === FORK_SUMMARY_TIMEOUT_MS)).toBe(true);

    store.send({
      scopeId: 'ws', fromAgentId: A, fromExecutionId: 'exA', toAgentId: STRADO_SENDER_ID,
      kind: 'reply', replyTo: ask.id, body: 'goal: retries; done: the client; open: the test', context: [],
    });
    await service.settle();

    const delivered = store.getFork('ws', fork.id);
    expect(delivered).toMatchObject({ status: 'delivered', summarySource: 'agent', target: { kind: 'peer', agentId: B } });
    expect(delivered.packageBytes).toBeGreaterThan(0);
    expect(types()).toContain('fork.delivered');

    const pkg = fromStrado(B)!;
    expect(pkg.kind).toBe('request');
    expect(pkg.forkId).toBe(fork.id);
    expect(pkg.body).toContain('FORK HAND-OVER');
    expect(pkg.body).toContain('SUMMARY (agent)');
    expect(pkg.body).toContain('goal: retries; done: the client; open: the test');
    expect(pkg.body).toContain('take over the retry work');
    expect(pkg.body).toContain('branch main');
    expect(pkg.body).toContain('1 file changed');
    expect(delivered.packageBytes).toBe(Buffer.byteLength(pkg.body, 'utf8'));
    expect(pkg.context).toEqual(expect.arrayContaining([
      { kind: 'file', value: '/tmp/transcript.jsonl', label: 'source transcript' },
      { kind: 'reference', value: `intercom_diary agent=${A}`, label: 'turn diary' },
      { kind: 'reference', value: WT, label: 'worktree' },
    ]));

    store.pull('ws', B, 'exB');
    store.ack('ws', B, pkg.id);
    expect(store.getFork('ws', fork.id).status).toBe('accepted');
  });

  it('carries the task reference and the claim instruction when a task is given', async () => {
    state.sourceLive = false;
    const task = store.createTask({ scopeId: 'ws', by: HUMAN_ACTOR, title: 'retry the client' });
    const fork = await service.create({
      scopeId: 'ws', from: HUMAN_ACTOR, source: { agentId: A },
      target: { kind: 'peer', agentId: B }, notes: '', taskId: task.id,
    });
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
    const pkg = fromStrado(B)!;
    expect(pkg.body).toContain(`Claim task ${task.id} with task_claim.`);
    expect(pkg.context).toEqual(expect.arrayContaining([{ kind: 'reference', value: `task ${task.id}`, label: 'task' }]));
  });

  it('falls back to the turn diary at once when the source is not live', async () => {
    state.sourceLive = false;
    recordDiary(3);
    const fork = await peerFork();
    expect(fork.status).toBe('queued');
    expect(fork.summarySource).toBe('diary');
    expect(fromStrado(A)).toBeUndefined();                 // nobody was asked
    await service.settle();

    expect(store.getFork('ws', fork.id).status).toBe('delivered');
    const pkg = fromStrado(B)!;
    expect(pkg.body).toContain('SUMMARY (diary)');
    expect(pkg.body).toContain('diary prompt 2');
  });

  it('never asks a shell tab for a summary', async () => {
    state.sourceMode = 'shell';
    const fork = await peerFork();
    expect(fork.status).toBe('queued');
    expect(fromStrado(A)).toBeUndefined();
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
  });

  it("records summarySource 'none' when the source is gone and its diary is empty", async () => {
    state.sourceLive = false;
    const fork = await peerFork();
    await service.settle();
    expect(store.getFork('ws', fork.id)).toMatchObject({ status: 'delivered', summarySource: 'none' });
    expect(fromStrado(B)!.body).toContain('SUMMARY (none)');
  });

  it('renders an unavailable repository snapshot into the diff stat instead of failing', async () => {
    state.sourceLive = false;
    state.snapshotError = 'not a git repository';
    const fork = await peerFork();
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
    expect(fromStrado(B)!.body).toContain('(unavailable: not a git repository)');
  });

  it('falls back to the diary when the summary ask cannot be queued', async () => {
    recordDiary(2);
    state.sendThrows = 1;                         // only the ask; the package send that follows succeeds
    const fork = await peerFork();
    // Left `queued` with no deadline and no timer, this row would never move
    // again: sweepStale only scans `summarising`.
    expect(fork).toMatchObject({ status: 'queued', summarySource: 'diary', summaryDeadline: null });
    expect(fromStrado(A)).toBeUndefined();
    await service.settle();
    expect(store.getFork('ws', fork.id)).toMatchObject({ status: 'delivered', summarySource: 'diary' });
    expect(logs.some((m) => m.includes('summary ask failed'))).toBe(true);
  });

  it('omits the transcript reference when no transcript is known', async () => {
    state.sourceLive = false;
    state.transcriptPath = undefined;
    const fork = await peerFork();
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
    expect(fromStrado(B)!.context.some((c) => c.label === 'source transcript')).toBe(false);
  });
});

describe('forkService summary timeout', () => {
  it('delivers a diary summary when the deadline timer fires with no reply', async () => {
    recordDiary(2);
    const fork = await peerFork();
    const timer = scheduled.find((s) => s.ms === FORK_SUMMARY_TIMEOUT_MS)!;
    clock.now += FORK_SUMMARY_TIMEOUT_MS;
    timer.fn();
    await service.settle();

    const after = store.getFork('ws', fork.id);
    expect(after).toMatchObject({ status: 'delivered', summarySource: 'diary' });
    expect(fromStrado(B)!.body).toContain('SUMMARY (diary)');
  });

  it('a source reply that lands first wins; the timer is then a no-op', async () => {
    recordDiary(2);
    const fork = await peerFork();
    const ask = fromStrado(A)!;
    store.send({
      scopeId: 'ws', fromAgentId: A, fromExecutionId: 'exA', toAgentId: STRADO_SENDER_ID,
      kind: 'reply', replyTo: ask.id, body: 'the agent answered', context: [],
    });
    await service.settle();
    const timer = scheduled.find((s) => s.ms === FORK_SUMMARY_TIMEOUT_MS)!;
    timer.fn();
    await service.settle();

    expect(store.getFork('ws', fork.id)).toMatchObject({ status: 'delivered', summarySource: 'agent' });
    expect(inbox(B).filter((m) => m.from.agentId === STRADO_SENDER_ID)).toHaveLength(1);
  });

  it('poll advances a summarising fork whose deadline has passed, and delivers it', async () => {
    recordDiary(1);
    const fork = await peerFork();
    expect(service.poll('ws', fork.id).status).toBe('summarising');   // deadline not reached yet
    clock.now += FORK_SUMMARY_TIMEOUT_MS + 1;
    expect(service.poll('ws', fork.id).summarySource).toBe('diary');
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
  });

  it('sweepStale counts the rows it actually advanced, not the rows it looked at', async () => {
    recordDiary(1);
    await peerFork();
    await newTabFork();
    clock.now += FORK_SUMMARY_TIMEOUT_MS + 1;
    state.setSummaryThrows = 1;                   // one of the two fallbacks fails to write
    expect(await service.sweepStale()).toBe(1);
    await service.settle();
    expect(logs.some((m) => m.includes('diary fallback failed'))).toBe(true);
  });

  it('sweepStale advances every overdue summarising fork', async () => {
    recordDiary(1);
    const one = await peerFork();
    const two = await newTabFork();
    clock.now += FORK_SUMMARY_TIMEOUT_MS + 1;
    expect(await service.sweepStale()).toBe(2);
    await service.settle();
    expect(store.getFork('ws', one.id).status).toBe('delivered');
    expect(store.getFork('ws', two.id).status).toBe('delivered');
    expect(await service.sweepStale()).toBe(0);
  });
});

describe('forkService restart recovery', () => {
  it.each(['peer', 'new'] as const)('recovers a persisted queued %s fork exactly once across racing recovery calls', async (kind) => {
    store.close();
    bus = createEventBus();
    store = await createIntercomStore({ file: path.join(dir, 'intercom.sqlite'), bus, now: () => clock.now });
    const fork = store.createFork({ scopeId: 'ws', from: HUMAN_ACTOR,
      source: { agentId: A, mode: 'claude', worktreePath: WT, sessionId: '1' },
      target: kind === 'peer' ? { kind, agentId: B } : { kind, mode: 'codex', worktreePath: WT, agentId: null }, notes: '', taskId: null });
    store.forkSetSummary('ws', fork.id, 'diary', 'Persisted working context');
    store.close();
    bus = createEventBus();
    store = await createIntercomStore({ file: path.join(dir, 'intercom.sqlite'), bus, now: () => clock.now });
    faulty = store;
    service = build();
    service.poll('ws', fork.id);
    await Promise.all([service.sweepStale(), service.sweepStale()]);
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
    expect(inbox(B)).toHaveLength(1);
    expect(inbox(B)[0]!.body).toContain('Persisted working context');
    expect(spawns).toHaveLength(kind === 'new' ? 1 : 0);
    await service.sweepStale();
    await service.settle();
    expect(inbox(B)).toHaveLength(1);
  });
});

describe('forkService delivery failures', () => {
  it('fails with `target gone` when the peer is no longer live', async () => {
    state.sourceLive = false;
    state.peerLive = false;
    const fork = await peerFork();
    await service.settle();
    const failed = store.getFork('ws', fork.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'target gone' });
    expect(fromStrado(B)).toBeUndefined();
    expect(types()).toContain('fork.failed');
  });

  it('delivers a queued fork exactly once even if fork.queued is seen twice', async () => {
    state.sourceLive = false;
    const fork = await peerFork();
    await service.settle();
    bus.emit(INTERCOM_CHANNEL, { type: 'fork.queued', data: { scopeId: 'ws', id: fork.id } });
    await service.settle();
    expect(inbox(B).filter((m) => m.from.agentId === STRADO_SENDER_ID)).toHaveLength(1);
  });

  it('never throws out of a bus handler when the fork cannot be read', async () => {
    expect(() => bus.emit(INTERCOM_CHANNEL, { type: 'fork.queued', data: { scopeId: 'ws', id: '01J8ZK3ABCDEFGHJKMNPQRSTVW' } })).not.toThrow();
    expect(() => bus.emit(INTERCOM_CHANNEL, { type: 'fork.queued', data: { scopeId: 'ws' } })).not.toThrow();
    await service.settle();
    expect(logs.some((m) => m.includes('delivery failed'))).toBe(true);
  });

  it('leaves a cancelled fork alone', async () => {
    const fork = await peerFork();                    // live source: still summarising
    store.cancelFork('ws', fork.id);
    const timer = scheduled.find((s) => s.ms === FORK_SUMMARY_TIMEOUT_MS)!;
    timer.fn();
    await service.settle();
    expect(store.getFork('ws', fork.id).status).toBe('cancelled');
    expect(fromStrado(B)).toBeUndefined();
  });
});

describe('forkService acceptance notice', () => {
  it('tells the asking agent when the target takes the hand-over over', async () => {
    state.sourceLive = false;
    const fork = await service.create({
      scopeId: 'ws', from: { agentId: A, executionId: 'exA' }, source: { agentId: A },
      target: { kind: 'peer', agentId: B }, notes: 'over to you', taskId: null,
    });
    await service.settle();
    const pkg = fromStrado(B)!;
    store.pull('ws', B, 'exB');
    store.ack('ws', B, pkg.id);
    await service.settle();

    const notices = inbox(A).filter((m) => m.from.agentId === STRADO_SENDER_ID && m.kind === 'message');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(`fork ${fork.id} accepted by ${B}`);
    expect(notices[0]!.forkId).toBe(fork.id);
  });

  it('sends nothing when the human asked for the fork — the UI sees the event', async () => {
    state.sourceLive = false;
    const fork = await peerFork();
    await service.settle();
    const pkg = fromStrado(B)!;
    store.pull('ws', B, 'exB');
    store.ack('ws', B, pkg.id);
    await service.settle();

    expect(store.getFork('ws', fork.id).status).toBe('accepted');
    expect(inbox(A).filter((m) => m.from.agentId === STRADO_SENDER_ID)).toEqual([]);
    expect(inbox('human')).toEqual([]);
  });
});

describe('forkService new-tab target', () => {
  it('uses one retry loop with the real pusher while a new tab is painting', async () => {
    state.sourceLive = false;
    store.close();
    bus = createEventBus();
    store = await createIntercomStore({ file: path.join(dir, 'intercom.sqlite'), bus, now: () => clock.now });
    faulty = store;
    let quiet = 0;
    const writes: string[] = [];
    const realPush = createIntercomPush({
      agents: { list: async () => agentList() }, intercom: store, bus,
      terminal: () => ({ status: () => ({ status: 'running', pid: 1, exitCode: null }), write: (_key, text) => { writes.push(text); } }),
      activity: { quiet: () => ({ input: Infinity, output: quiet }) }, enabled: () => true,
      schedule: (fn, ms) => { const e = { fn, ms, cancelled: false }; scheduled.push(e); return { cancel: () => { e.cancelled = true; } }; },
    });
    service = build(realPush);
    const fork = await newTabFork('codex');
    await service.settle();
    const retries = scheduled.filter((s) => s.ms === FORK_NUDGE_RETRY_MS && !s.cancelled);
    expect(retries).toHaveLength(1);
    quiet = 5000;
    retries[0]!.fn();
    await service.settle();
    await realPush.settle();
    expect(writes).toEqual([FORK_NUDGE]);
    expect(store.getFork('ws', fork.id).status).toBe('delivered');
  });
  it('spawns the harness in the source worktree, delivers to it and types the nudge', async () => {
    state.sourceLive = false;
    const fork = await newTabFork('codex');
    await service.settle();

    expect(spawns).toEqual([{ wsId: 'ws', mode: 'codex', worktreePath: WT }]);
    const after = store.getFork('ws', fork.id);
    expect(after).toMatchObject({ status: 'delivered', target: { kind: 'new', mode: 'codex', worktreePath: WT, agentId: B } });
    const pkg = fromStrado(B)!;
    expect(pkg.body).toContain('FORK HAND-OVER');
    expect(nudges).toEqual([[codexKey(WT, '2'), FORK_NUDGE]]);
  });

  it('does not type a nudge into a new claude tab — its hook delivers the inbox', async () => {
    state.sourceLive = false;
    await newTabFork('claude');
    await service.settle();
    expect(spawns).toHaveLength(1);
    expect(nudges).toEqual([]);
  });

  it('retries the nudge on the schedule until the tab accepts it', async () => {
    state.sourceLive = false;
    state.nudgeResults = ['skipped', 'skipped'];
    await newTabFork('codex');
    await service.settle();
    expect(nudges).toHaveLength(1);

    const retry = scheduled.filter((s) => s.ms === FORK_NUDGE_RETRY_MS);
    expect(retry).toHaveLength(1);
    retry[0]!.fn();
    await service.settle();
    expect(nudges).toHaveLength(2);

    scheduled.filter((s) => s.ms === FORK_NUDGE_RETRY_MS)[1]!.fn();
    await service.settle();
    expect(nudges).toHaveLength(3);
    expect(nudges.every(([, text]) => text === FORK_NUDGE)).toBe(true);
  });

  it('gives up on the nudge after the retry window and logs it', async () => {
    state.sourceLive = false;
    const attempts = FORK_NUDGE_WINDOW_MS / FORK_NUDGE_RETRY_MS;
    state.nudgeResults = Array.from({ length: attempts + 5 }, () => 'skipped' as const);
    await newTabFork('codex');
    await service.settle();
    for (let i = 0; i < attempts + 2; i += 1) {
      const pending = scheduled.filter((s) => s.ms === FORK_NUDGE_RETRY_MS && !s.cancelled);
      const next = pending[i];
      if (!next) break;
      next.fn();
      await service.settle();
    }
    expect(nudges.length).toBeLessThanOrEqual(attempts);
    expect(logs.some((m) => m.includes('nudge'))).toBe(true);
    expect(store.getFork('ws', (store.listForks('ws')[0]!).id).status).toBe('delivered');
  });

  it('hands over nothing when the fork is cancelled while the spawn is pending', async () => {
    state.sourceLive = false;
    let release: () => void = () => {};
    state.spawnGate = new Promise<void>((resolve) => { release = resolve; });
    const fork = await newTabFork('codex');
    // Delivery runs off the bus; wait for it to reach the (gated) spawn.
    while (spawns.length === 0) await new Promise((resolve) => setImmediate(resolve));
    store.cancelFork('ws', fork.id);
    release();
    await service.settle();

    expect(store.getFork('ws', fork.id).status).toBe('cancelled');
    expect(fromStrado(B)).toBeUndefined();
    expect(nudges).toEqual([]);
  });

  it('fails the fork when the harness cannot be started', async () => {
    state.sourceLive = false;
    state.spawnThrows = 'no codex on PATH';
    const fork = await newTabFork('codex');
    await service.settle();
    expect(store.getFork('ws', fork.id)).toMatchObject({ status: 'failed', error: 'could not start codex: no codex on PATH' });
    expect(nudges).toEqual([]);
  });
});
