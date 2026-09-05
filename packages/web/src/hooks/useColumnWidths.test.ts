import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useColumnWidths } from './useColumnWidths';

beforeEach(() => localStorage.clear());

describe('useColumnWidths', () => {
  it('uses minmax for the branch column in the template', () => {
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.gridTemplate).toBe('96px 76px 130px minmax(300px, 1fr) 96px 110px 88px');
  });

  it('exposes totalWidth as the sum of all column widths', () => {
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.totalWidth).toBe(96 + 130 + 300 + 96 + 110 + 76 + 88); // 896
  });

  it('ignores stored widths for columns that no longer exist', () => {
    localStorage.setItem('strado:column-widths', JSON.stringify({ ticket: 150, link: 400, actions: 500 }));
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.gridTemplate).toBe('150px 76px 130px minmax(300px, 1fr) 96px 110px 88px');
  });
});
