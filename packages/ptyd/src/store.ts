// In-memory session registry + per-session byte ring buffer.
// Buffer is memory-only by design: it survives server restarts (the daemon
// does), not daemon restarts. Matches the old in-process 256KB scrollback.

/** Structural minimum the store needs from a PTY; pty.ts's Pty satisfies it. */
export interface PtyLike {
  pid: number;
  cols: number;
  rows: number;
}

export interface Session {
  id: string;
  pty: PtyLike;
  buffer: Buffer[];
  bufferBytes: number;
  exited: boolean;
  exitCode: number | null;
}

const DEFAULT_BUFFER_CAP = 256 * 1024;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly bufferCap: number;

  constructor(opts: { bufferCap?: number } = {}) {
    this.bufferCap = opts.bufferCap ?? DEFAULT_BUFFER_CAP;
  }

  add(id: string, pty: PtyLike): Session {
    const existing = this.sessions.get(id);
    if (existing && !existing.exited) throw new Error(`session exists: ${id}`);
    const session: Session = { id, pty, buffer: [], bufferBytes: 0, exited: false, exitCode: null };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  all(): IterableIterator<Session> {
    return this.sessions.values();
  }

  appendOutput(session: Session, chunk: Buffer): void {
    session.buffer.push(chunk);
    session.bufferBytes += chunk.byteLength;
    while (session.bufferBytes > this.bufferCap && session.buffer.length > 0) {
      const head = session.buffer[0]!;
      const excess = session.bufferBytes - this.bufferCap;
      if (head.byteLength <= excess) {
        session.buffer.shift();
        session.bufferBytes -= head.byteLength;
      } else {
        session.buffer[0] = head.subarray(excess);
        session.bufferBytes -= excess;
      }
    }
  }

  replay(session: Session): Buffer {
    return Buffer.concat(session.buffer);
  }
}
