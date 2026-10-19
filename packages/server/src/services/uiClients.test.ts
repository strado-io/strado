import { describe, expect, it } from 'vitest';
import { createUiClients, type UiCommand } from './uiClients';

function harness(opts: { allowRemote?: boolean } = {}) {
  let t = 1000;
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let n = 0;
  const ui = createUiClients({
    now: () => t,
    allowRemote: () => opts.allowRemote ?? false,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    newId: () => `cmd-${++n}`,
  });
  const sent = new Map<string, UiCommand[]>();
  const open = (clientId: string, o: { wsId?: string; remote?: boolean } = {}) => {
    sent.set(clientId, []);
    return ui.connect({ clientId, wsId: o.wsId ?? 'ws', remote: o.remote ?? false, send: (c) => sent.get(clientId)!.push(c) });
  };
  const state = (clientId: string, s: { focused?: boolean; keys?: string[]; wsId?: string } = {}) =>
    ui.report(s.wsId ?? 'ws', clientId, { focused: s.focused ?? false, worktreePath: null, visibleKeys: s.keys ?? [], layout: null });
  const tick = (ms: number) => { t += ms; };
  const fire = () => { for (const x of timers) if (!x.cancelled) { x.cancelled = true; x.fn(); } };
  return { ui, sent, open, state, tick, fire };
}

describe('uiClients', () => {
  it('answers no_window when nothing is connected', async () => {
    const { ui } = harness();
    expect(await ui.dispatch('ws', 'place', {})).toEqual({ applied: false, reason: 'no_window' });
  });

  it('sends to exactly one window and resolves with its ack', async () => {
    const { ui, sent, open, state } = harness();
    open('a'); open('b');
    state('a', { focused: true }); state('b');
    const p = ui.dispatch('ws', 'place', { key: 'k' });
    expect(sent.get('a')).toEqual([{ id: 'cmd-1', op: 'place', args: { key: 'k' } }]);
    expect(sent.get('b')).toEqual([]);
    expect(ui.ack('ws', 'a', 'cmd-1', { applied: true, result: { tabId: '2' } })).toBe(true);
    expect(await p).toEqual({ applied: true, result: { tabId: '2' }, clientId: 'a' });
  });

  it('prefers the window that shows the anchor, even when another is focused', async () => {
    const { ui, sent, open, state } = harness();
    open('a'); open('b');
    state('a', { focused: true });
    state('b', { keys: ['shell:/w:1'] });
    void ui.dispatch('ws', 'place', {}, 'shell:/w:1');
    expect(sent.get('b')).toHaveLength(1);
    expect(sent.get('a')).toHaveLength(0);
  });

  it('falls back to the most recently focused window', async () => {
    const { ui, sent, open, state, tick } = harness();
    open('a'); open('b');
    state('a', { focused: true }); tick(10);
    state('b', { focused: true }); tick(10);
    state('b', { focused: false });
    void ui.dispatch('ws', 'place', {}, 'not-shown');
    expect(sent.get('b')).toHaveLength(1);
  });

  it('with no anchor match, prefers the window showing the target worktree over a more recently focused one', async () => {
    const { ui, sent, open, tick } = harness();
    open('a'); open('b');
    ui.report('ws', 'a', { focused: false, worktreePath: '/x', visibleKeys: [], layout: null });
    tick(5);
    ui.report('ws', 'b', { focused: true, worktreePath: '/y', visibleKeys: [], layout: null });
    void ui.dispatch('ws', 'place', {}, null, '/x');
    expect(sent.get('a')).toHaveLength(1);
    expect(sent.get('b')).toHaveLength(0);
  });

  it('times out without an ack, and ignores the late ack', async () => {
    const { ui, open, state, fire } = harness();
    open('a'); state('a', { focused: true });
    const p = ui.dispatch('ws', 'place', {});
    fire();
    expect(await p).toEqual({ applied: false, reason: 'timeout', clientId: 'a' });
    expect(ui.ack('ws', 'a', 'cmd-1', { applied: true })).toBe(false);
  });

  it('settles pending commands when the window closes', async () => {
    const { ui, open, state } = harness();
    const close = open('a'); state('a', { focused: true });
    const p = ui.dispatch('ws', 'place', {});
    close();
    expect(await p).toEqual({ applied: false, reason: 'window_closed', clientId: 'a' });
    expect(ui.list('ws')).toEqual([]);
  });

  it('refuses an ack from a different window than the target', async () => {
    const { ui, open, state } = harness();
    open('a'); open('b'); state('a', { focused: true });
    void ui.dispatch('ws', 'place', {});
    expect(ui.ack('ws', 'b', 'cmd-1', { applied: true })).toBe(false);
  });

  it('never targets a remote window unless allowed', async () => {
    const off = harness();
    off.open('r', { remote: true }); off.state('r', { focused: true });
    expect(await off.ui.dispatch('ws', 'place', {})).toEqual({ applied: false, reason: 'no_window' });
    const on = harness({ allowRemote: true });
    on.open('r', { remote: true }); on.state('r', { focused: true });
    void on.ui.dispatch('ws', 'place', {});
    expect(on.sent.get('r')).toHaveLength(1);
  });

  it('keeps workspaces apart', async () => {
    const { ui, open, state } = harness();
    open('a', { wsId: 'other' }); state('a', { focused: true, wsId: 'other' });
    expect(await ui.dispatch('ws', 'place', {})).toEqual({ applied: false, reason: 'no_window' });
    expect(state('a')).toBe(false); // unknown in 'ws'
  });

  it('a stale close after a reconnect with the same id keeps the new entry', () => {
    const { ui, open } = harness();
    const closeOld = open('a');
    open('a');
    closeOld();
    expect(ui.list('ws').map((c) => c.clientId)).toEqual(['a']);
  });
});
