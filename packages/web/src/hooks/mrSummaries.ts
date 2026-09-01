import { useEffect, useState } from 'react';
import { api, type WorktreeMergeRequests } from '../api';
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

// Polling *at* the TTL meant every tick landed the microsecond the entry went
// stale, so the cache never served anything and each tick cost a full round of
// provider calls. Poll well clear of the TTL instead: create/merge events call
// invalidateMrPath for immediacy, so the interval only backstops those.
const POLL_MS = 5 * 60_000;

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

function summaryOf(entry: WorktreeMergeRequests | undefined): MergeRequest | null {
  return entry?.kind === 'list' ? pickMrSummary(entry.mergeRequests) : null;
}

/**
 * Summaries for `paths`, reading the cache first and asking for whatever is
 * left in ONE batch request. Each path still gets its own inflight entry, so
 * two components mounting the same path share a single lookup.
 */
function fetchSummaries(wsId: string, paths: string[]): Promise<Map<string, MergeRequest | null>> {
  const now = Date.now();
  const out = new Map<string, MergeRequest | null>();
  const settled: Array<Promise<unknown>> = [];
  const wanted: string[] = [];

  for (const path of paths) {
    const hit = cache.get(path);
    if (hit && now - hit.at < TTL_MS) { out.set(path, hit.mr); continue; }
    const pending = inflight.get(path);
    if (pending) { settled.push(pending.then((mr) => out.set(path, mr))); continue; }
    wanted.push(path);
  }

  if (wanted.length) {
    // call the api synchronously (tests dedupe on the mock being invoked
    // before the microtask queue drains) but route a synchronous throw
    // (e.g. an incomplete api mock) into the same rejection path as an
    // async one, so both keep the last cached value below.
    let call: Promise<Awaited<ReturnType<typeof api.worktrees.mergeRequestsBatch>>>;
    try {
      call = api.worktrees.mergeRequestsBatch(wsId, wanted);
    } catch (err) {
      call = Promise.reject(err);
    }
    for (const path of wanted) {
      const per = call
        .then((r) => summaryOf(r?.results?.[path]))
        // transient failure (server restarting mid-poll, host behind a VPN):
        // keep showing the last known chip instead of flickering it away
        .catch(() => cache.get(path)?.mr ?? null)
        .then((mr) => {
          cache.set(path, { at: Date.now(), mr });
          inflight.delete(path);
          out.set(path, mr);
          return mr;
        });
      inflight.set(path, per);
      settled.push(per);
    }
  }

  return Promise.all(settled).then(() => out);
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
      const summaries = await fetchSummaries(wsId, paths);
      if (alive) setByPath(summaries);
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // paths is captured via `key` — a new array with the same contents must not refire
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, key]);

  return byPath;
}
