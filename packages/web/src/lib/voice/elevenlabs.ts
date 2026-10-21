import type { VoiceBridge } from '../../hooks/voice';

// ElevenLabs Scribe v2 Realtime as a VoiceBridge: the same shape (and events)
// as the desktop app's on-device engine, so the hook can't tell them apart.
// The mic goes through an AudioWorklet, down to 16 kHz PCM16, ~100 ms a chunk;
// the key never reaches the page, only a single-use token from our server.

type VoiceEvent = Parameters<Parameters<VoiceBridge['onEvent']>[0]>[0];

export type ElevenLabsDeps = {
  /** POST /api/voice/elevenlabs-token; rejects with the server's message. */
  getToken: () => Promise<string>;
  /** The rest default to the browser's own (injected in tests). */
  WebSocket?: new (url: string) => WebSocket;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContext?: new () => AudioContext;
  AudioWorkletNode?: new (ctx: AudioContext, name: string, opts?: AudioWorkletNodeOptions) => AudioWorkletNode;
};

const URL_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const RATE = 16_000;
/** Samples per chunk sent (100 ms) and per level event (50 ms: ~20 a second). */
const CHUNK = RATE / 10;
const LEVEL = RATE / 20;
const KEYTERMS_MAX = 50;
/** ElevenLabs refuses the whole session over one longer keyterm ("Each keyterm must be at most 20 characters"). */
const KEYTERM_LEN_MAX = 20;
/** After stop, how long to wait for the last commit before the last partial is used. */
export const ELEVENLABS_FINAL_WAIT_MS = 1_500;

const PROCESSOR = 'strado-pcm-tap';
const WORKLET = `class P extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('${PROCESSOR}', P);`;

const ERROR_CODE: Record<string, string> = { auth_error: 'auth', quota_exceeded: 'quota', rate_limited: 'quota' };
/** A failed token fetch: 'auth' when ElevenLabs refused the saved key (reason bad_key), else 'token'. */
const tokenCode = (err: unknown): string => {
  const e = err as { code?: unknown; details?: { reason?: unknown } } | null;
  return (e?.details?.reason ?? e?.code) === 'bad_key' ? 'auth' : 'token';
};

export function elevenLabsUrl(token: string, contextual: string[]): string {
  const q = new URLSearchParams({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'vad', token });
  const terms = new Set<string>();
  for (const raw of contextual) {
    const t = raw.trim();
    if (t && t.length <= KEYTERM_LEN_MAX) terms.add(t);
    if (terms.size >= KEYTERMS_MAX) break;
  }
  for (const t of terms) q.append('keyterms', t);
  return `${URL_BASE}?${q}`;
}

/** PCM16 little-endian, base64. */
function encode(samples: Float32Array): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  const bytes = new Uint8Array(view.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Box-filter resampler from the mic's rate to 16 kHz, keeping its phase across frames. */
function resampler(inRate: number): (frame: Float32Array) => Float32Array {
  const ratio = inRate / RATE;
  if (ratio === 1) return (f) => f;
  let carry = new Float32Array(0);
  let pos = 0;
  return (frame) => {
    const input = new Float32Array(carry.length + frame.length);
    input.set(carry); input.set(frame, carry.length);
    const out: number[] = [];
    while (pos + ratio <= input.length) {
      const a = Math.floor(pos), b = Math.max(a + 1, Math.floor(pos + ratio));
      let sum = 0;
      for (let i = a; i < b; i++) sum += input[i]!;
      out.push(sum / (b - a));
      pos += ratio;
    }
    const used = Math.floor(pos);
    carry = input.slice(used);
    pos -= used;
    return Float32Array.from(out);
  };
}

type Session = {
  ws: WebSocket | null;
  stream: MediaStream | null;
  ctx: AudioContext | null;
  node: AudioWorkletNode | null;
  moduleUrl: string | null;
  started: boolean;
  stopping: boolean;
  done: boolean;
  committed: string[];
  partial: string;
  /** 16 kHz samples not yet sent, and not yet measured for a level. */
  pending: Float32Array;
  levelBuf: Float32Array;
  timer: ReturnType<typeof setTimeout> | null;
};

const concat = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export function createElevenLabsBridge(deps: ElevenLabsDeps): VoiceBridge & { available: boolean } {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const getUserMedia = deps.getUserMedia ?? (media?.getUserMedia ? (c: MediaStreamConstraints) => media.getUserMedia(c) : undefined);
  const WS = deps.WebSocket ?? globalThis.WebSocket;
  const Ctx = deps.AudioContext ?? globalThis.AudioContext;
  const listeners = new Set<(e: VoiceEvent) => void>();
  let cur: Session | null = null;
  const emit = (s: Session, e: VoiceEvent) => { if (s === cur && !s.done) for (const cb of [...listeners]) cb(e); };

  const stable = (s: Session) => s.committed.join(' ');
  const full = (s: Session) => [...s.committed, s.partial].filter(Boolean).join(' ');

  /** Releases the mic, the audio graph and the socket. Safe to call twice. */
  const release = (s: Session) => {
    s.done = true;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (s.ws) {
      s.ws.onmessage = null; s.ws.onclose = null; s.ws.onerror = null; s.ws.onopen = null;
      try { s.ws.close(); } catch { /* already closed */ }
    }
    for (const t of s.stream?.getTracks() ?? []) { try { t.stop(); } catch { /* gone */ } }
    try { s.node?.disconnect(); } catch { /* gone */ }
    if (s.node) s.node.port.onmessage = null;
    void s.ctx?.close().catch(() => {});
    if (s.moduleUrl) { try { URL.revokeObjectURL(s.moduleUrl); } catch { /* no-op */ } }
    if (cur === s) cur = null;
  };
  const fail = (s: Session, code: string, message: string) => { emit(s, { type: 'error', code, message }); release(s); };
  const finish = (s: Session) => { emit(s, { type: 'final', text: full(s) }); release(s); };

  const send = (s: Session, samples: Float32Array, commit: boolean) => {
    s.ws?.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: encode(samples), commit, sample_rate: RATE }));
  };
  const pump = (s: Session) => {
    while (s.started && !s.stopping && s.pending.length >= CHUNK) {
      send(s, s.pending.subarray(0, CHUNK), false);
      s.pending = s.pending.slice(CHUNK);
    }
  };
  const onAudio = (s: Session, samples: Float32Array) => {
    if (s.done || s.stopping) return;
    s.pending = concat(s.pending, samples);
    s.levelBuf = concat(s.levelBuf, samples);
    while (s.levelBuf.length >= LEVEL) {
      let sum = 0;
      for (let i = 0; i < LEVEL; i++) sum += s.levelBuf[i]! * s.levelBuf[i]!;
      emit(s, { type: 'level', rms: Math.min(1, Math.sqrt(sum / LEVEL)) });
      s.levelBuf = s.levelBuf.slice(LEVEL);
    }
    pump(s);
  };

  const onMessage = (s: Session, raw: unknown) => {
    let m: { message_type?: unknown; text?: unknown; error?: unknown };
    try { m = JSON.parse(String(raw)); } catch { return; }
    const type = typeof m.message_type === 'string' ? m.message_type : '';
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    switch (type) {
      case 'session_started':
        s.started = true;
        emit(s, { type: 'ready' });
        pump(s);
        return;
      case 'partial_transcript':
        s.partial = text;
        emit(s, { type: 'partial', text: full(s), stable: stable(s) });
        return;
      case 'committed_transcript':
        if (text) s.committed.push(text);
        s.partial = '';
        emit(s, { type: 'partial', text: full(s), stable: stable(s) });
        if (s.stopping) finish(s);
        return;
      default:
        if (typeof m.error === 'string' || /error|exceeded|limited|insufficient/.test(type)) {
          fail(s, ERROR_CODE[type] ?? 'failed', typeof m.error === 'string' ? m.error : type);
        }
    }
  };

  const start = async (contextual: string[]) => {
    if (cur) release(cur);
    const s: Session = { ws: null, stream: null, ctx: null, node: null, moduleUrl: null, started: false, stopping: false, done: false,
      committed: [], partial: '', pending: new Float32Array(0), levelBuf: new Float32Array(0), timer: null };
    cur = s;
    let token: string;
    try { token = await deps.getToken(); } catch (err) {
      return fail(s, tokenCode(err), err instanceof Error ? err.message : String(err));
    }
    if (s.done) return;
    try {
      if (!getUserMedia) throw Object.assign(new Error('No microphone access in this window'), { name: 'NotSupportedError' });
      s.stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return fail(s, e?.name === 'NotAllowedError' ? 'mic_denied' : 'failed', e?.message ?? String(err));
    }
    if (s.done) return release(s);
    try {
      const ws = new WS(elevenLabsUrl(token, contextual));
      s.ws = ws;
      ws.onmessage = (e) => onMessage(s, (e as MessageEvent).data);
      ws.onclose = () => { if (!s.done) fail(s, 'network', 'The connection to ElevenLabs closed'); };
      ws.onerror = () => { /* a close follows */ };

      const ctx = new Ctx();
      s.ctx = ctx;
      s.moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(s.moduleUrl);
      if (s.done) return;
      const Node = deps.AudioWorkletNode ?? AudioWorkletNode;
      const node = new Node(ctx, PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      s.node = node;
      const down = resampler(ctx.sampleRate);
      node.port.onmessage = (e: MessageEvent) => onAudio(s, down(e.data as Float32Array));
      ctx.createMediaStreamSource(s.stream).connect(node);
    } catch (err) {
      fail(s, 'failed', err instanceof Error ? err.message : String(err));
    }
  };

  const stop = () => {
    const s = cur;
    if (!s || s.done || s.stopping) return;
    s.stopping = true;
    if (!s.started || !s.ws) return finish(s);
    send(s, s.pending, true);
    s.pending = new Float32Array(0);
    s.timer = setTimeout(() => finish(s), ELEVENLABS_FINAL_WAIT_MS);
  };

  const cancel = () => { if (cur) release(cur); };

  return {
    available: !!getUserMedia,
    start,
    stop,
    cancel,
    onEvent: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
