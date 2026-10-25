import { describe, expect, it } from 'vitest';
import { buildParseContext } from './jarvisContext';
import type { PeerDto } from '../../api';

const peer = (over: Partial<PeerDto>): PeerDto => ({ agentId: 'claude-1@a', alias: 'rev', mode: 'claude', worktreePath: '/w/a', sessionId: '1', executionId: 'E1', lifecycle: 'idle', live: true, ...over });

describe('buildParseContext', () => {
  it('stamps registry identity (agent id, alias, executionId) onto the hub strip; live peers only', () => {
    const ctx = buildParseContext({
      hub: { path: '/w/a', context: { tabs: [{ worktreePath: '/w/a', mode: 'claude', sessionId: '1', label: 'Claude', busy: false }, { worktreePath: '/w/a', mode: 'shell', sessionId: '2', label: 'Shell 2', busy: false }], focused: null } },
      peers: [peer({}), peer({ agentId: 'shell-2@a', alias: null, mode: 'shell', sessionId: '2', executionId: null, live: false })],
      lastActedOn: null, worktrees: [], focuses: [], workspaces: [], repos: [], scripts: null,
    });
    expect(ctx.tabs[0]).toMatchObject({ agentId: 'claude-1@a', alias: 'rev', executionId: 'E1' });
    expect(ctx.tabs[1]!.executionId).toBeUndefined();
    expect(ctx.peers).toEqual([{ agentId: 'claude-1@a', alias: 'rev', mode: 'claude', worktreePath: '/w/a' }]);
    expect(ctx).toMatchObject({ currentWorktree: '/w/a', packageScripts: {} });
  });
  it('no hub: no tabs, no current worktree, version 0', () => {
    const ctx = buildParseContext({ hub: null, peers: [], lastActedOn: null, worktrees: [], focuses: [], workspaces: [], repos: [], scripts: { packageManager: 'bun', scripts: ['dev'] } });
    expect(ctx).toMatchObject({ tabs: [], focused: null, currentWorktree: null, packageManager: 'bun' });
  });
  it('open calls to the human come from the stations feed (one per open call)', () => {
    const ctx = buildParseContext({
      hub: null, peers: [], lastActedOn: null, worktrees: [], focuses: [], workspaces: [], repos: [], scripts: null,
      stations: [
        { agentId: 'claude-1@a', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/w/a', worktreeName: 'a', sessionId: '1', lifecycle: 'idle', live: true,
          calls: [{ id: 'e1', title: 'Which DB?', body: '', createdAt: 1 }, { id: 'e2', title: 'Merge?', body: '', createdAt: 2 }], lastActivityAt: null },
        { agentId: 'shell-1@a', alias: null, name: 'shell-1', mode: 'shell', worktreePath: '/w/a', worktreeName: 'a', sessionId: '1', lifecycle: 'idle', live: true, calls: [], lastActivityAt: null },
      ],
    });
    expect(ctx.calls).toEqual([{ id: 'e1', agentId: 'claude-1@a', title: 'Which DB?' }, { id: 'e2', agentId: 'claude-1@a', title: 'Merge?' }]);
  });
  it('each worktree carries when it was last opened here (the LRU), for the model to rank recent first', () => {
    const ctx = buildParseContext({
      hub: null, peers: [], lastActedOn: null, focuses: [], workspaces: [], repos: [], scripts: null,
      worktrees: [{ path: '/w/a', branch: 'a' }, { path: '/w/b', branch: 'b' }] as never,
      lru: { '/w/b': 42 },
    });
    expect(ctx.worktrees[0]!.lastUsedAt).toBeUndefined();
    expect(ctx.worktrees[1]!.lastUsedAt).toBe(42);
  });
  describe('Focuses: the open one, and each one\'s worktrees', () => {
    const focuses = [
      { id: 'f1', name: 'Release', members: ['local:/w/a', 'remote:runner-1:/srv/x', 'local:/w/b'], createdAt: 't', lastActiveAt: 't' },
      { id: 'f2', name: 'Empty', members: [], createdAt: 't', lastActiveAt: 't' },
    ];
    const base = { hub: null, peers: [], lastActedOn: null, worktrees: [], workspaces: [], repos: [], scripts: null, focuses };

    it('each Focus carries its local worktree paths (a runner\'s worktrees are left out)', () => {
      const ctx = buildParseContext(base);
      expect(ctx.focuses).toEqual([
        { id: 'f1', name: 'Release', worktreePaths: ['/w/a', '/w/b'] },
        { id: 'f2', name: 'Empty', worktreePaths: [] },
      ]);
    });

    it('the Focus open in this window is currentFocus; none open (or a stale id) is null', () => {
      expect(buildParseContext({ ...base, activeFocusId: 'f1' }).currentFocus).toEqual({ id: 'f1', name: 'Release' });
      expect(buildParseContext({ ...base, activeFocusId: null }).currentFocus).toBeNull();
      expect(buildParseContext({ ...base, activeFocusId: 'gone' }).currentFocus).toBeNull();
      expect(buildParseContext(base).currentFocus).toBeNull();
    });
  });
  it('each worktree names its repo (by repoId; a repo\'s own checkout by path; unknown is null)', () => {
    const ctx = buildParseContext({
      hub: null, peers: [], lastActedOn: null, focuses: [], workspaces: [], scripts: null,
      repos: [{ id: 'r1', name: 'Strado', path: '/code/strado' }, { id: 'r2', name: 'Strado Website', path: '/code/site' }] as never,
      worktrees: [
        { path: '/wt/strado/mcp', repoId: 'r1', branch: 'mcp' },
        { path: '/code/site', repoId: null, branch: 'main' },
        { path: '/wt/other/x', repoId: 'gone', branch: 'x' },
      ] as never,
    });
    expect(ctx.worktrees).toMatchObject([
      { path: '/wt/strado/mcp', repoName: 'Strado' },
      { path: '/code/site', repoName: 'Strado Website' },
      { path: '/wt/other/x', repoName: null },
    ]);
  });
  describe('worktree names are unique', () => {
    const build = (worktrees: unknown[]) => buildParseContext({
      hub: null, peers: [], lastActedOn: null, focuses: [], workspaces: [], scripts: null,
      repos: [{ id: 'r1', name: 'Strado', path: '/code/strado' }, { id: 'r2', name: 'Strado Website', path: '/code/site' }] as never,
      worktrees: worktrees as never,
    }).worktrees.map((w) => w.name);

    it('a name only one worktree has stays plain', () => {
      expect(build([{ path: '/wt/a/FD-9', repoId: 'r1', branch: 'fd-9', meta: { ticketId: 'FD-9' } }, { path: '/code/site', repoId: 'r2', branch: 'main' }])).toEqual(['FD-9', 'main']);
    });

    it('a shared name (two repos\' "main") is "<repo>/<name>" for each of them', () => {
      expect(build([
        { path: '/code/strado', repoId: 'r1', branch: 'main' },
        { path: '/code/site', repoId: 'r2', branch: 'main' },
        { path: '/wt/a/x', repoId: 'r1', branch: 'x' },
      ])).toEqual(['Strado/main', 'Strado Website/main', 'x']);
    });

    it('case-insensitive clash too; with no repo, the last two path segments', () => {
      expect(build([
        { path: '/code/strado', repoId: 'r1', branch: 'Main' },
        { path: '/elsewhere/proj/main', repoId: null, branch: 'main' },
      ])).toEqual(['Strado/Main', 'proj/main']);
    });

    it('still clashing after the repo (same ticket twice in one repo): the last two path segments', () => {
      expect(build([
        { path: '/wt/strado/FD-9', repoId: 'r1', branch: 'a', meta: { ticketId: 'FD-9' } },
        { path: '/wt/strado/FD-9-retry', repoId: 'r1', branch: 'b', meta: { ticketId: 'FD-9' } },
      ])).toEqual(['strado/FD-9', 'strado/FD-9-retry']);
    });
  });
  describe('tabs in every local worktree, not just the one on screen', () => {
    const wts = [{ path: '/w/a', branch: 'a' }, { path: '/w/main', branch: 'main' }, { path: '/w/old', branch: 'old' }] as never;
    const none = { lastActedOn: null, focuses: [], workspaces: [], repos: [], scripts: null };

    it('home (no hub): a live shell in another worktree is a tab, labelled like the strip, off screen', () => {
      const ctx = buildParseContext({ ...none, hub: null, worktrees: wts,
        peers: [peer({ agentId: 'shell-1@main', alias: null, mode: 'shell', worktreePath: '/w/main', sessionId: '1', executionId: 'X1' })] });
      expect(ctx.tabs).toEqual([
        { worktreePath: '/w/main', mode: 'shell', sessionId: '1', label: 'Shell', busy: false, agentId: 'shell-1@main', alias: null, executionId: 'X1', onScreen: false },
      ]);
    });

    it('on-screen tabs first (marked), then other worktrees\' sessions by how recently their worktree was opened; no duplicates, live and local only', () => {
      const ctx = buildParseContext({ ...none, worktrees: wts, lru: { '/w/old': 1, '/w/main': 9 },
        hub: { path: '/w/a', context: { tabs: [{ worktreePath: '/w/a', mode: 'claude', sessionId: '1', label: 'Claude', busy: false }], focused: null } },
        peers: [
          peer({}), // on screen already
          peer({ agentId: 'codex-2@old', alias: null, mode: 'codex', worktreePath: '/w/old', sessionId: '2', executionId: null, lifecycle: 'working' }),
          peer({ agentId: 'claude-3@main', alias: 'fixer', mode: 'claude', worktreePath: '/w/main', sessionId: '3', executionId: 'E3' }),
          peer({ agentId: 'shell-9@main', mode: 'shell', worktreePath: '/w/main', sessionId: '9', live: false }),
          peer({ agentId: 'claude-1@runner', worktreePath: '/srv/remote', sessionId: '1' }),
        ] });
      expect(ctx.tabs.map((t) => [t.worktreePath, t.label, (t as { onScreen?: boolean }).onScreen, t.busy])).toEqual([
        ['/w/a', 'Claude', true, false],
        ['/w/main', 'Claude 3', false, false],
        ['/w/old', 'Codex 2', false, true],
      ]);
    });

    it('a renamed session (the strip\'s own names) shows by its name off screen too', () => {
      const ctx = buildParseContext({ ...none, hub: null, worktrees: wts,
        shellNames: { '/w/main::1': 'test', '/w/main::claude::3': 'fixer bot' },
        peers: [
          peer({ agentId: 'shell-1@main', alias: null, mode: 'shell', worktreePath: '/w/main', sessionId: '1', executionId: null }),
          peer({ agentId: 'claude-3@main', alias: null, mode: 'claude', worktreePath: '/w/main', sessionId: '3', executionId: null }),
          peer({ agentId: 'shell-2@main', alias: null, mode: 'shell', worktreePath: '/w/main', sessionId: '2', executionId: null }),
        ] });
      expect(ctx.tabs.map((t) => t.label)).toEqual(['test', 'fixer bot', 'Shell 2']);
    });

    it('capped at 60 tabs, on-screen ones always kept', () => {
      const many = Array.from({ length: 80 }, (_, i) => peer({ agentId: `shell-${i + 1}@main`, alias: null, mode: 'shell', worktreePath: '/w/main', sessionId: String(i + 1), executionId: null }));
      const ctx = buildParseContext({ ...none, worktrees: wts, peers: many,
        hub: { path: '/w/a', context: { tabs: [{ worktreePath: '/w/a', mode: 'claude', sessionId: '1', label: 'Claude', busy: false }], focused: null } } });
      expect(ctx.tabs).toHaveLength(60);
      expect(ctx.tabs[0]!.worktreePath).toBe('/w/a');
    });
  });
  it('the workspace this window is in is currentWorkspace; unknown (or none given) is null', () => {
    const base = { hub: null, peers: [], lastActedOn: null, worktrees: [], focuses: [], repos: [], scripts: null,
      workspaces: [{ id: 'default', name: 'Personal' }, { id: 'fx', name: 'FleetX' }] as never };
    expect(buildParseContext({ ...base, activeWorkspaceId: 'fx' }).currentWorkspace).toEqual({ id: 'fx', name: 'FleetX' });
    expect(buildParseContext({ ...base, activeWorkspaceId: 'gone' }).currentWorkspace).toBeNull();
    expect(buildParseContext(base).currentWorkspace).toBeNull();
  });

  it('stored Browser tabs of worktrees not on screen are listed off screen; the shown worktree\'s come from its hub', () => {
    const wt = (path: string) => ({ path, branch: path.split('/').pop() } as never);
    const ctx = buildParseContext({
      hub: { path: '/w/a', context: { tabs: [], focused: null } }, peers: [], lastActedOn: null,
      worktrees: [wt('/w/a'), wt('/w/b')], focuses: [], workspaces: [], repos: [], scripts: null,
      storedBrowsers: [
        { worktreePath: '/w/b', sessionId: '2', label: 'Google' },
        { worktreePath: '/w/a', sessionId: '1', label: 'Shown already' },
        { worktreePath: '/elsewhere', sessionId: '1', label: 'Not local' },
      ],
    });
    expect(ctx.tabs).toEqual([{ worktreePath: '/w/b', mode: 'browser', sessionId: '2', label: 'Google', busy: false, onScreen: false }]);
  });
});
