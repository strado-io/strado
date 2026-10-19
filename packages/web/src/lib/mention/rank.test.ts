import { describe, expect, it } from 'vitest';
import { rankStations, type Station } from './rank';

const st = (name: string, over: Partial<Station> = {}): Station => ({
  agentId: `${name}@${over.worktreeName ?? 'app'}`, name, worktreeName: 'app', inThisWorktree: true,
  focused: false, status: 'idle', lastActivityAt: 0, ...over,
});
const names = (r: { rows: Station[] }) => r.rows.map((s) => `${s.worktreeName}/${s.name}`);

describe('rankStations', () => {
  it('empty query: calling, then focused, then this worktree, then others below a divider', () => {
    const r = rankStations([
      st('claude-1', { worktreeName: 'hotfix', inThisWorktree: false, lastActivityAt: 9 }),
      st('shell-2', { lastActivityAt: 5 }),
      st('claude-1', { focused: true }),
      st('opencode-1', { status: 'calling' }),
    ], '');
    expect(names(r)).toEqual(['app/opencode-1', 'app/claude-1', 'app/shell-2', 'hotfix/claude-1']);
    expect(r.dividerBefore).toBe(3);
  });

  it('a call from another worktree still leads, and does not move the divider', () => {
    const r = rankStations([st('shell-1'), st('claude-2', { worktreeName: 'api', inThisWorktree: false, status: 'calling' })], '');
    expect(names(r)).toEqual(['api/claude-2', 'app/shell-1']);
    expect(r.dividerBefore).toBeNull();
  });

  it('this worktree is ordered by most recent activity', () => {
    expect(names(rankStations([st('a', { lastActivityAt: 1 }), st('b', { lastActivityAt: 3 }), st('c', { lastActivityAt: 2 })], ''))).toEqual(['app/b', 'app/c', 'app/a']);
  });

  it('offline goes last within its group', () => {
    expect(names(rankStations([st('a', { status: 'offline', lastActivityAt: 9 }), st('b')], ''))).toEqual(['app/b', 'app/a']);
  });

  it('filters case-insensitively on name, ignoring a leading @', () => {
    const r = rankStations([st('claude-1'), st('shell-1'), st('Codex-1')], '@CL');
    expect(names(r)).toEqual(['app/claude-1']);
  });

  it('prefix matches rank above substring matches in the same group', () => {
    expect(names(rankStations([st('my-claude', { lastActivityAt: 9 }), st('claude-1')], 'claude'))).toEqual(['app/claude-1', 'app/my-claude']);
  });

  it('matches the alias too', () => {
    expect(names(rankStations([st('claude-1', { alias: 'reviewer' }), st('shell-1')], 'rev'))).toEqual(['app/claude-1']);
  });

  it('group beats match quality: a focused substring hit stays above a prefix hit elsewhere', () => {
    const r = rankStations([st('claude-1', { worktreeName: 'x', inThisWorktree: false }), st('my-claude', { focused: true })], 'claude');
    expect(names(r)).toEqual(['app/my-claude', 'x/claude-1']);
  });

  it('caps at the limit and reports the divider only within shown rows', () => {
    const many = Array.from({ length: 8 }, (_, i) => st(`s${i}`, { lastActivityAt: 10 - i }));
    const r = rankStations([...many, st('far', { worktreeName: 'y', inThisWorktree: false })], '');
    expect(r.rows).toHaveLength(6);
    expect(r.dividerBefore).toBeNull();
    expect(rankStations(many, '', 3).rows).toHaveLength(3);
  });

  it('no match → no rows and no divider', () => {
    expect(rankStations([st('claude-1')], 'zzz')).toEqual({ rows: [], dividerBefore: null });
  });

  it('ties break by name for a stable order', () => {
    expect(names(rankStations([st('b'), st('a')], ''))).toEqual(['app/a', 'app/b']);
  });
});
