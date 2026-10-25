import { describe, it, expect, vi } from 'vitest';
import { runJarvisAction } from './windowAction';
import { buildParseContext } from '../jarvis/jarvisContext';
import type { JarvisPorts, JarvisServerPort } from '../../lib/jarvis/execute';
import type { Worktree } from '../../types';

const wt = (path: string, branch: string): Worktree => ({ path, branch } as Worktree);
const ctx = () => buildParseContext({
  hub: null, lastActedOn: null, focuses: [], workspaces: [], repos: [], scripts: null,
  worktrees: [wt('/w/api', 'fleetx-api')],
  peers: [{ agentId: 'claude-1@a', alias: 'rev', mode: 'claude', worktreePath: '/w/api', sessionId: '1', executionId: 'E', lifecycle: 'idle', live: true }],
});
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
    const r = await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'fleetx-api', command: 'npm run dev' } }, { context: ctx, ports: () => ports(s) });
    expect(s.spawn).toHaveBeenCalledWith({ mode: 'shell', worktreePath: '/w/api' });
    expect(s.run).toHaveBeenCalledWith({ mode: 'shell', worktreePath: '/w/api', sessionId: '3' }, 'npm run dev');
    expect(r).toMatchObject({ ok: true, card: { kind: 'shell', worktree: 'fleetx-api', tab: 'shell-3' } });
    expect(r.text).toMatch(/opened/i);
  });

  it('agent.ask returns the question id as askId', async () => {
    const s = server();
    const r = await runJarvisAction({ action: 'agent.ask', args: { to: 'rev', question: 'Done yet?' } }, { context: ctx, ports: () => ports(s) });
    expect(s.message).toHaveBeenCalledWith('claude-1@a', 'Done yet?', { ask: true });
    expect(r).toMatchObject({ ok: true, askId: 'm1' });
  });

  it('a step it cannot build or run says why', async () => {
    const s = server({ spawn: vi.fn(async () => { throw new Error('pty limit'); }) });
    expect(await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'nope' } }, { context: ctx, ports: () => ports(s) }))
      .toMatchObject({ ok: false });
    const r = await runJarvisAction({ action: 'tab.open', args: { mode: 'shell', worktree: 'fleetx-api' } }, { context: ctx, ports: () => ports(s) });
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toContain('pty limit');
  });

  it('never navigates: nav actions are refused', async () => {
    const s = server();
    const p = ports(s);
    const r = await runJarvisAction({ action: 'nav.worktree', args: { worktree: 'fleetx-api' } }, { context: ctx, ports: () => p });
    expect(r.ok).toBe(false);
    expect(p.nav.worktree).not.toHaveBeenCalled();
  });
});
