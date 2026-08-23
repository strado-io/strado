// Single persistent connection to strado-ptyd. Fire-and-forget for the hot
// path (input/resize/close); request-reply only for open (correlated by
// session id) and list (serialized — one outstanding at a time is plenty
// for our single-server client).

import net from 'node:net';
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionInfo,
  type SessionMeta,
  type UpgradeResult,
} from '@strado/ptyd/protocol';

export interface DaemonClient {
  connect(): Promise<void>;
  open(id: string, meta: SessionMeta): Promise<{ pid: number }>;
  input(id: string, data: Buffer): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  list(): Promise<SessionInfo[]>;
  prepareUpgrade(): Promise<UpgradeResult>;
  subscribe(id: string, replay: boolean): void;
  onOutput(cb: (id: string, chunk: Buffer) => void): void;
  onSessionExit(cb: (id: string, code: number | null) => void): void;
  onDisconnect(cb: () => void): void;
  destroy(): void;
}

const OPEN_TIMEOUT_MS = 10_000;

export function createDaemonClient(socketPath: string): DaemonClient {
  let socket: net.Socket | null = null;
  let destroyed = false;
  const outputCbs: Array<(id: string, chunk: Buffer) => void> = [];
  const exitCbs: Array<(id: string, code: number | null) => void> = [];
  const disconnectCbs: Array<() => void> = [];
  const pendingOpens = new Map<string, { resolve: (v: { pid: number }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const pendingLists: Array<{ resolve: (v: SessionInfo[]) => void; reject: (e: Error) => void }> = [];
  const pendingUpgrades: Array<{ resolve: (v: UpgradeResult) => void; reject: (e: Error) => void }> = [];

  const send = (msg: object, payload?: Buffer) => {
    if (!socket || socket.destroyed) return;
    socket.write(encodeFrame(msg, payload));
  };

  const handleMessage = (msg: ServerMessage, payload: Buffer | null) => {
    switch (msg.type) {
      case 'output':
        if (payload) for (const cb of outputCbs) cb(msg.id, payload);
        return;
      case 'exit':
        for (const cb of exitCbs) cb(msg.id, msg.code);
        return;
      case 'open-ack': {
        const p = pendingOpens.get(msg.id);
        if (p) { pendingOpens.delete(msg.id); clearTimeout(p.timer); p.resolve({ pid: msg.pid }); }
        return;
      }
      case 'open-err': {
        const p = pendingOpens.get(msg.id);
        if (p) { pendingOpens.delete(msg.id); clearTimeout(p.timer); p.reject(new Error(msg.message)); }
        return;
      }
      case 'list-reply': {
        pendingLists.shift()?.resolve(msg.sessions);
        return;
      }
      case 'upgrade-prepared': {
        pendingUpgrades.shift()?.resolve(msg.result);
        return;
      }
      case 'error':
        // Expected during adoption races (subscribe vs exit); safe to ignore.
        return;
      default:
        return;
    }
  };

  const failAllPending = (reason: string) => {
    for (const [id, p] of pendingOpens) {
      clearTimeout(p.timer);
      p.reject(new Error(`daemon connection lost: ${reason}`));
      pendingOpens.delete(id);
    }
    for (const p of pendingLists.splice(0)) p.reject(new Error(`daemon connection lost: ${reason}`));
    for (const p of pendingUpgrades.splice(0)) p.reject(new Error(`daemon connection lost: ${reason}`));
  };

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const s = net.connect(socketPath);
        // Claim "current" before any event can fire. During an upgrade two
        // handshaked sockets coexist; every handler below compares
        // `s !== socket` so a superseded predecessor's late frames/teardown
        // cannot touch shared state belonging to the successor.
        socket = s;
        // Per-connection decoder: a shared one would let the predecessor's
        // trailing bytes corrupt the successor's frame boundaries.
        const decoder = new FrameDecoder();
        let helloAcked = false;
        s.once('connect', () => s.write(encodeFrame({ type: 'hello', protocols: [PROTOCOL_VERSION] })));
        s.on('data', (chunk) => {
          if (s !== socket) return; // superseded connection — its frames are stale
          try {
            decoder.push(chunk);
            for (const frame of decoder.drain()) {
              const msg = frame.message as ServerMessage;
              if (!helloAcked) {
                if (msg.type === 'hello-ack') { helloAcked = true; resolve(); }
                else { s.destroy(); reject(new Error(`expected hello-ack, got ${msg.type}`)); }
                continue;
              }
              handleMessage(msg, frame.payload);
            }
          } catch (err) {
            s.destroy();
            if (!helloAcked) reject(err as Error);
          }
        });
        let goneFired = false;
        const onGone = (err?: Error) => {
          if (goneFired) return; // 'error' is always followed by 'close' — fire once per connection
          goneFired = true;
          if (s !== socket) {
            // Superseded connection dying late — current conn is healthy, but a
            // mid-handshake loser must still settle its connect() promise.
            if (!helloAcked) reject(err ?? new Error('connection superseded'));
            return;
          }
          failAllPending(err?.message ?? 'socket closed');
          if (!helloAcked) reject(err ?? new Error('socket closed during handshake'));
          else if (!destroyed) for (const cb of disconnectCbs) cb();
        };
        s.once('error', onGone);
        s.once('close', () => onGone());
      });
    },
    open(id, meta) {
      return new Promise((resolve, reject) => {
        if (!socket || socket.destroyed) return reject(new Error('daemon not connected'));
        const timer = setTimeout(() => {
          pendingOpens.delete(id);
          reject(new Error(`open timed out for ${id}`));
        }, OPEN_TIMEOUT_MS);
        pendingOpens.set(id, { resolve, reject, timer });
        send({ type: 'open', id, meta });
      });
    },
    input: (id, data) => send({ type: 'input', id }, data),
    resize: (id, cols, rows) => send({ type: 'resize', id, cols, rows }),
    close: (id) => send({ type: 'close', id }),
    list() {
      return new Promise((resolve, reject) => {
        if (!socket || socket.destroyed) return reject(new Error('daemon not connected'));
        pendingLists.push({ resolve, reject });
        send({ type: 'list' });
      });
    },
    prepareUpgrade() {
      return new Promise<UpgradeResult>((resolve, reject) => {
        if (!socket || socket.destroyed) return reject(new Error('daemon not connected'));
        const timer = setTimeout(() => {
          const i = pendingUpgrades.findIndex((p) => p.resolve === wrapped.resolve);
          if (i >= 0) pendingUpgrades.splice(i, 1);
          reject(new Error('prepare-upgrade timed out'));
        }, 15_000);
        const wrapped = {
          resolve: (v: UpgradeResult) => { clearTimeout(timer); resolve(v); },
          reject: (e: Error) => { clearTimeout(timer); reject(e); },
        };
        pendingUpgrades.push(wrapped);
        send({ type: 'prepare-upgrade' });
      });
    },
    subscribe: (id, replay) => send({ type: 'subscribe', id, replay }),
    onOutput: (cb) => { outputCbs.push(cb); },
    onSessionExit: (cb) => { exitCbs.push(cb); },
    onDisconnect: (cb) => { disconnectCbs.push(cb); },
    destroy() {
      destroyed = true;
      failAllPending('client destroyed');
      socket?.destroy();
    },
  };
}
