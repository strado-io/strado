import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPriceCatalog } from '../services/usage/priceCatalog.js';
import { createQuotaService } from '../services/usage/quota.js';
import { createUsageStore, type WorktreeLabel } from '../services/usage/usageStore.js';
import { sampleMachine } from '../services/usage/machine.js';

const Query = z.object({
  // The three windows the UI offers; an arbitrary day count would let a caller
  // ask for a parse the cache does not retain.
  days: z.enum(['7', '30', '90']).default('30'),
});

/**
 * Every worktree the workspace knows about, so a session's cwd can be named on
 * the usage breakdown. Missing repo paths are skipped: a repo the user moved
 * should cost one unattributed row, not a failed page.
 */
async function worktreeLabels(app: FastifyInstance, wsId: string): Promise<WorktreeLabel[]> {
  const stores = await app.deps.registry.get(wsId);
  const repos = await stores.repos.list();
  const labels: WorktreeLabel[] = [];
  for (const repo of repos) {
    labels.push({ path: repo.path, label: repo.name });
    try {
      for (const worktree of await app.deps.git.list(repo.path)) {
        if (worktree.path === repo.path) continue;
        labels.push({ path: worktree.path, label: worktree.branch || worktree.path.split('/').pop() || repo.name });
      }
    } catch {
      // Repo path gone or not a git dir; its worktrees simply go unlabelled.
    }
  }
  return labels;
}

export async function registerUsageRoutes(app: FastifyInstance) {
  // Rates come from the public LiteLLM catalog, cached on disk for a day and
  // falling back to the built-in table offline.
  const catalog = createPriceCatalog({ stateDir: app.deps.homeStateDir });
  const store = createUsageStore({
    agentHomeDir: app.deps.agentHomeDir,
    stateDir: app.deps.homeStateDir,
    catalog,
  });
  const quota = createQuotaService({
    agentHomeDir: app.deps.agentHomeDir,
    codexRateLimits: () => store.codexRateLimits(),
  });

  app.get('/usage/summary', async (req) => {
    const { days } = Query.parse(req.query ?? {});
    const worktrees = await worktreeLabels(app, req.workspace!.id);
    return store.summary({ days: Number(days), worktrees });
  });

  app.get('/usage/accounts', async () => ({ accounts: await quota.accounts() }));

  app.get('/usage/machine', async () => sampleMachine());
}
