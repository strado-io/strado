import { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { readProfile } from '../services/profileStore.js';
import { readVoiceCredential } from '../services/voiceCredential.js';
import { assertHubRequest, VIA_RELAY_HEADER } from './appControl.js';

/** ElevenLabs mints a token the browser opens one realtime session with (15 min, single use). */
export const ELEVENLABS_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';
const TOKEN_TIMEOUT_MS = 10_000;

export async function registerVoiceRoutes(app: FastifyInstance) {
  // The command box's voice, on ElevenLabs: the renderer streams the mic
  // straight to ElevenLabs with this token; the key itself stays here.
  // Only the local hub: a relayed remote window would spend this machine's key.
  app.post('/api/voice/elevenlabs-token', async (req) => {
    assertHubRequest(req.headers);
    if (req.headers[VIA_RELAY_HEADER] !== undefined) throw new AppError('FORBIDDEN', 'voice keys are used on this machine only', { reason: 'relayed' });
    if ((await readProfile()).jarvisLocalOnly) throw new AppError('FORBIDDEN', 'local only is on: voice stays on this Mac', { reason: 'local_only' });
    const key = await readVoiceCredential();
    if (!key) throw new AppError('NOT_FOUND', 'no ElevenLabs key saved', { reason: 'no_key' });
    let res: Response;
    try {
      res = await fetch(ELEVENLABS_TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    } catch (err) {
      throw new AppError('CLOUD_UNREACHABLE', `ElevenLabs unreachable: ${(err as Error).message}`, { reason: 'upstream' });
    }
    if (res.status === 401 || res.status === 403) throw new AppError('UNAUTHENTICATED', 'ElevenLabs refused the key', { reason: 'bad_key' });
    if (!res.ok) throw new AppError('CLOUD_UNREACHABLE', `ElevenLabs answered ${res.status}`, { reason: 'upstream' });
    const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
    if (typeof body?.token !== 'string' || !body.token) throw new AppError('CLOUD_UNREACHABLE', 'ElevenLabs sent no token', { reason: 'upstream' });
    return { token: body.token };
  });
}
