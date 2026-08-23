// Wire protocol for strado-ptyd.
//
// Frame layout (all integers big-endian):
//   [4 bytes: totalLen] [4 bytes: headerLen] [headerLen bytes: JSON header] [rest: binary payload]
// totalLen counts everything after itself. PTY input/output bytes ride the
// binary payload — never encoded inside the JSON.

export const PROTOCOL_VERSION = 1;

export interface SessionMeta {
  shell: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface SessionInfo {
  id: string;
  pid: number;
  cols: number;
  rows: number;
}

export type UpgradeResult =
  | { ok: true; successorPid: number }
  | { ok: false; reason: string };

/** IPC (process.send) messages between predecessor and handoff successor. */
export type HandoffMessage =
  | { type: 'upgrade-ack'; successorPid: number }
  | { type: 'upgrade-nak'; reason: string }
  // predecessor → successor: my listener is closed and the socket file is
  // unlinked; bind now (don't wait for my full exit).
  | { type: 'socket-released' };

// ---- client → daemon ----
export type ClientMessage =
  | { type: 'hello'; protocols: number[] }
  | { type: 'open'; id: string; meta: SessionMeta }
  | { type: 'input'; id: string } // bytes in payload
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'close'; id: string } // SIGHUP + escalation
  | { type: 'list' }
  | { type: 'subscribe'; id: string; replay: boolean }
  | { type: 'unsubscribe'; id: string }
  | { type: 'prepare-upgrade' };

// ---- daemon → client ----
export type ServerMessage =
  | { type: 'hello-ack'; protocol: number; daemonVersion: string; daemonPid: number }
  | { type: 'open-ack'; id: string; pid: number }
  | { type: 'open-err'; id: string; message: string }
  | { type: 'output'; id: string } // bytes in payload
  | { type: 'exit'; id: string; code: number | null }
  | { type: 'list-reply'; sessions: SessionInfo[] }
  | { type: 'error'; message: string; code: 'EPROTO' | 'ENOENT' | 'EVERSION' }
  | { type: 'upgrade-prepared'; result: UpgradeResult };

export interface Frame {
  message: unknown;
  payload: Buffer | null;
}

const MAX_FRAME = 64 * 1024 * 1024;

export function encodeFrame(msg: object, payload?: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify(msg), 'utf8');
  const payloadLen = payload?.byteLength ?? 0;
  const buf = Buffer.allocUnsafe(8 + header.byteLength + payloadLen);
  buf.writeUInt32BE(4 + header.byteLength + payloadLen, 0);
  buf.writeUInt32BE(header.byteLength, 4);
  header.copy(buf, 8);
  if (payload) payload.copy(buf, 8 + header.byteLength);
  return buf;
}

export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    // Early oversize check once the length prefix is readable.
    if (this.buffered >= 4) {
      const head = this.peek(4);
      const totalLen = head.readUInt32BE(0);
      if (totalLen > MAX_FRAME) throw new Error(`frame too large: ${totalLen}`);
    }
  }

  drain(): Frame[] {
    const out: Frame[] = [];
    for (;;) {
      if (this.buffered < 4) return out;
      const totalLen = this.peek(4).readUInt32BE(0);
      if (this.buffered < 4 + totalLen) return out;
      const frame = this.take(4 + totalLen).subarray(4);
      const headerLen = frame.readUInt32BE(0);
      if (headerLen > frame.byteLength - 4) throw new Error('malformed frame: header overruns');
      const header = frame.subarray(4, 4 + headerLen);
      const payload = frame.subarray(4 + headerLen);
      let message: unknown;
      try {
        message = JSON.parse(header.toString('utf8'));
      } catch {
        throw new Error('malformed frame: bad JSON header');
      }
      out.push({ message, payload: payload.byteLength > 0 ? Buffer.from(payload) : null });
    }
  }

  private peek(n: number): Buffer {
    if (this.chunks.length === 1 && this.chunks[0]!.byteLength >= n) return this.chunks[0]!;
    this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0]!;
  }

  private take(n: number): Buffer {
    const all = this.peek(n);
    const taken = all.subarray(0, n);
    this.chunks = [all.subarray(n)];
    this.buffered -= n;
    return taken;
  }
}
