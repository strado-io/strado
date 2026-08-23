// TerminalManager implemented over strado-ptyd. The server keeps a local
// mirror per session (status + decoded scrollback + EventEmitter) so every
// interface method except ensure() stays synchronous. The daemon's byte ring
// buffer is the source of truth; the mirror refills from replay on (re)connect.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionMeta, UpgradeResult } from '@strado/ptyd/protocol';
import {
  parseSessionKey,
  sessionEnv,
  type BuildSpec,
  type LiveSession,
  type SpawnSpec,
  type SpecWrapper,
  type TerminalInfo,
  type TerminalManager,
} from '../terminalManager.js';
import { createDaemonClient, type DaemonClient } from './client.js';
import { ensurePtyDaemon, probeDaemon, readExpectedDaemonVersion, versionLess } from './supervisor.js';
import { defaultShell } from '../platform.js';
// CJS packages: named imports fail under Node ESM (the runtime lexer doesn't
// see `Terminal`/`SerializeAddon` as named exports), so import the default.
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const HeadlessTerminal = headlessPkg.Terminal;
const SerializeAddon = serializePkg.SerializeAddon;
type HeadlessTerm = InstanceType<typeof HeadlessTerminal>;
type Serialize = InstanceType<typeof SerializeAddon>;

const MAX_MIRROR = 256 * 1024; // chars, same cap as the old in-process buffer

const defaultBuildSpec: BuildSpec = () => ({
  file: defaultShell(),
  args: ['-l', '-c', 'claude'],
});

type Mirror = {
  info: TerminalInfo;
  buffer: string;
  decoder: StringDecoder; // one per session: chunk edges can split multibyte chars
  emitter: EventEmitter;
  // Server-side terminal emulator for the session's SCREEN. The daemon's byte
  // ring buffer (mirrored in `buffer`) is raw output, which cannot reconstruct
  // a live alt-screen TUI on reconnect: a long-running app (opencode/opentui)
  // draws its base frame once, then emits only deltas, so the base scrolls out
  // of the ring and a replay paints nothing. Feeding the same bytes into this
  // emulator keeps a live cell grid — always the current screen regardless of
  // how many bytes flowed — so snapshot() can serialize it (alt-screen and all)
  // the way tmux reattaches. See snapshot().
  emu: HeadlessTerm;
  serialize: Serialize;
};

const makeEmu = (cols: number, rows: number): { emu: HeadlessTerm; serialize: Serialize } => {
  const emu = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const serialize = new SerializeAddon();
  emu.loadAddon(serialize);
  return { emu, serialize };
};

// Replace a mirror's emulator with a fresh one at the given size. Called
// wherever the byte mirror is cleared for a daemon replay (open, resync): the
// replay re-feeds the whole ring buffer, so the emulator must start empty and
// the right size or the reconstructed screen would be doubled or clipped.
const resetEmu = (m: Mirror, cols: number, rows: number) => {
  try { m.emu.dispose(); } catch { /* ignore */ }
  const next = makeEmu(cols, rows);
  m.emu = next.emu;
  m.serialize = next.serialize;
};

export type DaemonTerminalManagerOptions = {
  stateDir: string;
  daemonScript: string;
  buildSpec?: BuildSpec;
  wrapSpec?: SpecWrapper;
  onData?: (key: string) => void;
  onExit?: (key: string) => void;
};

export async function createDaemonTerminalManager(
  opts: DaemonTerminalManagerOptions,
): Promise<TerminalManager & { destroy(): void }> {
  const buildSpec = opts.buildSpec ?? defaultBuildSpec;
  // One place where a spec is settled, so the wrapper cannot be bypassed by
  // the override path. Mirrored in terminalManager.ts.
  const resolveSpec = (cwd: string, override?: SpawnSpec): SpawnSpec => {
    const spec = override ?? buildSpec(cwd);
    return opts.wrapSpec ? opts.wrapSpec(cwd, spec) : spec;
  };
  const mirrors = new Map<string, Mirror>();
  const inflightOpens = new Map<string, Promise<TerminalInfo>>();

  const { socketPath, daemonVersion } = await ensurePtyDaemon({ stateDir: opts.stateDir, daemonScript: opts.daemonScript });
  const client: DaemonClient = createDaemonClient(socketPath);
  await client.connect();

  const mirror = (key: string): Mirror => {
    let m = mirrors.get(key);
    if (!m) {
      const { emu, serialize } = makeEmu(80, 24); // real size set on open/resync
      m = {
        info: { status: 'exited', pid: null, exitCode: null },
        buffer: '',
        decoder: new StringDecoder('utf8'),
        emitter: new EventEmitter(),
        emu,
        serialize,
      };
      m.emitter.setMaxListeners(0);
      mirrors.set(key, m);
    }
    return m;
  };

  // Subscriber callbacks are host code (app.ts wiring). A throw from one must
  // never abort a resync/reconnect loop mid-iteration or surface as an
  // unhandled rejection — log and carry on.
  const notifyData = (key: string) => {
    try {
      opts.onData?.(key);
    } catch (err) {
      process.stderr.write(`[ptyd-manager] subscriber callback threw: ${(err as Error)?.message ?? err}\n`);
    }
  };
  const notifyExit = (key: string) => {
    try {
      opts.onExit?.(key);
    } catch (err) {
      process.stderr.write(`[ptyd-manager] subscriber callback threw: ${(err as Error)?.message ?? err}\n`);
    }
  };

  client.onOutput((key, chunk) => {
    const m = mirror(key);
    const text = m.decoder.write(chunk);
    if (!text) return;
    m.buffer += text;
    if (m.buffer.length > MAX_MIRROR) m.buffer = m.buffer.slice(m.buffer.length - MAX_MIRROR);
    m.emu.write(text); // keep the screen emulator current for snapshot()
    m.emitter.emit('data', text);
    notifyData(key);
  });

  client.onSessionExit((key, code) => {
    if (!mirrors.has(key)) return; // foreign session (other client's) — not ours
    const m = mirror(key);
    m.info = { status: 'exited', pid: null, exitCode: code };
    m.emitter.emit('exit', code ?? 0);
    notifyExit(key);
  });

  // Recovery both at boot (adopt a daemon that outlived the last server) and
  // when the daemon connection drops (daemon crashed or was restarted).
  const resync = async () => {
    const sessions = await client.list();
    const liveIds = new Set(sessions.map((s) => s.id));
    for (const s of sessions) {
      const m = mirror(s.id);
      m.info = { status: 'running', pid: s.pid, exitCode: null };
      m.buffer = '';
      m.decoder = new StringDecoder('utf8');
      resetEmu(m, s.cols, s.rows); // replay rebuilds the screen at the daemon's size
      client.subscribe(s.id, true); // replay refills the mirror buffer
    }
    // Anything we believed was running but the daemon no longer has, exited
    // while we were away.
    for (const [key, m] of mirrors) {
      if (m.info.status === 'running' && !liveIds.has(key)) {
        m.info = { status: 'exited', pid: null, exitCode: null };
        m.emitter.emit('exit', 0);
        notifyExit(key);
      }
    }
  };
  await resync();

  let destroyed = false;
  let reconnecting = false;
  let connected = true; // set false on disconnect, true after successful (re)connect+resync
  // True while a deliberate daemon upgrade is in flight: the disconnect is
  // EXPECTED and the sessions are alive in the successor — do not mark
  // mirrors exited, do not emit exit events, do not run the crash loop.
  let upgrading = false;
  // Handle of the in-flight background reconnect loop, so ensure() can join
  // it instead of racing a duplicate spawn/connect while one is underway.
  let reconnectPromise: Promise<void> | null = null;
  // Handle of the in-flight upgrade (boot-time today, runtime-triggered if we
  // ever add it), so ensure() can join it rather than re-arming underneath a
  // handoff that is about to reconnect anyway.
  let upgradePromise: Promise<void> | null = null;
  client.onDisconnect(() => {
    connected = false;
    if (destroyed || reconnecting || upgrading) return;
    reconnecting = true;
    // Daemon died: every session died with it. Respawn the daemon and
    // reconnect so new terminals keep working; mark old sessions exited.
    reconnectPromise = (async () => {
      try {
        for (const [key, m] of mirrors) {
          if (m.info.status === 'running') {
            m.info = { status: 'exited', pid: null, exitCode: null };
            m.emitter.emit('exit', 0);
            notifyExit(key);
          }
        }
        for (let attempt = 0; attempt < 5 && !destroyed; attempt++) {
          try {
            await ensurePtyDaemon({ stateDir: opts.stateDir, daemonScript: opts.daemonScript });
            if (destroyed) return;
            await client.connect();
            if (destroyed) return;
            await resync();
            connected = true;
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            if (destroyed) return;
          }
        }
        if (!destroyed) {
          process.stderr.write('[ptyd-manager] reconnect gave up after 5 attempts; terminals unavailable until server restart\n');
        }
      } finally {
        reconnecting = false;
        reconnectPromise = null;
      }
    })();
  });

  async function upgradeDaemon(running: string, expected: string): Promise<void> {
    process.stderr.write(`[ptyd-manager] daemon v${running} < bundled v${expected}; upgrading via fd handoff\n`);
    upgrading = true;
    try {
      let result: UpgradeResult;
      try {
        result = await client.prepareUpgrade();
      } catch (err) {
        // Reply lost in the disconnect race — the handoff may still have
        // succeeded. Fall through to reconnect; resync tells the truth.
        process.stderr.write(`[ptyd-manager] prepare-upgrade reply lost (${(err as Error).message}); reconnecting\n`);
        result = { ok: true as const, successorPid: -1 };
      }
      if (!result.ok) {
        process.stderr.write(`[ptyd-manager] daemon refused upgrade: ${result.reason}; staying on v${running}\n`);
        return; // conn is still alive; nothing changed
      }
      // Predecessor is exiting. Reconnect to the successor with patience —
      // it binds only after the predecessor fully closes.
      const deadline = Date.now() + 10_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 200));
        if (destroyed) return;
        try {
          // Adopt-only: probe the socket for the successor. ensurePtyDaemon
          // would SPAWN on probe failure, and a fresh zero-session daemon
          // racing the successor's bind can starve it into exiting with
          // every session. Only probe until the deadline.
          await probeDaemon(socketPath, 1_000);
          // Now guaranteed to adopt: rewrites the manifest to the successor's pid.
          await ensurePtyDaemon({ stateDir: opts.stateDir, daemonScript: opts.daemonScript });
          if (destroyed) return;
          await client.connect();
          if (destroyed) return;
          await resync(); // sessions come back running — no exit events fired
          connected = true;
          process.stderr.write('[ptyd-manager] upgrade complete; sessions preserved\n');
          return;
        } catch (err) {
          if (Date.now() > deadline) {
            // Successor never answered. Last resort: spawn-capable ensure so
            // terminals at least work again (sessions are gone either way).
            process.stderr.write(
              `[ptyd-manager] successor never answered: ${(err as Error).message}; falling back\n`,
            );
            try {
              await ensurePtyDaemon({ stateDir: opts.stateDir, daemonScript: opts.daemonScript });
              await client.connect();
              await resync();
              connected = true;
            } catch { /* next disconnect/ensure re-arms */ }
            return;
          }
        }
      }
    } finally {
      upgrading = false;
    }
  }

  const HANDOFF_FLOOR = '0.2.0'; // first daemon version that understands prepare-upgrade
  const expectedDaemonVersion = readExpectedDaemonVersion(opts.daemonScript);
  if (expectedDaemonVersion && versionLess(daemonVersion, expectedDaemonVersion)) {
    if (versionLess(daemonVersion, HANDOFF_FLOOR)) {
      // A pre-handoff daemon answers prepare-upgrade with an EPROTO error frame
      // it never even routes back to us — asking would just burn the 15s client
      // timeout on every boot and report a bogus "upgrade complete".
      const manifest = path.join(opts.stateDir, 'ptyd', 'manifest.json');
      process.stderr.write(
        `[ptyd-manager] running daemon v${daemonVersion} predates fd handoff; ` +
          `it cannot be upgraded in place — stop it manually when its sessions drain ` +
          `(its pid is the "pid" field in ${manifest}) and the next boot ` +
          `spawns v${expectedDaemonVersion}\n`,
      );
    } else {
      upgradePromise = upgradeDaemon(daemonVersion, expectedDaemonVersion)
        // Like reconnectPromise, this handle must never reject: ensure() awaits
        // it to join a handoff, and a rejection there would fail a terminal open
        // for a failure the upgrade path already handled.
        .catch((err) => {
          process.stderr.write(`[ptyd-manager] upgrade failed: ${(err as Error)?.message ?? err}\n`);
        })
        .finally(() => {
          upgradePromise = null;
        });
      // A wedged handoff must not wedge server boot: give it 20s, then continue
      // constructing. The daemon (predecessor or successor) keeps running either
      // way, and the upgrade keeps going in the background — ensure() joins
      // `upgradePromise` before re-arming so it can't race the handoff.
      await Promise.race([upgradePromise, new Promise<void>((r) => setTimeout(r, 20_000).unref())]);
    }
  }

  return {
    async ensure(key, cwd, spec, size) {
      const m = mirror(key);
      if (m.info.status === 'running') return { ...m.info };
      // Two racing ensures (WS reconnect storm, second tab) must share one
      // open: the daemon rejects the duplicate and the client's per-id
      // pending entry would orphan the first caller into a 10s timeout.
      const inflight = inflightOpens.get(key);
      if (inflight) return inflight;
      const opening = (async () => {
        if (!connected) {
          // An upgrade handoff is a deliberate disconnect that reconnects
          // itself — join it before considering a re-arm, or we'd spawn/connect
          // underneath the successor's own reconnect.
          if (upgrading && upgradePromise) await upgradePromise;
          // A background reconnect may already be in flight (daemon just
          // died) — join it instead of racing a duplicate spawn/connect.
          // This never rejects: the loop swallows its own errors and only
          // sets `connected` on success.
          if (reconnecting && reconnectPromise) await reconnectPromise;
          if (!connected) {
            // Either the background loop gave up (daemon was down >15s), or
            // none was running at all. A new ensure is the user trying
            // again — re-arm the connection inline.
            await ensurePtyDaemon({ stateDir: opts.stateDir, daemonScript: opts.daemonScript });
            await client.connect();
            await resync();
            connected = true;
          }
        }
        const s: SpawnSpec = resolveSpec(cwd, spec);
        const meta: SessionMeta = {
          shell: s.file,
          argv: s.args,
          cwd,
          env: sessionEnv(key, cwd),
          cols: size?.cols ?? 80,
          rows: size?.rows ?? 24,
        };
        const { pid } = await client.open(key, meta);
        m.info = { status: 'running', pid, exitCode: null };
        m.buffer = '';
        m.decoder = new StringDecoder('utf8');
        resetEmu(m, meta.cols, meta.rows); // fresh screen at the spawn size
        // replay:true — the pty may emit its first bytes before our subscribe
        // frame lands; the ring buffer has them and the mirror was just
        // cleared, so replay is lossless and duplicate-free.
        client.subscribe(key, true);
        return { ...m.info };
      })();
      inflightOpens.set(key, opening);
      try {
        return await opening;
      } finally {
        inflightOpens.delete(key);
      }
    },
    write(key, data) {
      if (mirror(key).info.status === 'running') client.input(key, Buffer.from(data, 'utf8'));
    },
    resize(key, cols, rows) {
      const m = mirror(key);
      if (m.info.status === 'running') {
        client.resize(key, cols, rows);
        try { m.emu.resize(cols, rows); } catch { /* ignore invalid dims */ }
      }
    },
    snapshot(key) {
      const m = mirrors.get(key);
      if (!m) return '';
      // Serialize the emulator's current screen: a self-contained escape
      // sequence that reconstructs exactly what's on screen (alt-screen,
      // colors, cursor) when replayed into the client's fresh xterm. Falls
      // back to the raw byte mirror if serialization ever throws.
      try {
        let out = m.serialize.serialize();
        // @xterm/addon-serialize restores the mouse TRACKING mode (1000/1002/
        // 1003) but NOT the mouse ENCODING mode. A reattached mouse TUI
        // (opencode/opentui, lazygit, htop) still expects the SGR-encoded mouse
        // reports it enabled at startup; without re-asserting the encoding, the
        // fresh client terminal reverts to legacy X10 encoding and the app can't
        // parse clicks or wheel — select/scroll dies after a tab switch. Re-add
        // the encoding from the live emulator's mouse service (SGR / SGR_PIXELS;
        // DEFAULT needs nothing).
        const enc = (m.emu as unknown as {
          _core?: { coreMouseService?: { activeEncoding?: string } };
        })._core?.coreMouseService?.activeEncoding;
        if (enc === 'SGR') out += '\x1b[?1006h';
        else if (enc === 'SGR_PIXELS') out += '\x1b[?1016h';
        return out;
      } catch {
        return m.buffer;
      }
    },
    subscribe(key, cb) {
      const m = mirror(key);
      m.emitter.on('data', cb);
      return () => m.emitter.off('data', cb);
    },
    onExit(key, cb) {
      const m = mirror(key);
      m.emitter.on('exit', cb);
      return () => m.emitter.off('exit', cb);
    },
    status(key) {
      return mirrors.get(key)?.info ?? { status: 'exited', pid: null, exitCode: null };
    },
    kill(key) {
      if (mirror(key).info.status === 'running') client.close(key); // daemon escalates
    },
    killUnder(pathPrefix) {
      const under = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
      for (const [key, m] of mirrors) {
        const worktreePath = key.split('\0')[0]!;
        if ((worktreePath === pathPrefix || worktreePath.startsWith(under)) && m.info.status === 'running') {
          client.close(key);
        }
      }
    },
    liveSessions() {
      const out: LiveSession[] = [];
      for (const [key, m] of mirrors) {
        if (m.info.status !== 'running') continue;
        out.push(parseSessionKey(key));
      }
      return out;
    },
    destroy() {
      destroyed = true;
      for (const m of mirrors.values()) {
        try { m.emu.dispose(); } catch { /* ignore */ }
      }
      client.destroy();
    },
  };
}
