import type { RepoConfig } from '../repoConfig.js';

export type ResolvedStartCommand = {
  command: string;
  profile: string | null;
  envFile: string | null;
  /**
   * True when the command named the env file itself via {ENV_FILE}. False
   * means the profile still applies, but by injecting the file's variables
   * into the process environment at start (see startEnv.ts) — a command
   * that never mentions the file must not make the profile picker a lie.
   */
  interpolated: boolean;
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

  if (profiles.length === 0) {
    return { command: base, profile: null, envFile: null, interpolated: false };
  }

  const preferred =
    (activeProfile && profiles.find((p) => p.name === activeProfile)) ||
    (repo.defaultEnvProfile && profiles.find((p) => p.name === repo.defaultEnvProfile)) ||
    profiles[0];

  if (!preferred) {
    return { command: base, profile: null, envFile: null, interpolated: false };
  }

  // Repo detection turns a `.env` into a DEFAULT profile while leaving the
  // package.json script as-is, so "profiles but no placeholder" is the
  // common case, not a misconfiguration. Never refuse to start over it.
  if (!placeholder.test(base)) {
    return { command: base, profile: preferred.name, envFile: preferred.envFile, interpolated: false };
  }

  return {
    command: base.replace(placeholder, preferred.envFile),
    profile: preferred.name,
    envFile: preferred.envFile,
    interpolated: true,
  };
}
