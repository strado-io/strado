import path from 'node:path';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry, Execution } from './agentRegistry.js';
import { codexNotifyScriptPath, hooksDir, installClaudeHooks, installOpencodePlugin, piExtensionPath } from './claudeHooks.js';
import { installClaudeMcp } from './claudeMcp.js';
import { defaultShell } from './platform.js';
import { sessionKeyFor, sessionsPayload, type LiveSession, type SpawnSpec, type TerminalManager } from './terminalManager.js';

// Step 9a: the agent-tab spawn the terminal WebSocket route has always done,
// lifted out of the route so a fork can open a tab with no client attached.
// The route still owns the socket, the handoff branch and the reattach path;
// everything here is what BOTH callers need to agree on, byte for byte.

export type AgentMode = 'claude' | 'codex' | 'opencode' | 'pi';

/** The tab-environment names Codex must forward to the `strado` MCP server.
 * Codex spawns stdio MCP servers with a minimal allowlist (HOME, PATH, USER…),
 * not the parent environment Claude and OpenCode pass through, so without this
 * list the bridge boots identity-less and every intercom tool answers "this is
 * not a Strado tab". Names only — the values never appear on a command line. */
export const CODEX_MCP_ENV_VARS = [
  'STRADO_AGENT_TOKEN', 'STRADO_AGENT_ID', 'STRADO_SCOPE_ID',
  'STRADO_STATUS_PORT', 'STRADO_SERVER_SOCKET', 'STRADO_SERVER', 'STRADO_WORKTREE',
] as const;

/** Every `-c` override a Codex tab launches with: the `notify` hook that posts
 * turn-complete to Strado, and the `strado` MCP server registered per launch
 * (Codex's config.toml is a global, user-owned file Strado never writes). */
export function codexConfigFlags(worktreePath: string): string {
  const port = Number(process.env.PORT ?? 7777);
  const overrides = [
    `notify=["node","${codexNotifyScriptPath()}","${port}","${worktreePath}"]`,
    'mcp_servers.strado.command="node"',
    `mcp_servers.strado.args=["${path.join(hooksDir(), 'strado-mcp.mjs')}"]`,
    `mcp_servers.strado.env_vars=[${CODEX_MCP_ENV_VARS.map((n) => `"${n}"`).join(',')}]`,
  ];
  return overrides.map((o) => `-c '${o}'`).join(' ');
}

/** The command a harness tab runs. `handoff` prompts belong to the route (and
 * to the branch that deletes them), so this is the plain-launch form only.
 * `codexFlags` is the full `-c …` override string from `codexConfigFlags`. */
export function agentLaunchCommand(mode: AgentMode, sessionId: string, codexFlags: string): string {
  if (mode === 'codex') {
    return sessionId === '1'
      ? `codex ${codexFlags} resume --last || codex ${codexFlags}`
      : `codex ${codexFlags}`;
  }
  if (mode === 'opencode') return sessionId === '1' ? 'opencode --continue || opencode' : 'opencode';
  if (mode === 'pi') {
    // Pi has no ambient hook config to write — its status extension is loaded
    // by path, so every launch carries `-e`. Same primary-session rule.
    const piExtension = piExtensionPath();
    return sessionId === '1'
      ? `pi -c -e "${piExtension}" || pi -e "${piExtension}"`
      : `pi -e "${piExtension}"`;
  }
  return 'claude';
}

// Start a login shell first, then let the bootstrap load the interactive
// profile and prepend Strado's launchers AFTER it. User rc files commonly
// prepend nvm/Homebrew paths, which otherwise hide the Codex launcher.
// Sandboxes override the inner shell to bash.
const SHELL_BOOTSTRAP = 'exec "$STRADO_SHELL_BOOTSTRAP"';

/** The pty spec for a tab, or `undefined` for a bare `claude` — the terminal
 * manager's own default spec is what a Claude tab has always spawned. */
export function agentSpawnSpec(mode: AgentMode | 'shell', sessionId: string, worktreePath: string): SpawnSpec | undefined {
  if (mode === 'shell') return { file: defaultShell(), args: ['-l', '-c', SHELL_BOOTSTRAP] };
  if (mode === 'claude') return undefined;
  return { file: defaultShell(), args: ['-l', '-c', agentLaunchCommand(mode, sessionId, codexConfigFlags(worktreePath))] };
}

/** The lowest free tab number for a (worktree, mode) pair — `max + 1`, never
 * below 1. Ids that are not plain numbers (a Shell-hosted agent reports
 * `shell:N`) never own a tab of their own, so they do not count. */
export function nextSessionId(live: LiveSession[], mode: AgentMode, worktreePath: string): string {
  let max = 0;
  for (const s of live) {
    if (s.path !== worktreePath || s.mode !== mode) continue;
    if (!/^\d+$/.test(s.id)) continue;
    max = Math.max(max, Number(s.id));
  }
  return String(max + 1);
}

/** Hook/MCP/plugin installs the terminal route runs before a spawn. Every one
 * is best-effort: a broken install must never stop a tab from opening. */
export async function agentSpawnInstallers(
  mode: AgentMode,
  worktreePath: string,
  log: (message: string, err: unknown) => void = () => {},
): Promise<void> {
  if (mode === 'claude') {
    try { await installClaudeHooks(worktreePath); } catch { /* best-effort */ }
    try { await installClaudeMcp(worktreePath); } catch (err) { log(`claude MCP registration failed for ${worktreePath}`, err); }
  }
  if (mode === 'opencode') {
    try { await installOpencodePlugin(worktreePath); } catch { /* best-effort */ }
  }
}

export type SpawnAgentTabDeps = {
  terminal: TerminalManager;
  agents: AgentRegistry;
  bus: EventBus;
  /** Overrides the default best-effort installs for this spawn. */
  installers?: () => Promise<void>;
};

export type SpawnAgentTabInput = {
  wsId: string;
  mode: AgentMode;
  worktreePath: string;
  size?: { cols: number; rows: number };
};

export type SpawnAgentTabResult = { key: string; sessionId: string; execution: Execution };

/** A caller-visible alias for the injectable spawn: `spawnAgentTab` bound to
 * its process-wide dependencies. */
export type SpawnAgentTab = (input: SpawnAgentTabInput) => Promise<SpawnAgentTabResult>;

// No client is attached when a fork opens a tab, so there is no fitted size to
// honour. 120x40 is a readable default that every harness TUI lays out at.
export const SPAWN_DEFAULT_SIZE = { cols: 120, rows: 40 } as const;

const spawnQueues = new WeakMap<TerminalManager, Map<string, Promise<unknown>>>();

/** Share allocation/registration/spawn exclusion with WebSocket attaches. */
export async function withAgentSpawnLock<T>(terminal: TerminalManager, cwd: string, mode: AgentMode | 'shell', run: () => Promise<T>): Promise<T> {
  let queues = spawnQueues.get(terminal);
  if (!queues) { queues = new Map(); spawnQueues.set(terminal, queues); }
  const key = `${cwd}\0${mode}`;
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

/**
 * Open a new agent tab in `worktreePath` and return its identity. Unlike the
 * route, the execution is *required*: the caller needs the agent id to address
 * the tab, so a registry failure rejects instead of degrading to an anonymous
 * terminal.
 */
export async function spawnAgentTab(deps: SpawnAgentTabDeps, input: SpawnAgentTabInput): Promise<SpawnAgentTabResult> {
  return withAgentSpawnLock(deps.terminal, input.worktreePath, input.mode, async () => {
    const sessionId = nextSessionId(deps.terminal.liveSessions(), input.mode, input.worktreePath);
    const key = sessionKeyFor(input.mode, input.worktreePath, sessionId);
    const spec = agentSpawnSpec(input.mode, sessionId, input.worktreePath);

    // Register before spawn so extraEnv reads this execution's credentials.
    const execution = await deps.agents.register({ key, cwd: input.worktreePath, scopeId: input.wsId });
    const installers = deps.installers ?? (() => agentSpawnInstallers(input.mode, input.worktreePath));
    try { await installers(); } catch { /* best-effort, exactly like the route */ }
    try {
      await deps.terminal.ensure(key, input.worktreePath, spec, input.size ?? { ...SPAWN_DEFAULT_SIZE });
    } catch (err) {
      await deps.agents.release(key);
      throw err;
    }

    const live = deps.terminal.liveSessions().filter((s) => s.path === input.worktreePath);
    deps.bus.emit('worktrees', { type: 'worktree.updated', data: { path: input.worktreePath, ...sessionsPayload(live) } });
    return { key, sessionId, execution };
  });
}
