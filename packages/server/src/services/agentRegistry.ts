import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { agentIdFor, slugOf, isValidAlias } from './agentId.js';
import {
  claudeKey, codexKey, opencodeKey, piKey, shellKey,
  parseSessionKey, type LiveSession, type TerminalManager,
} from './terminalManager.js';
import type { ClaudeStatusStore } from './claudeStatusStore.js';
import type { EventBus } from '../events/bus.js';
import { AppError } from '../errors.js';
import { ASK_TIMEOUT_MAX_MS, HUMAN_AGENT_ID, STRADO_SENDER_ID, WORKING_STALE_OUTPUT_MS } from './intercomSchema.js';

export type Execution = {
  key: string;
  scopeId: string;
  agentId: string;
  executionId: string;
  token: string;
  spawnedAt: string;
};

/** `needs_input` is only ever reported for Claude, whose Notification hook
 * marks a real permission or elicitation prompt. The other harnesses post
 * `waiting` when a turn finishes (Codex `agent-turn-complete`, OpenCode
 * `session.idle`, Pi `agent_settled`), which is what the dashboard's amber
 * "waiting for you" dot wants but in intercom terms means "idle at the
 * prompt"; Pi's blocking `ui_prompt_start` posts the same word and cannot be
 * told apart here, so it reads as idle too. */
export type AgentLifecycle = 'starting' | 'ready' | 'working' | 'needs_input' | 'idle' | 'offline';

export type AgentSummary = {
  agentId: string;
  alias: string | null;
  scopeId: string;
  mode: 'claude' | 'codex' | 'opencode' | 'pi' | 'shell';
  worktreePath: string;
  sessionId: string;
  lifecycle: AgentLifecycle;
  executionId: string | null;
  live: boolean;
};

export type AgentRegistry = {
  /** Mint an execution for a key unless one exists AND the manager says the
   * process is running. The manager is the tiebreaker, never our own memory. */
  register(input: { key: string; cwd: string; scopeId: string }): Promise<Execution>;
  /** Drop the execution for a key. Idempotent. */
  release(key: string): Promise<void>;
  /** Resolves once every write already queued in the serialize chain has
   * settled (resolved or rejected). Never rejects itself. Does NOT block
   * on writes issued after this call — those queue behind it as usual. */
  flush(): Promise<void>;
  /** Env record merged over sessionEnv() at spawn. Empty for unknown keys. */
  envFor(key: string, cwd: string): Record<string, string>;
  /** Constant-time token lookup. */
  byToken(token: string): Execution | null;
  /** Constant-time lookup by session key (the value `register` was given). */
  byKey(key: string): Execution | null;
  /** Drop executions whose key is not live; mint for live keys without one. */
  reconcile(): Promise<void>;
  list(scopeId: string): Promise<AgentSummary[]>;
  setAlias(scopeId: string, agentId: string, alias: string | null): Promise<AgentSummary>;
  /** Exact agentId, else unique case-insensitive alias. Never guesses. */
  resolve(scopeId: string, ref: string): Promise<AgentSummary>;
};

export type AgentRegistryDeps = {
  executionsFile: string;
  namesFile: string;
  terminal: () => TerminalManager | null;
  statuses: () => Record<'claude' | 'codex' | 'opencode' | 'pi', ClaudeStatusStore>;
  /** Called after execution(s) are dropped (release or reconcile), so the
   * intercom store can release their task claims and, if the agent has no
   * other live execution, retarget its open peer asks to the human. */
  onDropped?: (dropped: { execution: Execution; agentStillLive: boolean }[]) => void;
  /** Emits `peer.registered` / `peer.dropped` on the intercom channel (ids only —
   * never the token) so the dashboard refreshes its peer roster the moment
   * the registry changes, instead of inferring it from PTY snapshots. */
  bus?: EventBus;
  /** ms since the tab's PTY last printed (Infinity when never). Lets a stale
   * `working` on a hook-less harness read as idle — see lifecycleFor. */
  quiet?: (key: string) => { input: number; output: number };
};

type ExecutionsFile = { executions: Execution[] };
type NamesFile = {
  aliases: { scopeId: string; key: string; alias: string }[];
  slugs: { scopeId: string; worktreePath: string; slug: string }[];
};

const TOKEN_BYTES = 32;

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readJson<T>(file: string, empty: T): Promise<T> {
  if (!fs.existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as T) : empty;
  } catch (err) {
    // The file exists but is unreadable/unparseable — the only on-disk copy
    // of a credentials-bearing file. Never let the caller's fresh write
    // silently discard it: back it aside first, same convention as
    // handoffStore.ts. Unlike handoffStore we do not throw — agent identity
    // is optional for the server to run, so boot must still succeed with an
    // empty in-memory state.
    const backup = `${file}.corrupt-${Date.now()}`;
    await fsp.copyFile(file, backup).catch(() => undefined);
    console.error(`[agentRegistry] ${file} is corrupt, backed up to ${backup}: ${(err as Error).message}`);
    return empty;
  }
}

async function writeJson(file: string, value: unknown, mode: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  await fsp.rename(tmp, file);
  // rename keeps the tmp file's mode, but an existing target created by an
  // older version could be wider — clamp it. This enforces the 0600
  // requirement, so a failure here must reject the write, not be swallowed.
  await fsp.chmod(file, mode);
}

export async function createAgentRegistry(deps: AgentRegistryDeps): Promise<AgentRegistry> {
  // In-memory truth, keyed by session key. The file is a durable mirror so
  // executions survive a server restart (ptyd keeps the processes alive).
  const executions = new Map<string, Execution>();
  const loaded = await readJson<ExecutionsFile>(deps.executionsFile, { executions: [] });
  for (const ex of Array.isArray(loaded.executions) ? loaded.executions : []) {
    if (ex && typeof ex.key === 'string' && typeof ex.token === 'string') executions.set(ex.key, ex);
  }
  // Ensure the file exists with the right mode even when nothing was loaded.
  if (!fs.existsSync(deps.executionsFile) || (loaded.executions?.length ?? 0) === 0) {
    await writeJson(deps.executionsFile, { executions: [...executions.values()] }, 0o600);
  }

  let queue: Promise<void> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const persistExecutions = () =>
    writeJson(deps.executionsFile, { executions: [...executions.values()] }, 0o600);

  // Same channel the intercom store publishes on (INTERCOM_CHANNEL); the
  // literal avoids pulling the SQLite store into the registry module.
  const emitPeer = (type: 'peer.registered' | 'peer.dropped', ex: Execution): void => {
    try {
      deps.bus?.emit('intercom', { type, data: { scopeId: ex.scopeId, agentId: ex.agentId, executionId: ex.executionId } });
    } catch (err) {
      console.warn(`[agentRegistry] ${type} emit failed: ${(err as Error).message}`);
    }
  };

  const notifyDropped = (dropped: Execution[]): void => {
    if (dropped.length === 0) return;
    for (const ex of dropped) emitPeer('peer.dropped', ex);
    if (!deps.onDropped) return;
    const payload = dropped.map((execution) => ({
      execution,
      agentStillLive: [...executions.values()].some((e) => e.scopeId === execution.scopeId && e.agentId === execution.agentId),
    }));
    try { deps.onDropped(payload); } catch (err) { console.warn(`[agentRegistry] onDropped failed: ${(err as Error).message}`); }
  };

  const isRunning = (key: string): boolean => {
    const t = deps.terminal();
    return !!t && t.status(key).status === 'running';
  };

  // ---- names file: aliases + slug assignments (no credentials; 0644) ----
  const names: NamesFile = await readJson<NamesFile>(deps.namesFile, { aliases: [], slugs: [] });
  if (!Array.isArray(names.aliases)) names.aliases = [];
  if (!Array.isArray(names.slugs)) names.slugs = [];
  const persistNames = () => writeJson(deps.namesFile, names, 0o644);

  /** One slug per (scope, worktree), assigned on first sight and kept
   * forever, so deleting an earlier same-basename worktree never renumbers
   * a later one. */
  const slugFor = async (scopeId: string, cwd: string): Promise<string> => {
    const wt = path.resolve(cwd);
    const existing = names.slugs.find((s) => s.scopeId === scopeId && s.worktreePath === wt);
    if (existing) return existing.slug;
    const base = slugOf(wt);
    const taken = new Set(names.slugs.filter((s) => s.scopeId === scopeId).map((s) => s.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}~${n}`;
    names.slugs.push({ scopeId, worktreePath: wt, slug });
    await persistNames();
    return slug;
  };

  const register: AgentRegistry['register'] = ({ key, cwd, scopeId }) =>
    serialize(async () => {
      const current = executions.get(key);
      if (current && isRunning(key)) {
        if (current.scopeId === scopeId) return current;
        // The process is alive but was filed under the wrong scope — most
        // commonly a reconcile()-minted orphan under 'default' that is now
        // attaching to its real workspace. Re-scope in place: re-slug for the
        // real scope, but KEEP the token/executionId so the already-running
        // process (which was handed the old token via extraEnv at spawn)
        // keeps authenticating.
        const slug = await slugFor(scopeId, cwd);
        const rescoped: Execution = { ...current, scopeId, agentId: agentIdFor(key, slug) };
        executions.set(key, rescoped);
        await persistExecutions();
        emitPeer('peer.registered', rescoped);
        return rescoped;
      }
      const slug = await slugFor(scopeId, cwd);
      const ex: Execution = {
        key,
        scopeId,
        agentId: agentIdFor(key, slug),
        executionId: randomUUID(),
        token: mintToken(),
        spawnedAt: new Date().toISOString(),
      };
      executions.set(key, ex);
      await persistExecutions();
      emitPeer('peer.registered', ex);
      return ex;
    });

  // Reads `queue` at call time, so it resolves once whatever is currently
  // queued (register/release/reconcile/setAlias calls already in flight)
  // has settled — never blocks on writes issued after this call.
  const flush: AgentRegistry['flush'] = () => queue.then(() => undefined, () => undefined);

  const release: AgentRegistry['release'] = (key) =>
    serialize(async () => {
      const ex = executions.get(key);
      if (!ex) return;
      executions.delete(key);
      await persistExecutions();
      notifyDropped([ex]);
    });

  const envFor: AgentRegistry['envFor'] = (key): Record<string, string> => {
    const ex = executions.get(key);
    if (!ex) return {};
    const env: Record<string, string> = { STRADO_AGENT_ID: ex.agentId, STRADO_SCOPE_ID: ex.scopeId, STRADO_AGENT_TOKEN: ex.token };
    // Claude Code reads MCP_TOOL_TIMEOUT (ms) from the launching process's own
    // environment to bound how long it will block on an MCP tool call.
    // intercom_ask can legitimately hold the connection open for up to
    // ASK_TIMEOUT_MAX_MS, so without this the client can abandon the call
    // before the tool's own deadline. Never override a value the user set.
    if (process.env.MCP_TOOL_TIMEOUT === undefined) env.MCP_TOOL_TIMEOUT = String(ASK_TIMEOUT_MAX_MS + 5000);
    return env;
  };

  const byToken: AgentRegistry['byToken'] = (token) => {
    if (!token) return null;
    for (const ex of executions.values()) if (safeEqual(ex.token, token)) return ex;
    return null;
  };

  const byKey: AgentRegistry['byKey'] = (key) => executions.get(key) ?? null;

  const keyOf = (s: LiveSession): string => {
    switch (s.mode) {
      case 'claude': return claudeKey(s.path, s.id);
      case 'codex': return codexKey(s.path, s.id);
      case 'opencode': return opencodeKey(s.path, s.id);
      case 'pi': return piKey(s.path, s.id);
      case 'shell': return shellKey(s.path, s.id);
    }
  };

  const reconcile: AgentRegistry['reconcile'] = () =>
    serialize(async () => {
      const t = deps.terminal();
      if (!t) return;
      const liveKeys = new Set(t.liveSessions().map(keyOf));
      let changed = false;
      const dropped: Execution[] = [];
      for (const key of [...executions.keys()]) {
        if (!liveKeys.has(key)) { dropped.push(executions.get(key)!); executions.delete(key); changed = true; }
      }
      for (const s of t.liveSessions()) {
        const key = keyOf(s);
        if (executions.has(key)) continue;
        const slug = await slugFor('default', s.path);
        executions.set(key, {
          key, scopeId: 'default', agentId: agentIdFor(key, slug),
          executionId: randomUUID(), token: mintToken(), spawnedAt: new Date().toISOString(),
        });
        changed = true;
        // This session was live with no execution on record (server restart,
        // or a spawn that raced register() to completion) — filed under the
        // degraded 'default' scope until its owning tab next attaches and
        // register() re-scopes it. Log so the degradation is visible.
        console.warn(`[agentRegistry] reconciled orphan session ${key}, filed under scope "default"`);
      }
      if (changed) await persistExecutions();
      notifyDropped(dropped);
    });

  const aliasFor = (scopeId: string, key: string): string | null =>
    names.aliases.find((a) => a.scopeId === scopeId && a.key === key)?.alias ?? null;

  // See the AgentLifecycle doc comment: only Claude's `waiting` is a prompt.
  // `working` on a hook-less harness is set by a prompt-submit post (OpenCode,
  // Pi) or by the Enter heuristic in the terminal route (Codex) and cleared
  // only by turn-complete; a slash command or an Esc mid-turn produces no
  // turn-complete, so the mark would stand forever. A turn in flight keeps
  // painting (spinners, streamed text); one that has printed nothing for
  // WORKING_STALE_OUTPUT_MS is a tab at its prompt. Claude keeps its own
  // recovery (the idle_prompt Notification) and is left alone.
  const lifecycleFor = (harness: 'claude' | 'codex' | 'opencode' | 'pi', st: 'idle' | 'working' | 'waiting', key: string): AgentLifecycle => {
    if (st === 'waiting') return harness === 'claude' ? 'needs_input' : 'idle';
    if (st === 'working' && harness !== 'claude' && deps.quiet && deps.quiet(key).output >= WORKING_STALE_OUTPUT_MS) return 'idle';
    return st;
  };

  const lifecycleOf = (ex: Execution): { lifecycle: AgentLifecycle; live: boolean } => {
    const running = isRunning(ex.key);
    if (!running) return { lifecycle: 'offline', live: false };
    const { path: p, mode, id } = parseSessionKey(ex.key);
    const stores = deps.statuses();
    if (mode === 'shell') {
      // A launcher-started agent inside a shell tab posts under `shell:<id>`
      // to whichever store matches its own mode; the first hit wins.
      for (const [harness, store] of Object.entries(stores) as [keyof typeof stores, ClaudeStatusStore][]) {
        const st = store.sessions(p)[`shell:${id}`];
        if (st) return { lifecycle: lifecycleFor(harness, st, ex.key), live: true };
      }
      return { lifecycle: 'ready', live: true };
    }
    const st = stores[mode].sessions(p)[id];
    return { lifecycle: st ? lifecycleFor(mode, st, ex.key) : 'starting', live: true };
  };

  const summarize = (ex: Execution): AgentSummary => {
    const { path: p, mode, id } = parseSessionKey(ex.key);
    const { lifecycle, live } = lifecycleOf(ex);
    return {
      agentId: ex.agentId,
      alias: aliasFor(ex.scopeId, ex.key),
      scopeId: ex.scopeId,
      mode,
      worktreePath: p,
      sessionId: id,
      lifecycle,
      executionId: live ? ex.executionId : null,
      live,
    };
  };

  const inScope = (scopeId: string): Execution[] =>
    [...executions.values()].filter((ex) => ex.scopeId === scopeId);

  const list: AgentRegistry['list'] = async (scopeId) =>
    inScope(scopeId).map(summarize).sort((a, b) => a.agentId.localeCompare(b.agentId));

  const setAlias: AgentRegistry['setAlias'] = (scopeId, agentId, alias) =>
    serialize(async () => {
      if (alias !== null && alias.trim().toLowerCase() === HUMAN_AGENT_ID) throw new AppError('VALIDATION', '"human" is reserved');
      if (alias !== null && alias.trim().toLowerCase() === STRADO_SENDER_ID) throw new AppError('VALIDATION', '"strado" is reserved');
      const ex = inScope(scopeId).find((e) => e.agentId === agentId);
      if (!ex) throw new AppError('NOT_FOUND', `no agent ${agentId} in this workspace`);
      if (alias !== null && !isValidAlias(alias)) {
        throw new AppError('VALIDATION', 'alias must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$');
      }
      if (alias !== null) {
        const clash = names.aliases.find(
          (a) => a.scopeId === scopeId && a.key !== ex.key && a.alias.toLowerCase() === alias.toLowerCase(),
        );
        if (clash) throw new AppError('CONFLICT', `alias "${alias}" is already used in this workspace`);
      }
      names.aliases = names.aliases.filter((a) => !(a.scopeId === scopeId && a.key === ex.key));
      if (alias !== null) names.aliases.push({ scopeId, key: ex.key, alias });
      await persistNames();
      return summarize(ex);
    });

  const resolve: AgentRegistry['resolve'] = async (scopeId, ref) => {
    if (ref === HUMAN_AGENT_ID) throw new AppError('NOT_FOUND', 'no agent "human"');
    if (ref === STRADO_SENDER_ID) throw new AppError('NOT_FOUND', 'no agent "strado"');
    const scoped = inScope(scopeId);
    const exact = scoped.find((e) => e.agentId === ref);
    if (exact) return summarize(exact);
    const wanted = ref.toLowerCase();
    const matches = names.aliases.filter(
      (a) => a.scopeId === scopeId && a.alias.toLowerCase() === wanted && scoped.some((e) => e.key === a.key),
    );
    if (matches.length > 1) throw new AppError('CONFLICT', `alias "${ref}" is ambiguous in this workspace`);
    if (matches.length === 1) {
      const ex = scoped.find((e) => e.key === matches[0]!.key)!;
      return summarize(ex);
    }
    throw new AppError('NOT_FOUND', `no agent "${ref}" in this workspace`);
  };

  return {
    register,
    release,
    flush,
    envFor,
    byToken,
    byKey,
    reconcile,
    list,
    setAlias,
    resolve,
  };
}

export type { NamesFile };
