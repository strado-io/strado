// Runner side of a host's Sandboxes and Logs tabs. Reached by the laptop
// through the relay, never through /api/runners/:id/rpc (its /api/sandbox/
// denylist).
//
// Every failure is a fixed string: runtime stderr can carry anything.
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { realExec, type SandboxRuntime } from '../services/sandbox/runtime.js';
import { readRunnerAgentLogins } from '../services/agentLogins/runnerStore.js';
import { listContainers } from '../services/hostTabs/containers.js';
import { readRunnerLogs } from '../services/hostTabs/runnerLogs.js';
import { sandboxSlugFor, type SandboxService } from '../services/sandbox/sandboxes.js';
import { SandboxEnvSchema } from './worktrees.js';
import { RUNNER_HOST_TAB_PATHS, type LogPage, type LogQuery, type SandboxList, type SandboxRow } from '../services/hostTabs/types.js';

type Names = { repoName: string | null; worktreeName: string | null };

export type HostTabsRunnerDeps = {
  /** null with no sandbox runtime: the container routes are not registered. */
  sandbox: Pick<SandboxService, 'start' | 'stop' | 'remove' | 'worktreeOf'> | null;
  sandboxRuntime: SandboxRuntime | null;
  /** The workspace that holds this worktree, and its display names. */
  findWorktree(worktreePath: string): Promise<({ wsId: string } & Names) | null>;
  /** The existing worktree sandbox rebuild; returns its job id. */
  rebuild(wsId: string, worktreePath: string, sandboxEnv: Record<string, string>): Promise<string>;
  list(describe: (worktreePath: string) => Promise<Names | null>): Promise<SandboxRow[]>;
  readLogs(q: LogQuery): Promise<LogPage>;
  log?: (line: string) => void;
};

const Params = z.object({
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/),
  action: z.enum(['restart', 'stop', 'start', 'rebuild', 'remove']),
});
const ActionBody = z.object({ sandboxEnv: SandboxEnvSchema }).strict().nullish();
const LogsQuery = z.object({
  lines: z.coerce.number().int().positive().optional(),
  grep: z.string().max(200).optional(),
  since: z.coerce.number().nonnegative().optional(),
});

export async function registerHostTabsRunnerRoutes(app: FastifyInstance, deps: HostTabsRunnerDeps): Promise<void> {
  const log = deps.log ?? (() => {});

  app.get(RUNNER_HOST_TAB_PATHS.logs, async (req): Promise<LogPage> => {
    const q = LogsQuery.safeParse(req.query);
    if (!q.success) throw new AppError('VALIDATION', 'bad log query');
    try {
      return await deps.readLogs(q.data);
    } catch {
      log('host tabs: runner log read failed');
      throw new AppError('SHELL_FAILED', 'could not read the runner log');
    }
  });

  const sandbox = deps.sandbox;
  const runtime = deps.sandboxRuntime;
  if (!sandbox || !runtime) return;

  app.get(RUNNER_HOST_TAB_PATHS.sandboxes, async (): Promise<SandboxList> => {
    const describe = async (p: string) => {
      const w = await deps.findWorktree(p);
      return w ? { repoName: w.repoName, worktreeName: w.worktreeName } : null;
    };
    try {
      return { sandboxes: await deps.list(describe), runtime: runtime.bin };
    } catch {
      log('host tabs: container list failed');
      throw new AppError('SHELL_FAILED', 'could not list sandboxes');
    }
  });

  app.post(RUNNER_HOST_TAB_PATHS.action, async (req): Promise<{ ok: true } | { jobId: string }> => {
    const p = Params.safeParse(req.params);
    const body = ActionBody.safeParse(req.body);
    if (!p.success || !body.success) throw new AppError('VALIDATION', 'bad sandbox action');
    const { slug, action } = p.data;

    // Only a container carrying our worktree label is ours to touch, and
    // every action checks it the way a worktree delete does: a known
    // worktree, and the container whose name derives from it.
    const owner = await sandbox.worktreeOf(slug).catch(() => null);
    if (!owner) throw new AppError('CONFLICT', 'not a Strado sandbox');
    const wt = await deps.findWorktree(owner).catch(() => null);
    if (!wt || sandboxSlugFor(path.basename(owner), owner) !== slug) {
      throw new AppError('CONFLICT', 'not a known worktree');
    }
    const failed = new AppError('SHELL_FAILED', `sandbox ${action} failed`);

    if (action === 'remove' || action === 'rebuild') {
      if (action === 'rebuild') {
        try {
          return { jobId: await deps.rebuild(wt.wsId, owner, body.data?.sandboxEnv ?? {}) };
        } catch {
          log(`host tabs: rebuild ${slug} failed to start`);
          throw failed;
        }
      }
      const r = await sandbox.remove(slug).catch(() => ({ ok: false }));
      if (!r.ok) {
        log(`host tabs: remove ${slug} failed`);
        throw failed;
      }
      log(`host tabs: removed ${slug}`);
      return { ok: true };
    }

    try {
      if (action === 'stop' || action === 'restart') {
        const r = await sandbox.stop(slug);
        if (!r.ok) throw failed;
      }
      if (action === 'start' || action === 'restart') await sandbox.start(slug);
    } catch {
      log(`host tabs: ${action} ${slug} failed`);
      throw failed;
    }
    return { ok: true };
  });
}

/** The real deps on a runner: names and the owning workspace from the
 *  workspace stores, Rebuild through the existing worktree sandbox route,
 *  the log from the journal or server.log. */
export function runnerHostTabsDeps(app: FastifyInstance): HostTabsRunnerDeps {
  const d = app.deps;
  const findWorktree = async (worktreePath: string) => {
    for (const ws of await d.workspaces.list().catch(() => [])) {
      const stores = await d.registry.get(ws.id).catch(() => null);
      const meta = await stores?.state.get(worktreePath).catch(() => null);
      if (!stores || !meta) continue;
      const repo = (await stores.repos.list().catch(() => [])).find((r) => r.id === meta.repoId);
      return { wsId: ws.id, repoName: repo?.name ?? null, worktreeName: meta.title || path.basename(worktreePath) };
    }
    return null;
  };
  return {
    sandbox: d.sandbox,
    sandboxRuntime: d.sandboxRuntime,
    findWorktree,
    async rebuild(wsId, worktreePath, sandboxEnv) {
      // The same route a worktree's own Rebuild calls: every check it makes
      // (bare clone, owning repo) applies here unchanged.
      const res = await app.inject({
        method: 'POST',
        url: `/api/w/${encodeURIComponent(wsId)}/worktrees/${encodeURIComponent(worktreePath)}/sandbox`,
        payload: { sandboxEnv },
      });
      let jobId: unknown;
      try {
        jobId = res.statusCode >= 200 && res.statusCode < 300 ? (res.json() as { jobId?: unknown }).jobId : undefined;
      } catch {
        jobId = undefined;
      }
      if (typeof jobId !== 'string') throw new Error('rebuild refused');
      return jobId;
    },
    list: (describe) =>
      listContainers({
        rt: d.sandboxRuntime!,
        exec: realExec,
        describe,
        changedAt: async () => (await readRunnerAgentLogins()).changedAt ?? {},
      }),
    readLogs: (q) =>
      readRunnerLogs(q, {
        exec: realExec,
        underSystemd: !!process.env.INVOCATION_ID,
        logFile: path.join(process.env.STRADO_HOME || path.join(os.homedir(), '.strado'), 'logs', 'server.log'),
      }),
    log: (line) => d.debugLog.log('server', line),
  };
}
