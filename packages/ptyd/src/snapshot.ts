// Handoff snapshot — the daemon-side bookkeeping a successor needs to adopt
// live sessions. The kernel-side state (PTY master fds) travels via the
// successor's stdio array; this file carries ids, dims, pids, the fd-index
// assigned to each session, and the replay ring buffer.
//
// On-disk format reuses the wire framing: one header frame, then one frame
// per session with the ring-buffer bytes riding the binary payload tail.
// The file is transient (written by the predecessor, consumed by the
// successor moments later), so version 1 is a forward-compat hook only.

import fs from 'node:fs';
import { encodeFrame, FrameDecoder } from './protocol.js';

export const SNAPSHOT_VERSION = 1 as const;

export interface SnapshotSession {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  /** stdio slot in the successor where this session's master fd was placed. */
  fdIndex: number;
  buffer: Buffer;
}

export interface HandoffSnapshot {
  version: typeof SNAPSHOT_VERSION;
  sessions: SnapshotSession[];
}

interface HeaderMsg { type: 'handoff-header'; version: number; sessionCount: number }
interface SessionMsg { type: 'handoff-session'; id: string; pid: number; cols: number; rows: number; fdIndex: number }

export function writeSnapshot(filePath: string, snapshot: HandoffSnapshot): void {
  const header: HeaderMsg = {
    type: 'handoff-header',
    version: snapshot.version,
    sessionCount: snapshot.sessions.length,
  };
  const parts: Buffer[] = [encodeFrame(header)];
  for (const s of snapshot.sessions) {
    const msg: SessionMsg = { type: 'handoff-session', id: s.id, pid: s.pid, cols: s.cols, rows: s.rows, fdIndex: s.fdIndex };
    parts.push(encodeFrame(msg, s.buffer.byteLength > 0 ? s.buffer : undefined));
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat(parts), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function readSnapshot(filePath: string): HandoffSnapshot {
  const raw = fs.readFileSync(filePath);
  const dec = new FrameDecoder();
  dec.push(raw);
  const frames = dec.drain();
  const header = frames[0]?.message as Partial<HeaderMsg> | undefined;
  if (!header || header.type !== 'handoff-header') {
    throw new Error(`malformed handoff snapshot at ${filePath}: missing header frame`);
  }
  if (header.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version ${header.version} at ${filePath}`);
  }
  if (header.sessionCount !== frames.length - 1) {
    throw new Error(`malformed handoff snapshot at ${filePath}: header session count ${header.sessionCount} ≠ ${frames.length - 1} frames`);
  }
  const sessions: SnapshotSession[] = [];
  for (let i = 1; i < frames.length; i++) {
    const m = frames[i]!.message as Partial<SessionMsg>;
    if (
      m.type !== 'handoff-session' ||
      typeof m.id !== 'string' ||
      typeof m.pid !== 'number' ||
      typeof m.cols !== 'number' ||
      typeof m.rows !== 'number' ||
      typeof m.fdIndex !== 'number'
    ) {
      throw new Error(`malformed handoff snapshot at ${filePath}: bad session frame ${i}`);
    }
    sessions.push({ id: m.id, pid: m.pid, cols: m.cols, rows: m.rows, fdIndex: m.fdIndex, buffer: frames[i]!.payload ?? Buffer.alloc(0) });
  }
  return { version: SNAPSHOT_VERSION, sessions };
}

export function clearSnapshot(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
