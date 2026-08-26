import { describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus';
import { createAgentStatusStore, createClaudeStatusStore } from '../../src/services/claudeStatusStore';

describe('claudeStatusStore', () => {
  it('stores status and emits a worktree.updated event with the per-session map', () => {
    const bus = createEventBus();
    const events: any[] = [];
    bus.on('worktrees', (e) => events.push(e));
    const store = createClaudeStatusStore(bus);

    store.set('/wt/a', 'working');
    expect(store.get('/wt/a')).toBe('working');
    expect(events).toContainEqual({
      type: 'worktree.updated',
      data: { path: '/wt/a', claudeStatus: 'working', claudeStatusById: { '1': 'working' } },
    });
  });

  it('clear() with no session resets every session to idle and emits', () => {
    const bus = createEventBus();
    const events: any[] = [];
    bus.on('worktrees', (e) => events.push(e));
    const store = createClaudeStatusStore(bus);

    store.set('/wt/a', 'working');
    store.set('/wt/a', 'waiting', '2');
    store.clear('/wt/a');
    expect(store.get('/wt/a')).toBe('idle');
    expect(events.at(-1)).toEqual({
      type: 'worktree.updated',
      data: { path: '/wt/a', claudeStatus: 'idle', claudeStatusById: { '1': 'idle', '2': 'idle' } },
    });
  });

  it('aggregates across sessions: any working wins, then any waiting', () => {
    const bus = createEventBus();
    const store = createClaudeStatusStore(bus);

    store.set('/wt/a', 'waiting', '1');
    store.set('/wt/a', 'working', '2');
    expect(store.get('/wt/a')).toBe('working');

    store.set('/wt/a', 'idle', '2');
    expect(store.get('/wt/a')).toBe('waiting');

    store.set('/wt/a', 'idle', '1');
    expect(store.get('/wt/a')).toBe('idle');
  });

  it('clear(path, sessionId) resets only that session', () => {
    const bus = createEventBus();
    const events: any[] = [];
    bus.on('worktrees', (e) => events.push(e));
    const store = createClaudeStatusStore(bus);

    store.set('/wt/a', 'working', '1');
    store.set('/wt/a', 'working', '2');
    store.clear('/wt/a', '2');
    expect(store.get('/wt/a')).toBe('working'); // session 1 still working
    expect(events.at(-1).data.claudeStatusById).toEqual({ '1': 'working', '2': 'idle' });
  });

  it('tracks whether a namespaced Shell agent is currently open', () => {
    const store = createClaudeStatusStore(createEventBus());
    expect(store.active('/wt/a', 'shell:2')).toBe(false);
    store.set('/wt/a', 'waiting', 'shell:2');
    expect(store.active('/wt/a', 'shell:2')).toBe(true);
    // idle between turns is still open — only the launcher's exit report ends it
    store.set('/wt/a', 'idle', 'shell:2');
    expect(store.active('/wt/a', 'shell:2')).toBe(true);
    store.remove('/wt/a', 'shell:2');
    expect(store.active('/wt/a', 'shell:2')).toBe(false);
  });

  it('remove drops the session from the listing and announces it', () => {
    const bus = createEventBus();
    const store = createClaudeStatusStore(bus);
    const events: any[] = [];
    bus.on('worktrees', (e) => events.push(e));
    store.set('/wt/a', 'working', '1');
    store.set('/wt/a', 'idle', 'shell:2');
    store.remove('/wt/a', 'shell:2');
    expect(store.sessions('/wt/a')).toEqual({ '1': 'working' });
    expect(events.at(-1).data.claudeStatusById).toEqual({ '1': 'working' });
    const seen = events.length;
    store.remove('/wt/a', 'shell:2'); // already gone — nothing to announce
    expect(events).toHaveLength(seen);
  });
});

describe('claudeStatusStore.sessions', () => {
  it('returns the per-session map for the worktrees listing', () => {
    const bus = createEventBus();
    const store = createClaudeStatusStore(bus);
    store.set('/wt/a', 'working', '1');
    store.set('/wt/a', 'waiting', '2');
    expect(store.sessions('/wt/a')).toEqual({ '1': 'working', '2': 'waiting' });
    expect(store.sessions('/wt/none')).toEqual({});
  });
});

describe('createAgentStatusStore', () => {
  it('emits worktree.updated carrying the named field and its per-session map', () => {
    const bus = createEventBus();
    const events: any[] = [];
    bus.on('worktrees', (e) => events.push(e));
    const store = createAgentStatusStore(bus, 'opencodeStatus');

    store.set('/w', 'working');
    expect(events).toContainEqual({
      type: 'worktree.updated',
      data: { path: '/w', opencodeStatus: 'working', opencodeStatusById: { '1': 'working' } },
    });
    expect(store.get('/w')).toBe('working');
  });
});
