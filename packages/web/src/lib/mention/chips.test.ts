import { describe, expect, it } from 'vitest';
import type { StationDto } from '../../api';
import { chipEndingAt, chipLabel, chipSegments, insertChip, mentionAt, pruneChips, toRankStation, toWire, type Chip } from './chips';

const c1: Chip = { label: 'claude-1', agentId: 'claude-1@app' };
const c2: Chip = { label: 'opencode-1', agentId: 'opencode-1@api' };

describe('mentionAt', () => {
  it('an @ that starts a word, up to the caret, is a mention being typed', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '', sigil: '@' });
    expect(mentionAt('tell @cl', 8)).toEqual({ start: 5, query: 'cl', sigil: '@' });
    expect(mentionAt('tell @cl and', 8)).toEqual({ start: 5, query: 'cl', sigil: '@' });
  });
  it('a # that starts a word is a worktree being named', () => {
    expect(mentionAt('#', 1)).toEqual({ start: 0, query: '', sigil: '#' });
    expect(mentionAt('open claude in #ap', 18)).toEqual({ start: 15, query: 'ap', sigil: '#' });
    expect(mentionAt('issue#12', 8)).toBeNull();
  });
  it('not a mention: an @ inside a word, a finished word, or text after a space', () => {
    expect(mentionAt('me@host', 7)).toBeNull();
    expect(mentionAt('@cl ', 4)).toBeNull();
    expect(mentionAt('hello', 5)).toBeNull();
  });
});

describe('insertChip', () => {
  it('replaces the @query with @label and a space, caret after it', () => {
    expect(insertChip('tell @cl to run', { start: 5, query: 'cl', sigil: '@' }, 'claude-1')).toEqual({ text: 'tell @claude-1 to run', caret: 15 });
    expect(insertChip('@op', { start: 0, query: 'op', sigil: '@' }, 'opencode-1')).toEqual({ text: '@opencode-1 ', caret: 12 });
    expect(insertChip('run tests in #ap', { start: 13, query: 'ap', sigil: '#' }, 'api')).toEqual({ text: 'run tests in #api ', caret: 18 });
  });
});

describe('toWire / pruneChips / chipEndingAt', () => {
  it('each chip becomes its exact @{agentId}; other @names stay as typed', () => {
    expect(toWire('@claude-1 @opencode-1 run the tests', [c1, c2])).toBe('@{claude-1@app} @{opencode-1@api} run the tests');
    expect(toWire('tell @claude-1 to ping @someone', [c1])).toBe('tell @{claude-1@app} to ping @someone');
  });
  it('only whole tokens: @claude-10 is not the claude-1 chip', () => {
    expect(toWire('@claude-10 hi', [c1])).toBe('@claude-10 hi');
  });
  it('a chip whose text was edited away is dropped', () => {
    expect(pruneChips('@claude-1 hi', [c1, c2])).toEqual([c1]);
    expect(pruneChips('@claude- hi', [c1])).toEqual([]);
  });
  it('the chip right before the caret (for backspace)', () => {
    expect(chipEndingAt('hi @claude-1', 12, [c1])).toEqual({ chip: c1, start: 3 });
    expect(chipEndingAt('hi @claude-1 ', 13, [c1])).toBeNull();
  });
});

describe('toRankStation', () => {
  const dto: StationDto = { agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/wt/a', worktreeName: 'a', sessionId: '1', lifecycle: 'working', live: true, calls: [], lastActivityAt: null };
  it('maps the feed into the ranking shape', () => {
    expect(toRankStation(dto, '/wt/a', { worktreePath: '/wt/a', mode: 'claude', sessionId: '1' })).toEqual({
      agentId: 'claude-1@app', name: 'claude-1', alias: null, worktreeName: 'a', inThisWorktree: true, focused: true, status: 'working', lastActivityAt: 0,
    });
    expect(toRankStation({ ...dto, needsYou: true }, '/wt/b', null)).toMatchObject({ inThisWorktree: false, focused: false, status: 'calling' });
  });
});

describe('chipSegments', () => {
  it('splits the text into plain runs and chip runs (the same tokens toWire replaces)', () => {
    expect(chipSegments('tell @claude-1 and @claude-10 hi', [c1])).toEqual([
      { text: 'tell ' }, { text: '@claude-1', chip: c1 }, { text: ' and @claude-10 hi' },
    ]);
    expect(chipSegments('plain', [])).toEqual([{ text: 'plain' }]);
  });
});

describe('chipLabel', () => {
  const base = { agentId: 'claude-1@api', name: 'claude-1', alias: null, worktreeName: 'api', inThisWorktree: false, focused: false, status: 'idle' as const, lastActivityAt: 0 };
  it('names that read back to the same agent: alias, else name here, else <worktree>/<name>', () => {
    expect(chipLabel({ ...base, inThisWorktree: true })).toBe('claude-1');
    expect(chipLabel(base)).toBe('api/claude-1');
    expect(chipLabel({ ...base, alias: 'reviewer' })).toBe('reviewer');
  });
});

describe('worktree (#) chips', () => {
  const wt: Chip = { label: 'my app', worktreePath: '/wt/my app' };
  const api: Chip = { label: 'api', worktreePath: '/wt/api' };
  it('submitted as #{encoded path}, next to agent chips', () => {
    expect(toWire('#api run the tests with @claude-1', [api, c1])).toBe(`#{${encodeURIComponent('/wt/api')}} run the tests with @{claude-1@app}`);
  });
  it('a # chip and an @ chip with the same label are different tokens', () => {
    const agentApi: Chip = { label: 'api', agentId: 'api@x' };
    expect(toWire('@api #api', [api, agentApi])).toBe(`@{api@x} #{${encodeURIComponent('/wt/api')}}`);
  });
  it('labels may hold spaces (repo/name, a dir name): the whole label is the token', () => {
    expect(toWire('#my app go', [wt])).toBe(`#{${encodeURIComponent('/wt/my app')}} go`);
    expect(chipEndingAt('in #my app', 10, [wt])).toEqual({ chip: wt, start: 3 });
    expect(pruneChips('in #my ap', [wt])).toEqual([]);
    expect(chipSegments('in #api now', [api])).toEqual([{ text: 'in ' }, { text: '#api', chip: api }, { text: ' now' }]);
  });
});
