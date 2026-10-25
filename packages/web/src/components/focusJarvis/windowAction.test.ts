import { describe, it, expect, vi } from 'vitest';
import { runJarvisAction } from './windowAction';
import { buildParseContext } from '../jarvis/jarvisContext';
import type { JarvisPorts, JarvisServerPort } from '../../lib/jarvis/execute';
import type { Worktree } from '../../types';
import { readActiveTab } from '../../hooks/tabOrder';
import { readBrowserUrls, previewKey } from '../../hooks/browserTabs';
import { readPaneLayouts, leafKeys } from '../../hooks/paneLayout';
import { beforeEach, afterEach } from 'vitest';

const wt = (path: string, branch: string): Worktree => ({ path, branch } as Worktree);
const focus = (members: string[]) => ({ id: 'f1', name: 'Billing', members, createdAt: 't', lastActiveAt: 't' });
const ctxWith = (members: string[] = ['local:/w/api']) => () => buildParseContext({
  hub: null, lastActedOn: null, focuses: [focus(members)], activeFocusId: 'f1', workspaces: [], repos: [], scripts: null,
  worktrees: [wt('/w/api', 'fleetx-api'), wt('/w/web', 'web')],
  peers: [
    { agentId: 'claude-1@a', alias: 'rev', mode: 'claude', worktreePath: '/w/api', sessionId: '1', executionId: 'E', lifecycle: 'idle', live: true },
    { agentId: 'shell-3@a', alias: null, mode: 'shell', worktreePath: '/w/api', sessionId: '3', executionId: 'S', lifecycle: 'idle', live: true },
  ],
});
const ctx = ctxWith();
const SCOPE = ['/w/api'];
function server(over: Partial<JarvisServerPort> = {}): JarvisServerPort {
  return {
    spawn: vi.fn(async ({ mode, worktreePath }) => ({ tab: { mode, worktreePath, sessionId: '3' } })),
    run: vi.fn(async () => ({})), interrupt: vi.fn(async () => ({})), close: vi.fn(async () => ({})),
    message: vi.fn(async () => ({ id: 'm1', delivered: 'sent', to: { agentId: 'claude-1@a', alias: 'rev' } })),
    startServer: vi.fn(async () => ({})), stopServer: vi.fn(async () => ({})), answerCall: vi.fn(async () => ({})), dismissCall: vi.fn(async () => ({})),
    ...over,
  } as JarvisServerPort;
}
const ports = (s: JarvisServerPort): Omit<JarvisPorts, 'verify' | 'onStep'> => ({
  hub: null, server: s,
  nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() },
});

describe('runJarvisAction', () => {
  it('opens a tab off screen and returns its card, named as Jarvis names it', async () => {
    const s = server();
    const r = await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'fleetx-api', command: 'npm run dev' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(s) });
    expect(s.spawn).toHaveBeenCalledWith({ mode: 'shell', worktreePath: '/w/api' });
    expect(s.run).toHaveBeenCalledWith({ mode: 'shell', worktreePath: '/w/api', sessionId: '3' }, 'npm run dev');
    // worktreePath is what wakes match on (wakes.ts); worktree is the name Jarvis uses.
    expect(r.card).toEqual({ kind: 'shell', worktree: 'fleetx-api', worktreePath: '/w/api', tab: 'shell-3' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/opened/i);
  });

  it('agent.ask returns the question id as askId', async () => {
    const s = server();
    const r = await runJarvisAction({ action: 'agent.ask', args: { to: 'rev', question: 'Done yet?' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(s) });
    expect(s.message).toHaveBeenCalledWith('claude-1@a', 'Done yet?', { ask: true });
    expect(r).toMatchObject({ ok: true, askId: 'm1' });
  });

  it('a step it cannot build or run says why', async () => {
    const s = server({ spawn: vi.fn(async () => { throw new Error('pty limit'); }) });
    expect(await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'nope' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(s) }))
      .toMatchObject({ ok: false });
    const r = await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'fleetx-api' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(s) });
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toContain('pty limit');
  });

  it('never navigates: nav actions are refused', async () => {
    const s = server();
    const p = ports(s);
    const r = await runJarvisAction({ action: 'nav.worktree', args: { worktree: 'fleetx-api' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => p });
    expect(r.ok).toBe(false);
    expect(p.nav.worktree).not.toHaveBeenCalled();
  });

  describe('off screen (the chat is showing, no hub)', () => {
    beforeEach(() => { localStorage.clear(); (window as unknown as { strado?: unknown }).strado = {}; });
    afterEach(() => { delete (window as unknown as { strado?: unknown }).strado; });

    it('browser.open stores a Browser tab in that worktree, active, and the card carries the url', async () => {
      const r = await runJarvisAction({ action: 'browser.open', args: { url: 'http://localhost:3000', worktree: 'fleetx-api' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(server()) });
      expect(r).toMatchObject({ ok: true, card: { kind: 'browser', worktree: 'fleetx-api', tab: 'browser-1', url: 'http://localhost:3000/' } });
      expect(readBrowserUrls()[previewKey('/w/api', '1')]).toMatch(/^http:\/\/localhost:3000/);
      expect(readActiveTab('/w/api')).toEqual({ mode: 'browser', id: '1' });
    });

    it('tab.focus makes the tab its worktree\'s active one; nothing navigates', async () => {
      const p = ports(server());
      const r = await runJarvisAction({ action: 'tab.focus', args: { tab: 'fleetx-api/rev' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => p });
      expect(r.ok).toBe(true);
      expect(readActiveTab('/w/api')).toEqual({ mode: 'claude', id: '1' });
      expect(p.nav.worktree).not.toHaveBeenCalled();
    });

    it('tab.place updates the stored layout', async () => {
      const r = await runJarvisAction({ action: 'tab.place', args: { tab: 'fleetx-api/shell-3', split: 'down', anchor: 'fleetx-api/rev' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(server()) });
      expect(r.ok).toBe(true);
      expect(leafKeys(readPaneLayouts()['/w/api']![0]!)).toEqual(['claude:1', 'shell:3']);
    });

    it('no worktree named: the Focus\'s only one; with several, which?', async () => {
      const s = server();
      expect(await runJarvisAction({ action: 'tab.open', args: { mode: 'claude' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(s) })).toMatchObject({ ok: true, card: { worktree: 'fleetx-api' } });
      expect(s.spawn).toHaveBeenCalledWith({ mode: 'claude', worktreePath: '/w/api' });
      const two = await runJarvisAction({ action: 'browser.open', args: { url: 'http://x.dev' }, scope: ['/w/api', '/w/web'], focusId: 'f1' }, { context: ctxWith(['local:/w/api', 'local:/w/web']), ports: () => ports(server()) });
      expect(two).toEqual({ ok: false, text: 'Which worktree? fleetx-api, web' });
    });
  });

  describe('D1: only inside the Focus', () => {
    beforeEach(() => { localStorage.clear(); });
    const withWeb = () => buildParseContext({
      hub: null, lastActedOn: null, focuses: [focus(['local:/w/api'])], activeFocusId: 'f1', workspaces: [], repos: [], scripts: null,
      worktrees: [wt('/w/api', 'fleetx-api'), wt('/w/web', 'web')],
      peers: [
        { agentId: 'claude-1@a', alias: 'rev', mode: 'claude', worktreePath: '/w/api', sessionId: '1', executionId: 'E', lifecycle: 'idle', live: true },
        { agentId: 'claude-2@w', alias: 'other', mode: 'claude', worktreePath: '/w/web', sessionId: '2', executionId: 'F', lifecycle: 'idle', live: true },
      ],
    });
    const deps = (s: JarvisServerPort, p = ports(s)) => ({ context: withWeb, ports: () => p });

    it('a tab in a worktree outside the scope is refused with fixed words, and nothing runs', async () => {
      const s = server();
      expect(await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'web' }, scope: SCOPE, focusId: 'f1' }, deps(s)))
        .toEqual({ ok: false, text: "That worktree isn't in this Focus." });
      expect(s.spawn).not.toHaveBeenCalled();
      expect(await runJarvisAction({ action: 'tab.close', args: { tab: 'web/other' }, scope: SCOPE, focusId: 'f1' }, deps(s)))
        .toEqual({ ok: false, text: "That worktree isn't in this Focus." });
      expect(s.close).not.toHaveBeenCalled();
      expect(await runJarvisAction({ action: 'server.stop', args: { worktree: 'web' }, scope: SCOPE, focusId: 'f1' }, deps(s)))
        .toEqual({ ok: false, text: "That worktree isn't in this Focus." });
      expect(s.stopServer).not.toHaveBeenCalled();
    });

    it('an agent outside the scope is refused; one inside is reached', async () => {
      const s = server();
      expect(await runJarvisAction({ action: 'agent.message', args: { to: 'other', text: 'hi' }, scope: SCOPE, focusId: 'f1' }, deps(s)))
        .toEqual({ ok: false, text: "That worktree isn't in this Focus." });
      expect(s.message).not.toHaveBeenCalled();
      expect((await runJarvisAction({ action: 'agent.message', args: { to: 'rev', text: 'hi' }, scope: SCOPE, focusId: 'f1' }, deps(s))).ok).toBe(true);
      expect(s.message).toHaveBeenCalledWith('claude-1@a', 'hi');
    });

    it('an empty scope refuses every worktree step', async () => {
      const s = server();
      expect(await runJarvisAction({ action: 'tab.open', args: { mode: 'claude', worktree: 'fleetx-api' }, scope: [], focusId: 'f1' }, deps(s)))
        .toEqual({ ok: false, text: "That worktree isn't in this Focus." });
    });

    it('focus.edit changes only this Focus; create is allowed', async () => {
      const s = server();
      const focusPort = vi.fn(async () => ({ focusId: 'f9' }));
      const p = { ...ports(s), app: { page: vi.fn(), settings: vi.fn(), set: vi.fn(), focus: focusPort } };
      const ctxTwo = () => buildParseContext({
        hub: null, lastActedOn: null, focuses: [focus(['local:/w/api']), { id: 'f2', name: 'Other', members: [], createdAt: 't', lastActiveAt: 't' }], activeFocusId: 'f1',
        workspaces: [], repos: [], scripts: null, worktrees: [wt('/w/api', 'fleetx-api')], peers: [],
      });
      const d = { context: ctxTwo, ports: () => p };
      expect(await runJarvisAction({ action: 'focus.edit', args: { op: 'rename', focus: 'Other', name: 'Mine' }, scope: SCOPE, focusId: 'f1' }, d))
        .toEqual({ ok: false, text: "That Focus isn't this one." });
      expect(focusPort).not.toHaveBeenCalled();
      expect(await runJarvisAction({ action: 'focus.edit', args: { op: 'rename', focus: 'Billing', name: 'Billing 2' }, scope: SCOPE, focusId: 'f1' }, d))
        .toEqual({ ok: true, text: 'Renamed Billing to Billing 2' });
      expect((await runJarvisAction({ action: 'focus.edit', args: { op: 'create', name: 'Spike' }, scope: SCOPE, focusId: 'f1' }, d)).ok).toBe(true);
      expect(focusPort).toHaveBeenCalledTimes(2);
    });
  });

  it('W2: a window failure reaches Jarvis as fixed words, never the error text', async () => {
    const r = await runJarvisAction({ action: 'tab.open', args: { mode: 'claude', worktree: 'fleetx-api' }, scope: SCOPE, focusId: 'f1' },
      { context: () => { throw new Error('/Users/secret/path exploded'); }, ports: () => ports(server()) });
    expect(r).toEqual({ ok: false, text: "The Strado window couldn't do that." });
  });

  it('shell.run in an existing tab returns that tab as the card', async () => {
    const s = server();
    const r = await runJarvisAction({ action: 'shell.run', args: { tab: 'fleetx-api/shell-3', command: 'git status' }, scope: SCOPE, focusId: 'f1' }, { context: ctx, ports: () => ports(s) });
    expect(s.run).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/w/api', mode: 'shell', sessionId: '3' }), 'git status');
    expect(r).toMatchObject({ ok: true, card: { kind: 'shell', worktree: 'fleetx-api', worktreePath: '/w/api', tab: 'shell-3' } });
  });

  it('acts for the turn\'s Focus, not the one the window shows now', async () => {
    const s = server();
    const focusPort = vi.fn(async () => undefined);
    const p = { ...ports(s), app: { page: vi.fn(), settings: vi.fn(), set: vi.fn(), focus: focusPort } };
    // The window has moved on to f2; a late action of f1's turn arrives.
    const showingF2 = () => buildParseContext({
      hub: null, lastActedOn: null, activeFocusId: 'f2', workspaces: [], repos: [], scripts: null, worktrees: [wt('/w/api', 'fleetx-api')], peers: [],
      focuses: [focus(['local:/w/api']), { id: 'f2', name: 'Other', members: [], createdAt: 't', lastActiveAt: 't' }],
    });
    const d = { context: showingF2, ports: () => p };
    expect((await runJarvisAction({ action: 'focus.edit', args: { op: 'rename', focus: 'this focus', name: 'Billing 2' }, scope: SCOPE, focusId: 'f1' }, d)).ok).toBe(true);
    expect(focusPort).toHaveBeenCalledWith(expect.objectContaining({ op: 'rename', focusId: 'f1' }));
    expect(await runJarvisAction({ action: 'focus.edit', args: { op: 'rename', focus: 'Other', name: 'x' }, scope: SCOPE, focusId: 'f1' }, d))
      .toEqual({ ok: false, text: "That Focus isn't this one." });
  });
});
