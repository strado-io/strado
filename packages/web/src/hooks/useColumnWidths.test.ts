import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useColumnWidths } from './useColumnWidths';

beforeEach(() => localStorage.clear());

describe('useColumnWidths', () => {
  it('uses minmax for the branch column in the template', () => {
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.gridTemplate).toBe('110px 90px 130px minmax(300px, 1fr) 110px 88px');
  });

  it('exposes totalWidth as the sum of all column widths', () => {
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.totalWidth).toBe(110 + 130 + 300 + 110 + 90 + 88); // 828
  });

  it('ignores stored widths for columns that no longer exist', () => {
    localStorage.setItem('strado:column-widths', JSON.stringify({ ticket: 150, link: 400, actions: 500 }));
    const { result } = renderHook(() => useColumnWidths());
    expect(result.current.gridTemplate).toBe('150px 90px 130px minmax(300px, 1fr) 110px 88px');
  });
});
