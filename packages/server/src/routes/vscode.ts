import { FastifyInstance } from 'fastify';
import { ensureVsCodeWeb, dropVsCodeWeb } from '../services/vscodeWeb.js';
import { AppError } from '../errors.js';

function requireFolder(body: unknown): string {
  const folder = (body as { folder?: unknown } | null)?.folder;
  if (typeof folder !== 'string' || !folder.startsWith('/')) {
    throw new AppError('VALIDATION', 'folder must be an absolute path');
  }
  return folder;
}

export async function registerVsCodeRoutes(app: FastifyInstance) {
  // One serve-web daemon per worktree folder, reaped on close.
  app.post('/api/vscode', async (req) => ensureVsCodeWeb(requireFolder(req.body)));
  app.delete('/api/vscode', async (req) => {
    await dropVsCodeWeb(requireFolder(req.body));
    return { ok: true };
  });
}
