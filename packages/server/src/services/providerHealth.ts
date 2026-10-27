// Per-host reachability breaker, shared by the GitLab and GitHub services.
//
// Why: a repo whose host sits behind a VPN blackholes TCP. Every provider
// call then burns the full 10s request timeout, and with ~25 worktrees on
// that host one poll tick needs longer to drain than the poll interval — the
// browser's handful of HTTP sockets stay parked and the whole app stops
// responding. Neither service caches failures (only successes are cached), so
// every tick paid the full cost again.
//
// One timeout now marks the host unreachable; calls fail instantly instead of
// holding a socket. Any response at all — even a 401 — proves reachability and
// clears the mark, as does an explicit refresh.
//
// After the cooldown, the host is tried again in the background, never by a
// caller: a page load used to be the probe, and its 10s wait parked two of the
// browser's six sockets while the Files tab queued behind them. Calls keep
// failing fast until the probe gets an answer.

const COOLDOWN_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

const unreachableUntil = new Map<string, number>();
const probing = new Set<string>();

/** Any HTTP answer from the host means it is reachable. Tests replace it. */
let probe = async (host: string): Promise<boolean> => {
  try {
    await fetch(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
};

/** True while `host` is marked: until its background probe gets an answer. */
export function hostUnreachable(host: string, now = Date.now()): boolean {
  const until = unreachableUntil.get(host);
  if (until === undefined) return false;
  if (now >= until && !probing.has(host)) {
    probing.add(host);
    void probe(host).then((up) => {
      probing.delete(host);
      if (!unreachableUntil.has(host)) return; // cleared meanwhile (a refresh got through)
      if (up) unreachableUntil.delete(host);
      else markHostUnreachable(host);
    });
  }
  return true;
}

/** Record that `host` could not be reached, starting a fresh cooldown. */
export function markHostUnreachable(host: string, now = Date.now()): void {
  unreachableUntil.set(host, now + COOLDOWN_MS);
}

/** Forget any mark for `host` — it answered, or the user asked us to retry. */
export function clearHostHealth(host: string): void {
  unreachableUntil.delete(host);
}

/** Tests only. */
export function __resetProviderHealth(): void {
  unreachableUntil.clear();
  probing.clear();
}

/** Tests only: what the background probe does. */
export function __setProbe(fn: (host: string) => Promise<boolean>): void {
  probe = fn;
}
