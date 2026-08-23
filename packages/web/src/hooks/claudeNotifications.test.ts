import { describe, expect, it } from 'vitest';
import { computeClaudeNotifications, snapshotStatuses } from './claudeNotifications';
import type { Worktree } from '../types';

function wt(path: string, claudeStatus?: 'idle' | 'working' | 'waiting'): Worktree {
  return {
    path,
    meta: { ticketId: path.split('/').pop() } as any,
    claudeStatus,
  } as unknown as Worktree;
}

describe('computeClaudeNotifications', () => {
  it('notifies when a worktree transitions into waiting', () => {
    const prev = snapshotStatuses([wt('/wt/a', 'working')]);
    const out = computeClaudeNotifications(prev, [wt('/wt/a', 'waiting')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe('/wt/a');
    expect(out[0]!.sessionId).toBe('1');
    expect(out[0]!.title).toMatch(/needs your input/i);
    expect(out[0]!.kind).toBe('waiting');
  });

  it('notifies when a worktree transitions from working to idle', () => {
    const prev = snapshotStatuses([wt('/wt/a', 'working')]);
    const out = computeClaudeNotifications(prev, [wt('/wt/a', 'idle')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toMatch(/finished/i);
    expect(out[0]!.kind).toBe('finished');
  });

  it('does not notify on idle->working or unchanged status', () => {
    const prev = snapshotStatuses([wt('/wt/a', 'idle'), wt('/wt/b', 'waiting')]);
    const out = computeClaudeNotifications(prev, [wt('/wt/a', 'working'), wt('/wt/b', 'waiting')]);
    expect(out).toHaveLength(0);
  });

  it('snapshotStatuses keys by path + session id', () => {
    expect(snapshotStatuses([wt('/wt/a', 'working'), wt('/wt/b')])).toEqual({
      '/wt/a\x001': 'working',
      '/wt/b\x001': undefined,
    });
  });

  it('does not notify for a first-seen worktree already in waiting', () => {
    const out = computeClaudeNotifications({}, [wt('/wt/a', 'waiting')]);
    expect(out).toHaveLength(0);
  });

  describe('multi-session worktrees', () => {
    function wtById(path: string, byId: Record<string, 'idle' | 'working' | 'waiting'>): Worktree {
      const agg = Object.values(byId).includes('working')
        ? 'working'
        : Object.values(byId).includes('waiting') ? 'waiting' : 'idle';
      return {
        path,
        meta: { ticketId: path.split('/').pop() } as any,
        claudeStatus: agg,
        claudeStatusById: byId,
      } as unknown as Worktree;
    }

    it('notifies for a session turning waiting even while another keeps working', () => {
      // aggregate stays 'working' — the old worktree-level diff missed this
      const prev = snapshotStatuses([wtById('/wt/a', { '1': 'working', '2': 'working' })]);
      const out = computeClaudeNotifications(prev, [wtById('/wt/a', { '1': 'working', '2': 'waiting' })]);
      expect(out).toHaveLength(1);
      expect(out[0]!.sessionId).toBe('2');
      expect(out[0]!.title).toMatch(/Claude 2 needs your input/);
    });

    it('names the session in finished notifications too, keeping plain "Claude" for session 1', () => {
      const prev = snapshotStatuses([wtById('/wt/a', { '1': 'working', '2': 'working' })]);
      const out = computeClaudeNotifications(prev, [wtById('/wt/a', { '1': 'idle', '2': 'idle' })]);
      expect(out).toHaveLength(2);
      expect(out.find((n) => n.sessionId === '1')!.title).toMatch(/: Claude finished/);
      expect(out.find((n) => n.sessionId === '2')!.title).toMatch(/: Claude 2 finished/);
    });

    it('a brand-new session appearing already-waiting does not notify', () => {
      const prev = snapshotStatuses([wtById('/wt/a', { '1': 'working' })]);
      const out = computeClaudeNotifications(prev, [wtById('/wt/a', { '1': 'working', '2': 'waiting' })]);
      expect(out).toHaveLength(0);
    });
  });

  describe('notification context', () => {
    function full(overrides: Partial<Worktree>): Worktree {
      return {
        path: '/repos/strado.worktrees/fix-login',
        repoId: 'r1',
        branch: 'fix/google-login',
        meta: { ticketId: 'STRA-142' },
        claudeStatus: 'idle',
        ...overrides,
      } as unknown as Worktree;
    }

    it('an empty-string ticketId falls back to the folder name, never a bare ":" title', () => {
      // Seen live 2026-08-02: meta.ticketId === '' slipped past the ?? fallback
      // and the banner read ": Claude finished" with no worktree at all.
      const w = full({ meta: { ticketId: '' } as any, claudeStatus: 'idle' });
      const prev = snapshotStatuses([{ ...w, claudeStatus: 'working' } as Worktree]);
      const out = computeClaudeNotifications(prev, [w]);
      expect(out).toHaveLength(1);
      expect(out[0]!.title).toBe('fix-login: Claude finished');
    });

    it('carries repo and branch in the body when a repo-name lookup is provided', () => {
      const w = full({});
      const prev = snapshotStatuses([{ ...w, claudeStatus: 'working' } as Worktree]);
      const out = computeClaudeNotifications(prev, [w], { r1: 'strado' });
      expect(out[0]!.body).toBe('strado · fix/google-login');
    });

    it('body degrades gracefully: branch only without a lookup, empty without either', () => {
      const w = full({});
      const prev = snapshotStatuses([{ ...w, claudeStatus: 'working' } as Worktree]);
      expect(computeClaudeNotifications(prev, [w])[0]!.body).toBe('fix/google-login');

      const bare = full({ branch: null });
      const prevBare = snapshotStatuses([{ ...bare, claudeStatus: 'working' } as Worktree]);
      expect(computeClaudeNotifications(prevBare, [bare])[0]!.body).toBe('');
    });

    it('names the runner for a remote worktree', () => {
      const w = full({ remote: { runnerId: 'x', runnerName: 'runner-dev', wsBase: '', wsId: '' } });
      const prev = snapshotStatuses([{ ...w, claudeStatus: 'working' } as Worktree]);
      const out = computeClaudeNotifications(prev, [w], { r1: 'strado' });
      expect(out[0]!.body).toBe('strado · fix/google-login · on runner-dev');
    });
  });
});
