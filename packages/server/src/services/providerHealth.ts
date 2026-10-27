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
//
// Nor does the first contact cost 10s: before a host has answered once, a bare
// TCP connect (CONNECT_TIMEOUT_MS) says whether anything is there. A host
// behind a VPN that's off fails it in 1.5s; a reachable one connects in
// milliseconds and isn't checked again until it fails. The server also checks
// every repo's host at start (warmHost), so a page load rarely pays even that.
import net from 'node:net';

const COOLDOWN_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 1_500;

const unreachableUntil = new Map<string, number>();
const probing = new Set<string>();
/** Hosts that accepted a connection, until one of their calls fails. */
const connected = new Set<string>();
const checking = new Map<string, Promise<boolean>>();

/** Can a TCP connection be opened to the host's HTTPS port? `host` may carry a port. */
function tcpCheck(host: string): Promise<boolean> {
  const m = /^(.*?)(?::(\d+))?$/.exec(host)!;
  return new Promise((resolve) => {
    const socket = net.connect({ host: m[1]!, port: m[2] ? Number(m[2]) : 443 });
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
// Suites mock fetch for made-up hosts: no real sockets there (unit tests set their own).
let connectCheck: (host: string) => Promise<boolean> = process.env.VITEST ? async () => true : tcpCheck;

/**
 * Whether to call `host` now: false while it is marked unreachable, and for a
 * host not yet heard from, the answer of one shared quick connect check.
 */
export async function hostReachable(host: string): Promise<boolean> {
  if (hostUnreachable(host)) return false;
  if (connected.has(host)) return true;
  let check = checking.get(host);
  if (!check) {
    check = connectCheck(host).then((ok) => {
      checking.delete(host);
      if (ok) connected.add(host);
      else markHostUnreachable(host);
      return ok;
    });
    checking.set(host, check);
  }
  return check;
}

/** Check a host in the background (server start), so the first call knows. */
export function warmHost(host: string): void {
  void hostReachable(host);
}

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
      if (up) { unreachableUntil.delete(host); connected.add(host); }
      else markHostUnreachable(host);
    });
  }
  return true;
}

/** Record that `host` could not be reached, starting a fresh cooldown. */
export function markHostUnreachable(host: string, now = Date.now()): void {
  connected.delete(host);
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
  connected.clear();
  checking.clear();
}

/** Tests only: the first-contact connect check. */
export function __setConnectCheck(fn: (host: string) => Promise<boolean>): void {
  connectCheck = fn;
}

/** Tests only: what the background probe does. */
export function __setProbe(fn: (host: string) => Promise<boolean>): void {
  probe = fn;
}
