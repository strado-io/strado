import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFocusPrefs } from './focusPrefs';

beforeEach(() => localStorage.clear());

describe('useFocusPrefs', () => {
  it('stores the active group and collapse per workspace', () => {
    const a = renderHook(() => useFocusPrefs('w1'));
    const b = renderHook(() => useFocusPrefs('w2'));
    act(() => a.result.current.setActiveFocusGroupId('g1'));
    act(() => a.result.current.setFocusCollapsed(true));
    expect(a.result.current.activeFocusGroupId).toBe('g1');
    expect(a.result.current.focusCollapsed).toBe(true);
    expect(b.result.current.activeFocusGroupId).toBeNull();
    expect(b.result.current.focusCollapsed).toBe(false);
    act(() => a.result.current.setActiveFocusGroupId(null));
    expect(a.result.current.activeFocusGroupId).toBeNull();
  });

  it('keeps every instance for a workspace in sync', () => {
    const a = renderHook(() => useFocusPrefs('w1'));
    const b = renderHook(() => useFocusPrefs('w1'));
    act(() => a.result.current.setActiveFocusGroupId('g2'));
    expect(b.result.current.activeFocusGroupId).toBe('g2');
  });

  it('ignores garbage in storage', () => {
    localStorage.setItem('strado:focus-group-active', '{not json');
    expect(renderHook(() => useFocusPrefs('w1')).result.current.activeFocusGroupId).toBeNull();
  });
});
