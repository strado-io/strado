import { describe, expect, it } from 'vitest';
import type { StationDto } from '../../api';
import { lightOf, splitStations, statusText } from './stations';

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
