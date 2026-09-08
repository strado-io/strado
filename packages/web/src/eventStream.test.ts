import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { INTERCOM_EVENT_TYPES, subscribeIntercom, worktreesReducer } from './eventStream';

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

  it('opens /events/intercom with the encoded workspace id and registers exactly the nineteen event types', () => {
    subscribeIntercom('a b', vi.fn());
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/events/intercom?ws=a%20b');
    expect(INTERCOM_EVENT_TYPES).toEqual([
      'task.created', 'task.claimed', 'task.released', 'task.done', 'task.cancelled', 'task.assigned',
      'escalation.opened', 'escalation.resolved', 'escalation.dismissed', 'escalation.retargeted',
      'fork.created', 'fork.summarising', 'fork.queued', 'fork.delivered', 'fork.accepted', 'fork.failed', 'fork.cancelled',
      'peer.registered', 'peer.dropped',
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
