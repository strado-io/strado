// Cloud-backed relay auth: runner tokens and one-time attach codes are
// validated against strado-api's internal endpoints (same box, loopback).
// Verify results are cached briefly — allow 60s / deny 10s — so a runner's
// 30s pings don't hammer the API and a revoke lands within a minute.
import type { RelayAuth } from './server.js';

export interface CloudAuthOptions {
  /** strado-api base, e.g. http://127.0.0.1:8790 */
  apiUrl: string;
  internalSecret: string;
  /** Verify-cache TTLs; the allow TTL bounds revocation latency for a live tunnel's re-auth. */
  allowTtlMs?: number;
  denyTtlMs?: number;
  log?: (line: string) => void;
}

export function cloudAuth(opts: CloudAuthOptions): RelayAuth {
  const log = opts.log ?? (() => {});
  const allowTtl = opts.allowTtlMs ?? 60_000;
  const denyTtl = opts.denyTtlMs ?? 10_000;
  const cache = new Map<string, { ok: boolean; until: number }>();

  const post = async (path: string, body: object): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${opts.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': opts.internalSecret },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON error body */
    }
    return { status: res.status, json };
  };

  return {
    async verifyRunner(runnerId, token) {
      const key = `${runnerId}:${token}`;
      const hit = cache.get(key);
      if (hit && hit.until > Date.now()) return hit.ok;
      const { status, json } = await post('/internal/runners/verify', { runnerId, runnerToken: token });
      if (status !== 200) {
        // API errors are not denials: fail closed for this attempt but don't
        // cache, so the runner's reconnect loop recovers as soon as the API is
        // back.
        log(`verify API returned ${status} for ${runnerId}`);
        return false;
      }
      const ok = json.ok === true;
      cache.set(key, { ok, until: Date.now() + (ok ? allowTtl : denyTtl) });
      return ok;
    },

    async authorizeConnect(runnerId, credential) {
      // Attach codes are single-use — never cached.
      const { status, json } = await post('/internal/runners/attach-exchange', { code: credential });
      if (status !== 200) return false;
      return json.runnerId === runnerId;
    },

    async authorizeSocket(runnerId, ticket) {
      // Unlike attach codes these are reusable within their TTL, so caching is
      // both safe and necessary: a reconnect storm would otherwise verify once
      // per attempt. The allow TTL bounds how long a revoked runner's tickets
      // keep working.
      const key = `sock:${runnerId}:${ticket}`;
      const hit = cache.get(key);
      if (hit && hit.until > Date.now()) return hit.ok;
      const { status, json } = await post('/internal/runners/socket-verify', { ticket });
      if (status >= 500) {
        // API trouble is not a denial: fail closed for this attempt without
        // caching, so the client's own retry recovers once the API is back.
        log(`socket-verify API returned ${status} for ${runnerId}`);
        return false;
      }
      const ok = status === 200 && json.runnerId === runnerId;
      cache.set(key, { ok, until: Date.now() + (ok ? allowTtl : denyTtl) });
      return ok;
    },
  };
}

/** Fire-and-forget presence reporter for TunnelManager's online heartbeats. */
export function cloudPresenceReporter(opts: CloudAuthOptions): (runnerId: string) => void {
  return (runnerId) => {
    void fetch(`${opts.apiUrl}/internal/runners/online`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': opts.internalSecret },
      body: JSON.stringify({ runnerId }),
    }).catch(() => {});
  };
}
