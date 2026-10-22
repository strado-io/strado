import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationDto } from '../../api';
import { activityLine, lightOf, readStationScope, scopeStations, sortStations, splitStations, stateOf, stateWord, statusText, writeStationScope, type StationState } from './stations';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
});
const call = { id: 'e1', title: 'Which DB?', body: '', createdAt: 1 };

describe('lightOf / statusText', () => {
  it('a call to you outranks everything; offline next; then working; else idle', () => {
    expect(lightOf(st({ calls: [call], lifecycle: 'working' }))).toBe('calling');
    expect(lightOf(st({ calls: [call], live: false }))).toBe('calling');
    expect(lightOf(st({ live: false, lifecycle: 'working' }))).toBe('offline');
    expect(lightOf(st({ lifecycle: 'working' }))).toBe('working');
    expect(lightOf(st({ lifecycle: 'needs_input', needsYou: true }))).toBe('calling'); // a permission prompt is a call too
    expect(lightOf(st({ lifecycle: 'starting' }))).toBe('idle');
  });

  it('plain words, no jargon', () => {
    expect(statusText('calling')).toBe('calling you');
    expect(statusText('working')).toBe('working');
    expect(statusText('idle')).toBe('idle');
    expect(statusText('offline')).toBe('offline');
  });
});

describe('splitStations', () => {
  it('this worktree gets lights (callers first, then by tab order); the rest is a count, flagged if any of them calls', () => {
    const here = [st({ agentId: 'shell-2@app', name: 'shell-2', mode: 'shell', sessionId: '2' }), st({ agentId: 'claude-1@app', sessionId: '1' }), st({ agentId: 'claude-2@app', name: 'claude-2', sessionId: '2', calls: [call] })];
    const away = [st({ agentId: 'claude-1@api', worktreePath: '/wt/b', worktreeName: 'b' }), st({ agentId: 'codex-1@api', worktreePath: '/wt/b', worktreeName: 'b', calls: [call] })];
    const r = splitStations([...here, ...away], '/wt/a');
    expect(r.here.map((s) => s.agentId)).toEqual(['claude-2@app', 'claude-1@app', 'shell-2@app']);
    expect(r.others).toBe(2);
    expect(r.othersCalling).toBe(1);
  });

  it('no current worktree (the board): everything is "others"', () => {
    const r = splitStations([st()], null);
    expect(r.here).toEqual([]);
    expect(r.others).toBe(1);
  });
});

// Mission Control: one state per station, its live line, the order and the scope.
const approval = { id: 'a1', kind: 'command' as const, title: 'Run npm test', detail: 'npm test', createdAt: 1 };

describe('stateOf / stateWord', () => {
  it('needs you (a call, a pending approval, or the server says so) outranks offline and working', () => {
    expect(stateOf(st({ calls: [call], live: false }))).toBe('needs_you');
    expect(stateOf(st({ approvals: [approval], lifecycle: 'working' }))).toBe('needs_you');
    expect(stateOf(st({ needsYou: true }))).toBe('needs_you');
    expect(stateOf(st({ live: false, lifecycle: 'working' }))).toBe('offline');
    expect(stateOf(st({ lifecycle: 'working' }))).toBe('working');
    expect(stateOf(st({ lifecycle: 'starting' }))).toBe('idle');
    expect(stateOf(st({ approvals: [] }))).toBe('idle');
  });
  it('plain words', () => {
    expect(['needs_you', 'failed', 'limited', 'working', 'idle', 'offline'].map((s) => stateWord(s as StationState)))
      .toEqual(['needs you', 'failed', 'limited', 'working', 'idle', 'offline']);
  });
});

describe('activityLine', () => {
  const result = { text: 'All 12 tests pass.\nI also fixed the lint.', at: 2 };
  it('while working: the live tool line', () => {
    expect(activityLine(st({ lifecycle: 'working', activity: { text: 'Bash: npm test', at: 1 }, lastResult: result }))).toBe('Bash: npm test');
  });
  it('working with no tool line yet: nothing (not the last turn\'s result)', () => {
    expect(activityLine(st({ lifecycle: 'working', activity: null, lastResult: result }))).toBe('');
  });
  it('otherwise: "done:" and the first line of the last result', () => {
    expect(activityLine(st({ lastResult: result, activity: { text: 'Edit: a.ts', at: 1 } }))).toBe('done: All 12 tests pass.');
    expect(activityLine(st({ lastResult: { text: '\n\n  Shipped.  \nmore', at: 1 } }))).toBe('done: Shipped.');
  });
  it('nothing known (or an older server without the fields): empty', () => {
    expect(activityLine(st())).toBe('');
    expect(activityLine(st({ activity: null, lastResult: null }))).toBe('');
    expect(activityLine(st({ lastResult: { text: '   ', at: 1 } }))).toBe('');
  });
});

describe('sortStations', () => {
  it('worktree, then tab order: the state never moves an agent; does not touch the input', () => {
    const input = [
      st({ agentId: 'off', live: false }),
      st({ agentId: 'idle-b', worktreePath: '/wt/b', worktreeName: 'b' }),
      st({ agentId: 'idle-a2', mode: 'codex' }),
      st({ agentId: 'idle-a1' }),
      st({ agentId: 'work', lifecycle: 'working' }),
      st({ agentId: 'ask', approvals: [approval] }),
    ];
    const copy = [...input];
    const order = sortStations(input).map((s) => s.agentId);
    expect(order.at(-1)).toBe('idle-b'); // worktree b after a, whatever the states
    expect(order.indexOf('idle-a2')).toBeGreaterThan(order.indexOf('idle-a1')); // codex after claude in a's tab order
    // Changing a state keeps the order.
    const asked = input.map((s) => (s.agentId === 'idle-a1' ? { ...s, approvals: [approval] } : s));
    expect(sortStations(asked).map((s) => s.agentId)).toEqual(order);
    expect(input).toEqual(copy);
  });
});

describe('scopeStations', () => {
  const a1 = st({ agentId: 'a1' });
  const b1 = st({ agentId: 'b1', worktreePath: '/wt/b', worktreeName: 'b' });
  const b2 = st({ agentId: 'b2', worktreePath: '/wt/b', worktreeName: 'b', approvals: [approval] });
  const c1 = st({ agentId: 'c1', worktreePath: '/wt/c', worktreeName: 'c', calls: [call] });
  const all = [a1, b1, b2, c1];

  it('focus scope: the Focus\'s worktrees, plus anyone outside it who needs you, flagged outside', () => {
    const r = scopeStations(all, { scope: 'focus', focusWorktrees: ['/wt/a'] });
    expect(r.map((s) => s.agentId)).toEqual(['a1', 'b2', 'c1']);
    expect(r.map((s) => s.outside ?? false)).toEqual([false, true, true]);
    expect(r[1]).toMatchObject({ outside: true, worktreeName: 'b' });
  });
  it('a needs-you station inside the Focus is not flagged', () => {
    expect(scopeStations(all, { scope: 'focus', focusWorktrees: ['/wt/b'] }).map((s) => [s.agentId, s.outside ?? false]))
      .toEqual([['b1', false], ['b2', false], ['c1', true]]);
  });
  it('workspace scope, or no active Focus: everything, nothing flagged', () => {
    for (const r of [scopeStations(all, { scope: 'workspace', focusWorktrees: ['/wt/a'] }), scopeStations(all, { scope: 'focus', focusWorktrees: null })]) {
      expect(r.map((s) => s.agentId)).toEqual(['a1', 'b1', 'b2', 'c1']);
      expect(r.some((s) => s.outside)).toBe(false);
    }
  });
});

describe('station scope, remembered per workspace', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to focus; each workspace keeps its own choice', () => {
    expect(readStationScope('w1')).toBe('focus');
    writeStationScope('w1', 'workspace');
    expect(readStationScope('w1')).toBe('workspace');
    expect(readStationScope('w2')).toBe('focus');
  });
  it('a junk value, or storage that throws, falls back to focus', () => {
    localStorage.setItem('strado:station-scope:w1', 'everything');
    expect(readStationScope('w1')).toBe('focus');
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readStationScope('w1')).toBe('focus');
    expect(() => writeStationScope('w1', 'workspace')).not.toThrow();
    get.mockRestore(); set.mockRestore();
  });
});
