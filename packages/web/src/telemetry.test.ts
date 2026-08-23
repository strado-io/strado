import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTelemetry, track, _resetTelemetry } from './telemetry';

afterEach(() => {
  _resetTelemetry();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('telemetry', () => {
  it('is a no-op before init and when disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    track('app_launched');
    initTelemetry({ apiUrl: 'https://api.test', token: 't'.repeat(64), enabled: false });
    track('app_launched');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('batches events and flushes on the interval', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    initTelemetry({ apiUrl: 'https://api.test/', token: 't'.repeat(64), enabled: true });
    track('hub_opened', { tab: 'browser' });
    track('palette_used');
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/events');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.token).toBe('t'.repeat(64));
    expect(body.events.map((e: { name: string }) => e.name)).toEqual(['hub_opened', 'palette_used']);
    expect(body.events[0].ts).toBeTruthy();
  });

  it('flushes early once the batch limit is reached', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    initTelemetry({ apiUrl: 'https://api.test', token: 't'.repeat(64), enabled: true });
    for (let i = 0; i < 20; i++) track('switcher_used');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
