import type { RepoConfig } from '../repoConfig.js';
import { AppError } from '../errors.js';

export type ResolvedStartCommand = {
  command: string;
  profile: string | null;
  envFile: string | null;
};

export function resolveStartCommand(
  repo: RepoConfig,
  activeProfile: string | null,
  overrideCommand?: string | null,
): ResolvedStartCommand {
  // A worktree-level override replaces the repo command wholesale; it may
  // still use {ENV_FILE} to participate in env profiles.
  const base = overrideCommand?.trim() ? overrideCommand.trim() : repo.startCommand;
  const profiles = repo.envProfiles ?? [];
  const placeholder = /\{ENV_FILE\}/g;
  const hasPlaceholder = placeholder.test(base);

  if (profiles.length === 0) {
    return { command: base, profile: null, envFile: null };
  }

  const preferred =
    (activeProfile && profiles.find((p) => p.name === activeProfile)) ||
    (repo.defaultEnvProfile && profiles.find((p) => p.name === repo.defaultEnvProfile)) ||
    profiles[0];

  if (!preferred) {
    return { command: base, profile: null, envFile: null };
  }

  if (!hasPlaceholder) {
    // Repo commands must interpolate the profile; an override without the
    // placeholder is taken literally (the user chose a fixed command).
    if (overrideCommand?.trim()) {
      return { command: base, profile: null, envFile: null };
    }
    throw new AppError(
      'VALIDATION',
      `startCommand must contain {ENV_FILE} placeholder when envProfiles is set (repo: ${repo.id})`,
    );
  }

  return {
    command: base.replace(/\{ENV_FILE\}/g, preferred.envFile),
    profile: preferred.name,
    envFile: preferred.envFile,
  };
}
