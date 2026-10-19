import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';

// Guards for `agent_spawn`: an agent opening tabs is the one MCP action whose
// mistakes compound (retries double, children spawn children), so every spawn
// passes through here.
//
// Identity is the EXECUTION, not the agent id: agent ids are deterministic and
// reused (a new Claude tab can become `claude-3@wt` after a spawned
// `claude-3@wt` exited), executions are minted per tab. The parent markers are
// persisted, because PTYs and executions outlive a server restart (strado-ptyd
// keeps the tabs; agent-executions.json keeps the tokens) — a restart must not
// hand a spawned child spawn rights.

export const SPAWN_RATE_PER_MIN = 6;
export const SPAWN_LIVE_MAX_DEFAULT = 8;
export const SPAWN_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export type SpawnGuardDeps = {
  now?: () => number;
  /** Is this execution still a live tab? Counts the scope's live agent-spawned tabs. */
  isLive: (scopeId: string, executionId: string) => Promise<boolean>;
  liveMax?: () => number;
  /** JSON file the parent markers persist to; omitted = in memory (tests). */
  file?: string;
  log?: (message: string) => void;
};

export type SpawnReservation = {
  /** The tab exists: mark it as agent-spawned and stop counting the reservation. Call at once after the spawn. */
  commit(childExecutionId: string): void;
  /** The spawn failed before a tab existed. */
  release(): void;
};

export type IdempotencyHit<T> = { response: T } | null;

export type SpawnGuard = {
  /** Replay for this key: the finished response, or waits for an in-flight one.
   * CONFLICT when the key was used with a different body. Null = go ahead (and
   * the caller MUST later call `complete` or `abandon` with the same key). */
  begin<T>(scopeId: string, callerExecutionId: string, key: string | null | undefined, bodyHash: string): Promise<IdempotencyHit<T>>;
  complete<T>(scopeId: string, callerExecutionId: string, key: string | null | undefined, response: T): void;
  abandon(scopeId: string, callerExecutionId: string, key: string | null | undefined): void;
  /** FORBIDDEN / BACKPRESSURE when the caller may not spawn now. Synchronous
   * bookkeeping happens before any await, so parallel calls cannot overshoot. */
  admit(scopeId: string, callerExecutionId: string): Promise<SpawnReservation>;
  /** Was this execution opened by agent_spawn? Such a tab may not spawn or
   * type into other shells. */
  isSpawned(executionId: string): boolean;
  /** The execution that spawned this one through agent_spawn, or null. */
  parentOf(executionId: string): string | null;
};

type Pending<T> = { hash: string; at: number; done: boolean; response?: T; waiters: ((r: T | null) => void)[] };

export function createSpawnGuard(deps: SpawnGuardDeps): SpawnGuard {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const liveMax = deps.liveMax ?? (() => {
    const n = Number(process.env.STRADO_MCP_SPAWN_MAX);
    return Number.isInteger(n) && n > 0 ? n : SPAWN_LIVE_MAX_DEFAULT;
  });

  // child executionId → { scopeId, parent executionId }
  const parents = new Map<string, { scopeId: string; parent: string }>();
  const attempts = new Map<string, number[]>();      // caller executionId → timestamps
  const reserved = new Map<string, number>();         // scopeId → in-flight spawns
  const idem = new Map<string, Pending<unknown>>();

  if (deps.file) {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.file, 'utf8')) as { children?: { child: string; scopeId: string; parent: string }[] };
      for (const c of raw.children ?? []) if (typeof c.child === 'string') parents.set(c.child, { scopeId: c.scopeId, parent: c.parent });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`spawn markers unreadable, starting empty: ${(err as Error).message}`);
    }
  }
  const persist = (): void => {
    if (!deps.file) return;
    try {
      fs.mkdirSync(path.dirname(deps.file), { recursive: true });
      const tmp = `${deps.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ children: [...parents].map(([child, v]) => ({ child, ...v })) }), { mode: 0o600 });
      fs.renameSync(tmp, deps.file);
    } catch (err) {
      log(`spawn markers not saved: ${(err as Error).message}`);
    }
  };

  const k = (...parts: string[]) => parts.join('\0');
  const prune = (): void => {
    const t = now();
    for (const [key, v] of idem) if (v.done && t - v.at > SPAWN_IDEMPOTENCY_TTL_MS) idem.delete(key);
  };

  return {
    async begin<T>(scopeId: string, caller: string, key: string | null | undefined, bodyHash: string): Promise<IdempotencyHit<T>> {
      if (!key) return null;
      prune();
      const id = k(scopeId, caller, key);
      const hit = idem.get(id) as Pending<T> | undefined;
      if (!hit) {
        idem.set(id, { hash: bodyHash, at: now(), done: false, waiters: [] });
        return null;
      }
      if (hit.hash !== bodyHash) throw new AppError('CONFLICT', 'idempotencyKey was already used with a different request', { reason: 'idempotency_mismatch' });
      if (hit.done) return { response: hit.response as T };
      const r = await new Promise<T | null>((resolve) => hit.waiters.push(resolve as (r: unknown) => void));
      if (r === null) throw new AppError('CONFLICT', 'the earlier request with this idempotencyKey failed; retry with a new key', { reason: 'idempotency_failed' });
      return { response: r };
    },
    complete(scopeId, caller, key, response) {
      if (!key) return;
      const p = idem.get(k(scopeId, caller, key));
      if (!p) return;
      p.done = true; p.response = response; p.at = now();
      for (const w of p.waiters.splice(0)) w(response);
    },
    abandon(scopeId, caller, key) {
      if (!key) return;
      const id = k(scopeId, caller, key);
      const p = idem.get(id);
      if (!p || p.done) return;
      idem.delete(id);
      for (const w of p.waiters.splice(0)) w(null);
    },
    async admit(scopeId, caller) {
      if (parents.has(caller)) {
        throw new AppError('FORBIDDEN', 'a tab opened by agent_spawn cannot open more tabs; ask the human with intercom_escalate', { reason: 'spawn_depth' });
      }
      // Everything up to the first await is synchronous: rate and reservation
      // are taken before any other call can interleave.
      const t = now();
      const recent = (attempts.get(caller) ?? []).filter((x) => t - x < 60_000);
      if (recent.length >= SPAWN_RATE_PER_MIN) {
        attempts.set(caller, recent);
        throw new AppError('BACKPRESSURE', `at most ${SPAWN_RATE_PER_MIN} spawns per minute`, { reason: 'spawn_rate' });
      }
      recent.push(t);
      attempts.set(caller, recent);
      reserved.set(scopeId, (reserved.get(scopeId) ?? 0) + 1);
      let open = true;
      const release = (): void => {
        if (!open) return;
        open = false;
        const n = (reserved.get(scopeId) ?? 1) - 1;
        if (n <= 0) reserved.delete(scopeId); else reserved.set(scopeId, n);
      };

      let live = 0;
      let pruned = false;
      try {
        for (const [child, v] of [...parents]) {
          if (v.scopeId !== scopeId) continue;
          if (await deps.isLive(scopeId, child)) live += 1;
          else { parents.delete(child); pruned = true; }
        }
      } catch (err) {
        release();
        throw err;
      }
      if (pruned) persist();
      // `reserved` includes this call; live children plus every in-flight spawn must fit.
      if (live + (reserved.get(scopeId) ?? 0) > liveMax()) {
        release();
        throw new AppError('BACKPRESSURE', `at most ${liveMax()} agent-opened tabs may be live in a workspace; close some first`, { reason: 'spawn_cap' });
      }
      return {
        commit(child) {
          parents.set(child, { scopeId, parent: caller });
          persist();
          release();
        },
        release,
      };
    },
    isSpawned(executionId) {
      return parents.has(executionId);
    },
    parentOf(executionId) {
      return parents.get(executionId)?.parent ?? null;
    },
  };
}
