import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { createElevenLabsBridge, type ElevenLabsDeps } from '../lib/voice/elevenlabs';
import { VOICE_ENGINE_EVENT, type VoiceBridge } from './voice';

// Which speech engine the command box listens with. ElevenLabs Scribe v2
// Realtime when an ElevenLabs key is saved and Local only is off (audio goes to
// ElevenLabs); otherwise the desktop app's on-device Apple engine. Settings
// signals a change (VOICE_ENGINE_EVENT) and this re-checks.

/** ElevenLabs can't work right now (key refused, no token, out of quota): Apple, for the rest of this session. */
const FALLBACK_CODES = new Set(['auth', 'token', 'quota']);
let fellBack = false;
export function __resetVoiceEngine() { fellBack = false; }

/** The browser pieces ElevenLabs needs; null where there is no microphone API. */
function browserDeps(): ElevenLabsDeps | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  if (typeof WebSocket === 'undefined' || typeof AudioContext === 'undefined') return null;
  return {
    getToken: () => api.voice.elevenlabsToken().then((r) => r.token),
    WebSocket,
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    AudioContext,
    ...(typeof AudioWorkletNode !== 'undefined' ? { AudioWorkletNode } : {}),
  };
}

export function useVoiceEngine(apple: VoiceBridge | null): VoiceBridge | null {
  const [wantEleven, setWantEleven] = useState(false);
  const [fallback, setFallback] = useState(fellBack);

  useEffect(() => {
    let alive = true;
    const check = () => {
      // Through a .then: a synchronous throw (no such API here) lands in the catch too.
      Promise.resolve().then(() => Promise.all([api.voiceCredential.get(), api.profile.get()]))
        .then(([cred, profile]) => { if (alive) setWantEleven(!!cred.present && !profile.jarvisLocalOnly); })
        .catch(() => { if (alive) setWantEleven(false); });
    };
    check();
    window.addEventListener(VOICE_ENGINE_EVENT, check);
    return () => { alive = false; window.removeEventListener(VOICE_ENGINE_EVENT, check); };
  }, []);

  const eleven = useMemo((): VoiceBridge | null => {
    if (!wantEleven) return null;
    const deps = browserDeps();
    if (!deps) return null;
    const bridge = createElevenLabsBridge(deps);
    return {
      ...bridge,
      // The box still gets the error (it shows it); then Apple takes over, if there is one.
      onEvent: (cb) => bridge.onEvent((e) => {
        cb(e);
        if (e.type === 'error' && FALLBACK_CODES.has(e.code) && apple) { fellBack = true; setFallback(true); }
      }),
    };
  }, [wantEleven, apple]);

  return eleven && !(fallback && apple) ? eleven : apple;
}
