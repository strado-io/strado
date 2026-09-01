// Per-host reachability breaker, shared by the GitLab and GitHub services.
//
// Why: a repo whose host sits behind a VPN blackholes TCP. Every provider
// call then burns the full 10s request timeout, and with ~25 worktrees on
// that host one poll tick needs longer to drain than the poll interval — the
// browser's handful of HTTP sockets stay parked and the whole app stops
// responding. Neither service caches failures (only successes are cached), so
// every tick paid the full cost again.
//
// One timeout now marks the host unreachable for a cooldown; calls during it
// fail instantly instead of holding a socket. Any response at all — even a
// 401 — proves reachability and clears the mark, as does an explicit refresh.

const COOLDOWN_MS = 60_000;

const unreachableUntil = new Map<string, number>();

/** True while `host` is inside its cooldown after a failed connection. */
export function hostUnreachable(host: string, now = Date.now()): boolean {
  const until = unreachableUntil.get(host);
  if (until === undefined) return false;
  if (now >= until) {
    unreachableUntil.delete(host); // cooldown elapsed — let the next call probe
    return false;
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
}
