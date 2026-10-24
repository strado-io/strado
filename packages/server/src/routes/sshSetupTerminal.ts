// The terminal of an "Add over SSH" run: the one pty a setup job opens for the
// steps a person must answer (the first connect's password or host key, sudo).
// Attach only — the job spawns and kills it. Every frame is JSON so the exit
// can't be faked by what the remote box prints.
import type { FastifyInstance } from 'fastify';
import type { JobQueue } from '../services/jobs.js';
import { SSH_SETUP_KEY_PREFIX, SSH_SETUP_ROUTES } from '../services/sshSetup/types.js';
import { isSetupKey, type TerminalManager } from '../services/terminalManager.js';
import { assertLocalHub } from './profile.js';

type ClientMsg = { type: 'data'; data: string } | { type: 'resize'; cols: number; rows: number };
type ServerFrame = { type: 'data'; data: string } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };

const dim = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : null;
};

/** The Origin is this server's own: a loopback host on the very port the
 * request reached (Host). No Origin at all is refused too. */
export function sameOrigin(origin: string | string[] | undefined, host: string | string[] | undefined): boolean {
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  let o: URL;
  let h: URL;
  try {
    o = new URL(origin);
    h = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const loopback = (n: string) => n === 'localhost' || n === '127.0.0.1' || n === '[::1]';
  const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');
  return (o.protocol === 'http:' || o.protocol === 'https:') && loopback(o.hostname) && loopback(h.hostname) && port(o) === port(h);
}

/** A setup key is `${prefix}${jobId}`: owned while that ssh-setup job runs. */
export function jobOwnsKey(jobs: Pick<JobQueue, 'get'>): (key: string) => boolean {
  return (key) => {
    if (!isSetupKey(key)) return false;
    const job = jobs.get(key.slice(SSH_SETUP_KEY_PREFIX.length));
    return !!job && job.kind === 'ssh-setup' && job.status === 'running';
  };
}

export async function registerSshSetupTerminalRoutes(
  app: FastifyInstance,
  deps: {
    /** True while a running setup job owns this key. Defaults to jobOwnsKey(app.deps.jobs). */
    owns?: (key: string) => boolean;
    terminal?: Pick<TerminalManager, 'snapshot' | 'subscribe' | 'onExit' | 'status' | 'write' | 'resize'>;
  },
): Promise<void> {
  app.get<{ Querystring: { key?: string; cols?: string; rows?: string } }>(
    SSH_SETUP_ROUTES.terminal,
    { websocket: true },
    (connection, req) => {
      const socket = connection.socket;
      const term = deps.terminal ?? app.deps.terminal;
      const send = (frame: ServerFrame) => {
        if (socket.readyState !== socket.OPEN) return;
        try { socket.send(JSON.stringify(frame)); } catch { /* gone */ }
      };
      // The local hub only: this pty types into ssh on the user's behalf. And
      // stricter than other hub routes: the hub page itself, so an Origin is
      // required and must be this server's own (another local port is another app).
      try {
        assertLocalHub(req.headers);
        if (!sameOrigin(req.headers.origin, req.headers.host)) throw new Error('origin');
      } catch {
        send({ type: 'error', message: 'only this machine can attach' });
        socket.close(4403);
        return;
      }
      const key = req.query.key ?? '';
      const owns = deps.owns ?? jobOwnsKey(app.deps.jobs);
      if (!isSetupKey(key) || !owns(key)) {
        send({ type: 'error', message: 'not a setup terminal' });
        socket.close(4404);
        return;
      }

      const cols = dim(req.query.cols);
      const rows = dim(req.query.rows);
      const live = term.status(key).status === 'running';
      if (live && cols && rows) term.resize(key, cols, rows);
      send({ type: 'data', data: term.snapshot(key) });

      const end = (code: number | null) => {
        send({ type: 'exit', code });
        socket.close(1000);
      };
      if (!live) {
        end(term.status(key).exitCode);
        return;
      }
      const unsub = term.subscribe(key, (data) => send({ type: 'data', data }));
      const unsubExit = term.onExit(key, (code) => end(code));
      socket.on('message', (raw: Buffer) => {
        let msg: ClientMsg;
        try { msg = JSON.parse(raw.toString()) as ClientMsg; } catch { return; }
        if (msg.type === 'data' && typeof msg.data === 'string') term.write(key, msg.data);
        else if (msg.type === 'resize') {
          const c = dim(msg.cols);
          const r = dim(msg.rows);
          if (c && r) term.resize(key, c, r);
        }
      });
      socket.on('close', () => { unsub(); unsubExit(); });
    },
  );
}
