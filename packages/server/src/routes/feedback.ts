import os from 'node:os';
import fsp from 'node:fs/promises';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { readLicense } from '../services/licenseFile.js';

const Body = z.object({
  category: z.enum(['bug', 'idea', 'other']),
  message: z.string().min(1).max(5000),
  email: z.string().max(200).optional(),
  includeDiagnostics: z.boolean().default(false),
  context: z.string().max(200).optional(),
});

// Last N lines / M bytes of a file, whichever is smaller. Never throws.
async function tailFile(file: string, maxLines: number, maxBytes: number): Promise<string | undefined> {
  try {
    const buf = await fsp.readFile(file, 'utf8');
    const sliced = buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
    return sliced.split('\n').slice(-maxLines).join('\n');
  } catch {
    return undefined; // log missing / unreadable — omit it
  }
}

export async function registerFeedbackRoutes(app: FastifyInstance) {
  const apiUrl = (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');

  app.post('/api/feedback', async (req) => {
    const body = Body.parse(req.body);
    const license = await readLicense();

    const payload: Record<string, unknown> = {
      token: license?.token,
      category: body.category,
      message: body.message,
      email: body.email,
      appVersion: process.env.STRADO_APP_VERSION ?? undefined,
    };
    if (body.includeDiagnostics) {
      payload.diagnostics = {
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        logTail: await tailFile(app.deps.debugLog.path, 200, 64 * 1024),
        context: body.context,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${apiUrl}/v1/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new AppError('FEEDBACK_SEND_FAILED', `feedback service returned ${res.status}`);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('FEEDBACK_SEND_FAILED', 'could not reach the feedback service');
    } finally {
      clearTimeout(timer);
    }
    return { ok: true };
  });
}
