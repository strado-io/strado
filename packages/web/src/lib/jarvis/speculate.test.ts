import { describe, expect, it, vi } from 'vitest';
import { createSpeculator, normaliseAsk } from './speculate';
import type { ModelResult } from './modelClient';
import type { ParseContext } from './types';

const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [], focused: null, lastActedOn: null, currentWorktree: '/wt/app', worktrees: [{ path: '/wt/app', name: 'app' }],
  focuses: [], packageScripts: {}, peers: [], ...over,
});
const plan = (n: number): ModelResult => ({ kind: 'plan', steps: [{ action: 'ui.state', args: { n } }], model: 'm', ms: 1 });

/** A fake ask whose calls resolve when the test says so, and honour abort. */
function fakeAsk() {
  const calls: { text: string; signal: AbortSignal; resolve: (r: ModelResult) => void }[] = [];
  const ask = vi.fn((text: string, _thread: unknown, _ctx: ParseContext, signal: AbortSignal) => new Promise<ModelResult>((resolve) => {
    calls.push({ text, signal, resolve });
    signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
  }));
  return { ask, calls };
}

describe('normaliseAsk', () => {
  it('lowercases, trims, collapses spaces, drops trailing punctuation', () => {
    expect(normaliseAsk('  Open   a Shell below?! ')).toBe('open a shell below');
    expect(normaliseAsk('open a shell below.')).toBe(normaliseAsk('open a shell below'));
    expect(normaliseAsk('git add .')).toBe('git add');
  });
});

describe('createSpeculator', () => {
  it('take() with the same words reuses the in-flight ask (no second request)', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('open a shell below', ctx(), []);
    expect(ask).toHaveBeenCalledTimes(1);
    const taken = s.take('Open a shell below.', ctx(), []);
    calls[0]!.resolve(plan(1));
    await expect(taken).resolves.toEqual(plan(1));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('take() reuses a finished result too', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('go to api', ctx(), []);
    calls[0]!.resolve(plan(2));
    await Promise.resolve();
    await expect(s.take('go to api', ctx(), [])).resolves.toEqual(plan(2));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('different words: the speculation is aborted and a fresh ask goes out with the final text', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('open a shell', ctx(), []);
    const taken = s.take('open a shell below claude', ctx(), []);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.text).toBe('open a shell below claude');
    calls[1]!.resolve(plan(3));
    await expect(taken).resolves.toEqual(plan(3));
  });

  it('a changed context (what the model would see) or thread is a miss', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('close it', ctx(), []);
    void s.take('close it', ctx({ currentWorktree: '/wt/api', worktrees: [{ path: '/wt/api', name: 'api' }] }), []);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    s.speculate('again', ctx(), []);
    void s.take('again', ctx(), [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }]);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it('only one speculation at a time: a new one aborts the old', () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('open', ctx(), []);
    s.speculate('open a shell', ctx(), []);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
    s.speculate('open a shell!', ctx(), []);
    expect(ask).toHaveBeenCalledTimes(2); // same words: keep the one in flight
  });

  it('a speculation is used once; take() after that asks fresh', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('hi', ctx(), []);
    calls[0]!.resolve(plan(1));
    await s.take('hi', ctx(), []);
    void s.take('hi', ctx(), []);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('the caller aborting take() aborts the reused request', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('hi', ctx(), []);
    const ac = new AbortController();
    const taken = s.take('hi', ctx(), [], ac.signal);
    ac.abort();
    await expect(taken).resolves.toEqual({ kind: 'aborted' });
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('a speculation that was aborted is not reused', async () => {
    const { ask, calls } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('hi', ctx(), []);
    s.cancel();
    expect(calls[0]!.signal.aborted).toBe(true);
    void s.take('hi', ctx(), []);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('never runs anything itself: it only holds the model result', () => {
    const { ask } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('close shell-1', ctx(), []);
    expect(Object.keys(s).sort()).toEqual(['cancel', 'speculate', 'take']);
  });

  it('$ lines and secrets are never speculated', () => {
    const { ask } = fakeAsk();
    const s = createSpeculator(ask);
    s.speculate('$ rm -rf /', ctx(), []);
    s.speculate('my token=abc123', ctx(), []);
    expect(ask).not.toHaveBeenCalled();
  });
});
