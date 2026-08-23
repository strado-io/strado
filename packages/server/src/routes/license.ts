import fsp from 'node:fs/promises';
import { FastifyInstance } from 'fastify';
import { licensePath, readLicense } from '../services/licenseFile.js';
import { licenseState, recordVerification } from '../services/licenseState.js';

// The local half of the license file: it never mints a license itself — the
// device-code sign-in flow (routes/auth.ts) is the only thing that writes
// license.json — these routes just read it and tell the UI whether the gate
// is enforced at all. Packaged builds set STRADO_LICENSE_REQUIRED=1; dev runs
// stay ungated. requireLicense.ts is the actual security boundary; these
// routes just read the file it consults.
export async function registerLicenseRoutes(app: FastifyInstance) {
  const required = process.env.STRADO_LICENSE_REQUIRED === '1';
  const apiUrl = (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');
  // anonymous usage counters ride the same token; STRADO_TELEMETRY=0 opts out
  const telemetry = required && process.env.STRADO_TELEMETRY !== '0';

  app.get('/api/license', async () => {
    const license = await readLicense();
    // The enforcement hook (requireLicense.ts) already computes this to decide
    // whether to 401 a request; the UI needs the same answer so a launch that
    // is *stale* (grace expired, cloud unreached) can say so instead of
    // rendering a shell whose every call silently 401s.
    const { status } = await licenseState(new Date());
    return { required, apiUrl, telemetry, license, status };
  });

  app.delete('/api/license', async (_req, reply) => {
    await fsp.rm(licensePath(), { force: true });
    return reply.code(204).send();
  });

  // The hook (requireLicense.ts) only ever reads lastVerifiedAt; this is what
  // writes it. The renderer used to call the cloud's heartbeat directly, so
  // the local server never learned the outcome and the timestamp would have
  // stayed stale forever.
  app.post('/api/license/verify', async () => {
    const license = await readLicense();
    if (!license) return { ok: false, reason: 'none' };
    try {
      const res = await fetch(`${apiUrl}/v1/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: license.token }),
      });
      if (!res.ok) return { ok: false, reason: 'unreachable' };
      const body = (await res.json()) as { ok?: boolean; revoked?: boolean };
      if (body.revoked) {
        // The cloud is the authority on revocation, and this is the whole
        // point of the mechanism: revoking the invite code locks the install out.
        await fsp.rm(licensePath(), { force: true });
        return { ok: false, reason: 'revoked' };
      }
      if (body.ok) {
        await recordVerification(new Date());
        return { ok: true };
      }
      // A reachable cloud answering a bare `ok: false` (no `revoked` flag) is
      // what you get when the device row has been deleted outright — the
      // join in store.pg.ts's heartbeat finds nothing to match, and that is
      // itself a real revocation path, not a corner case. Stamping here would
      // restart this install's own grace window and turn "delete the device
      // row" into a no-op forever. Clearing here would let one ambiguous,
      // possibly-transient answer log every install out at once — a hair
      // trigger on a shared backend becoming its own outage. So: leave the
      // license exactly as it is. The existing grace window keeps counting
      // down regardless, and the install locks itself out within it.
      return { ok: false, reason: 'unconfirmed' };
    } catch {
      // Unreachable is NOT revoked. The grace window exists for exactly this.
      return { ok: false, reason: 'unreachable' };
    }
  });
}
