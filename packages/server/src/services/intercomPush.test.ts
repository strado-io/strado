import { beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, type BusEvent } from '../events/bus.js';
import type { AgentSummary } from './agentRegistry.js';
import { FORK_NUDGE, PUSH_ENTER_DELAY_MS, PUSH_INPUT_QUIET_MS, PUSH_OUTPUT_QUIET_MS, PUSH_OUTPUT_RETRY_MS, PUSH_RETRY_MAX, PUSH_RETRY_MS } from './intercomSchema.js';
import { INTERCOM_CHANNEL, type IntercomStore } from './intercomStore.js';
import { MCP_NUDGE, NUDGE, createIntercomPush, type IntercomPush, type SkipReason } from './intercomPush.js';
import { claudeKey, codexKey, piKey } from './terminalManager.js';

type State = {
  enabled: boolean; mode: AgentSummary['mode']; lifecycle: AgentSummary['lifecycle']; running: boolean;
  queued: number; input: number; output: number; peekThrows: boolean; agents: boolean;
  /** Bumped when a newer message lands: ids sort after every earlier generation's. */
  gen: number;
};
let state: State;
let writes: [string, string][];
let events: BusEvent[];
let scheduled: { fn: () => void; ms: number; cancelled: boolean }[];
let push: IntercomPush;
let bus: ReturnType<typeof createEventBus>;
const KEY = claudeKey('/wt', '2');
const AGENT = 'claude-2@repo';

beforeEach(() => {
  state = { enabled: true, mode: 'claude', lifecycle: 'idle', running: true, queued: 2, input: Infinity, output: Infinity, peekThrows: false, agents: true, gen: 0 };
  writes = []; events = []; scheduled = [];
  bus = createEventBus();
  bus.on(INTERCOM_CHANNEL, (e) => events.push(e));
  push = createIntercomPush({
    agents: {
      list: async (scopeId) => (scopeId === 'ws' && state.agents
        ? [{ agentId: AGENT, alias: null, scopeId: 'ws', mode: state.mode, worktreePath: '/wt', sessionId: '2', lifecycle: state.lifecycle, executionId: 'ex', live: true }]
        : []),
    },
    intercom: {
      peek: () => {
        if (state.peekThrows) throw new Error('boom');
        return Array.from({ length: state.queued }, (_, i) => ({ id: `g${state.gen}-m${i}` })) as unknown as ReturnType<IntercomStore['peek']>;
      },
    },
    terminal: () => ({
      write: (key, data) => { writes.push([key, data]); },
      status: () => ({ status: state.running ? 'running' : 'exited', pid: state.running ? 1 : null, exitCode: null }),
    }),
    activity: { quiet: () => ({ input: state.input, output: state.output }) },
    bus,
    enabled: () => state.enabled,
    schedule: (fn, ms) => { const e = { fn, ms, cancelled: false }; scheduled.push(e); return { cancel: () => { e.cancelled = true; } }; },
  });
});

const skips = () => events.filter((e) => e.type === 'push.skipped').map((e) => (e.data as { reason: SkipReason }).reason);
const expectSkip = async (reason: SkipReason) => {
  expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
  expect(writes).toEqual([]);
  expect(skips()).toEqual([reason]);
};

describe('intercomPush gates', () => {
  it('writes the nudge, then Enter as a separate write once the delay elapses', async () => {
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(writes).toEqual([[KEY, NUDGE(2)]]);
    expect(events.map((e) => e.type)).toEqual(['push.sent']);
    expect(events[0]!.data).toEqual({ scopeId: 'ws', agentId: AGENT, trigger: 'stop', queued: 2 });
    const enter = scheduled.find((s) => s.ms === PUSH_ENTER_DELAY_MS)!;
    enter.fn();
    expect(writes).toEqual([[KEY, NUDGE(2)], [KEY, '\r']]);
  });

  it('disabled', async () => { state.enabled = false; await expectSkip('disabled'); });
  it('unknown-agent', async () => { state.agents = false; await expectSkip('unknown-agent'); });
  it('unsupported-mode for a shell tab', async () => { state.mode = 'shell'; await expectSkip('unsupported-mode'); });
  it('not-idle for a booting Claude', async () => { state.lifecycle = 'starting'; await expectSkip('not-idle'); });
  it('not-idle for ready, working, needs_input, offline', async () => {
    for (const lifecycle of ['ready', 'working', 'needs_input', 'offline'] as const) {
      state.lifecycle = lifecycle;
      expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    }
    expect(writes).toEqual([]);
    expect(skips()).toEqual(['not-idle']);                 // deduped within the idle period
  });
  it('not-running', async () => { state.running = false; await expectSkip('not-running'); });
  it('inbox-empty', async () => { state.queued = 0; await expectSkip('inbox-empty'); });
  it('input-busy when a keystroke is more recent than the quiet window', async () => {
    state.input = PUSH_INPUT_QUIET_MS - 1;
    await expectSkip('input-busy');
    state.input = PUSH_INPUT_QUIET_MS;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
  });
  it('error when peek throws', async () => { state.peekThrows = true; await expectSkip('error'); });
});

describe('intercomPush hook-less harnesses (step 5b)', () => {
  const CODEX_KEY = codexKey('/wt', '2');
  it('nudges an idle Codex tab with the MCP wording', async () => {
    state.mode = 'codex';
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
    expect(writes).toEqual([[CODEX_KEY, MCP_NUDGE(2)]]);
    expect(events.filter((e) => e.type === 'push.sent')).toHaveLength(1);
  });
  it('a fresh (starting) Codex, OpenCode or Pi tab is reachable; a booting Claude is not', async () => {
    for (const mode of ['codex', 'opencode', 'pi'] as const) {
      writes = []; state.mode = mode; state.lifecycle = 'starting';
      expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
      expect(writes[0]![1]).toBe(MCP_NUDGE(2));
      push.forget(writes[0]![0]);
    }
    writes = []; state.mode = 'claude'; state.lifecycle = 'starting';
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(writes).toEqual([]);
  });
  it('the quiet gates and the once-per-idle marker apply to Codex as to Claude', async () => {
    state.mode = 'codex'; state.input = 1;
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['input-busy']);
    state.input = Infinity;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
    expect(skips()).toContain('already-pushed');
    push.turnStarted(CODEX_KEY);
    state.gen += 1;                                          // a newer message landed
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
  });
});

describe('intercomPush nudge loop (one nudge per inbox head)', () => {
  const PI_KEY = piKey('/wt', '2');
  it('a hook-less tab that never acts on its inbox is nudged once, not after every turn the nudge started', async () => {
    state.mode = 'pi';
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
    // Pi's hook posts turn-complete after each turn: turnStarted + a 'stop' trigger, inbox unchanged.
    for (let turn = 0; turn < 5; turn += 1) {
      push.turnStarted(PI_KEY);
      expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
    }
    expect(writes).toEqual([[PI_KEY, MCP_NUDGE(2)]]);
    expect(skips()).toEqual(Array(5).fill('already-nudged'));   // reported once per idle period (turn), like every reason
  });

  it('a newer message moves the head and earns exactly one more nudge, counting the whole inbox', async () => {
    state.mode = 'pi';
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
    push.turnStarted(PI_KEY);
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
    state.gen += 1; state.queued = 3;
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
    push.turnStarted(PI_KEY);
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
    expect(writes).toEqual([[PI_KEY, MCP_NUDGE(2)], [PI_KEY, MCP_NUDGE(3)]]);
  });

  it('applies to Claude too, and an emptied inbox reports inbox-empty rather than the stale head', async () => {
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    push.turnStarted(KEY);
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
    expect(skips()).toEqual(['already-nudged']);
    push.turnStarted(KEY);
    state.queued = 0;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
    expect(skips()).toEqual(['already-nudged', 'inbox-empty']);
    state.queued = 2;                                        // the same inbox again (redelivery): still no nudge
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(writes).toHaveLength(1);
  });

  it('forget drops the head marker with the tab, so a re-spawned tab is nudged for the same inbox', async () => {
    state.mode = 'pi';
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
    push.forget(PI_KEY);
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
    expect(writes).toHaveLength(2);
  });
});

describe('intercomPush output retry', () => {
  it('schedules exactly one retry when output is busy, then sends once quiet', async () => {
    state.output = PUSH_OUTPUT_QUIET_MS - 1;
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual([]);                            // no event while a retry is pending
    expect(scheduled.map((s) => s.ms)).toEqual([PUSH_OUTPUT_RETRY_MS]);
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['output-busy']);               // a second call while pending is reported, not rescheduled
    expect(scheduled.filter((s) => s.ms === PUSH_OUTPUT_RETRY_MS)).toHaveLength(1);
    state.output = PUSH_OUTPUT_QUIET_MS;
    scheduled[0]!.fn();
    await push.settle();
    expect(writes).toEqual([[KEY, NUDGE(2)]]);
    expect(events.filter((e) => e.type === 'push.sent')).toHaveLength(1);
    const enter = scheduled.find((s) => s.ms === PUSH_ENTER_DELAY_MS)!;
    enter.fn();
    expect(writes).toEqual([[KEY, NUDGE(2)], [KEY, '\r']]);
  });

  it('reports output-busy when the retry still finds output, then keeps looking on the slow cadence', async () => {
    state.output = 10;
    await push.consider('ws', AGENT, 'stop');
    scheduled[0]!.fn();
    await push.settle();
    expect(writes).toEqual([]);
    expect(skips()).toEqual(['output-busy']);
    expect(scheduled.map((s) => s.ms)).toEqual([PUSH_OUTPUT_RETRY_MS, PUSH_RETRY_MS]);
  });
});

describe('intercomPush retry chain', () => {
  // Fire the most recently scheduled, still-live retry and let the attempt run.
  const fireLast = async () => {
    const live = scheduled.filter((s) => !s.cancelled && s.ms !== PUSH_ENTER_DELAY_MS);
    live[live.length - 1]!.fn();
    await push.settle();
  };

  it('a tab that is repainting when a message lands is nudged once it goes quiet, later', async () => {
    state.output = 10;
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    await fireLast();                                   // 1 s look: still busy → reported once, slow chain begins
    await fireLast();                                   // 5 s later: still busy → silent, chain continues
    expect(skips()).toEqual(['output-busy']);
    expect(scheduled.filter((s) => s.ms === PUSH_RETRY_MS)).toHaveLength(2);
    state.output = Infinity;
    await fireLast();
    expect(writes).toEqual([[KEY, NUDGE(2)]]);
    expect(events.filter((e) => e.type === 'push.sent')).toHaveLength(1);
  });

  it('a keystroke-busy tab is retried too, reported once', async () => {
    state.input = 1;
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['input-busy']);
    expect(scheduled.map((s) => s.ms)).toEqual([PUSH_RETRY_MS]);
    state.input = Infinity;
    await fireLast();
    expect(writes).toEqual([[KEY, NUDGE(2)]]);
  });

  it('gives up after PUSH_RETRY_MAX looks with a single retry-exhausted report; a fresh trigger starts a fresh budget', async () => {
    state.output = 10;
    await push.consider('ws', AGENT, 'arrival');
    for (let i = 0; i < PUSH_RETRY_MAX; i += 1) await fireLast();
    expect(writes).toEqual([]);
    expect(skips()).toEqual(['output-busy', 'retry-exhausted']);
    expect(scheduled.filter((s) => s.ms === PUSH_RETRY_MS || s.ms === PUSH_OUTPUT_RETRY_MS)).toHaveLength(PUSH_RETRY_MAX);
    state.output = Infinity;
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('sent');
  });

  it('a retry that finds the inbox empty ends the chain', async () => {
    state.output = 10;
    await push.consider('ws', AGENT, 'arrival');
    state.queued = 0;
    await fireLast();
    expect(skips()).toEqual(['inbox-empty']);
    expect(scheduled.filter((s) => s.ms === PUSH_RETRY_MS)).toHaveLength(0);
  });

  it('a send from a fresh trigger cancels the pending chain', async () => {
    state.output = 10;
    await push.consider('ws', AGENT, 'arrival');
    await fireLast();                                   // slow chain pending
    const chain = scheduled.find((s) => s.ms === PUSH_RETRY_MS)!;
    state.output = Infinity;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(chain.cancelled).toBe(true);
  });
});

describe('intercomPush idle period', () => {
  it('pushes once per idle period; turnStarted re-arms it and clears skip dedupe', async () => {
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['already-pushed']);
    push.turnStarted(KEY);
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');   // same inbox: one nudge per head
    expect(skips()).toEqual(['already-pushed', 'already-nudged']);
    state.gen += 1;                                                      // a newer message landed
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(writes).toHaveLength(2);
    expect(skips()).toEqual(['already-pushed', 'already-nudged', 'already-pushed']);
  });

  it('turnStarted cancels a pending output retry', async () => {
    state.output = 10;
    await push.consider('ws', AGENT, 'stop');
    push.turnStarted(KEY);
    expect(scheduled[0]!.cancelled).toBe(true);
    state.output = Infinity;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');   // no stale "retry pending" state
  });

  it('turnStarted cancels a pending Enter before it fires', async () => {
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    const enter = scheduled.find((s) => s.ms === PUSH_ENTER_DELAY_MS)!;
    push.turnStarted(KEY);
    expect(enter.cancelled).toBe(true);
    expect(writes).toEqual([[KEY, NUDGE(2)]]);   // the Enter never got the chance to write '\r'
  });

  it('a turn starting during the agent lookup cancels the push', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedPush = createIntercomPush({
      agents: {
        list: async (scopeId) => {
          await gate;
          return scopeId === 'ws' && state.agents
            ? [{ agentId: AGENT, alias: null, scopeId: 'ws', mode: state.mode, worktreePath: '/wt', sessionId: '2', lifecycle: state.lifecycle, executionId: 'ex', live: true }]
            : [];
        },
      },
      intercom: {
        peek: () => Array.from({ length: state.queued }, (_, i) => ({ id: `m${i}` })) as unknown as ReturnType<IntercomStore['peek']>,
      },
      terminal: () => ({
        write: (key, data) => { writes.push([key, data]); },
        status: () => ({ status: state.running ? 'running' : 'exited', pid: state.running ? 1 : null, exitCode: null }),
      }),
      activity: { quiet: () => ({ input: state.input, output: state.output }) },
      bus,
      enabled: () => state.enabled,
      schedule: (fn, ms) => { const e = { fn, ms, cancelled: false }; scheduled.push(e); return { cancel: () => { e.cancelled = true; } }; },
    });

    const pending = gatedPush.consider('ws', AGENT, 'stop');
    gatedPush.turnStarted(KEY);   // fires while the agents.list lookup is still awaited above
    release();
    expect(await pending).toBe('skipped');
    expect(writes).toEqual([]);
    expect(skips()).toEqual(['not-idle']);

    expect(await gatedPush.consider('ws', AGENT, 'stop')).toBe('sent');   // no stale marker left behind
  });
});

describe('intercomPush emit safety', () => {
  it('a throwing bus listener neither rejects consider nor changes its result', async () => {
    bus.on(INTERCOM_CHANNEL, () => { throw new Error('listener boom'); });

    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(writes).toEqual([[KEY, NUDGE(2)]]);

    state.enabled = false;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('skipped');
  });
});

describe('intercomPush forget', () => {
  it('drops the marker so a re-sent tab pushes again', async () => {
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['already-pushed']);

    push.forget(KEY);
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');   // no stale marker
    expect(writes).toEqual([[KEY, NUDGE(2)], [KEY, NUDGE(2)]]);
  });

  it('clears skip dedupe for the tab\'s agent, so a previously deduped reason is reported again', async () => {
    state.lifecycle = 'working';
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['not-idle']);                 // deduped on the second call

    push.forget(KEY);
    expect(await push.consider('ws', AGENT, 'arrival')).toBe('skipped');
    expect(skips()).toEqual(['not-idle', 'not-idle']);      // dedupe cleared by forget: reported again
  });

  it('cancels a pending output retry and a pending Enter', async () => {
    state.output = 10;
    await push.consider('ws', AGENT, 'stop');
    const retry = scheduled.find((s) => s.ms === PUSH_OUTPUT_RETRY_MS)!;
    push.forget(KEY);
    expect(retry.cancelled).toBe(true);

    state.output = Infinity;
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
    const enter = scheduled.find((s) => s.ms === PUSH_ENTER_DELAY_MS && !s.cancelled)!;
    push.forget(KEY);
    expect(enter.cancelled).toBe(true);
  });
});

describe('intercomPush nudge (fork force path)', () => {
  const FORK_KEY = codexKey('/wt', '2');
  const LINE = FORK_NUDGE;

  it('writes into a non-claude tab — the mode gate and the inbox check do not apply', async () => {
    state.mode = 'codex';
    state.queued = 0;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('sent');
    expect(writes).toEqual([[FORK_KEY, LINE]]);
    expect(events.map((e) => e.type)).toEqual(['push.sent']);
    expect(events[0]!.data).toEqual({ key: FORK_KEY, forced: true });
    const enter = scheduled.find((s) => s.ms === PUSH_ENTER_DELAY_MS)!;
    enter.fn();
    expect(writes).toEqual([[FORK_KEY, LINE], [FORK_KEY, '\r']]);
  });

  it('honours the push kill switch — a disabled pusher types nothing', async () => {
    state.enabled = false;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('skipped');
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it('skips while the tab is not running', async () => {
    state.running = false;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('skipped');
    expect(writes).toEqual([]);
  });

  it('skips while the user is typing', async () => {
    state.input = PUSH_INPUT_QUIET_MS - 1;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('skipped');
    expect(writes).toEqual([]);
    state.input = PUSH_INPUT_QUIET_MS;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('sent');
  });

  it('leaves retries to the caller when the tab is still painting', async () => {
    state.output = PUSH_OUTPUT_QUIET_MS - 1;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('skipped');
    expect(scheduled).toEqual([]);
    state.output = PUSH_OUTPUT_QUIET_MS;
    expect(await push.nudge(FORK_KEY, LINE)).toBe('sent');
    expect(writes).toEqual([[FORK_KEY, LINE]]);
  });

  it('has no once-per-idle-period dedupe and leaves the inbox marker alone', async () => {
    expect(await push.nudge(FORK_KEY, LINE)).toBe('sent');
    expect(await push.nudge(FORK_KEY, LINE)).toBe('sent');
    expect(writes).toEqual([[FORK_KEY, LINE], [FORK_KEY, LINE]]);
    // The forced line is not an inbox push: the ordinary gate is untouched.
    expect(await push.consider('ws', AGENT, 'stop')).toBe('sent');
  });

  it('forget cancels a pending nudge Enter', async () => {
    expect(await push.nudge(FORK_KEY, LINE)).toBe('sent');
    const enter = scheduled.find((s) => s.ms === PUSH_ENTER_DELAY_MS)!;
    push.forget(FORK_KEY);
    expect(enter.cancelled).toBe(true);
    expect(writes).toEqual([[FORK_KEY, LINE]]);
  });
});
