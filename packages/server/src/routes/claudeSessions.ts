import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { WorkspaceStores } from '../workspaceRegistry.js';

function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

async function statDir(dir: string): Promise<{ files: number; bytes: number; mtimeMs: number }> {
  let files = 0;
  let bytes = 0;
  let mtimeMs = 0;
  try {
    const entries = await fsp.readdir(dir);
    for (const e of entries) {
      const full = path.join(dir, e);
      try {
        const s = await fsp.stat(full);
        if (s.isFile()) {
          files += 1;
          bytes += s.size;
          if (s.mtimeMs > mtimeMs) mtimeMs = s.mtimeMs;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { files, bytes, mtimeMs };
}

async function buildLiveEncoded(app: FastifyInstance, stores: WorkspaceStores): Promise<Set<string>> {
  const live = new Set<string>();
  const repos = await stores.repos.list();
  for (const repo of repos) {
    live.add(encodeProjectDir(repo.path));
    if (repo.projectSubdir) {
      live.add(encodeProjectDir(path.join(repo.path, repo.projectSubdir)));
    }
    let worktrees: { path: string }[] = [];
    try {
      worktrees = await app.deps.git.list(repo.path);
    } catch {
      // repo path may be missing; skip
    }
    for (const w of worktrees) {
      live.add(encodeProjectDir(w.path));
      if (repo.projectSubdir) {
        live.add(encodeProjectDir(path.join(w.path, repo.projectSubdir)));
      }
    }
  }
  return live;
}

export async function registerClaudeSessionsRoutes(app: FastifyInstance) {
  app.get('/claude/sessions/orphans', async (req) => {
    const stores = req.workspace!.stores;
    const root = projectsRoot();
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(root);
    } catch {
      return { root, orphans: [] };
    }
    const live = await buildLiveEncoded(app, stores);
    const orphans: { name: string; files: number; bytes: number; mtimeMs: number }[] = [];
    for (const name of entries) {
      if (live.has(name)) continue;
      const full = path.join(root, name);
      try {
        const s = await fsp.stat(full);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      const meta = await statDir(full);
      orphans.push({ name, ...meta });
    }
    orphans.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { root, orphans };
  });

  const PruneBody = z.object({ names: z.array(z.string().min(1)).min(1) });
  app.post('/claude/sessions/prune', async (req) => {
    const { names } = PruneBody.parse(req.body);
    const root = projectsRoot();
    const deleted: string[] = [];
    for (const name of names) {
      if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
        throw new AppError('VALIDATION', `invalid name: ${name}`);
      }
      const target = path.join(root, name);
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new AppError('VALIDATION', `path escapes projects root: ${name}`);
      }
      try {
        await fsp.rm(target, { recursive: true, force: true });
        deleted.push(name);
      } catch (err) {
        throw new AppError('SHELL_FAILED', `failed to delete ${name}: ${(err as Error).message}`);
      }
    }
    return { deleted };
  });
}
