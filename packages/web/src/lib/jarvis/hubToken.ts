// The per-boot hub token for the box's human routes (/api/w/:ws/jarvis/*).
// The server mints one per boot and hands it only to a loopback, same-origin
// request; this module fetches it once per page load and keeps it in memory.
// Never in localStorage/sessionStorage: anything persisted there is readable
// by every page that ever shares this origin, and outlives the boot it is for.

export const HUB_TOKEN_HEADER = 'x-strado-hub-token';
const SESSION_URL = '/api/jarvis/session';

let pending: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch(SESSION_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`hub token unavailable (${res.status})`);
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== 'string' || body.token.length === 0) throw new Error('hub token missing from the session response');
  return body.token;
}

/** The token, fetched on first use; concurrent first callers share one request. A failure is not cached. */
export function getHubToken(): Promise<string> {
  pending ??= fetchToken().catch((err: unknown) => { pending = null; throw err; });
  return pending;
}

/** Forget the token (a 401/403 after a server restart, or tests). */
export function resetHubToken(): void {
  pending = null;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(HUB_TOKEN_HEADER, await getHubToken());
  if (init.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(url, { ...init, headers, credentials: 'same-origin' });
}

/** fetch for the box's routes: adds the token, and on 401/403 (a restarted
 * server has a new per-boot token) refreshes it and retries exactly once. */
export async function jarvisFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await send(url, init);
  if (res.status !== 401 && res.status !== 403) return res;
  resetHubToken();
  return send(url, init);
}
