import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { EventEmitter } from 'node:events';
import { defaultShell } from './platform.js';

export type TerminalStatus = 'running' | 'exited';
export type TerminalInfo = { status: TerminalStatus; pid: number | null; exitCode: number | null };

export type SpawnSpec = { file: string; args: string[] };
export type BuildSpec = (cwd: string) => SpawnSpec;
// Applied to whichever spec won — the built-in one or a caller's override —
// as the LAST step before spawning. The sandbox uses it to re-point a session
// at the worktree's container (services/sandbox/spec.ts); undefined means the
// spec spawns exactly as it always has.
export type SpecWrapper = (cwd: string, spec: SpawnSpec) => SpawnSpec;

export type LiveSession = { path: string; mode: 'claude' | 'shell' | 'codex' | 'opencode'; id: string };

// Shell 1 keeps the historical un-suffixed key so sessions that were live
// before this change survive without migration.
export function shellKey(path: string, id: string): string {
  return id === '1' ? `${path}\0shell` : `${path}\0shell:${id}`;
}

// Claude 1 keeps the historical bare-path key for the same reason.
export function claudeKey(path: string, id: string): string {
  return id === '1' ? path : `${path}\0claude:${id}`;
}

// Codex 1 keeps the historical suffix-only key for the same reason.
export function codexKey(path: string, id: string): string {
  return id === '1' ? `${path}\0codex` : `${path}\0codex:${id}`;
}

// OpenCode 1 keeps the historical suffix-only key for the same reason.
export function opencodeKey(path: string, id: string): string {
  return id === '1' ? `${path}\0opencode` : `${path}\0opencode:${id}`;
}

export function parseSessionKey(key: string): LiveSession {
  const [path, suffix] = key.split('\0');
  if (!suffix) return { path: path!, mode: 'claude', id: '1' };
  if (suffix === 'codex') return { path: path!, mode: 'codex', id: '1' };
  if (suffix === 'opencode') return { path: path!, mode: 'opencode', id: '1' };
  if (suffix.startsWith('claude:')) return { path: path!, mode: 'claude', id: suffix.slice('claude:'.length) };
  if (suffix.startsWith('codex:')) return { path: path!, mode: 'codex', id: suffix.slice('codex:'.length) };
  if (suffix.startsWith('opencode:')) return { path: path!, mode: 'opencode', id: suffix.slice('opencode:'.length) };
  const id = suffix === 'shell' ? '1' : suffix.slice('shell:'.length);
  return { path: path!, mode: 'shell', id };
}

// The session-presence payload carried on worktree.updated events and the
// worktrees listing — derived from one worktree's live sessions. Single
// builder so the WS route, exit handler, kill route, and listing agree.
export function sessionsPayload(live: LiveSession[]) {
  const ids = (mode: LiveSession['mode']) =>
    live.filter((s) => s.mode === mode).map((s) => s.id).sort((a, b) => Number(a) - Number(b));
  const shellSessions = ids('shell');
  const claudeSessions = ids('claude');
  const codexSessions = ids('codex');
  const opencodeSessions = ids('opencode');
  return {
    hasClaudeSession: claudeSessions.length > 0,
    hasCodexSession: codexSessions.length > 0,
    hasOpencodeSession: opencodeSessions.length > 0,
    hasShellSession: shellSessions.length > 0,
    shellSessions,
    claudeSessions,
    codexSessions,
    opencodeSessions,
  };
}

// Vars that identify *this Strado instance* and must not leak into child
// shells. Two sources populate these: (1) applyProfileEnv writes profile
// identity (STRADO_HOME, STRADO_CONFIG_DIR, STRADO_PROFILE, PORT); (2)
// main.cjs sets packaging-specific paths/flags (STRADO_EMBEDS, STRADO_WEB_DIST,
// STRADO_HOOKS_DIR, STRADO_CDP_PORT). Without stripping, a nested instance
// (e.g., `npm run dev` in a terminal) inherits the outer instance's identity —
// wrong port, wrong hooks dir, wrong web dist, dead preview tabs.
//
// Deliberately NOT stripped: STRADO_INPROC_PTY is a test/break-glass toggle
// that nested instances should inherit. STRADO_LICENSE_REQUIRED gates the
// entire API and is handled separately.
const INSTANCE_IDENTITY_KEYS = [
  'STRADO_HOME',
  'STRADO_CONFIG_DIR',
  'STRADO_PROFILE',
  'PORT',
  'STRADO_EMBEDS',
  'STRADO_WEB_DIST',
  'STRADO_HOOKS_DIR',
  'STRADO_CDP_PORT',
] as const;

// Env every session spawns with, shared by the in-process manager and the
// ptyd-backed one. STRADO_SESSION_ID is derived from the session key so
// child processes (Claude Code hooks) can attribute their status posts to
// the right tab — two Claude sessions in one worktree must not overwrite
// each other.
export function sessionEnv(key: string, cwd: string): Record<string, string> {
  const env = { ...process.env };
  for (const k of INSTANCE_IDENTITY_KEYS) delete env[k];
  return {
    ...env,
    // STRADO_WORKTREE lets tools inside the session (the per-worktree
    // preview MCP) resolve which worktree they belong to without guessing
    // from cwd.
    STRADO_WORKTREE: cwd,
    // Lets the opencode status plugin (and any future in-session tool)
    // reach this server without guessing the port.
    STRADO_STATUS_PORT: String(process.env.PORT ?? 7777),
    // The per-worktree preview MCP (packages/desktop/preview-mcp.cjs) asks this
    // server which CDP target belongs to the worktree. Without this it falls
    // back to :7777 — so an agent under the dev instance would drive the
    // release instance's browser.
    STRADO_SERVER: `http://127.0.0.1:${process.env.PORT ?? 7777}`,
    STRADO_SESSION_ID: parseSessionKey(key).id,
  } as Record<string, string>;
}

const MAX_BUFFER = 256 * 1024;

const defaultBuildSpec: BuildSpec = () => ({
  file: defaultShell(),
  args: ['-l', '-c', 'claude'],
});

export type TerminalManager = {
  ensure(key: string, cwd: string, spec?: SpawnSpec, size?: { cols: number; rows: number }): Promise<TerminalInfo>;
  write(key: string, data: string): void;
  resize(key: string, cols: number, rows: number): void;
  snapshot(key: string): string;
  subscribe(key: string, cb: (data: string) => void): () => void;
  onExit(key: string, cb: (exitCode: number) => void): () => void;
  status(key: string): TerminalInfo;
  kill(key: string): void;
  killUnder(pathPrefix: string): void;
  liveSessions(): LiveSession[];
};

type Session = {
  pty: IPty;
  buffer: string;
  emitter: EventEmitter;
  info: TerminalInfo;
};

export function createTerminalManager(
  buildSpec: BuildSpec = defaultBuildSpec,
  onData?: (key: string) => void,
  onExit?: (key: string) => void,
  wrapSpec?: SpecWrapper,
): TerminalManager {
  const sessions = new Map<string, Session>();

  // One place where a spec is settled, so the wrapper cannot be bypassed by
  // the override path. Mirrored in ptyDaemon/manager.ts.
  const resolveSpec = (cwd: string, override?: SpawnSpec): SpawnSpec => {
    const spec = override ?? buildSpec(cwd);
    return wrapSpec ? wrapSpec(cwd, spec) : spec;
  };

  function spawn(key: string, cwd: string, override?: SpawnSpec, size?: { cols: number; rows: number }): Session {
    const spec = resolveSpec(cwd, override);
    const term = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      // spawn at the requesting client's real size when known: resize
      // messages sent during connection setup can be lost, and a CLI that
      // painted at 80x24 stays wrong until something else triggers a resize
      cols: size?.cols ?? 80,
      rows: size?.rows ?? 24,
      cwd,
      env: sessionEnv(key, cwd),
    });
    const session: Session = {
      pty: term,
      buffer: '',
      emitter: new EventEmitter(),
      info: { status: 'running', pid: term.pid, exitCode: null },
    };
    session.emitter.setMaxListeners(0);
    term.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > MAX_BUFFER) {
        session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
      }
      session.emitter.emit('data', data);
      onData?.(key);
    });
    term.onExit(({ exitCode }) => {
      session.info.status = 'exited';
      session.info.exitCode = exitCode;
      session.info.pid = null;
      session.emitter.emit('exit', exitCode);
      onExit?.(key);
    });
    sessions.set(key, session);
    return session;
  }

  return {
    async ensure(key, cwd, spec, size) {
      let s = sessions.get(key);
      if (!s || s.info.status === 'exited') s = spawn(key, cwd, spec, size);
      return { ...s.info };
    },
    write(key, data) {
      const s = sessions.get(key);
      if (s && s.info.status === 'running') s.pty.write(data);
    },
    resize(key, cols, rows) {
      const s = sessions.get(key);
      if (s && s.info.status === 'running') {
        try { s.pty.resize(cols, rows); } catch { /* ignore invalid dims */ }
      }
    },
    snapshot(key) {
      return sessions.get(key)?.buffer ?? '';
    },
    subscribe(key, cb) {
      const s = sessions.get(key);
      if (!s) return () => {};
      s.emitter.on('data', cb);
      return () => s.emitter.off('data', cb);
    },
    onExit(key, cb) {
      const s = sessions.get(key);
      if (!s) return () => {};
      s.emitter.on('exit', cb);
      return () => s.emitter.off('exit', cb);
    },
    status(key) {
      return sessions.get(key)?.info ?? { status: 'exited', pid: null, exitCode: null };
    },
    kill(key) {
      const s = sessions.get(key);
      if (!s || s.info.status !== 'running') return;
      const pid = s.info.pid;
      try { s.pty.kill(); } catch { /* already gone */ } // SIGHUP: graceful for shells
      // Some interactive CLIs (notably Claude Code) survive SIGHUP, so the pty
      // never exits and the session lingers as "running". Escalate: if it's
      // still alive after a grace period, SIGKILL the whole process group —
      // negative pid reaches the session's children (e.g. MCP servers) too.
      if (pid == null) return;
      setTimeout(() => {
        if (sessions.get(key) !== s || s.info.status !== 'running') return; // exited cleanly / replaced
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }, 2_000);
    },
    killUnder(pathPrefix) {
      const under = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
      for (const [key, s] of sessions) {
        // Keys may carry a mode suffix after a NUL (e.g. "<path>\0shell");
        // match on the worktree-path portion so all of a worktree's sessions
        // are cleaned up together.
        const worktreePath = key.split('\0')[0]!;
        if ((worktreePath === pathPrefix || worktreePath.startsWith(under)) && s.info.status === 'running') {
          try { s.pty.kill(); } catch { /* ignore */ }
        }
      }
    },
    liveSessions() {
      const out: LiveSession[] = [];
      for (const [key, s] of sessions) {
        if (s.info.status !== 'running') continue;
        out.push(parseSessionKey(key));
      }
      return out;
    },
  };
}
