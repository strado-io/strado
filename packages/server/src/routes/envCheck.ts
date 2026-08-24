import { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { checkTools, installSpec } from '../services/toolCheck.js';
import { createToolInstaller, INSTALL_CHANNEL, type InstallEvent } from '../services/toolInstall.js';

// First-run environment probe: which external CLIs exist on this machine.
// Cached for the process lifetime after the first success — tool installs
// mid-session are rare and a server restart re-probes. An install driven from
// onboarding patches the cache directly (below), so the row it just installed
// doesn't need a full re-probe to go green.
export async function registerEnvCheckRoutes(app: FastifyInstance) {
  let cache: Awaited<ReturnType<typeof checkTools>> | null = null;
  const installer = createToolInstaller(app.deps.bus);

  // Keep the cache honest without re-probing every tool: an install that
  // actually landed reports the freshly probed status for its own id.
  app.deps.bus.on(INSTALL_CHANNEL, (evt) => {
    const { type, data } = evt as InstallEvent;
    if (type !== 'done' || !data.tool || !cache) return;
    cache = cache.map((t) => (t.id === data.tool!.id ? data.tool! : t));
  });

  app.get<{ Querystring: { fresh?: string } }>('/api/env-check', async (req) => {
    if (!cache || req.query.fresh === '1') cache = await checkTools();
    return { tools: cache };
  });

  // Onboarding installs a prerequisite in place. The body carries a tool id and
  // nothing else — the argv lives in toolCheck's TOOLS table, so no caller can
  // choose what runs. Output arrives on /events/env-install.
  app.post<{ Params: { id: string } }>('/api/env-check/install/:id', async (req) => {
    const { id } = req.params;
    if (!installSpec(id)) {
      throw new AppError('VALIDATION', `${id} cannot be installed from here`);
    }
    if (!installer.start(id)) {
      throw new AppError('PROCESS_ALREADY_RUNNING', `an install for ${id} is already running`);
    }
    return { started: true };
  });

  app.delete<{ Params: { id: string } }>('/api/env-check/install/:id', async (req) => {
    installer.cancel(req.params.id);
    return { cancelled: true };
  });
}
