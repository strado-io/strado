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
});
