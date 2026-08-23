import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readProfile, writeProfile } from '../services/profileStore.js';
import { readModelCredential, writeModelCredential, credentialSummary } from '../services/modelCredential.js';

const PatchBody = z.object({
  fullName: z.string().max(120).optional(),
  callMe: z.string().max(120).optional(),
  telemetryOptOut: z.boolean().optional(),
});

// null/empty clears the credential; a string sets it. Bounded so a fat-finger
// paste can't write a megabyte to disk.
const ModelCredentialBody = z.object({ key: z.string().max(4096).nullable() });

export async function registerProfileRoutes(app: FastifyInstance) {
  app.get('/api/profile', async () => readProfile());
  app.put('/api/profile', async (req) => writeProfile(PatchBody.parse(req.body)));

  // The model API key: writeable, but the GET only ever discloses presence and
  // the last four. The renderer never needs the secret back, so the route never
  // returns it.
  app.get('/api/model-credential', async () => credentialSummary(await readModelCredential()));
  app.post('/api/model-credential', async (req) => {
    const { key } = ModelCredentialBody.parse(req.body);
    await writeModelCredential(key);
    return credentialSummary(await readModelCredential());
  });
}
