// Liveness + capability advertisement.
//
// /api/capabilities exists because a headless runner is NOT the desktop app:
// VS Code embed and the preview browser are Electron WebContentsView features
// and simply do not exist there. The client must ask rather than infer from
// "is this remote" — a future desktop-hosted-remotely setup would break that
// guess, and silently-dead tabs are the worst possible symptom.
import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    version: process.env.STRADO_APP_VERSION ?? null,
    sessions: app.deps.terminal.liveSessions().length,
  }));

  app.get('/api/capabilities', async () => ({
    // Electron-only surfaces. `false` on a runner; the desktop shell reports
    // true for its own local server.
    embeds: process.env.STRADO_EMBEDS === '1',
    // Headless runners have no window to raise or notify from.
    notifications: process.env.STRADO_EMBEDS === '1',
    runner: process.env.STRADO_RUNNER === '1',
    // Which instance is this? The renderer cannot see app.isPackaged, and the
    // window title must distinguish a dev build from the installed release.
    profile: process.env.STRADO_PROFILE === 'dev' ? 'dev' : 'stable',
    // Sandboxing actually ENABLED on this box — sandboxed worktrees possible.
    // Keys off `sandbox`, not a bare runtime detect: a desktop with Docker
    // installed has a runtime but never sandboxes, and reporting one there
    // would show a capability the UI can't deliver. sandboxRuntime is non-null
    // whenever sandbox is. false otherwise; the UI uses this to show the
    // one-line install hint instead of a per-worktree error.
    sandbox: app.deps.sandbox ? { runtime: app.deps.sandboxRuntime!.bin } : false,
  }));
}
