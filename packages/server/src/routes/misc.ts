import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { ALLOWED_EDITORS } from '../repoConfig.js';

function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

async function newestJsonlMtime(dir: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dir);
    let newest = 0;
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const stat = await fsp.stat(path.join(dir, e));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
    return newest;
  } catch {
    return 0;
  }
}

async function pickClaudeCwd(candidates: string[]): Promise<string> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let best = candidates[0]!;
  let bestMtime = -1;
  for (const c of candidates) {
    const m = await newestJsonlMtime(path.join(projectsRoot, encodeClaudeProjectDir(c)));
    if (m > bestMtime) {
      bestMtime = m;
      best = c;
    }
  }
  return best;
}

export async function registerMiscRoutes(app: FastifyInstance) {
  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/open-editor',
    async (req, reply) => {
      const { repos } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const repoList = await repos.list();
      const repo = findOwningRepo(repoList, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
      if (!ALLOWED_EDITORS.includes(repo.editor)) {
        throw new AppError('VALIDATION', `editor ${repo.editor} not allowed`);
      }
      const child = spawn(repo.editor, [target], { stdio: 'ignore', detached: true });
      child.unref();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/open-terminal',
    async (req, reply) => {
      const { repos } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const repoList = await repos.list();
      const repo = findOwningRepo(repoList, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
      const cwd = repo.projectSubdir ? `${target}/${repo.projectSubdir}` : target;
      const child = spawn('open', ['-a', 'Warp', cwd], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/resume-claude',
    async (req, reply) => {
      // "Resume in Warp" is a macOS-only integration (open + osascript). On
      // other platforms it's a no-op rather than spawning a missing `open`.
      if (process.platform !== 'darwin') return reply.code(204).send();
      const { repos } = req.workspace!.stores;
      const target = decodeURIComponent(req.params.encodedPath);
      const repoList = await repos.list();
      const repo = findOwningRepo(repoList, target, app.deps.homeStateDir, { includeRepoRoot: true });
      if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
      assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);

      const candidates = repo.projectSubdir
        ? [target, path.join(target, repo.projectSubdir)]
        : [target];
      const cwd = await pickClaudeCwd(candidates);

      const opener = spawn('open', ['-a', 'Warp', cwd], { stdio: 'ignore', detached: true });
      opener.unref();

      const script = [
        'delay 1.2',
        'tell application "Warp" to activate',
        'delay 0.4',
        'tell application "System Events" to key code 53',
        'delay 0.15',
        'tell application "System Events" to keystroke "claude -c"',
        'delay 0.25',
        'tell application "System Events" to key code 36',
      ]
        .map((line) => ['-e', line])
        .flat();
      const osa = spawn('osascript', script, { stdio: 'ignore', detached: true });
      osa.unref();

      return reply.code(204).send();
    },
  );

  app.post<{ Params: { encodedPath: string } }>(
    '/worktrees/:encodedPath/refresh-git',
    async (req) => {
      const target = decodeURIComponent(req.params.encodedPath);
      const result = await app.deps.status.status(target);
      app.deps.bus.emit('worktrees', {
        type: 'worktree.updated',
        data: { path: target, gitStatus: result },
      });
      return result;
    },
  );
}
