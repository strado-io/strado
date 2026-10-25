import { describe, it, expect } from 'vitest';
import { resolveCard } from './cards';
import type { PeerDto } from '../../api';
import type { Worktree } from '../../types';

const wt = (path: string, branch: string): Worktree => ({ path, branch } as Worktree);
const peer = (over: Partial<PeerDto>): PeerDto => ({ agentId: 'claude-1@a', alias: null, mode: 'claude', worktreePath: '/w/api', sessionId: '1', executionId: 'E', lifecycle: 'idle', live: true, ...over });
const world = { worktrees: [wt('/w/api', 'fleetx-api'), wt('/w/web', 'web')], repos: [], peers: [peer({})] };

describe('resolveCard', () => {
  it('finds a live agent tab by its session name', () => {
    expect(resolveCard({ kind: 'claude', worktree: 'fleetx-api', tab: 'claude-1' }, world))
      .toEqual({ open: true, worktreePath: '/w/api', mode: 'claude', sessionId: '1', busy: false, status: 'idle' });
  });
  it('a worktree-qualified tab name works too, and alias matches', () => {
    const w = { ...world, peers: [peer({ alias: 'rev', lifecycle: 'working' })] };
    expect(resolveCard({ kind: 'claude', worktree: 'fleetx-api', tab: 'fleetx-api/rev' }, w)).toMatchObject({ open: true, sessionId: '1', busy: true, status: 'working' });
  });
  it('a tab no longer live is closed, and so is a missing worktree', () => {
    expect(resolveCard({ kind: 'claude', worktree: 'fleetx-api', tab: 'claude-2' }, world)).toEqual({ open: false });
    expect(resolveCard({ kind: 'claude', worktree: 'gone', tab: 'claude-1' }, world)).toEqual({ open: false });
    expect(resolveCard({ kind: 'claude', worktree: 'fleetx-api', tab: 'claude-1' }, { ...world, peers: [peer({ live: false })] })).toEqual({ open: false });
  });
  it('a run card opens its shell; a browser card opens the worktree browser', () => {
    const w = { ...world, peers: [peer({ agentId: 'shell-3@a', mode: 'shell', sessionId: '3' })] };
    expect(resolveCard({ kind: 'run', worktree: 'fleetx-api', tab: 'shell-3', label: 'dev' }, w)).toMatchObject({ open: true, mode: 'shell', sessionId: '3' });
    expect(resolveCard({ kind: 'browser', worktree: 'web', tab: 'browser-1', url: 'http://localhost:3000' }, world))
      .toEqual({ open: true, worktreePath: '/w/web', mode: 'browser', sessionId: '1', busy: false, status: '' });
  });
  it('a card with worktreePath matches that exact worktree, whatever its name says', () => {
    expect(resolveCard({ kind: 'claude', worktree: 'renamed', worktreePath: '/w/api', tab: 'claude-1' }, world)).toMatchObject({ open: true, worktreePath: '/w/api' });
    expect(resolveCard({ kind: 'claude', worktree: 'fleetx-api', worktreePath: '/w/gone', tab: 'claude-1' }, world)).toEqual({ open: false });
  });
});
