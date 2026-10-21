import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoice, VOICE_FINAL_WAIT_MS, type VoiceBridge } from './voice';

function fakeBridge(available: VoiceBridge['available'] = true) {
  let listener: ((e: StradoVoiceEvent) => void) | null = null;
  const bridge = {
    available,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: (cb: (e: StradoVoiceEvent) => void) => { listener = cb; return () => { listener = null; }; },
  };
  const emit = (e: StradoVoiceEvent) => act(() => { listener?.(e); });
  return { bridge, emit };
}

function setup(bridge: VoiceBridge | null) {
  const on = { partial: vi.fn(), final: vi.fn(), cancel: vi.fn() };
  const view = renderHook(() => useVoice({ bridge, contextual: () => ['claude-1', 'FD-9'], onPartial: on.partial, onFinal: on.final, onCancel: on.cancel }));
  return { ...on, view, v: () => view.result.current };
}

afterEach(() => { vi.useRealTimers(); });

describe('useVoice (push-to-talk)', () => {
  it('no bridge (a browser, the web hub): not available, and start does nothing', () => {
    const s = setup(null);
    expect(s.v().available).toBe(false);
    act(() => s.v().start());
    expect(s.v().phase).toBe('idle');
  });

  it('available may be a flag or a function (sync or async)', async () => {
    expect(setup(fakeBridge(true).bridge).v().available).toBe(true);
    const s = setup(fakeBridge(async () => false).bridge);
    await act(async () => {});
    expect(s.v().available).toBe(false);
  });

  it('start primes the names; partials and the level stream while listening; release waits for the final, which is submitted', async () => {
    const { bridge, emit } = fakeBridge();
    const s = setup(bridge);
    act(() => s.v().start());
    expect(bridge.start).toHaveBeenCalledWith(['claude-1', 'FD-9']);
    expect(s.v().phase).toBe('listening');
    emit({ type: 'partial', text: 'open' });
    emit({ type: 'level', rms: 0.4 });
    emit({ type: 'partial', text: 'open master' });
    expect(s.partial).toHaveBeenLastCalledWith('open master');
    expect(s.v().level).toBe(0.4);
    act(() => s.v().stop());
    expect(bridge.stop).toHaveBeenCalled();
    expect(s.v().phase).toBe('finishing');
    emit({ type: 'final', text: 'open master and run dev' });
    expect(s.final).toHaveBeenCalledWith('open master and run dev');
    expect(s.v().phase).toBe('idle');
  });

  it('a partial\'s committed prefix (stable, from ElevenLabs) comes through with it; Apple\'s partials have none', () => {
    const { bridge, emit } = fakeBridge();
    const s = setup(bridge);
    act(() => s.v().start());
    emit({ type: 'partial', text: 'open master and', stable: 'open master' });
    expect(s.partial).toHaveBeenLastCalledWith('open master and', 'open master');
    emit({ type: 'partial', text: 'open master and run' });
    expect(s.partial).toHaveBeenLastCalledWith('open master and run');
  });

  it('no final within the wait: the last partial is used', () => {
    vi.useFakeTimers();
    const { bridge, emit } = fakeBridge();
    const s = setup(bridge);
    act(() => s.v().start());
    emit({ type: 'partial', text: 'close the shell' });
    act(() => s.v().stop());
    act(() => { vi.advanceTimersByTime(VOICE_FINAL_WAIT_MS); });
    expect(s.final).toHaveBeenCalledWith('close the shell');
    emit({ type: 'final', text: 'late' }); // too late: nothing more
    expect(s.final).toHaveBeenCalledTimes(1);
  });

  it('nothing heard: no submit', () => {
    const { bridge, emit } = fakeBridge();
    const s = setup(bridge);
    act(() => s.v().start());
    act(() => s.v().stop());
    emit({ type: 'final', text: '  ' });
    expect(s.final).not.toHaveBeenCalled();
    expect(s.v().phase).toBe('idle');
  });

  it('cancel stops the helper, restores, and ignores what comes after', () => {
    const { bridge, emit } = fakeBridge();
    const s = setup(bridge);
    act(() => s.v().start());
    emit({ type: 'partial', text: 'oops' });
    act(() => s.v().cancel());
    expect(bridge.cancel).toHaveBeenCalled();
    expect(s.cancel).toHaveBeenCalled();
    emit({ type: 'final', text: 'oops' });
    expect(s.final).not.toHaveBeenCalled();
    expect(s.v().phase).toBe('idle');
  });

  it('a permission error is shown (with which permission); unavailable hides the mic for good', () => {
    const { bridge, emit } = fakeBridge();
    const s = setup(bridge);
    act(() => s.v().start());
    emit({ type: 'error', code: 'mic_denied', message: 'denied' });
    expect(s.v()).toMatchObject({ phase: 'error', error: { code: 'mic_denied' } });
    act(() => s.v().start()); // trying again is allowed
    expect(s.v().phase).toBe('listening');
    emit({ type: 'error', code: 'no_on_device' });
    expect(s.v().available).toBe(false);
  });
});
