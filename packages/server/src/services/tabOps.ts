import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { findOwningRepo, worktreeRootsFor } from './worktreeRoot.js';
import { trustAttention } from './claudeTrust.js';
import { agentSpawnInstallers, spawnAgentTab, type AgentMode, type SpawnAgentTabResult } from './agentSpawn.js';
import { ShellRunError, type ShellRunResult } from './shellRunner.js';
import { parseSessionKey, sessionKeyFor } from './terminalManager.js';
import type { AgentSummary } from './agentRegistry.js';

// Tab operations shared by every caller that drives tabs: the agent-facing
// app-control routes (MCP) and the human's command box (Jarvis). Who may do
// what is the caller's business; this module only does it.

export const SPAWN_COMMAND_TIMEOUT_MS = 15_000;
/** How long a fresh shell may print its banner/profile before the command is typed. */
export const SHELL_SETTLE_QUIET_MS = 500;
export const SHELL_SETTLE_MAX_MS = 5_000;
/** How long the first prompt keeps trying to reach a freshly started harness. */
export const PROMPT_DELIVERY_WINDOW_MS = 45_000;
/** …while the tab shows Claude's folder-trust question (the person must answer it). */
export const PROMPT_TRUST_WINDOW_MS = 15 * 60_000;
export const PROMPT_DELIVERY_RETRY_MS = 1_000;
/** After typing the first prompt into Claude, how long until it must report working. */
export const PROMPT_CONFIRM_MS = 5_000;
/** What Ctrl-C is on a PTY. */
export const INTERRUPT = '\x03';

/** How a window names a tab: structured, never a server session key (the hub
 * has its own tab keys, and the server's key format is an internal detail). */
export type TabRef = { worktreePath: string; mode: AgentSummary['mode']; sessionId: string };

export const refOf = (a: Pick<AgentSummary, 'mode' | 'worktreePath' | 'sessionId'>): TabRef => ({ worktreePath: a.worktreePath, mode: a.mode, sessionId: a.sessionId });
export const refOfKey = (key: string): TabRef => { const s = parseSessionKey(key); return { worktreePath: s.path, mode: s.mode, sessionId: s.id }; };
export const keyOfRef = (r: TabRef): string => sessionKeyFor(r.mode, r.worktreePath, r.sessionId);
/** uiClients matches windows by string; this is the canonical string of a TabRef. */
export const refKey = (r: TabRef): string => `${r.worktreePath}\0${r.mode}\0${r.sessionId}`;

export type CommandResult = ShellRunResult | { error: string };

/** A shell younger than this still gets the settle wait before a command is typed. */
export const FRESH_SHELL_MS = 15_000;
// When each tab key was spawned through tabOps, process-wide: the window may
// spawn a shell and send its first command in two separate requests.
const spawnedAt = new Map<string, number>();

/** One line to type into a TUI: newlines and tabs become spaces (a newline
 * would submit early) and every other control character is dropped — ESC,
 * Ctrl-C or shift-tab typed raw would drive the TUI (e.g. cycle its
 * permission mode) instead of being read as text. */
export function cleanLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function createTabOps(app: FastifyInstance) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const log = (m: string) => app.deps.debugLog.log('app-control', m);
  const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** A repo of this workspace must own the path (its checkout or its canonical worktree root). */
  async function assertWorktree(scopeId: string, worktreePath: string): Promise<void> {
    const invalid = () => new AppError('VALIDATION', 'invalid worktreePath');
    const stores = await app.deps.registry.get(scopeId);
    const repo = findOwningRepo(await stores.repos.list(), worktreePath, app.deps.homeStateDir, { includeRepoRoot: true });
    if (!repo) throw invalid();
    try { assertPathUnder(worktreePath, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]); } catch { throw invalid(); }
  }

  async function spawnTab(scopeId: string, mode: AgentMode | 'shell', worktreePath: string): Promise<SpawnAgentTabResult> {
    const r = await spawnAgentTab({
      terminal: app.deps.terminal,
      agents: app.deps.agents,
      bus: app.deps.bus,
      installers: () => agentSpawnInstallers(mode, worktreePath, (m, err) => app.deps.debugLog.log('mcp', `${m}: ${msg(err)}`)),
    }, { wsId: scopeId, mode, worktreePath });
    spawnedAt.set(r.key, Date.now());
    if (spawnedAt.size > 500) for (const [k, t] of spawnedAt) if (Date.now() - t > FRESH_SHELL_MS) spawnedAt.delete(k);
    return r;
  }

  /** A shell spawned moments ago may still be loading its profile: wait for
   * it to settle before typing. Older shells are typed into at once — one
   * that is busy printing (a dev server) would otherwise stall every run. */
  async function settleIfFresh(key: string): Promise<void> {
    const t = spawnedAt.get(key);
    if (t === undefined || Date.now() - t > FRESH_SHELL_MS) return;
    await shellSettled(key);
    spawnedAt.delete(key);
  }

  /** Wait until a fresh shell has printed (its prompt) and then stopped
   * printing (profile, banner), bounded. Nothing printed yet is not quiet: a
   * slow profile that prints nothing would otherwise get the command typed
   * before its prompt, where it can be lost. */
  async function shellSettled(key: string): Promise<void> {
    const start = Date.now();
    await sleep(SHELL_SETTLE_QUIET_MS);
    while (Date.now() - start < SHELL_SETTLE_MAX_MS) {
      const { output } = app.deps.ptyActivity.quiet(key);
      if (output !== Infinity && output >= SHELL_SETTLE_QUIET_MS) return;
      await sleep(100);
    }
  }

  /** Run one line in a shell tab; ShellRunError becomes a readable error result. */
  async function runCommand(key: string, command: string, timeoutMs = SPAWN_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    try {
      return await app.deps.shellRunner.run(key, command, { timeoutMs });
    } catch (err) {
      if (!(err instanceof ShellRunError)) throw err;
      return { error: err.code === 'NOT_RUNNING' ? 'the shell is not running' : err.code === 'BUSY' ? 'a run is already in progress on that tab' : 'someone is typing in that tab' };
    }
  }

  /** Type the first prompt once the harness is ready. Claude: after SessionStart
   * reported idle. Others: the push gates (quiet input/output) stand in for a
   * "prompt shown" signal. Background; gives up quietly after the window. */
  function deliverPrompt(scopeId: string, agentId: string, key: string, mode: string, text: string): void {
    const started = Date.now();
    let trust = false;
    const tryOnce = async (): Promise<void> => {
      try {
        const me = (await app.deps.agents.list(scopeId)).find((a) => a.agentId === agentId);
        if (!me || !me.live) return;
        // A Claude tab on its folder-trust question is waiting for the person,
        // not stuck: keep the prompt for them (up to 15 min) instead of 45 s.
        // Once seen, the longer window holds: the prompt goes in after they answer.
        trust ||= trustAttention(me, (k) => app.deps.terminal.snapshot(k)) === 'trust';
        const window = trust ? PROMPT_TRUST_WINDOW_MS : PROMPT_DELIVERY_WINDOW_MS;
        if (Date.now() - started > window) { log(`first prompt for ${agentId} gave up after ${window} ms`); return; }
        // Non-Claude harnesses post nothing until a first turn ends, so
        // 'starting' plus the push's quiet gates is the only "prompt shown"
        // signal. Known limit: a first-run trust/onboarding dialog that sits
        // quiet would receive this text.
        const ready = mode === 'claude' ? me.lifecycle === 'idle' : me.lifecycle === 'idle' || me.lifecycle === 'starting' || me.lifecycle === 'ready';
        if (ready && await app.deps.intercomPush.nudge(key, text) === 'sent') {
          if (mode === 'claude') confirmSubmitted(scopeId, agentId, key);
          return;
        }
      } catch (err) {
        log(`first prompt for ${agentId} failed: ${msg(err)}`);
        return;
      }
      setTimeout(() => { void tryOnce(); }, PROMPT_DELIVERY_RETRY_MS).unref();
    };
    setTimeout(() => { void tryOnce(); }, PROMPT_DELIVERY_RETRY_MS).unref();
  }

  /** The push withholds its Enter when a keystroke lands in the same 150 ms,
   * and still reports 'sent'. Claude reports 'working' once a prompt is
   * submitted; if it has not after a few seconds, press Enter once more —
   * only while nobody is typing in that tab. */
  function confirmSubmitted(scopeId: string, agentId: string, key: string): void {
    setTimeout(() => {
      void (async () => {
        try {
          const me = (await app.deps.agents.list(scopeId)).find((a) => a.agentId === agentId);
          if (!me || !me.live || me.lifecycle !== 'idle') return;
          if (app.deps.ptyActivity.quiet(key).input < PROMPT_CONFIRM_MS) return;
          app.deps.terminal.write(key, '\r');
        } catch (err) {
          log(`first prompt confirm for ${agentId} failed: ${msg(err)}`);
        }
      })();
    }, PROMPT_CONFIRM_MS).unref();
  }

  /** The live tab a ref names in this workspace, or NOT_FOUND. */
  async function liveTab(scopeId: string, ref: TabRef & { executionId?: string }): Promise<AgentSummary> {
    const a = (await app.deps.agents.list(scopeId)).find((x) => x.worktreePath === ref.worktreePath && x.mode === ref.mode && x.sessionId === ref.sessionId);
    if (!a || !a.live) throw new AppError('NOT_FOUND', 'no live tab with that reference');
    if (ref.executionId !== undefined && a.executionId !== ref.executionId) {
      throw new AppError('CONFLICT', 'that tab was closed and its number reused by another tab', { reason: 'tab_replaced' });
    }
    return a;
  }

  /** Is anything running in this tab right now (an agent turn, or a shell that printed recently)? */
  function busy(a: AgentSummary): boolean {
    if (a.mode !== 'shell') return a.lifecycle === 'working';
    return app.deps.ptyActivity.quiet(keyOfRef(refOf(a))).output < 2_000;
  }

  const interrupt = (key: string): void => app.deps.terminal.write(key, INTERRUPT);
  const close = (key: string): void => app.deps.terminal.kill(key);

  return { assertWorktree, spawnTab, shellSettled, settleIfFresh, runCommand, deliverPrompt, liveTab, busy, interrupt, close };
}

export type TabOps = ReturnType<typeof createTabOps>;
