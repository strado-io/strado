import type { FastifyInstance } from 'fastify';
import { licenseState } from '../services/licenseState.js';

/**
 * The routes that must answer while signed out, because they are how somebody
 * signs in. Everything else requires a license.
 *
 * Keep this list short and exact. It is the same shape of hazard as the cloud's
 * BRIDGED_AUTH_PATHS: an entry nobody questioned is a hole, and a prefix match
 * would quietly open every route beneath it.
 */
export const OPEN_PATHS = [
  '/api/health',         // liveness probe — must answer before anyone is signed in
  '/api/license',        // the UI asks whether it is locked
  '/api/license/verify', // a locked app must be able to discover it is no longer locked
  '/api/auth/start',     // begin a device-code sign-in
  '/api/auth/poll',      // wait for it
  '/api/auth/signout',   // sign out, which by definition needs no license
] as const;

export function registerLicenseEnforcement(app: FastifyInstance): void {
  // The dev switch. Working on Strado must not require signing in to Strado —
  // and yes, this is also the bypass. The app runs on the user's machine, so a
  // determined developer was never going to be stopped here; the point is that
  // hiding the React gate is no longer enough.
  if (process.env.STRADO_LICENSE_REQUIRED !== '1') return;

  app.addHook('onRequest', async (req, reply) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (OPEN_PATHS.includes(url.pathname as (typeof OPEN_PATHS)[number])) return;
    // The gated surface: the REST API, the SSE event streams (registerEventRoutes
    // mounts at /events, not /api/events), and the terminal websocket (mounted at
    // /ws/terminal, not /api/) — that last one is a live shell into the user's
    // worktrees and would otherwise be the biggest hole of all. Everything else
    // is a static asset — the UI itself — and refusing it would serve a blank
    // window instead of the sign-in screen.
    const gated =
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/events/') || url.pathname.startsWith('/ws/');
    if (!gated) return;

    const state = await licenseState(new Date());
    if (state.status === 'ok') return;
    return reply.code(401).send({ error: 'not_licensed', reason: state.status });
  });
}
