import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TerminalView reads intercom state for the focused tab's escalation banner;
// these tests mount it without the provider, so stub a quiet, "loaded" context.
vi.mock('../contexts/IntercomContext', () => ({
  useIntercom: () => ({
    peers: [], loaded: true, error: null,
    refresh: vi.fn(),
  }),
}));

// window.strado must exist BEFORE TerminalView is imported: isElectron is a
// module-level const, and desktop-only tabs surface only with it.
vi.hoisted(() => {
  (globalThis as unknown as { window: { strado?: unknown } }).window.strado = {};
});

// Capture the hub's app-control bridge instead of mounting the provider.
type JHub = {
  path: string; snapshot(): unknown; restore(s: unknown): void;
  place(tab: unknown, place: unknown, deadline: number): Promise<unknown>; focus(tab: unknown): boolean;
  openBrowser(url: string, place: unknown, deadline: number): Promise<unknown>; closeLocal(tab: unknown): void;
  context(): { tabs: { label: string; mode: string; sessionId: string; busy: boolean; humanActive?: boolean; instance?: string }[]; focused: unknown };
};
const bridgeBox = vi.hoisted(() => ({ current: null as null | { path: string; visible(): unknown[]; layout(): unknown; apply(cmd: unknown, deadline: number): Promise<unknown>; jarvis?: JHub } }));
vi.mock('../contexts/UiControlContext', () => ({
  useUiHubBridge: (b: typeof bridgeBox.current) => { bridgeBox.current = b; return () => undefined; },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    parser = { registerCsiHandler: vi.fn() };
    registerLinkProvider = vi.fn();
    write = vi.fn();
    onData() {
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class { dispose = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'default' } }),
}));

const wtStream = vi.hoisted(() => ({ handlers: new Set<(e: { type: 'worktree.updated'; data: Record<string, unknown> }) => void>() }));
vi.mock('../eventStream', () => ({
  subscribeWorktrees: (h: (e: { type: 'worktree.updated'; data: Record<string, unknown> }) => void) => { wtStream.handlers.add(h); return () => { wtStream.handlers.delete(h); }; },
  subscribeLogs: () => () => {},
}));

vi.mock('../api', () => ({
  ApiClientError: class extends Error {},
  api: {
    envCheck: vi.fn().mockResolvedValue([]),
    kb: {
      files: vi.fn().mockResolvedValue({ files: [], truncated: false }),
      file: vi.fn().mockResolvedValue({ content: '', size: 0, mtimeMs: 0 }),
    },
    worktrees: {
      killSession: vi.fn().mockResolvedValue(undefined),
      sessionBusy: vi.fn().mockResolvedValue({ busy: false }),
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue(undefined),
      setEnvProfile: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      logs: vi.fn().mockResolvedValue({ lines: [] }),
      upload: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      mergeRequests: vi.fn().mockResolvedValue({ kind: 'absent' }),
      git: {
        changes: vi.fn().mockResolvedValue({ files: [] }),
        branches: vi.fn().mockResolvedValue({ branches: [] }),
        branchChanges: vi.fn().mockResolvedValue({ base: '', baseBranch: 'main', files: [] }),
        diff: vi.fn().mockResolvedValue({ diff: '' }),
        remotes: vi.fn().mockResolvedValue({ remotes: [] }),
      },
    },
    repos: { list: vi.fn().mockResolvedValue([]) },
    runners: {
      list: vi.fn().mockResolvedValue({ runners: [] }),
      socketTicket: vi.fn().mockResolvedValue({ ticket: 't'.repeat(48), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), wsBase: '', httpBase: '' }),
      rpc: vi.fn(),
      forwards: {
        open: vi.fn(),
        list: vi.fn().mockResolvedValue({ forwards: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      },
    },
    usage: { accounts: vi.fn().mockResolvedValue([]) },
  },
}));

class FakeWS {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close = vi.fn();
}

import { TerminalView } from './TerminalView';
import type { Worktree } from '../types';
import { readClosedAgents, rememberClosedAgent } from '../hooks/agentTabs';
import { readBrowserUrls } from '../hooks/browserTabs';
// Tab lookups: the strip only (a pane card's header repeats the tab's title).
const strip = () => within(screen.getByTestId('tab-segments'));

const P = '/Users/me/repo.worktrees/FD-1';
const worktree = {
  path: P,
  repoId: 'r', branch: 'FD-1', head: 'abc', prunable: false, tracked: true,
  hasShellSession: true,
  shellSessions: ['1', '2'],
  meta: { ticketId: 'FD-1', title: 'T', repoId: 'r', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
} as unknown as Worktree;

// Ticks act() in short slices so the hub can re-render (adopting the tab)
// while the command polls for it; one long act() would hold every update.
const apply = async (cmd: Record<string, unknown>, deadline = Date.now() + 2_500) => {
  let settled = false;
  const pending = bridgeBox.current!.apply(cmd, deadline).finally(() => { settled = true; });
  for (let i = 0; i < 100 && !settled; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return pending;
};
const layouts = () => JSON.parse(localStorage.getItem('strado.paneLayout') ?? '{}')[P];
const leaf = (key: string) => ({ kind: 'leaf', key });
const ref = (mode: string, sessionId: string, worktreePath = P) => ({ worktreePath, mode, sessionId });

beforeEach(() => {
  localStorage.clear();
  bridgeBox.current = null;
  wtStream.handlers.clear();
  (globalThis as any).WebSocket = FakeWS;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (Element.prototype as any).scrollTo = vi.fn();
});
afterEach(() => { vi.clearAllMocks(); });

describe('TerminalView app-control bridge', () => {
  it('registers for its worktree and reports the visible PTY panes as tab refs', () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    expect(bridgeBox.current!.path).toBe(P);
    expect(bridgeBox.current!.visible()).toEqual([ref('shell', '1')]);
  });

  it('place right of the anchor splits the anchor pane and leaves focus alone', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'place', worktreePath: P, tab: ref('shell', '2'), split: 'right', anchor: ref('shell', '1'), focus: false });
    expect(ack).toEqual({ applied: true });
    expect(layouts()).toEqual([{ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('shell:1'), b: leaf('shell:2') }]);
    expect(screen.getByTestId('pane-split')).toHaveAttribute('data-split-dir', 'row');
    expect(bridgeBox.current!.visible()).toEqual([ref('shell', '1'), ref('shell', '2')]);
  });

  it('adopts a session the strip does not show yet, below the focused pane when the anchor is elsewhere', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'place', worktreePath: P, tab: ref('shell', '5'), split: 'down', anchor: ref('shell', '1', '/elsewhere'), focus: false });
    expect(ack).toEqual({ applied: true, reason: 'anchor_not_visible' });
    expect(layouts()).toEqual([{ kind: 'split', dir: 'col', ratio: 0.5, a: leaf('shell:1'), b: leaf('shell:5') }]);
  });

  it('a null anchor (spawned into another worktree than the caller) goes beside the active pane', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'place', worktreePath: P, tab: ref('shell', '2'), split: 'right', anchor: null, focus: false });
    expect(ack).toEqual({ applied: true });
    expect(layouts()).toEqual([{ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('shell:1'), b: leaf('shell:2') }]);
  });

  it('a command whose deadline already passed does not wait for the session', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'place', worktreePath: P, tab: ref('shell', '7'), split: 'right', anchor: null, focus: false }, Date.now() - 1);
    expect(ack).toEqual({ applied: false, reason: 'tab_not_found' });
  });

  it('browser.open without placement adds the tab but leaves focus where it was', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'browser.open', worktreePath: P, url: 'https://example.com/', place: null });
    expect(ack).toEqual({ applied: true, result: { tabId: '1' } });
    expect(bridgeBox.current!.visible()).toEqual([ref('shell', '1')]);
    expect(layouts()).toBeUndefined();
  });

  it('an adopted id survives a stale snapshot without it, then appears exactly once when the server confirms it', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'place', worktreePath: P, tab: ref('shell', '3'), split: 'right', anchor: ref('shell', '1'), focus: false });
    expect(ack).toEqual({ applied: true });
    // Plain shell tabs plus the members of a group tab (one deck layer each).
    const shells = () => document.querySelectorAll('[data-tab-key^="shell:"]').length
      + (screen.queryByTestId('tab-group')?.querySelectorAll('[data-testid="tile-layer"]').length ?? 0);
    const emit = (shellSessions: string[]) => act(() => { for (const h of wtStream.handlers) h({ type: 'worktree.updated', data: { path: P, shellSessions } }); });
    expect(shells()).toBe(3);
    emit(['1', '2']); // stale: taken before the spawn landed
    expect(shells()).toBe(3);
    expect(layouts()).toEqual([{ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('shell:1'), b: leaf('shell:3') }]);
    emit(['1', '2', '3']);
    expect(shells()).toBe(3);
    expect(bridgeBox.current!.visible()).toEqual([ref('shell', '1'), ref('shell', '3')]);
  });

  it('human always wins: a pane the user touched in the last 5 s is off limits to agents', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
      render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
      const pane = document.querySelector('[data-pane-key="shell:1"]')!;
      fireEvent.pointerDown(pane);
      const ack = await apply({ op: 'place', worktreePath: P, tab: ref('shell', '2'), split: 'right', anchor: ref('shell', '1'), focus: false }, Date.now() + 2_500);
      expect(ack).toEqual({ applied: false, reason: 'human_active' });
      expect(layouts()).toBeUndefined();
      // Typing does NOT count: the user typing into an agent's terminal is
      // usually what asked that agent to open a tab beside itself.
      vi.setSystemTime(new Date('2026-10-17T10:00:10Z'));
      fireEvent.keyDown(document.querySelector('[data-pane-key="shell:1"]')!, { key: 'a' });
      fireEvent.keyDown(window, { key: 'a' });
      expect(await apply({ op: 'place', worktreePath: P, tab: ref('shell', '2'), split: 'down', anchor: null, focus: false }, Date.now() + 2_500))
        .toEqual({ applied: true });
      // A click on the strip's tab counts like a click in its pane; shell:1 is
      // in a group tab now, and a click on the group touches all its members.
      vi.setSystemTime(new Date('2026-10-17T10:00:12Z'));
      fireEvent.pointerDown(screen.getByTestId('tab-group'));
      expect(await apply({ op: 'place', worktreePath: P, tab: ref('shell', '2'), split: 'right', anchor: ref('shell', '1'), focus: false }, Date.now() + 2_500))
        .toEqual({ applied: false, reason: 'human_active' });
      // After 5 s of quiet the agent may act.
      vi.setSystemTime(new Date('2026-10-17T10:00:18Z'));
      expect(await apply({ op: 'place', worktreePath: P, tab: ref('shell', '2'), split: 'right', anchor: ref('shell', '1'), focus: false }, Date.now() + 2_500))
        .toEqual({ applied: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('split tab with focus brings back a user-closed agent as a focused full tab', async () => {
    rememberClosedAgent('claude', P, true);
    render(<TerminalView worktree={{ ...worktree, hasClaudeSession: true, claudeSessions: ['1'] } as Worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'place', worktreePath: P, tab: ref('claude', '1'), split: 'tab', anchor: ref('shell', '1'), focus: true });
    expect(ack).toEqual({ applied: true });
    expect(readClosedAgents().claude.has(P)).toBe(false);
    expect(layouts()).toBeUndefined();
    expect(bridgeBox.current!.visible()).toEqual([ref('claude', '1')]);
  });

  it('browser.open adds a Browser tab at the url, beside the anchor, and returns its tab id', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ack = await apply({ op: 'browser.open', worktreePath: P, url: 'https://example.com/', place: { split: 'right', anchor: ref('shell', '1'), focus: false } });
    expect(ack).toEqual({ applied: true, result: { tabId: '1' } });
    expect(readBrowserUrls()[P]).toBe('https://example.com/');
    expect(layouts()).toEqual([{ kind: 'split', dir: 'row', ratio: 0.5, a: leaf('shell:1'), b: leaf('browser:1') }]);
  });
});

describe('TerminalView Jarvis hub port', () => {
  // Ticks act() while a hub promise waits for the strip (see apply above).
  const settle = async <T,>(p: Promise<T>): Promise<T> => {
    let done = false;
    const q = p.finally(() => { done = true; });
    for (let i = 0; i < 100 && !done; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return q;
  };
  const hub = () => bridgeBox.current!.jarvis!;

  it('exposes the strip as parse context', () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const ctx = hub().context();
    expect(ctx.tabs.map((t) => [t.mode, t.sessionId, t.label])).toEqual([['shell', '1', 'Shell'], ['shell', '2', 'Shell 2']]);
    expect(ctx.focused).toEqual(ref('shell', '1'));
  });

  it('an agent counts as busy while working AND while it waits on you (a permission prompt or a question): closing it loses that', () => {
    const w = { ...worktree, hasClaudeSession: true, claudeSessions: ['1', '2', '3'], claudeStatusById: { '1': 'working', '2': 'waiting', '3': 'idle' } };
    render(<TerminalView worktree={w as typeof worktree} mode="claude" sessionId="1" onClose={() => {}} />);
    const busy = (id: string) => hub().context().tabs.find((t) => t.mode === 'claude' && t.sessionId === id)?.busy;
    expect([busy('1'), busy('2'), busy('3')]).toEqual([true, true, false]);
  });

  it('gives each tab a hub instance that stays put across reads and changes when its slot is closed and reopened', () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const instanceOf = (id: string) => hub().context().tabs.find((t) => t.sessionId === id)?.instance;
    const first = instanceOf('2');
    expect(first).toBeTruthy();
    expect(instanceOf('2')).toBe(first);
    const emit = (shellSessions: string[]) => act(() => { for (const h of wtStream.handlers) h({ type: 'worktree.updated', data: { path: P, shellSessions } }); });
    emit(['1']);
    emit(['1', '2']);
    expect(instanceOf('2')).toBeTruthy();
    expect(instanceOf('2')).not.toBe(first);
    expect(instanceOf('1')).toBe(instanceOf('1'));
  });

  it('clicking or typing in the command bar (outside every pane) marks no tab and leaves the focused tab alone', () => {
    render(<><TerminalView worktree={worktree} mode="shell" onClose={() => {}} /><div data-testid="command-bar"><input aria-label="bar" /></div></>);
    const bar = screen.getByLabelText('bar');
    const before = hub().context().focused;
    fireEvent.pointerDown(bar);
    act(() => { bar.focus(); });
    fireEvent.keyDown(bar, { key: 'a' });
    expect(hub().context().tabs.some((t) => t.humanActive)).toBe(false);
    expect(hub().context().focused).toEqual(before);
  });

  it('marks the tabs the user touched in the last 5 s as humanActive, so the box confirms before acting on them', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
      render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
      expect(hub().context().tabs.some((t) => t.humanActive)).toBe(false);
      fireEvent.pointerDown(document.querySelector('[data-pane-key="shell:1"]')!);
      expect(hub().context().tabs.map((t) => [t.sessionId, !!t.humanActive])).toEqual([['1', true], ['2', false]]);
      vi.setSystemTime(new Date('2026-10-17T10:00:06Z'));
      expect(hub().context().tabs.some((t) => t.humanActive)).toBe(false);
      // Typing keeps it in use for the box (not for the agent guard, above).
      fireEvent.keyDown(document.querySelector('[data-pane-key="shell:1"]')!, { key: 'a' });
      vi.setSystemTime(new Date('2026-10-17T10:00:10Z'));
      fireEvent.keyDown(document.querySelector('[data-pane-key="shell:1"]')!, { key: 'b' });
      vi.setSystemTime(new Date('2026-10-17T10:00:13Z'));
      expect(hub().context().tabs.map((t) => [t.sessionId, !!t.humanActive])).toEqual([['1', true], ['2', false]]);
      fireEvent.keyDown(window, { key: 'c' }); // outside any pane: no tab
      vi.setSystemTime(new Date('2026-10-17T10:00:19Z'));
      expect(hub().context().tabs.some((t) => t.humanActive)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restore puts panes and focus back but leaves Browser tabs alone (the plan closes the ones it opened)', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const snap = hub().snapshot();
    await settle(hub().openBrowser('https://example.com/', null, Date.now() + 2_000));
    act(() => { hub().restore(snap); });
    expect(hub().context().focused).toEqual(ref('shell', '1'));
    expect(hub().context().tabs.some((t) => t.mode === 'browser')).toBe(true);
  });

  it('place ignores human_active (it IS the human), and focus switches tabs', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    fireEvent.pointerDown(document.querySelector('[data-pane-key="shell:1"]')!);
    expect(await settle(hub().place(ref('shell', '2'), { split: 'down', anchor: ref('shell', '1'), focus: false }, Date.now() + 2_000))).toEqual({ ok: true });
    expect(layouts()).toEqual([{ kind: 'split', dir: 'col', ratio: 0.5, a: leaf('shell:1'), b: leaf('shell:2') }]);
    act(() => { expect(hub().focus(ref('shell', '2'))).toBe(true); });
    expect(hub().context().focused).toEqual(ref('shell', '2'));
    expect(hub().focus(ref('shell', '9'))).toBe(false);
  });

  it('openBrowser shows the new tab by default; closeLocal removes it and forgets its url', async () => {
    render(<TerminalView worktree={worktree} mode="shell" onClose={() => {}} />);
    const tab = await settle(hub().openBrowser('https://example.com/', null, Date.now() + 2_000));
    expect(tab).toEqual(ref('browser', '1'));
    expect(hub().context().focused).toEqual(ref('browser', '1'));
    act(() => { hub().closeLocal(ref('browser', '1')); });
    expect(hub().context().tabs.some((t) => t.mode === 'browser')).toBe(false);
    expect(readBrowserUrls()[P]).toBeUndefined();
  });

});
