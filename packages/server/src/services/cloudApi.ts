// Shared cloud-call plumbing for every route that proxies strado-api on the
// account's behalf. The renderer must never hold the account's device token:
// it lives in ~/.strado/license.json, which only the server reads, so every
// such route reads it here and injects it server-side.
import { AppError } from '../errors.js';
import { readLicense } from './licenseFile.js';

const TIMEOUT_MS = 10_000;

export type CloudApi = {
  /** The account token, or a 400 the UI can render as "sign in first". */
  token(): Promise<string>;
  cloud<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
};

export function createCloudApi(): CloudApi {
  const apiUrl = (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');

  async function token(): Promise<string> {
    const license = await readLicense();
    if (!license?.token) {
      throw new AppError('VALIDATION', 'no Strado account on this machine — sign in first');
    }
    return license.token;
  }

  async function cloud<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'content-type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // The cloud's org routes (and others) reply with structured JSON
        // reasons — {error:'orphans_runners', runners:[...]}, {error:'cap'},
        // etc — that a UI needs whole, not flattened into a message string.
        // Parse it through as `details` when it is JSON; callers that only
        // want the message (runners.ts) are unaffected since the message
        // itself is unchanged below.
        let details: unknown;
        try {
          details = text ? JSON.parse(text) : undefined;
        } catch {
          details = undefined;
        }
        // Surface the cloud's own reason (revoked token, unknown runner) rather
        // than a generic failure the user can't act on.
        throw new AppError('VALIDATION', `strado-api ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, details);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      throw new AppError('CLOUD_UNREACHABLE', `could not reach strado-api (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { token, cloud };
}
