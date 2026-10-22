import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INTERCOM_EVENT_TYPES, subscribeIntercom, subscribeUi, subscribeWorktrees, worktreesReducer } from './eventStream';

describe('worktreesReducer', () => {
  it('applies worktree.updated by merging fields by path', () => {
    const state = [{ path: '/a', branch: 'x', process: { status: 'idle' } } as any];
    const next = worktreesReducer(state, {
      type: 'worktree.updated',
      data: { path: '/a', process: { status: 'running' } as any },
    });
    expect(next[0]!.process.status).toBe('running');
  });

  it('drops worktrees marked removed', () => {
    const state = [{ path: '/a' } as any, { path: '/b' } as any];
    const next = worktreesReducer(state, { type: 'worktree.updated', data: { path: '/a', removed: true } });
    expect(next.map((w) => w.path)).toEqual(['/b']);
  });

  it('ignores events with no matching path', () => {
    const state = [{ path: '/a' } as any];
    const next = worktreesReducer(state, { type: 'worktree.updated', data: { path: '/missing' } });
    expect(next).toBe(state);
  });
});

/** Minimal stand-in for the browser's EventSource, recording what subscribeIntercom does to it. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const l of this.listeners[type] ?? []) l({ data: JSON.stringify(data) } as MessageEvent);
  }
  emitRaw(type: string, data: string) {
    for (const l of this.listeners[type] ?? []) l({ data } as MessageEvent);
  }
}

describe('subscribeIntercom', () => {
  let real: typeof globalThis.EventSource;

  beforeEach(() => {
    real = globalThis.EventSource;
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  });
  afterEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = real;
  });

  it('opens /events/intercom with the encoded workspace id and registers exactly the fourteen event types (an agent answering you is message.queued)', () => {
    subscribeIntercom('a b', vi.fn());
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/events/intercom?ws=a%20b');
    expect(INTERCOM_EVENT_TYPES).toEqual([
      'task.created', 'task.claimed', 'task.released', 'task.done', 'task.cancelled', 'task.assigned',
      'escalation.opened', 'escalation.resolved', 'escalation.dismissed', 'escalation.retargeted',
      'peer.registered', 'peer.dropped', 'feed.changed', 'message.queued', 'station.changed',
    ]);
    expect(Object.keys(es.listeners).sort()).toEqual([...INTERCOM_EVENT_TYPES].sort());
    for (const type of INTERCOM_EVENT_TYPES) expect(es.listeners[type]).toHaveLength(1);
  });

  it('forwards a parsed payload with the right type', () => {
    const handler = vi.fn();
    subscribeIntercom('default', handler);
    const es = FakeEventSource.instances[0]!;
    es.emit('task.created', { scopeId: 'default', id: 'T1' });
    expect(handler).toHaveBeenCalledWith({ type: 'task.created', data: { scopeId: 'default', id: 'T1' } });
  });

  it('ignores a malformed payload instead of throwing', () => {
    const handler = vi.fn();
    subscribeIntercom('default', handler);
    const es = FakeEventSource.instances[0]!;
    expect(() => es.emitRaw('escalation.opened', '{not json')).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('closes the EventSource on unsubscribe', () => {
    const unsub = subscribeIntercom('default', vi.fn());
    const es = FakeEventSource.instances[0]!;
    unsub();
    expect(es.closed).toBe(true);
    for (const type of INTERCOM_EVENT_TYPES) expect(es.listeners[type]).toHaveLength(0);
  });
});

describe('subscribeUi', () => {
  let real: typeof globalThis.EventSource;
  beforeEach(() => {
    real = globalThis.EventSource;
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  });
  afterEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = real;
  });

  it('opens /events/ui with workspace and client, forwards ui.command, drops malformed or id-less ones, closes on unsub', () => {
    const onCommand = vi.fn();
    const onReady = vi.fn();
    const unsub = subscribeUi('a b', 'c_1', { onCommand, onReady });
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/events/ui?ws=a%20b&client=c_1');
    es.emit('ui.ready', { clientId: 'c_1' });
    expect(onReady).toHaveBeenCalledTimes(1);
    es.emit('ui.command', { id: 'C1', op: 'place', args: { split: 'right' } });
    es.emit('ui.command', { id: 'C2', op: 'browser.open' });
    es.emitRaw('ui.command', '{nope');
    es.emit('ui.command', { op: 'place' });
    expect(onCommand.mock.calls).toEqual([[{ id: 'C1', op: 'place', args: { split: 'right' } }], [{ id: 'C2', op: 'browser.open', args: {} }]]);
    unsub();
    expect(es.closed).toBe(true);
  });
});

describe('subscribeWorktrees (one shared stream)', () => {
  let real: typeof globalThis.EventSource;
  beforeEach(() => {
    real = globalThis.EventSource;
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  });
  afterEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = real;
  });

  // Browsers allow 6 HTTP/1.1 connections per host; every EventSource holds
  // one for good, so three subscribers must not mean three streams.
  it('every subscriber shares one EventSource, each gets every event, and it closes after the last unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unA = subscribeWorktrees(a);
    const unB = subscribeWorktrees(b);
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/events/worktrees');
    es.emit('worktree.updated', { path: '/a' });
    expect(a).toHaveBeenCalledWith({ type: 'worktree.updated', data: { path: '/a' } });
    expect(b).toHaveBeenCalledTimes(1);
    unA();
    expect(es.closed).toBe(false);
    es.emit('worktree.updated', { path: '/b' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    unB();
    expect(es.closed).toBe(true);
  });

  it('a subscriber after the stream closed opens a fresh one; a double unsubscribe is harmless', () => {
    const un = subscribeWorktrees(vi.fn());
    un();
    un();
    const un2 = subscribeWorktrees(vi.fn());
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    un2();
  });

  it('one subscriber throwing does not starve the others; malformed payloads are dropped', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const u1 = subscribeWorktrees(bad);
    const u2 = subscribeWorktrees(good);
    const es = FakeEventSource.instances[0]!;
    es.emitRaw('worktree.updated', '{nope');
    es.emit('worktree.updated', { path: '/a' });
    expect(good).toHaveBeenCalledTimes(1);
    u1(); u2();
  });
});
