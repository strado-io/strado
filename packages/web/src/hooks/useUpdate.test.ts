import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUpdate } from './useUpdate';
import { api } from '../api';

afterEach(() => { vi.restoreAllMocks(); (window as any).strado = undefined; });

const avail = { updateAvailable: true, current: '0.1.0', version: '0.2.0', url: 'u', sha256: 's', mandatory: false };

describe('useUpdate', () => {
  it('surfaces an available update from the check', async () => {
    vi.spyOn(api.update, 'check').mockResolvedValue(avail);
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.phase).toBe('available'));
    expect(result.current.info?.version).toBe('0.2.0');
  });

  it('drives download → ready via bridge events', async () => {
    vi.spyOn(api.update, 'check').mockResolvedValue(avail);
    let emit: (e: any) => void = () => {};
    (window as any).strado = {
      platform: 'darwin',
      update: vi.fn().mockResolvedValue({ ok: true }),
      onUpdateEvent: (cb: any) => { emit = cb; return () => {}; },
    };
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.phase).toBe('available'));
    act(() => { result.current.startDownload(); });
    expect((window as any).strado.update).toHaveBeenCalledWith('download', { url: 'u', sha256: 's' });
    act(() => emit({ type: 'progress', pct: 50 }));
    expect(result.current.phase).toBe('downloading');
    expect(result.current.progress).toBe(50);
    act(() => emit({ type: 'ready', version: '0.2.0' }));
    expect(result.current.phase).toBe('ready');
  });

  it('stays idle when no update is available', async () => {
    vi.spyOn(api.update, 'check').mockResolvedValue({ updateAvailable: false });
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(api.update.check).toHaveBeenCalled());
    expect(result.current.phase).toBe('idle');
  });

  it('polls when the shell reports updateMode swap (linux AppImage)', async () => {
    const check = vi.spyOn(api.update, 'check').mockResolvedValue(avail);
    (window as any).strado = { platform: 'linux', updateMode: 'swap' };
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.phase).toBe('available'));
    expect(check).toHaveBeenCalled();
    expect(result.current.mode).toBe('swap');
  });

  it('link mode opens the deb url instead of downloading', async () => {
    vi.spyOn(api.update, 'check').mockResolvedValue({ ...avail, debUrl: 'https://dl/deb' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const update = vi.fn();
    (window as any).strado = { platform: 'linux', updateMode: 'link', update };
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.phase).toBe('available'));
    expect(result.current.mode).toBe('link');
    act(() => { result.current.startDownload(); });
    expect(open).toHaveBeenCalledWith('https://dl/deb', '_blank');
    expect(update).not.toHaveBeenCalled();
  });

  it('link mode falls back to the main url without a debUrl', async () => {
    vi.spyOn(api.update, 'check').mockResolvedValue(avail);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    (window as any).strado = { platform: 'linux', updateMode: 'link' };
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.phase).toBe('available'));
    act(() => { result.current.startDownload(); });
    expect(open).toHaveBeenCalledWith('u', '_blank');
  });

  it('legacy non-darwin shells (no updateMode) never poll', async () => {
    const check = vi.spyOn(api.update, 'check').mockResolvedValue(avail);
    (window as any).strado = { platform: 'linux' };
    const { result } = renderHook(() => useUpdate());
    // give the mount effect a tick; it must not poll or leave idle
    await new Promise((r) => setTimeout(r, 20));
    expect(check).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
    expect(result.current.info).toBeNull();
  });
});
