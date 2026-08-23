import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder } from '../src/protocol.js';

describe('framing', () => {
  it('round-trips a message without payload', () => {
    const buf = encodeFrame({ type: 'list' });
    const dec = new FrameDecoder();
    dec.push(buf);
    const frames = dec.drain();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.message).toEqual({ type: 'list' });
    expect(frames[0]!.payload).toBeNull();
  });

  it('round-trips a message with binary payload, byte-perfect', () => {
    // Non-UTF-8 bytes: must survive untouched (no utf8 decode hop).
    const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0xf0, 0x9f]);
    const buf = encodeFrame({ type: 'input', id: 'k' }, payload);
    const dec = new FrameDecoder();
    dec.push(buf);
    const frames = dec.drain();
    expect(frames[0]!.message).toEqual({ type: 'input', id: 'k' });
    expect(Buffer.compare(frames[0]!.payload!, payload)).toBe(0);
  });

  it('decodes frames split across arbitrary chunk boundaries', () => {
    const a = encodeFrame({ type: 'input', id: 'x' }, Buffer.from('hello'));
    const b = encodeFrame({ type: 'resize', id: 'x', cols: 120, rows: 40 });
    const joined = Buffer.concat([a, b]);
    // push one byte at a time — worst-case fragmentation
    const dec = new FrameDecoder();
    const out: unknown[] = [];
    for (const byte of joined) {
      dec.push(Buffer.from([byte]));
      for (const f of dec.drain()) out.push(f.message);
    }
    expect(out).toEqual([
      { type: 'input', id: 'x' },
      { type: 'resize', id: 'x', cols: 120, rows: 40 },
    ]);
  });

  it('rejects oversized frames', () => {
    const dec = new FrameDecoder();
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(64 * 1024 * 1024 + 1, 0);
    expect(() => dec.push(evil)).toThrow(/frame too large/);
  });
});
