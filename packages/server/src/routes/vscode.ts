import { FastifyInstance } from 'fastify';
import { ensureVsCodeWeb, dropVsCodeWeb } from '../services/vscodeWeb.js';
import { AppError } from '../errors.js';
import { vscodeWindows } from '../services/vscodeWindows.js';

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
    const folder = requireFolder(req.body);
    await dropVsCodeWeb(folder);
    // The tab closed, so its window is gone for good. VS Code would keep that
    // window's extension host (and its TypeScript servers) alive for its
    // reconnection grace — hours — holding the memory. End it now.
    await vscodeWindows.closeFolder(folder);
    return { ok: true };
  });

  // The bundled strado-window extension reports which folder each serve-web
  // extension host is showing (Settings → Sessions attributes its tree).
  const requirePid = (body: unknown): number => {
    const pid = (body as { pid?: unknown } | null)?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      throw new AppError('VALIDATION', 'pid must be a positive integer');
    }
    return pid;
  };
  app.post('/api/vscode/window', async (req, reply) => {
    vscodeWindows.report(requirePid(req.body), requireFolder(req.body));
    return reply.code(204).send();
  });
  app.delete('/api/vscode/window', async (req, reply) => {
    vscodeWindows.forget(requirePid(req.body));
    return reply.code(204).send();
  });
}
