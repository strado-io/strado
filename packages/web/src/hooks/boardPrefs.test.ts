import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BOARD_PREFS, readBoardPrefs, useBoardPrefs } from './boardPrefs';

beforeEach(() => localStorage.clear());

describe('useBoardPrefs', () => {
  it('starts from the defaults: grouped by state, sorted by activity, no tile', () => {
    const { result } = renderHook(() => useBoardPrefs('ws1'));
    expect(result.current[0]).toEqual(DEFAULT_BOARD_PREFS);
    expect(DEFAULT_BOARD_PREFS).toEqual({ groupBy: 'state', sort: 'activity', tile: null, collapsed: [] });
  });

  it('patches persist per workspace', () => {
    const { result } = renderHook(() => useBoardPrefs('ws1'));
    act(() => result.current[1]({ groupBy: 'repo', collapsed: ['repo:r1'] }));
    expect(readBoardPrefs('ws1')).toMatchObject({ groupBy: 'repo', sort: 'activity', collapsed: ['repo:r1'] });
    expect(readBoardPrefs('ws2')).toEqual(DEFAULT_BOARD_PREFS);
  });

  it('ignores garbage and unknown values in storage', () => {
    localStorage.setItem('strado.board.ws1', '{not json');
    expect(readBoardPrefs('ws1')).toEqual(DEFAULT_BOARD_PREFS);
    localStorage.setItem('strado.board.ws1', JSON.stringify({ groupBy: 'colour', sort: 'ticket', tile: 'bogus', collapsed: 'x' }));
    expect(readBoardPrefs('ws1')).toEqual({ ...DEFAULT_BOARD_PREFS, sort: 'ticket' });
  });

  it('never writes stale prefs under a new workspace key on wsId switch', () => {
    // Seed ws2 with known values
    localStorage.setItem('strado.board.ws2', JSON.stringify({ groupBy: 'repo', sort: 'ticket', tile: null, collapsed: [] }));

    // Render hook with ws1
    const { result, rerender } = renderHook((props: { wsId: string }) => useBoardPrefs(props.wsId), {
      initialProps: { wsId: 'ws1' },
    });

    // Patch ws1 to change groupBy
    act(() => result.current[1]({ groupBy: 'none' }));
    expect(result.current[0].groupBy).toBe('none');

    // Switch to ws2 and verify its stored value was never overwritten
    rerender({ wsId: 'ws2' });
    expect(result.current[0].groupBy).toBe('repo');
    expect(readBoardPrefs('ws2').groupBy).toBe('repo');
  });
});
