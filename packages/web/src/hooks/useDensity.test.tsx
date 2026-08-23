import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDensity } from './useDensity';

beforeEach(() => localStorage.clear());

describe('useDensity', () => {
  it('defaults to comfy', () => {
    const { result } = renderHook(() => useDensity());
    expect(result.current[0]).toBe('comfy');
  });

  it('persists changes to localStorage', () => {
    const { result } = renderHook(() => useDensity());
    act(() => result.current[1]('compact'));
    expect(result.current[0]).toBe('compact');
    expect(localStorage.getItem('strado:density')).toBe('compact');
  });

  it('reads an existing stored value', () => {
    localStorage.setItem('strado:density', 'compact');
    const { result } = renderHook(() => useDensity());
    expect(result.current[0]).toBe('compact');
  });
});
