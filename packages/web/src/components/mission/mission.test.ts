import { describe, expect, it, vi } from 'vitest';
import type { StationDto } from '../../api';
import { cardAgent, decideApproval, focusWorktreesOf, missionStations, pendingApprovals } from './mission';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
});
const ap = (id: string, createdAt: number) => ({ id, kind: 'command' as const, title: 'Bash', detail: 'npm test', createdAt });

describe('mission rows', () => {
  it('focusWorktreesOf: the Focus\'s local members as paths; no Focus = null', () => {
    expect(focusWorktreesOf({ members: ['local:/wt/a', 'remote:x', 'local:/wt/b'] })).toEqual(['/wt/a', '/wt/b']);
    expect(focusWorktreesOf(null)).toBeNull();
  });
  it('missionStations: scoped (Focus + needs-you from outside), in a fixed order (worktree, then tab), never by state', () => {
    const list = [st({ agentId: 'a1' }), st({ agentId: 'b1', worktreePath: '/wt/b', worktreeName: 'b' }), st({ agentId: 'b2', worktreePath: '/wt/b', worktreeName: 'b', approvals: [ap('x', 1)] }), st({ agentId: 'a2', lifecycle: 'working' })];
    const r = missionStations(list, 'focus', ['/wt/a']);
    expect(r.map((s) => s.agentId)).toEqual(['a1', 'a2', 'b2']);
    expect(r[2]!.outside).toBe(true);
    expect(missionStations(list, 'workspace', ['/wt/a'])).toHaveLength(4);
  });
  it('cardAgent: mode, worktree, elapsed in the state, and the activity or last result', () => {
    vi.useFakeTimers(); vi.setSystemTime(10 * 60_000);
    try {
      expect(cardAgent(st({ name: 'codex-2', mode: 'codex', worktreeName: 'Strado_Mcp', lifecycle: 'working', activity: { text: 'Bash: npm test', at: 7 * 60_000 } }))).toEqual({
        agentId: 'claude-1@app', name: 'codex-2', mode: 'codex', worktree: 'Strado_Mcp', state: 'working', word: 'working', elapsed: '3m', detail: 'Bash: npm test', calls: [],
      });
      expect(cardAgent(st({ lastResult: { text: 'All tests pass.', at: 8 * 60_000 } }))).toMatchObject({ state: 'idle', elapsed: '2m', detail: 'done: All tests pass.' });
      expect(cardAgent(st())).toMatchObject({ elapsed: null, detail: null, calls: [] });
      // Needs you because of a call: the call says why.
      expect(cardAgent(st({ calls: [{ id: 'e1', title: 'Status: idle. Looked up mohan', body: '', createdAt: 1 }] })))
        .toMatchObject({ state: 'needs_you', detail: 'asks: Status: idle. Looked up mohan', calls: [{ id: 'e1', title: 'Status: idle. Looked up mohan' }] });
    } finally { vi.useRealTimers(); }
  });
  it('cardAgent for a shell: the running command when known, else nothing (never "done: …")', () => {
    expect(cardAgent(st({ mode: 'shell', lifecycle: 'working', activity: { text: 'npm test', at: 1 } }))).toMatchObject({ mode: 'shell', detail: 'npm test' });
    expect(cardAgent(st({ mode: 'shell', lifecycle: 'idle', lastResult: { text: 'ok', at: 1 } }))).toMatchObject({ mode: 'shell', state: 'idle', detail: null });
  });
  it('pendingApprovals: every scoped station\'s, oldest first, with the agent named', () => {
    const r = pendingApprovals([st({ agentId: 'c@x', name: 'codex-2', approvals: [ap('2', 20)] }), st({ agentId: 'p@x', alias: 'pi', approvals: [ap('1', 10), ap('3', 30)] }), st()]);
    expect(r.map((a) => [a.id, a.agentName, a.agentId])).toEqual([['1', 'pi', 'p@x'], ['2', 'codex-2', 'c@x'], ['3', 'pi', 'p@x']]);
  });
  it('decideApproval: ok, or "gone" when the tab answered first; other errors throw', async () => {
    const answer = vi.fn(async () => ({ ok: true as const }));
    expect(await decideApproval(answer, 'w1', 'a', 'allow')).toBe('ok');
    expect(answer).toHaveBeenCalledWith('w1', 'a', 'allow');
    const gone = Object.assign(new Error('gone'), { code: 'gone', details: { reason: 'gone' } });
    expect(await decideApproval(async () => { throw gone; }, 'w1', 'a', 'deny')).toBe('gone');
    await expect(decideApproval(async () => { throw new Error('down'); }, 'w1', 'a', 'deny')).rejects.toThrow('down');
  });
});
