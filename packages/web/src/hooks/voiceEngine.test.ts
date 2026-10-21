import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cred: { present: true, last4: 'k9Z2' } as { present: boolean; last4: string | null },
  localOnly: false,
  made: 0,
  deps: null as unknown,
  listener: null as null | ((e: StradoVoiceEvent) => void),
}));
vi.mock('../api', () => ({
  api: {
    voiceCredential: { get: vi.fn(async () => h.cred) },
    profile: { get: vi.fn(async () => ({ jarvisLocalOnly: h.localOnly })) },
    voice: { elevenlabsToken: vi.fn(async () => ({ token: 'tok' })) },
  },
}));
vi.mock('../lib/voice/elevenlabs', () => ({
  createElevenLabsBridge: (deps: unknown) => {
    h.made += 1;
    h.deps = deps;
    return {
      available: true, kind: 'elevenlabs',
      start: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
      onEvent: (cb: (e: StradoVoiceEvent) => void) => { h.listener = cb; return () => { h.listener = null; }; },
    };
  },
}));

import { __resetVoiceEngine, useVoiceEngine } from './voiceEngine';
import { voiceEngineChanged, type VoiceBridge } from './voice';

const apple = { available: true, kind: 'apple', start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), onEvent: () => () => {} } as unknown as VoiceBridge;
const kindOf = (b: VoiceBridge | null) => (b as unknown as { kind?: string } | null)?.kind ?? null;

beforeEach(() => {
  __resetVoiceEngine();
  h.cred = { present: true, last4: 'k9Z2' }; h.localOnly = false; h.made = 0; h.deps = null; h.listener = null;
  (navigator as unknown as { mediaDevices?: unknown }).mediaDevices = { getUserMedia: vi.fn() };
  (globalThis as unknown as { AudioContext?: unknown }).AudioContext = class {};
});
afterEach(() => {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('which speech engine the box uses', () => {
  it('an ElevenLabs key saved and Local only off: ElevenLabs (its token comes from our server)', async () => {
    const { result } = renderHook(() => useVoiceEngine(apple));
    await waitFor(() => expect(kindOf(result.current)).toBe('elevenlabs'));
    await expect((h.deps as { getToken: () => Promise<string> }).getToken()).resolves.toBe('tok');
  });

  it('no key: Apple, on-device', async () => {
    h.cred = { present: false, last4: null };
    const { result } = renderHook(() => useVoiceEngine(apple));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(kindOf(result.current)).toBe('apple');
    expect(h.made).toBe(0);
  });

  it('Local only on: Apple, even with a key', async () => {
    h.localOnly = true;
    const { result } = renderHook(() => useVoiceEngine(apple));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(kindOf(result.current)).toBe('apple');
  });

  it('the key saved later (Settings says so): it switches to ElevenLabs; removed again: back to Apple', async () => {
    h.cred = { present: false, last4: null };
    const { result } = renderHook(() => useVoiceEngine(apple));
    await act(async () => { await Promise.resolve(); });
    expect(kindOf(result.current)).toBe('apple');
    h.cred = { present: true, last4: 'k9Z2' };
    act(() => voiceEngineChanged());
    await waitFor(() => expect(kindOf(result.current)).toBe('elevenlabs'));
    h.cred = { present: false, last4: null };
    act(() => voiceEngineChanged());
    await waitFor(() => expect(kindOf(result.current)).toBe('apple'));
  });

  it('works without the desktop helper: with no Apple engine, ElevenLabs is the mic (getUserMedia is enough)', async () => {
    const { result } = renderHook(() => useVoiceEngine(null));
    await waitFor(() => expect(kindOf(result.current)).toBe('elevenlabs'));
  });

  it('no microphone API at all: no ElevenLabs engine', async () => {
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    const { result } = renderHook(() => useVoiceEngine(null));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toBeNull();
  });

  for (const code of ['auth', 'token', 'quota']) {
    it(`an ElevenLabs "${code}" error: the box still gets the error, then Apple takes over for the rest of the session`, async () => {
      const { result, unmount } = renderHook(() => useVoiceEngine(apple));
      await waitFor(() => expect(kindOf(result.current)).toBe('elevenlabs'));
      const seen: StradoVoiceEvent[] = [];
      result.current!.onEvent((e) => seen.push(e));
      act(() => { h.listener?.({ type: 'error', code, message: 'Your ElevenLabs key was refused' }); });
      expect(seen).toEqual([{ type: 'error', code, message: 'Your ElevenLabs key was refused' }]);
      await waitFor(() => expect(kindOf(result.current)).toBe('apple'));
      unmount();
      const again = renderHook(() => useVoiceEngine(apple));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(kindOf(again.result.current)).toBe('apple');
    });
  }

  it('an ElevenLabs error with no Apple engine to fall back to: it stays (the error shows; a fixed key works next time)', async () => {
    const { result } = renderHook(() => useVoiceEngine(null));
    await waitFor(() => expect(kindOf(result.current)).toBe('elevenlabs'));
    result.current!.onEvent(() => {});
    act(() => { h.listener?.({ type: 'error', code: 'auth' }); });
    await act(async () => { await Promise.resolve(); });
    expect(kindOf(result.current)).toBe('elevenlabs');
  });

  it('a mic or network error is not a reason to switch engines', async () => {
    const { result } = renderHook(() => useVoiceEngine(apple));
    await waitFor(() => expect(kindOf(result.current)).toBe('elevenlabs'));
    result.current!.onEvent(() => {});
    act(() => { h.listener?.({ type: 'error', code: 'mic_denied' }); });
    await act(async () => { await Promise.resolve(); });
    expect(kindOf(result.current)).toBe('elevenlabs');
  });
});
