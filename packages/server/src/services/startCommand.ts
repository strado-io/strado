import { AppError } from '../errors.js';
import { deriveRunCommands, type RepoConfig } from '../repoConfig.js';

export type ResolvedRun = {
  id: string;
  name: string;
  command: string;
  /** Read into the environment at start (startEnv.ts); null when the command takes it itself. */
  envFile: string | null;
  /** The repo's first run command: it owns the worktree's port, PORT and the dev proxy. */
  isDefault: boolean;
};

/**
 * Which command a Run starts: `runId` (an id or a name), or the default (the first). A
 * worktree's own start command replaces the default's text there; it may
 * still say {ENV_FILE} to take the default's env file.
 */
export function resolveRunCommand(repo: RepoConfig, runId: string | null, overrideCommand?: string | null): ResolvedRun {
  const all = deriveRunCommands(repo);
  const override = overrideCommand?.trim() || null;
  const first = all[0] ?? (override ? { id: 'dev', name: 'dev', command: override } : null);
  // An id, or (the command box) a name in any case.
  const wanted = runId?.trim().toLowerCase();
  const run = runId ? all.find((c) => c.id === runId) ?? all.find((c) => c.name.trim().toLowerCase() === wanted) : first;
  if (runId && !run) throw new AppError('NOT_FOUND', `no run command ${runId}`);
  if (!run || !run.command.trim()) throw new AppError('VALIDATION', 'empty startCommand');
  const isDefault = run === first;
  const envFile = ('envFile' in run ? run.envFile : null) ?? null;
  if (!isDefault || !override) return { id: run.id, name: run.name, command: run.command, envFile, isDefault };
  const named = /\{ENV_FILE\}/.test(override);
  return {
    id: run.id, name: run.name, isDefault,
    command: named && envFile ? override.replace(/\{ENV_FILE\}/g, envFile) : override,
    envFile: named ? null : envFile,
  };
}
