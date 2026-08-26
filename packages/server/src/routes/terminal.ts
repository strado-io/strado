import { FastifyInstance } from 'fastify';
import { assertPathUnder } from '../paths.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { installClaudeHooks, installOpencodePlugin, codexNotifyScriptPath } from '../services/claudeHooks.js';
import { claudeKey, codexKey, opencodeKey, sessionsPayload, shellKey } from '../services/terminalManager.js';
import { defaultShell } from '../services/platform.js';

type ClientMsg =
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// Best-effort plain-text view of a pty buffer for hover previews: strip ANSI
// escapes and control characters, keep the last non-empty lines.
function peekLines(buffer: string, max: number): string[] {
  const text = buffer
    // OSC sequences (titles, hyperlinks), then CSI/other escapes
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    // carriage-return overwrites: keep what the terminal would show
    .replace(/^.*\r(?!\n)/gm, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-max)
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
}

export async function registerTerminalRoutes(app: FastifyInstance) {
  // Hover peek: last lines of a session buffer as plain text.
  app.get<{ Querystring: { ws?: string; path?: string; mode?: string; session?: string } }>(
    '/api/terminal/peek',
    async (req) => {
      const target = req.query.path ?? '';
      const wsId = req.query.ws ?? '';
      const mode =
        req.query.mode === 'shell' ? 'shell'
        : req.query.mode === 'codex' ? 'codex'
        : req.query.mode === 'opencode' ? 'opencode'
        : 'claude';
      const sessionId = /^\d+$/.test(req.query.session ?? '') ? req.query.session! : '1';
      const stores = await app.deps.registry.get(wsId);
      const wsMeta = await app.deps.workspaces.get(wsId);
      const repos = await stores.repos.list();
      const repo = findOwningRepo(repos, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) return { lines: [] };
      try {
        assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
      } catch {
        return { lines: [] };
      }
      const sessionKey =
        mode === 'shell' ? shellKey(target, sessionId)
        : mode === 'codex' ? codexKey(target, sessionId)
        : mode === 'opencode' ? opencodeKey(target, sessionId)
        : claudeKey(target, sessionId);
      try {
        return { lines: peekLines(app.deps.terminal.snapshot(sessionKey), 24) };
      } catch {
        return { lines: [] };
      }
    },
  );
  app.get<{ Querystring: { ws?: string; path?: string; mode?: string; session?: string; cols?: string; rows?: string } }>(
    '/ws/terminal',
    { websocket: true },
    async (connection, req) => {
      const socket = connection.socket;
      const wsId = req.query.ws;
      const target = req.query.path;
      const mode =
        req.query.mode === 'shell' ? 'shell'
        : req.query.mode === 'codex' ? 'codex'
        : req.query.mode === 'opencode' ? 'opencode'
        : 'claude';
      const sessionId = /^\d+$/.test(req.query.session ?? '') ? req.query.session! : '1';
      // Spawn-time size: resize messages sent while this handler is still in
      // async setup are LOST (no listener attached yet at the ws layer), so
      // a new pty would keep painting at 80x24. The client passes its fitted
      // dimensions up front instead.
      const dim = (v: string | undefined) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 2 && n <= 500 ? n : null;
      };
      const cols = dim(req.query.cols);
      const rows = dim(req.query.rows);
      const size = cols && rows ? { cols, rows } : undefined;

      // Buffer messages that arrive before the async setup completes.
      const pending: Buffer[] = [];
      const bufferHandler = (raw: Buffer) => { pending.push(raw); };
      socket.on('message', bufferHandler);

      const fail = (message: string) => {
        socket.off('message', bufferHandler);
        try { socket.send(`\r\n[terminal] ${message}\r\n`); } catch { /* ignore */ }
        socket.close();
      };

      if (!wsId || !target) return fail('missing ws or path');

      const meta = await app.deps.workspaces.get(wsId);
      if (!meta) return fail(`workspace ${wsId} not found`);

      const stores = await app.deps.registry.get(wsId);
      const repos = await stores.repos.list();
      // Multi-root: a worktree created before the workspace chose a root still
      // lives beside its repo, and refusing to own it would break its terminal.
      const repo = findOwningRepo(repos, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) return fail(`no repo owns ${target}`);

      try {
        assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
      } catch {
        return fail('invalid path');
      }

      // Setup is complete — remove the buffer handler and wire up the real one.
      socket.off('message', bufferHandler);

      // Claude runs `claude` (default spec) keyed by the worktree path
      // (`<path>\0claude:id` beyond session 1) with status hooks. Shell runs
      // a login shell under `<path>\0shell[:id]`. Codex runs the codex CLI
      // under `<path>\0codex` — resume the most recent conversation for this
      // directory, or start fresh. OpenCode runs under `<path>\0opencode` —
      // continue the last session, or start fresh.
      const sessionKey =
        mode === 'shell' ? shellKey(target, sessionId)
        : mode === 'codex' ? codexKey(target, sessionId)
        : mode === 'opencode' ? opencodeKey(target, sessionId)
        : claudeKey(target, sessionId);
      // Codex has no hooks API; its `notify` config calls our hook script on
      // agent-turn-complete so we can show a "waiting for input" status.
      const codexPort = Number(process.env.PORT ?? 7777);
      const codexNotify = `notify=["node","${codexNotifyScriptPath()}","${codexPort}","${target}"]`;
      // Only the primary session resumes the directory's last conversation —
      // a second tab resuming the SAME conversation as the first would have
      // both sessions fighting over one thread, so extras start fresh.
      const codexCmd =
        sessionId === '1'
          ? `codex -c '${codexNotify}' resume --last || codex -c '${codexNotify}'`
          : `codex -c '${codexNotify}'`;
      // Same rule as codex: only the primary session continues the last
      // conversation; extra tabs start fresh.
      const opencodeCmd = sessionId === '1' ? `opencode --continue || opencode` : `opencode`;
      // Start a login shell first, then let the bootstrap load the interactive
      // profile and prepend Strado's launchers AFTER it. User rc files commonly
      // prepend nvm/Homebrew paths, which otherwise hide the Codex launcher.
      // Sandboxes override the inner shell to bash.
      const shellCmd = 'exec "$STRADO_SHELL_BOOTSTRAP"';
      const spec =
        mode === 'shell'
          ? { file: defaultShell(), args: ['-l', '-c', shellCmd] }
          : mode === 'codex'
            ? { file: defaultShell(), args: ['-l', '-c', codexCmd] }
            : mode === 'opencode'
              ? { file: defaultShell(), args: ['-l', '-c', opencodeCmd] }
              : undefined;

      if (mode === 'claude' || mode === 'shell') {
        try {
          await installClaudeHooks(target, Number(process.env.PORT ?? 7777));
        } catch {
          // hook install is best-effort; never block the terminal
        }
      }
      if (mode === 'opencode' || mode === 'shell') {
        try {
          await installOpencodePlugin(target);
        } catch {
          // best-effort; never block the terminal
        }
      }

      const emitSessions = () => {
        const live = app.deps.terminal.liveSessions().filter((s) => s.path === target);
        app.deps.bus.emit('worktrees', {
          type: 'worktree.updated',
          data: { path: target, ...sessionsPayload(live) },
        });
      };

      try {
        await app.deps.terminal.ensure(sessionKey, target, spec, size);
      } catch (err) {
        return fail(`could not start session: ${(err as Error).message}`);
      }
      // On REATTACH the session already exists at its previous client's size —
      // ensure() ignores `size` for a running session. Align it to THIS client's
      // fitted size BEFORE snapshotting, so the serialized screen reconstructs at
      // the exact width the client will render it. Skipping this makes the
      // restored screen wrap/stagger diagonally until a manual resize (zoom)
      // reflows it. Harmless on a fresh spawn (already at `size`).
      if (size) app.deps.terminal.resize(sessionKey, size.cols, size.rows);
      emitSessions();
      try { socket.send(app.deps.terminal.snapshot(sessionKey)); } catch { /* ignore */ }

      const unsub = app.deps.terminal.subscribe(sessionKey, (data) => {
        if (socket.readyState === socket.OPEN) {
          try { socket.send(data); } catch { /* ignore */ }
        }
      });

      const unsubExit = app.deps.terminal.onExit(sessionKey, (code) => {
        if (mode === 'claude') app.deps.claudeStatus.clear(target, sessionId);
        if (mode === 'codex') app.deps.codexStatus.clear(target, sessionId);
        if (mode === 'opencode') app.deps.opencodeStatus.clear(target, sessionId);
        if (mode === 'shell') {
          // the tab is gone, so any agent it hosted is gone with it
          const shellAgentId = `shell:${sessionId}`;
          app.deps.claudeStatus.remove(target, shellAgentId);
          app.deps.codexStatus.remove(target, shellAgentId);
          app.deps.opencodeStatus.remove(target, shellAgentId);
        }
        emitSessions();
        if (socket.readyState === socket.OPEN) {
          try { socket.send(`\r\n[process exited ${code}]\r\n`); } catch { /* ignore */ }
        }
        socket.close();
      });

      const handleMsg = (raw: Buffer) => {
        let msg: ClientMsg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'data') {
          app.deps.terminal.write(sessionKey, msg.data);
          // Keystrokes are the activity heartbeat behind the Time spent column.
          app.deps.activity.touch(target);
          // Codex has no prompt-submit hook; treat Enter as "turn started".
          // The notify hook flips it to waiting when the turn completes.
          if (mode === 'codex' && msg.data.includes('\r')) {
            app.deps.codexStatus.set(target, 'working', sessionId);
          }
          // A Shell-scoped launcher registers Codex as waiting while its TUI
          // is open. Codex has no prompt-submit hook, so Enter is the turn
          // boundary here too — but only while that launcher is active, never
          // for ordinary commands in a generic Shell tab.
          if (mode === 'shell' && msg.data.includes('\r')) {
            const shellAgentId = `shell:${sessionId}`;
            if (app.deps.codexStatus.active(target, shellAgentId)) {
              app.deps.codexStatus.set(target, 'working', shellAgentId);
            }
          }
        } else if (msg.type === 'resize') app.deps.terminal.resize(sessionKey, msg.cols, msg.rows);
      };

      socket.on('message', handleMsg);

      // Replay any messages that arrived during async setup.
      for (const raw of pending) handleMsg(raw);

      socket.on('close', () => { unsub(); unsubExit(); });
    },
  );
}
