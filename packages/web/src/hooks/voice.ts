import { useEffect, useRef, useState } from 'react';

// Push-to-talk for the command box (spec: 2026-10-17-strado-voice-design.md).
// The desktop shell's on-device speech helper streams partials while you
// hold; on release the final text is submitted exactly as if typed. Nothing
// starts on its own, and nothing is recorded or stored here.

export type VoiceBridge = NonNullable<NonNullable<Window['strado']>['voice']>;
export type VoicePhase = 'idle' | 'listening' | 'finishing' | 'error';
export type VoiceError = { code: string; message?: string };

/** After release, how long the final may take before the last partial is used. */
export const VOICE_FINAL_WAIT_MS = 1_500;
// The helper cannot work on this Mac at all: hide the mic instead of erroring.
const GONE = new Set(['unavailable', 'no_on_device']);
/** Calls the bridge now; a throw or a rejection both land in `onError`. */
const call = (fn: () => unknown, onError: (err: unknown) => void = () => {}) => {
  try { void Promise.resolve(fn()).catch(onError); } catch (err) { onError(err); }
};

/** The shell's speech bridge, when this window has one (desktop, macOS). */
export const voiceBridge = (): VoiceBridge | null => (typeof window !== 'undefined' ? window.strado?.voice ?? null : null);

export function useVoice({ bridge, contextual, onPartial, onFinal, onCancel, onEmpty, onError }: {
  bridge: VoiceBridge | null;
  /** Names to prime recognition with (tabs, agents, worktrees, Focuses, scripts). */
  contextual: () => string[];
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onCancel: () => void;
  /** Released with nothing heard: no submit. */
  onEmpty?: () => void;
  /** The session ended in an error (permission, the helper gone): nothing will be submitted. */
  onError?: () => void;
}) {
  const [available, setAvailable] = useState(() => !!bridge && bridge.available === true);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<VoiceError | null>(null);
  const phaseRef = useRef<VoicePhase>('idle');
  const lastPartial = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef({ onPartial, onFinal, onCancel, onEmpty, onError, contextual });
  cb.current = { onPartial, onFinal, onCancel, onEmpty, onError, contextual };

  const go = (p: VoicePhase) => { phaseRef.current = p; setPhase(p); };
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const finish = (text: string) => {
    clearTimer();
    go('idle');
    setLevel(0);
    if (text.trim()) cb.current.onFinal(text.trim());
    else cb.current.onEmpty?.();
  };

  useEffect(() => {
    if (!bridge) { setAvailable(false); return; }
    let alive = true;
    const a = bridge.available;
    if (typeof a === 'function') {
      Promise.resolve().then(() => a()).then((ok) => { if (alive) setAvailable(!!ok); }).catch(() => { if (alive) setAvailable(false); });
    } else {
      setAvailable(!!a);
    }
    const off = bridge.onEvent((e) => {
      const p = phaseRef.current;
      if (p !== 'listening' && p !== 'finishing') return; // cancelled, or not ours
      if (e.type === 'partial') { lastPartial.current = e.text; cb.current.onPartial(e.text); }
      else if (e.type === 'level') setLevel(e.rms);
      else if (e.type === 'final') finish(e.text);
      else if (e.type === 'error') {
        clearTimer();
        setLevel(0);
        cb.current.onError?.();
        if (GONE.has(e.code)) { setAvailable(false); go('idle'); return; }
        setError({ code: e.code, ...(e.message ? { message: e.message } : {}) });
        go('error');
      }
    });
    return () => { alive = false; off(); clearTimer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const start = () => {
    if (!bridge || !available) return;
    if (phaseRef.current === 'listening' || phaseRef.current === 'finishing') return;
    setError(null);
    lastPartial.current = '';
    setLevel(0);
    go('listening');
    call(() => bridge.start(cb.current.contextual()), (err) => {
      setError({ code: 'failed', message: (err as Error)?.message });
      go('error');
    });
  };
  const stop = () => {
    if (!bridge || phaseRef.current !== 'listening') return;
    go('finishing');
    call(() => bridge.stop());
    clearTimer();
    timer.current = setTimeout(() => { if (phaseRef.current === 'finishing') finish(lastPartial.current); }, VOICE_FINAL_WAIT_MS);
  };
  const cancel = () => {
    if (!bridge || (phaseRef.current !== 'listening' && phaseRef.current !== 'finishing')) return;
    clearTimer();
    go('idle');
    setLevel(0);
    call(() => bridge.cancel());
    cb.current.onCancel();
  };
  const dismissError = () => { setError(null); if (phaseRef.current === 'error') go('idle'); };

  return { available, phase, level, error, start, stop, cancel, dismissError };
}
