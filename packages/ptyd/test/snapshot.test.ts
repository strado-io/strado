import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot, readSnapshot, clearSnapshot, type HandoffSnapshot } from '../src/snapshot.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-snap-')), 'h.snap');

describe('handoff snapshot', () => {
  it('round-trips sessions with binary buffers byte-perfect', () => {
    const p = tmpFile();
    const snap: HandoffSnapshot = {
      version: 1,
      sessions: [
        { id: '/tmp/a\0shell', pid: 123, cols: 120, rows: 40, fdIndex: 4, buffer: Buffer.from([0x00, 0xff, 0xc3, 0xa9]) },
        { id: '/tmp/b', pid: 456, cols: 80, rows: 24, fdIndex: 5, buffer: Buffer.alloc(0) },
      ],
    };
    writeSnapshot(p, snap);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    const back = readSnapshot(p);
    expect(back.version).toBe(1);
    expect(back.sessions).toHaveLength(2);
    expect(back.sessions[0]!.id).toBe('/tmp/a\0shell');
    expect(back.sessions[0]!.fdIndex).toBe(4);
    expect(Buffer.compare(back.sessions[0]!.buffer, snap.sessions[0]!.buffer)).toBe(0);
    expect(back.sessions[1]!.buffer.byteLength).toBe(0);
    clearSnapshot(p);
    expect(fs.existsSync(p)).toBe(false);
    clearSnapshot(p); // idempotent
  });

  it('rejects a truncated file', () => {
    const p = tmpFile();
    writeSnapshot(p, { version: 1, sessions: [{ id: 'x', pid: 1, cols: 80, rows: 24, fdIndex: 4, buffer: Buffer.from('abc') }] });
    const bytes = fs.readFileSync(p);
    fs.writeFileSync(p, bytes.subarray(0, bytes.byteLength - 2));
    expect(() => readSnapshot(p)).toThrow(/malformed|session count/);
  });

  it('rejects a header/session count mismatch', () => {
    const p = tmpFile();
    writeSnapshot(p, { version: 1, sessions: [] });
    // Valid empty snapshot reads fine…
    expect(readSnapshot(p).sessions).toHaveLength(0);
    // …but a missing header does not.
    fs.writeFileSync(p, Buffer.alloc(0));
    expect(() => readSnapshot(p)).toThrow(/malformed/);
  });
});
