// The app's half of the device-code flow. The device token is written under
// ~/.strado by this process — the renderer cannot write files, and the token
// must never be handed to it.
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { licensePath, readLicense } from '../services/licenseFile.js';

/** userCode -> deviceCode, in memory only. A restart mid-sign-in means starting
 *  over, which is correct: the secret should not outlive the attempt. Declared
 *  before its users — a `const` at the bottom of the module works, but only
 *  because handlers run after module init, and that is not a thing to rely on. */
const pending = new Map<string, string>();

function apiUrl(): string {
  return (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');
}

/** Stable per install once a license exists — reused so signing in twice does
 *  not orphan a device row. Before any successful sign-in there is nothing to
 *  reuse, so each abandoned attempt mints its own id; that's harmless, since
 *  mint only inserts a device row on success (see activateForAccount). */
async function deviceId(): Promise<string> {
  const existing = await readLicense();
  if (existing?.deviceId) return existing.deviceId;
  return crypto.randomUUID();
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/start', async (_req, reply) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(`${apiUrl()}/v1/auth/device`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: await deviceId(),
          appVersion: process.env.STRADO_APP_VERSION ?? undefined,
          platform: process.platform,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return reply.code(502).send({ error: `sign-in unavailable (${res.status})` });
    // deviceCode is a secret; it stays in this process and is never returned to
    // the renderer. The UI only needs the code to show and the URL to open.
    const grant = (await res.json()) as {
      userCode: string; deviceCode: string; verificationUrl: string; interval: number; expiresAt: string;
    };
    pending.set(grant.userCode, grant.deviceCode);
    return {
      userCode: grant.userCode,
      verificationUrl: grant.verificationUrl,
      interval: grant.interval,
      expiresAt: grant.expiresAt,
    };
  });

  app.post('/api/auth/poll', async (req, reply) => {
    const { userCode } = z.object({ userCode: z.string().min(8).max(16) }).parse(req.body);
    const deviceCode = pending.get(userCode);
    if (!deviceCode) return reply.code(400).send({ error: 'unknown_user_code' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(`${apiUrl()}/v1/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 400) {
      const { error } = (await res.json()) as { error: string };
      if (error === 'authorization_pending' || error === 'slow_down') return { status: error };
      pending.delete(userCode);
      return { status: 'expired' };
    }
    if (!res.ok) return reply.code(502).send({ error: `sign-in unavailable (${res.status})` });

    const out = (await res.json()) as { token: string; email: string; name: string; deviceId: string };
    const file = licensePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify({ token: out.token, name: out.name, deviceId: out.deviceId, email: out.email }, null, 2),
      { mode: 0o600 },
    );
    pending.delete(userCode);
    return { status: 'signed_in', email: out.email, name: out.name };
  });

  app.post('/api/auth/signout', async (_req, reply) => {
    await fsp.rm(licensePath(), { force: true });
    return reply.code(204).send();
  });
}
