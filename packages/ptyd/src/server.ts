import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type SessionInfo,
  type UpgradeResult,
  type HandoffMessage,
} from './protocol.js';
import { spawnPty, adoptFromFd, type Pty } from './pty.js';
import { SessionStore, type Session } from './store.js';
import { writeSnapshot, clearSnapshot, type HandoffSnapshot, type SnapshotSession } from './snapshot.js';

export interface PtydServerOptions {
  socketPath: string;
  daemonVersion: string;
  bufferCap?: number;
}

// Flow control: past this outbound backlog, pause the producing PTYs; the
// kernel PTY buffer fills and the foreground process blocks on write —
// the flood throttles at the source. Resume on socket 'drain'.
const PAUSE_THRESHOLD = 1 * 1024 * 1024;
// A conn that buffers past this is dead weight — cut it.
const DESTROY_THRESHOLD = 8 * 1024 * 1024;

interface Conn {
  socket: net.Socket;
  decoder: FrameDecoder;
  negotiated: boolean;
  subscriptions: Set<string>;
  pausedSessions: Set<string>;
}

interface LiveSession extends Session {
  pty: Pty;
}

function socketAnswers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, timeoutMs);
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true); });
    probe.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export class PtydServer {
  private readonly server: net.Server;
  private readonly store: SessionStore;
  private readonly conns = new Set<Conn>();
  private readonly opts: PtydServerOptions;
  private upgradeInFlight: Promise<UpgradeResult> | null = null;
  /** The conn that asked for the upgrade — its reply must flush before exit. */
  private pendingUpgradeConn: Conn | null = null;
  /**
   * Latched the instant a successor acks: the sessions (and, from the
   * socket-released signal onward, the socket path) belong to it, not us.
   * Everything after this point is wind-down only.
   */
  private handedOff = false;

  constructor(opts: PtydServerOptions) {
    this.opts = opts;
    this.store = new SessionStore({ bufferCap: opts.bufferCap });
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async listen(): Promise<void> {
    fs.mkdirSync(path.dirname(this.opts.socketPath), { recursive: true });
    // A live daemon may already own this path (two servers racing
    // spawn-or-adopt). Stealing its socket would orphan every session it
    // holds — probe first and refuse to start if something answers.
    if (fs.existsSync(this.opts.socketPath) && (await socketAnswers(this.opts.socketPath))) {
      throw new Error(`live daemon already owns ${this.opts.socketPath}; refusing to steal it`);
    }
    try {
      fs.unlinkSync(this.opts.socketPath); // stale socket from a dead daemon
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    // Owner-only. The socket file IS the auth boundary — no tokens.
    fs.chmodSync(this.opts.socketPath, 0o600);
    // Post-listen accept-loop errors (e.g. EMFILE) must not become an
    // unhandled 'error' event — that would crash the daemon and every session.
    this.server.on('error', (err) => {
      process.stderr.write(`[ptyd] server error: ${(err as Error).stack ?? err}\n`);
    });
  }

  async close(opts: { killSessions?: boolean } = {}): Promise<void> {
    // Once a successor has acked, the master fds and the socket path are its
    // property. A SIGTERM landing in our wind-down window arrives here with
    // the default killSessions:true — honouring it would kill the sessions the
    // successor now serves and unlink its socket. handedOff overrides the
    // argument: after a committed handoff this close is wind-down, nothing more.
    const killSessions = this.handedOff ? false : (opts.killSessions ?? true);
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    if (killSessions) {
      for (const s of this.store.all()) {
        if (!s.exited) (s as LiveSession).pty.killNow();
      }
    }
    // The accept loop may already be closed — the handoff path stops accepting
    // the instant the successor acks. close() on a non-listening server hands
    // its callback an ERR_SERVER_NOT_RUNNING (and if 'close' already fired it
    // can never call it at all), so only await when we're still listening;
    // either way this resolves.
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    // Invariant: the socket path is unlinked exactly ONCE per handoff, and
    // always strictly before the successor binds. libuv does it for us inside
    // the ack-time this.server.close() in doPrepareUpgrade (a listening pipe
    // server unlinks its path on close), and only then do we tell the successor
    // it may bind. So on the handoff path (handedOff / killSessions:false) the
    // listener guard above is already false AND this unlink must not run: the
    // file sitting at that path is now the SUCCESSOR's socket, not ours.
    // The explicit unlink below exists only for normal shutdowns, where the
    // listener was still bound moments ago and no successor exists.
    if (killSessions) {
      try { fs.unlinkSync(this.opts.socketPath); } catch { /* ignore */ }
    }
  }

  private send(conn: Conn, msg: ServerMessage, payload?: Buffer): void {
    const { socket } = conn;
    if (socket.destroyed) return;
    socket.write(encodeFrame(msg, payload));
    if (socket.writableLength > DESTROY_THRESHOLD) socket.destroy();
  }

  private onConnection(socket: net.Socket): void {
    const conn: Conn = {
      socket,
      decoder: new FrameDecoder(),
      negotiated: false,
      subscriptions: new Set(),
      pausedSessions: new Set(),
    };
    this.conns.add(conn);
    socket.on('drain', () => this.resumePaused(conn));
    // Annotated: @types/node >=26 widens the 'data' payload to
    // `string | Buffer` for the setEncoding() case. This socket is never
    // given an encoding, so frames always arrive as Buffers.
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        conn.decoder.push(chunk);
        frames = conn.decoder.drain();
      } catch (err) {
        this.send(conn, { type: 'error', message: (err as Error).message, code: 'EPROTO' });
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        try {
          this.dispatch(conn, frame.message as ClientMessage, frame.payload);
        } catch (err) {
          // Internal failure on one op must not kill the transport: the
          // daemon's real client is a single server conn holding every
          // subscription.
          process.stderr.write(`[ptyd] dispatch error: ${(err as Error).stack ?? err}\n`);
        }
      }
    });
    const drop = () => {
      this.conns.delete(conn);
      this.resumePaused(conn); // a destroyed socket never drains
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private dispatch(conn: Conn, msg: ClientMessage, payload: Buffer | null): void {
    if (!conn.negotiated) {
      if (msg.type !== 'hello' || !msg.protocols.includes(PROTOCOL_VERSION)) {
        this.send(conn, { type: 'error', message: 'expected hello (protocol 1)', code: msg.type === 'hello' ? 'EVERSION' : 'EPROTO' });
        conn.socket.destroy();
        return;
      }
      conn.negotiated = true;
      this.send(conn, {
        type: 'hello-ack',
        protocol: PROTOCOL_VERSION,
        daemonVersion: this.opts.daemonVersion,
        daemonPid: process.pid,
      });
      return;
    }
    // A committed handoff means the successor owns the ptys — mutating them
    // from here would write to fds it now serves (or spawn a session that dies
    // with this process). Read-only ops (list/subscribe) still answer honestly
    // for whatever conns are draining, and prepare-upgrade is already latched.
    if (this.handedOff && (msg.type === 'open' || msg.type === 'input' || msg.type === 'resize' || msg.type === 'close')) {
      this.send(conn, {
        type: 'error',
        message: 'daemon is handing off; retry against the successor',
        code: 'EPROTO',
      });
      return;
    }
    switch (msg.type) {
      case 'open': {
        const existing = this.store.get(msg.id);
        if (existing && !existing.exited) {
          this.send(conn, { type: 'open-err', id: msg.id, message: `session exists: ${msg.id}` });
          return;
        }
        let pty: Pty | null = null;
        try {
          pty = spawnPty(msg.meta);
          const session = this.store.add(msg.id, pty) as LiveSession;
          this.wireSession(session);
          this.send(conn, { type: 'open-ack', id: msg.id, pid: pty.pid });
        } catch (err) {
          // A pty forked before the failure must not outlive the error —
          // untracked children survive daemon shutdown otherwise.
          pty?.killNow();
          this.send(conn, { type: 'open-err', id: msg.id, message: (err as Error).message });
        }
        return;
      }
      case 'input': {
        const s = this.store.get(msg.id) as LiveSession | undefined;
        if (s && !s.exited && payload) s.pty.write(payload);
        return;
      }
      case 'resize': {
        const s = this.store.get(msg.id) as LiveSession | undefined;
        if (s && !s.exited) {
          try { s.pty.resize(msg.cols, msg.rows); } catch { /* invalid dims — ignore like today */ }
        }
        return;
      }
      case 'close': {
        const s = this.store.get(msg.id) as LiveSession | undefined;
        if (s && !s.exited) s.pty.kill();
        return;
      }
      case 'list': {
        const sessions: SessionInfo[] = [];
        for (const s of this.store.all()) {
          if (s.exited) continue;
          const live = s as LiveSession;
          sessions.push({ id: s.id, pid: live.pty.pid, cols: live.pty.cols, rows: live.pty.rows });
        }
        this.send(conn, { type: 'list-reply', sessions });
        return;
      }
      case 'subscribe': {
        const s = this.store.get(msg.id);
        if (!s) {
          this.send(conn, { type: 'error', message: `no session: ${msg.id}`, code: 'ENOENT' });
          return;
        }
        conn.subscriptions.add(msg.id);
        if (msg.replay) {
          const buf = this.store.replay(s);
          if (buf.byteLength > 0) this.send(conn, { type: 'output', id: msg.id }, buf);
        }
        return;
      }
      case 'unsubscribe': {
        conn.subscriptions.delete(msg.id);
        return;
      }
      case 'prepare-upgrade': {
        // Reply once the handoff has succeeded or definitively failed. On
        // success the reply must reach the supervisor BEFORE this process
        // exits — finalizeHandoff drains THIS conn before closing.
        this.pendingUpgradeConn = conn;
        void this.prepareUpgrade()
          .then((result) => this.send(conn, { type: 'upgrade-prepared', result }))
          .catch((err) =>
            this.send(conn, {
              type: 'upgrade-prepared',
              result: { ok: false, reason: `prepareUpgrade threw: ${(err as Error).message}` },
            }),
          );
        return;
      }
      default: {
        this.send(conn, { type: 'error', message: `unknown op: ${(msg as { type: string }).type}`, code: 'EPROTO' });
      }
    }
  }

  private wireSession(session: LiveSession): void {
    session.pty.onData((chunk) => {
      this.store.appendOutput(session, chunk);
      let congested = false;
      for (const c of this.conns) {
        if (!c.subscriptions.has(session.id)) continue;
        this.send(c, { type: 'output', id: session.id }, chunk);
        if (!c.socket.destroyed && c.socket.writableLength > PAUSE_THRESHOLD) {
          c.pausedSessions.add(session.id);
          congested = true;
        }
      }
      if (congested) session.pty.pause();
    });
    session.pty.onExit((code) => {
      session.exited = true;
      session.exitCode = code;
      // Guard: an explicitly closed id can be reopened before the old exit
      // callback lands — never broadcast a stale exit for the replacement.
      if (this.store.get(session.id) !== session) return;
      // Exit is a session-lifecycle event, not a stream event: broadcast to
      // every negotiated conn, not just subscribers, so a client learns a
      // detached session died without polling list.
      for (const c of this.conns) {
        if (!c.negotiated) continue;
        this.send(c, { type: 'exit', id: session.id, code });
        c.subscriptions.delete(session.id);
        c.pausedSessions.delete(session.id);
      }
      // Delete immediately — dead rows otherwise accumulate forever.
      this.store.delete(session.id);
    });
  }

  private resumePaused(conn: Conn): void {
    for (const id of conn.pausedSessions) {
      conn.pausedSessions.delete(id);
      let heldElsewhere = false;
      for (const other of this.conns) {
        if (other !== conn && other.pausedSessions.has(id)) { heldElsewhere = true; break; }
      }
      if (heldElsewhere) continue;
      const s = this.store.get(id) as LiveSession | undefined;
      if (s && !s.exited) s.pty.resume();
    }
  }

  /**
   * Phase 2 handoff (sender): spawn the NEW bundle at our own script path,
   * hand it the live PTY master fds via stdio inheritance, await its IPC
   * ack, then exit without killing sessions. On any failure the successor
   * is killed, the snapshot removed, and we keep serving — sessions are
   * never at risk from a failed handoff.
   */
  async prepareUpgrade(): Promise<UpgradeResult> {
    // Two successors adopting the same masters is split-brain — latch.
    if (this.upgradeInFlight) return this.upgradeInFlight;
    const attempt = this.doPrepareUpgrade();
    this.upgradeInFlight = attempt;
    let result: UpgradeResult;
    try {
      result = await attempt;
    } catch (err) {
      // A throw is a failure too — never leave a rejected promise latched, or
      // every future prepare-upgrade replays the same error.
      this.upgradeInFlight = null;
      throw err;
    }
    // Clear on failure so a later retry can run; keep latched on success —
    // this process is exiting and must never spawn a second successor.
    if (!result.ok) this.upgradeInFlight = null;
    return result;
  }

  private async doPrepareUpgrade(): Promise<UpgradeResult> {
    const live = [...this.store.all()].filter((s) => !s.exited) as LiveSession[];

    // stdio: [0]=ignore [1]=inherit [2]=inherit [3]=ipc [4..]=master fds
    const FD_BASE = 4;
    const stdio: Array<'ignore' | 'inherit' | 'ipc' | number> = ['ignore', 'inherit', 'inherit', 'ipc'];
    // This whole collect+pause block MUST stay synchronous — no await before
    // the spawn. An await here would let an exit callback run between
    // getMasterFd() and the spawn, so we'd hand the child a closed fd number
    // (or throw 'adopted pty disposed' mid-collection); staying sync means the
    // fd set we captured is exactly the fd set the successor inherits.
    const sessions: SnapshotSession[] = [];
    const paused: LiveSession[] = [];
    // Any failure after this point leaves US serving, so the freeze must lift.
    const resumeAll = () => {
      for (const s of paused) {
        if (!s.exited) s.pty.resume();
      }
    };
    try {
      live.forEach((s, i) => {
        stdio.push(s.pty.getMasterFd());
        sessions.push({
          id: s.id,
          pid: s.pty.pid,
          cols: s.pty.cols,
          rows: s.pty.rows,
          fdIndex: FD_BASE + i,
          buffer: this.store.replay(s),
        });
        // Freeze the stream for the handoff window: bytes stay in the kernel
        // pty buffer for the successor instead of being drained (and lost) by
        // this dying process — without this every handoff punches a hole in
        // the successor's scrollback. The kernel buffer blocking the shell for
        // the ack RTT is the same mechanism PAUSE_THRESHOLD relies on.
        s.pty.pause();
        paused.push(s);
      });
    } catch (err) {
      // getMasterFd() throws for a pty that died mid-collection.
      resumeAll();
      return { ok: false, reason: `master fd collection failed: ${(err as Error).message}` };
    }

    const snapshotPath = path.join(os.tmpdir(), `ptyd-handoff-${process.pid}-${Date.now()}.snap`);
    try {
      writeSnapshot(snapshotPath, { version: 1, sessions });
    } catch (err) {
      // writeSnapshot writes `${path}.tmp` then renames; a mid-write failure
      // leaves the tmp behind in os.tmpdir() forever.
      try { fs.unlinkSync(`${snapshotPath}.tmp`); } catch { /* never created */ }
      resumeAll();
      return { ok: false, reason: `snapshot write failed: ${(err as Error).message}` };
    }

    // argv[1] is our bundle path; the installer (or a dev rebuild) has
    // already swapped the bytes there — spawning it loads the new code.
    const scriptPath = process.argv[1];
    if (!scriptPath) {
      // resumeAll FIRST on every failure path: a throw out of clearSnapshot's
      // unlink must never leave the sessions frozen.
      resumeAll();
      clearSnapshot(snapshotPath);
      return { ok: false, reason: 'process.argv[1] empty — cannot self-spawn' };
    }

    process.stderr.write(
      `[ptyd] prepare-upgrade: spawning successor ${scriptPath} (sessions=${sessions.length})\n`,
    );
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(
        process.execPath,
        [...process.execArgv, scriptPath, '--handoff', `--snapshot=${snapshotPath}`, `--socket=${this.opts.socketPath}`],
        { stdio, detached: false },
      );
    } catch (err) {
      resumeAll();
      clearSnapshot(snapshotPath);
      return { ok: false, reason: `successor spawn failed: ${(err as Error).message}` };
    }

    const result = await waitForHandoffAck(child);
    if (!result.ok) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resumeAll();
      clearSnapshot(snapshotPath);
      return result;
    }

    // The successor owns the sessions now — stop accepting new clients
    // immediately so a fast reconnect gets ECONNREFUSED (and retries into
    // the successor) instead of being accepted by this dying process.
    // Existing conns (incl. the requester awaiting upgrade-prepared) are
    // untouched; net.Server.close only stops the accept loop.
    this.handedOff = true;
    this.server.close();

    // The listener (and its socket file, via libuv) is gone — tell the
    // successor it can bind NOW instead of waiting for our full exit.
    // This collapses the no-socket-file window (in which a concurrently
    // booting ensurePtyDaemon would spawn a fresh daemon and starve the
    // successor out of the path) to one IPC hop.
    try {
      // The callback is load-bearing: waitForHandoffAck removed our 'error'
      // listener, so a callback-less send whose write fails asynchronously
      // (successor died in the ack→close window) emits an unhandled 'error'
      // that would crash this predecessor with sessions still riding on it.
      child.send({ type: 'socket-released' } satisfies HandoffMessage, () => {
        /* EPIPE if successor died — reply-lost path recovers */
      });
    } catch { /* successor may have raced ahead; disconnect fallback covers it */ }

    // Successor adopted. Exit AFTER the upgrade-prepared reply has flushed
    // (the dispatch .then sends it right after this resolves; finalizeHandoff
    // yields, then drains the requesting conn). No resumeAll() on this path:
    // the masters belong to the successor now, and resuming would restart the
    // drain we just stopped.
    setImmediate(() => {
      this.finalizeHandoff().catch((err) =>
        process.stderr.write(`[ptyd] finalizeHandoff failed: ${(err as Error).stack ?? err}\n`),
      );
    });
    return result;
  }

  private async finalizeHandoff(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // The upgrade-prepared reply may still sit in the userspace write queue;
    // destroy() would discard it and the supervisor couldn't tell success from
    // a crash. Give it one drain (bounded).
    const c = this.pendingUpgradeConn;
    if (c && !c.socket.destroyed && c.socket.writableLength > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 500);
        c.socket.once('drain', () => { clearTimeout(t); r(); });
      });
    }
    // killSessions:false — the master fds now live in the successor.
    await this.close({ killSessions: false });
    setTimeout(() => process.exit(0), 50).unref();
  }

  /**
   * Phase 2 handoff (receiver): rebuild the store from the snapshot, taking
   * each session's master fd from our inherited stdio at `fdIndex`. All-or-
   * nothing: on any failure, close only OUR inherited copies and rethrow —
   * the predecessor keeps ownership and keeps serving.
   */
  adoptSnapshot(snapshot: HandoffSnapshot): void {
    const adopted: LiveSession[] = [];
    try {
      for (const s of snapshot.sessions) {
        // fdIndex 0..3 are our own stdio/IPC slots — a snapshot claiming one
        // would make us read the daemon's stderr (or IPC channel) as terminal
        // output. Reject before adoptFromFd touches the descriptor.
        if (!Number.isInteger(s.fdIndex) || s.fdIndex < 4) throw new Error(`invalid fdIndex ${s.fdIndex}`);
        const pty = adoptFromFd({ fd: s.fdIndex, pid: s.pid, cols: s.cols, rows: s.rows });
        try {
          const session = this.store.add(s.id, pty) as LiveSession;
          // Registered before anything else can throw — rollback must see it.
          adopted.push(session);
          // Through appendOutput so the restored bytes obey the ring cap (a
          // snapshot from a daemon with a larger cap must not raise ours).
          if (s.buffer.byteLength > 0) this.store.appendOutput(session, s.buffer);
          this.wireSession(session);
        } catch (err) {
          pty.closeLocal?.();
          throw err;
        }
      }
    } catch (err) {
      for (const session of adopted) {
        session.pty.closeLocal?.();
        this.store.delete(session.id);
      }
      throw err;
    }
  }

  /**
   * Successor bind: the predecessor's close() runs an instant before our
   * listen(), so retry both EADDRINUSE and our own steal-guard's refusal
   * (its socket may still answer while winding down) for up to timeoutMs.
   */
  async listenWithRetry(timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - start < timeoutMs) {
      try {
        await this.listen();
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        const stealRefusal = (err as Error).message?.includes('refusing to steal');
        if (code !== 'EADDRINUSE' && !stealRefusal) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw lastErr ?? new Error('listenWithRetry timed out');
  }
}

const HANDOFF_ACK_TIMEOUT_MS = 5_000;

function waitForHandoffAck(
  child: childProcess.ChildProcess,
  timeoutMs: number = HANDOFF_ACK_TIMEOUT_MS,
): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: UpgradeResult) => {
      if (settled) return;
      settled = true;
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      child.removeListener('disconnect', onDisconnect);
      clearTimeout(timer);
      resolve(r);
    };
    const onMessage = (raw: unknown) => {
      const msg = raw as Partial<HandoffMessage>;
      if (msg?.type === 'upgrade-ack') {
        if (typeof msg.successorPid !== 'number' || !Number.isInteger(msg.successorPid) || msg.successorPid <= 0) {
          settle({ ok: false, reason: `successor sent invalid ack pid: ${String(msg.successorPid)}` });
          return;
        }
        settle({ ok: true, successorPid: msg.successorPid });
      } else if (msg?.type === 'upgrade-nak') {
        settle({ ok: false, reason: msg.reason ?? 'successor sent nak' });
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle({ ok: false, reason: `successor exited before ack (code=${code} signal=${signal})` });
    };
    const onError = (err: Error) => {
      settle({ ok: false, reason: `successor spawn error before ack: ${err.message}` });
    };
    const onDisconnect = () => {
      settle({ ok: false, reason: 'successor IPC disconnected before ack' });
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
    child.on('disconnect', onDisconnect);
    const timer = setTimeout(() => {
      settle({ ok: false, reason: `successor ack timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}
