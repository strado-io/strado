import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readProfile, writeProfile } from '../services/profileStore.js';
import { assertHubRequest, VIA_RELAY_HEADER } from './appControl.js';
import { AppError } from '../errors.js';
import { readModelCredential, writeModelCredential, credentialSummary } from '../services/modelCredential.js';
import { readRouterCredential, writeRouterCredential } from '../services/routerCredential.js';

const PatchBody = z.object({
  fullName: z.string().max(120).optional(),
  callMe: z.string().max(120).optional(),
  telemetryOptOut: z.boolean().optional(),
  jarvisLocalOnly: z.boolean().optional(),
});

// null/empty clears the credential; a string sets it. Bounded so a fat-finger
// paste can't write a megabyte to disk.
const ModelCredentialBody = z.object({ key: z.string().max(4096).nullable() });

export async function registerProfileRoutes(app: FastifyInstance) {
  app.get('/api/profile', async () => readProfile());
  // Host only (DNS rebinding): the relay forwards a remote window's Origin but
  // always reaches us as 127.0.0.1, so remote Settings keep working.
  app.put('/api/profile', async (req) => {
    assertHubRequest({ host: req.headers.host });
    return writeProfile(PatchBody.parse(req.body));
  });

  // The model API key: writeable, but the GET only ever discloses presence and
  // the last four. The renderer never needs the secret back, so the route never
  // returns it.
  /** Key writes: the local hub only — never a window relayed from another machine. */
  const assertLocalHub = (headers: Record<string, string | string[] | undefined>) => {
    assertHubRequest(headers);
    if (headers[VIA_RELAY_HEADER] !== undefined) throw new AppError('FORBIDDEN', 'keys can only be set on this machine');
  };
  app.get('/api/model-credential', async () => credentialSummary(await readModelCredential()));
  // Only the local hub may set the key (not a page on another origin, not a
  // relayed remote window): it spends the user's money.
  // The OpenRouter key for the command box's fast decisions (Jev). Same rules:
  // presence + last four only; only the local hub may set it.
  app.get('/api/router-credential', async () => credentialSummary(await readRouterCredential()));
  app.post('/api/router-credential', async (req) => {
    assertLocalHub(req.headers);
    const { key } = ModelCredentialBody.parse(req.body);
    await writeRouterCredential(key);
    return credentialSummary(await readRouterCredential());
  });

  app.post('/api/model-credential', async (req) => {
    assertLocalHub(req.headers);
    const { key } = ModelCredentialBody.parse(req.body);
    await writeModelCredential(key);
    return credentialSummary(await readModelCredential());
  });
}
