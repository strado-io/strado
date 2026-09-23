// Shared plumbing for one request to a runner's own API, through the relay
// tunnel. Extracted from routes/runners.ts so a second route module (config
// forwarding) can reach the same ticket cache and error mapping rather than
// re-implementing it.
import { AppError, ErrorCode, type ErrorCodeName } from '../errors.js';
import type { CloudApi } from './cloudApi.js';

export type RunnerFetchDeps = {
  cloud: CloudApi['cloud'];
  token: CloudApi['token'];
  timeoutMs: number;
};

export type RunnerFetch = {
  fetch<T>(
    runnerId: string,
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T>;
  /** The runner's relay ticket + httpBase, minted fresh or served from cache. */
  credential(runnerId: string): Promise<{ ticket: string; httpBase: string }>;
};

/**
 * Unwrap a runner's error body down to its human sentence.
 *
 * Our own error shape is `{error:{code,message}}`, so a naive pass-through
 * shows the user JSON. Anything we can't parse falls back to naming the
 * runner and the status, which at least says which machine refused.
 */
export function runnerErrorMessage(body: string, runnerId: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const inner =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ?? parsed.message;
    if (inner) return `${runnerId}: ${inner}`;
  } catch {
    /* not JSON */
  }
  const text = body.trim();
  return text
    ? `${runnerId} returned ${status}: ${text.slice(0, 300)}`
    : `${runnerId} returned ${status}`;
}

// The only codes worth forwarding as-is: exactly the ones routes/agentConfig.ts's
// local code paths actually raise. Deliberately NOT "anything in ErrorCode" —
// several codes map to an HTTP status this relay could never legitimately
// produce for a FAILURE (LOCKFILE_MISMATCH is 200 by design, for a caller that
// treats a mismatch as informational rather than fatal), and blindly
// forwarding one of those would answer the browser 200 for a remote request
// that failed — worse than the generic fallback this replaces. Widen this set
// deliberately, one named code at a time, if another caller of this module
// ever needs a different code propagated; never widen it to "everything".
const FORWARDABLE_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCodeName>([
  'CONFIG_UNPARSEABLE', 'PATH_FORBIDDEN', 'NOT_FOUND', 'VALIDATION',
]);

/**
 * The far side's own error CODE, when its body is our own `{error:{code,
 * message}}` shape, `code` is one of OUR named codes, AND it's on the
 * forwardable allowlist above. `undefined` for anything else (a body we
 * can't parse, a runner on an older build sending a bare string, a code we
 * don't recognize, or a real code we deliberately don't propagate) —
 * callers fall back to their existing generic mapping in that case,
 * unchanged.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a runner
 * replying `{"error":{"code":"toString"}}` (or `"__proto__"`,
 * `"constructor"`, `"hasOwnProperty"`, …) would otherwise read as a "known"
 * code — `ErrorCode.toString` really does exist, it's just
 * `Object.prototype.toString`, not one of our entries — and constructing an
 * `AppError` with it hands `AppError.httpStatus` a FUNCTION instead of a
 * number, which Fastify then rejects outright (`FST_ERR_BAD_STATUS_CODE`),
 * turning a forwarded failure into a 500 that leaks server internals
 * instead of the far side's actual error.
 */
function runnerErrorCode(body: string): ErrorCodeName | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed.error && typeof parsed.error === 'object' ? parsed.error.code : undefined;
    if (typeof code !== 'string' || !Object.hasOwn(ErrorCode, code)) return undefined;
    return FORWARDABLE_ERROR_CODES.has(code) ? (code as ErrorCodeName) : undefined;
  } catch {
    return undefined;
  }
}

export function createRunnerFetch({ cloud, token, timeoutMs }: RunnerFetchDeps): RunnerFetch {
  // Tickets are reusable within their TTL, so cache them: listing remote
  // worktrees makes three calls per runner, and minting one apiece would turn
  // every sidebar refresh into a burst of writes on the cloud store.
  const tickets = new Map<string, { ticket: string; httpBase: string; expiresAt: number }>();

  async function runnerCredential(runnerId: string): Promise<{ ticket: string; httpBase: string }> {
    const hit = tickets.get(runnerId);
    // Re-mint a minute early so a call can't start with a ticket that expires
    // mid-flight.
    if (hit && hit.expiresAt - Date.now() > 60_000) return hit;
    const t = await token();
    const minted = await cloud<{ ticket: string; httpBase: string; expiresAt: string }>(
      '/v1/runners/socket-ticket',
      { method: 'POST', body: { token: t, runnerId } },
    );
    const entry = {
      ticket: minted.ticket,
      httpBase: minted.httpBase,
      expiresAt: Date.parse(minted.expiresAt),
    };
    tickets.set(runnerId, entry);
    return entry;
  }

  /** One request to a runner's own API, through the relay. */
  async function runnerFetch<T>(
    runnerId: string,
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    if (!path.startsWith('/api/')) {
      throw new AppError('VALIDATION', 'runner path must start with /api/');
    }
    const { ticket, httpBase } = await runnerCredential(runnerId);
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? timeoutMs);
    try {
      const res = await fetch(`${httpBase}${path}${sep}ticket=${ticket}`, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 401) {
        // The ticket was rejected (revoked runner, or it aged out while
        // cached). Drop it so the next call mints fresh rather than repeating
        // a request that can only fail.
        tickets.delete(runnerId);
        throw new AppError('VALIDATION', `runner ${runnerId} rejected our access`);
      }
      if (!res.ok) {
        // 503 from the relay means the tunnel is down: an offline runner, not a
        // broken request, and the UI renders those differently.
        if (res.status === 503) {
          throw new AppError('CLOUD_UNREACHABLE', `runner ${runnerId} is offline`);
        }
        // The far side already wrote a message for a human (clone failed,
        // no credentials, …). Pass THAT through — wrapping it in
        // "runner returned 500: {json}" buries the sentence the user needs
        // inside a payload.
        const detail = await res.text().catch(() => '');
        // Propagate the far side's own named error code (CONFIG_UNPARSEABLE,
        // PATH_FORBIDDEN, …) when its body carries one we recognize, instead
        // of flattening every non-401/503 failure to VALIDATION — a caller
        // keyed on the code (the whole point of forwarding a request rather
        // than proxying it blindly) would otherwise see the wrong one for
        // every remote host. Falls back to the prior VALIDATION mapping
        // for a body with no code, unchanged.
        const code = runnerErrorCode(detail) ?? 'VALIDATION';
        throw new AppError(code, runnerErrorMessage(detail, runnerId, res.status));
      }
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      throw new AppError('CLOUD_UNREACHABLE', `could not reach runner ${runnerId} (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetch: runnerFetch, credential: runnerCredential };
}
