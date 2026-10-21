import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElevenLabsBridge, ELEVENLABS_FINAL_WAIT_MS, type ElevenLabsDeps } from './elevenlabs';

type Ev = { type: string; [k: string]: unknown };

class FakeWS {
  static last: FakeWS | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.last = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serve(msg: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

class FakeNode {
  static last: FakeNode | null = null;
  port = { onmessage: null as ((e: { data: Float32Array }) => void) | null };
  disconnected = false;
  constructor(public ctx: unknown, public name: string) { FakeNode.last = this; }
  connect() {}
  disconnect() { this.disconnected = true; }
  /** One render quantum of mic audio at the context's rate. */
  feed(samples: Float32Array) { this.port.onmessage?.({ data: samples }); }
}

class FakeCtx {
  static last: FakeCtx | null = null;
  sampleRate = 48_000;
  closed = false;
  modules: string[] = [];
  audioWorklet = { addModule: async (url: string) => { this.modules.push(url); } };
  constructor() { FakeCtx.last = this; }
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
  async close() { this.closed = true; }
}

const track = () => ({ stopped: false, stop() { this.stopped = true; } });
let tracks: ReturnType<typeof track>[];
let events: Ev[];

const deps = (over: Partial<ElevenLabsDeps> = {}): ElevenLabsDeps => ({
  getToken: async () => 'tok-123',
  WebSocket: FakeWS as never,
  getUserMedia: async () => { tracks = [track()]; return { getTracks: () => tracks } as never; },
  AudioContext: FakeCtx as never,
  AudioWorkletNode: FakeNode as never,
  ...over,
});
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function started(over: Partial<ElevenLabsDeps> = {}, contextual: string[] = []) {
  const b = createElevenLabsBridge(deps(over));
  b.onEvent((e) => events.push(e as Ev));
  const p = b.start(contextual);
  await vi.runAllTimersAsync();
  await p;
  return b;
}
/** 100 ms of a 48 kHz tone at amplitude `a`. */
const tone = (a: number, ms = 100) => Float32Array.from({ length: 48 * ms }, (_, i) => a * Math.sin(i / 3));

beforeEach(() => {
  vi.useFakeTimers();
  events = []; tracks = [];
  FakeWS.last = null; FakeNode.last = null; FakeCtx.last = null;
  if (!URL.createObjectURL) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
  if (!URL.revokeObjectURL) (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(() => { vi.useRealTimers(); });

describe('the ElevenLabs realtime bridge', () => {
  it('has the VoiceBridge shape', () => {
    const b = createElevenLabsBridge(deps());
    for (const k of ['start', 'stop', 'cancel', 'onEvent'] as const) expect(typeof b[k]).toBe('function');
  });

  it('only getToken is required (the browser\'s own WebSocket, mic and audio otherwise); available follows the mic API', () => {
    const b = createElevenLabsBridge({ getToken: async () => 't' });
    expect(b.available).toBe(!!navigator.mediaDevices?.getUserMedia);
    expect(createElevenLabsBridge({ getToken: async () => 't', getUserMedia: async () => ({}) as never }).available).toBe(true);
  });

  it('connects with the single-use token, the model, PCM 16k, VAD commits and keyterms', async () => {
    const long = 'x'.repeat(60);
    const many = Array.from({ length: 70 }, (_, i) => `term${i}`);
    await started({}, ['claude-1', '', '  ', long, 'Strado Website', 'claude-1', ...many]);
    const u = new URL(FakeWS.last!.url);
    expect(`${u.origin}${u.pathname}`).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    expect(u.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(u.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(u.searchParams.get('commit_strategy')).toBe('vad');
    expect(u.searchParams.get('token')).toBe('tok-123');
    const terms = u.searchParams.getAll('keyterms');
    expect(terms.slice(0, 3)).toEqual(['claude-1', 'Strado Website', 'term0']);
    expect(terms).toHaveLength(50);
    expect(terms).not.toContain(long);
  });

  it('"ready" on session_started; audio waits for it, then goes as ~100 ms PCM16 chunks', async () => {
    await started();
    const ws = FakeWS.last!; ws.open();
    FakeNode.last!.feed(tone(0.5));
    expect(ws.sent).toHaveLength(0);
    expect(events.some((e) => e.type === 'ready')).toBe(false);
    ws.serve({ message_type: 'session_started', session_id: 's1' });
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
    expect(ws.sent).toHaveLength(1);
    FakeNode.last!.feed(tone(0.5, 200));
    expect(ws.sent).toHaveLength(3);
    for (const c of ws.sent) {
      expect(c).toEqual({ message_type: 'input_audio_chunk', audio_base_64: expect.any(String), commit: false, sample_rate: 16000 });
      // 100 ms at 16 kHz, 2 bytes a sample.
      expect(atob(c.audio_base_64 as string).length).toBe(3200);
      expect(c).not.toHaveProperty('previous_text');
    }
  });

  it('the samples are 16-bit little-endian, downsampled from the mic rate', async () => {
    await started();
    const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
    FakeNode.last!.feed(new Float32Array(4800).fill(0.5));
    const bytes = atob(ws.sent[0]!.audio_base_64 as string);
    const s = (bytes.charCodeAt(1) << 8) | bytes.charCodeAt(0);
    expect(s).toBe(Math.round(0.5 * 0x7fff));
  });

  it('"level" events about 20 a second, 0..1, louder for louder audio', async () => {
    await started();
    FakeWS.last!.serve({ message_type: 'session_started' });
    FakeNode.last!.feed(tone(0.05, 500));
    FakeNode.last!.feed(tone(0.8, 500));
    const levels = events.filter((e) => e.type === 'level').map((e) => e.rms as number);
    expect(levels.length).toBe(20);
    for (const l of levels) { expect(l).toBeGreaterThanOrEqual(0); expect(l).toBeLessThanOrEqual(1); }
    expect(levels[15]!).toBeGreaterThan(levels[5]!);
  });

  it('text: committed segments plus the in-flight partial; stable is the committed part', async () => {
    await started();
    const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
    ws.serve({ message_type: 'partial_transcript', text: 'open a' });
    ws.serve({ message_type: 'partial_transcript', text: 'open a shell' });
    ws.serve({ message_type: 'committed_transcript', text: 'Open a shell.' });
    ws.serve({ message_type: 'partial_transcript', text: 'and run' });
    const partials = events.filter((e) => e.type === 'partial');
    expect(partials).toEqual([
      { type: 'partial', text: 'open a', stable: '' },
      { type: 'partial', text: 'open a shell', stable: '' },
      { type: 'partial', text: 'Open a shell.', stable: 'Open a shell.' },
      { type: 'partial', text: 'Open a shell. and run', stable: 'Open a shell.' },
    ]);
  });

  it('stop: one last chunk with commit:true, then "final" on its committed_transcript, and everything closes', async () => {
    const b = await started();
    const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
    FakeNode.last!.feed(tone(0.3, 50));
    ws.serve({ message_type: 'committed_transcript', text: 'Open a shell.' });
    ws.serve({ message_type: 'partial_transcript', text: 'and run tests' });
    void b.stop();
    const last = ws.sent[ws.sent.length - 1]!;
    expect(last).toMatchObject({ message_type: 'input_audio_chunk', commit: true, sample_rate: 16000 });
    // The leftover 50 ms goes in that last chunk.
    expect(atob(last.audio_base_64 as string).length).toBe(1600);
    expect(events.some((e) => e.type === 'final')).toBe(false);
    ws.serve({ message_type: 'committed_transcript', text: 'and run the tests.' });
    expect(events.filter((e) => e.type === 'final')).toEqual([{ type: 'final', text: 'Open a shell. and run the tests.' }]);
    expect(ws.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeCtx.last!.closed).toBe(true);
    expect(FakeNode.last!.disconnected).toBe(true);
  });

  it('stop with no commit back in time: "final" with the last partial after the wait', async () => {
    const b = await started();
    const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
    ws.serve({ message_type: 'partial_transcript', text: 'close the shell' });
    void b.stop();
    vi.advanceTimersByTime(ELEVENLABS_FINAL_WAIT_MS - 10);
    expect(events.some((e) => e.type === 'final')).toBe(false);
    vi.advanceTimersByTime(20);
    expect(events.filter((e) => e.type === 'final')).toEqual([{ type: 'final', text: 'close the shell' }]);
    expect(ws.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    // A late commit changes nothing.
    ws.serve({ message_type: 'committed_transcript', text: 'late' });
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });

  it('cancel: closes everything and emits nothing more', async () => {
    const b = await started();
    const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
    ws.serve({ message_type: 'partial_transcript', text: 'hello' });
    const before = events.length;
    void b.cancel();
    ws.serve({ message_type: 'committed_transcript', text: 'hello' });
    ws.drop();
    vi.advanceTimersByTime(5_000);
    expect(events.length).toBe(before);
    expect(ws.closed).toBe(true);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeCtx.last!.closed).toBe(true);
  });

  it('cancel while the token is still coming: no mic is opened, nothing emitted', async () => {
    let give: (t: string) => void = () => {};
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as never);
    const b = createElevenLabsBridge(deps({ getToken: () => new Promise((r) => { give = r; }), getUserMedia }));
    b.onEvent((e) => events.push(e as Ev));
    const p = b.start([]);
    void b.cancel();
    give('tok');
    await vi.runAllTimersAsync(); await p;
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeWS.last).toBeNull();
    expect(events).toEqual([]);
  });

  describe('errors', () => {
    const serverError = async (message_type: string) => {
      await started();
      const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
      ws.serve({ message_type, error: `${message_type} happened` });
      return ws;
    };
    it.each([
      ['auth_error', 'auth'], ['quota_exceeded', 'quota'], ['rate_limited', 'quota'],
      ['error', 'failed'], ['input_error', 'failed'], ['transcriber_error', 'failed'], ['session_time_limit_exceeded', 'failed'],
    ])('%s → %s, and everything is released', async (type, code) => {
      const ws = await serverError(type);
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', code, message: `${type} happened` }]);
      expect(ws.closed).toBe(true);
      expect(tracks.every((t) => t.stopped)).toBe(true);
      expect(FakeCtx.last!.closed).toBe(true);
    });
    it('mic permission denied → mic_denied, no socket left open', async () => {
      await started({ getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
      expect(events).toEqual([{ type: 'error', code: 'mic_denied', message: 'denied' }]);
      expect(!FakeWS.last || FakeWS.last.closed).toBe(true);
    });
    it('no mic for another reason → failed', async () => {
      await started({ getUserMedia: async () => { throw Object.assign(new Error('no device'), { name: 'NotFoundError' }); } });
      expect(events).toEqual([{ type: 'error', code: 'failed', message: 'no device' }]);
    });
    it('the token fetch fails → token, with the server\'s message; no mic opened', async () => {
      const getUserMedia = vi.fn();
      await started({ getToken: async () => { throw new Error('Add an ElevenLabs key in Settings'); }, getUserMedia: getUserMedia as never });
      expect(events).toEqual([{ type: 'error', code: 'token', message: 'Add an ElevenLabs key in Settings' }]);
      expect(getUserMedia).not.toHaveBeenCalled();
    });
    it('the server refused the ElevenLabs key (reason bad_key) → auth; other token failures → token', async () => {
      class ApiErr extends Error { constructor(public code: string, m: string, public details?: unknown) { super(m); } }
      const cases: [Error, string][] = [
        [new ApiErr('upstream_error', 'ElevenLabs refused the key', { reason: 'bad_key' }), 'auth'],
        [new ApiErr('bad_key', 'ElevenLabs refused the key'), 'auth'],
        [new ApiErr('not_found', 'Add a key', { reason: 'no_key' }), 'token'],
        [new ApiErr('forbidden', 'Local only is on', { reason: 'local_only' }), 'token'],
        [new ApiErr('bad_gateway', 'ElevenLabs is down', { reason: 'upstream' }), 'token'],
      ];
      for (const [err, code] of cases) {
        events = [];
        await started({ getToken: async () => { throw err; } });
        expect(events).toEqual([{ type: 'error', code, message: err.message }]);
      }
    });
    it('the socket closes before the final → network, mic released', async () => {
      await started();
      const ws = FakeWS.last!; ws.serve({ message_type: 'session_started' });
      ws.drop();
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', code: 'network', message: expect.any(String) }]);
      expect(tracks.every((t) => t.stopped)).toBe(true);
      expect(FakeCtx.last!.closed).toBe(true);
    });
    it('after an error, a late stop emits nothing more', async () => {
      const b = createElevenLabsBridge(deps());
      b.onEvent((e) => events.push(e as Ev));
      const p = b.start([]); await vi.runAllTimersAsync(); await p;
      FakeWS.last!.serve({ message_type: 'auth_error', error: 'bad' });
      void b.stop();
      vi.advanceTimersByTime(5_000);
      expect(events.map((e) => e.type)).toEqual(['error']);
    });
  });

  it('onEvent returns an unsubscribe', async () => {
    const b = createElevenLabsBridge(deps());
    const seen: Ev[] = [];
    const off = b.onEvent((e) => seen.push(e as Ev));
    off();
    const p = b.start([]); await vi.runAllTimersAsync(); await p;
    FakeWS.last!.serve({ message_type: 'session_started' });
    expect(seen).toEqual([]);
  });

  it('a second start replaces the first session (its mic and socket are released)', async () => {
    const b = await started();
    const first = FakeWS.last!; const firstTracks = tracks;
    const p = b.start([]); await vi.runAllTimersAsync(); await p;
    expect(first.closed).toBe(true);
    expect(firstTracks.every((t) => t.stopped)).toBe(true);
    expect(FakeWS.last).not.toBe(first);
  });
});
