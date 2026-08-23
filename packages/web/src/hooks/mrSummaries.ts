import { useEffect, useState } from 'react';
import { api } from '../api';
import type { MergeRequest } from '../types';

// One chip per branch: the MR that best answers "what happened to this
// work?" — an open MR beats a merged one beats a closed one. The server
// list is newest-updated first, so the first match of a state is the
// newest of that state.
export function pickMrSummary(mrs: MergeRequest[]): MergeRequest | null {
  return (
    mrs.find((m) => m.state === 'open') ??
    mrs.find((m) => m.state === 'merged') ??
    mrs[0] ??
    null
  );
}

const TTL_MS = 60_000; // matches the server-side per-branch cache

type Entry = { at: number; mr: MergeRequest | null };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<MergeRequest | null>>();

export function __resetMrCache() {
  cache.clear();
  inflight.clear();
}

// Tests only: age every entry past the TTL without losing its value, so
// the keep-last-known-on-error path is exercisable without fake timers.
export function __resetMrCacheTtlOnly() {
  for (const [k, v] of cache) cache.set(k, { ...v, at: 0 });
}

// Create/merge just changed provider state — drop this path so the next
// poll tick refetches instead of serving up-to-60s-stale chips.
export function invalidateMrPath(path: string): void {
  cache.delete(path);
  inflight.delete(path);
}

function fetchSummary(wsId: string, path: string): Promise<MergeRequest | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.mr);
  const pending = inflight.get(path);
  if (pending) return pending;
  // call the api synchronously (tests dedupe on the mock being invoked
  // before the microtask queue drains) but route a synchronous throw
  // (e.g. an incomplete api mock) into the same rejection path as an
  // async one, so both keep the last cached value below.
  let call: Promise<Awaited<ReturnType<typeof api.worktrees.mergeRequests>>>;
  try {
    call = api.worktrees.mergeRequests(wsId, path);
  } catch (err) {
    call = Promise.reject(err);
  }
  const p = call
    .then((r) => (r.kind === 'list' ? pickMrSummary(r.mergeRequests) : null))
    // transient failure (server restarting mid-poll): keep showing the
    // last known chip instead of flickering it away
    .catch(() => cache.get(path)?.mr ?? null)
    .then((mr) => {
      cache.set(path, { at: Date.now(), mr });
      inflight.delete(path);
      return mr;
    });
  inflight.set(path, p);
  return p;
}

/**
 * MR/PR summary per worktree path. `needsAuth`, absent (204), and errors
 * all yield null — the board never nags about auth; the Changes rail does.
 */
export function useMrSummaries(
  wsId: string,
  paths: string[],
): Map<string, MergeRequest | null> {
  const [byPath, setByPath] = useState<Map<string, MergeRequest | null>>(() => new Map());
  const key = paths.join('\n'); // stable identity for the effect; paths never contain \n

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        paths.map(async (p) => [p, await fetchSummary(wsId, p)] as const),
      );
      if (alive) setByPath(new Map(entries));
    };
    void load();
    const timer = setInterval(() => void load(), TTL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // paths is captured via `key` — a new array with the same contents must not refire
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, key]);

  return byPath;
}
