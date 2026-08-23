import type { Profile } from './profile.js';

/**
 * Normalise a resolved profile back onto the environment. Existing code reads
 * process.env.PORT / STRADO_HOME directly in several places (e.g.
 * terminalManager.sessionEnv); doing this once at startup keeps a single
 * source of truth instead of threading the profile through every caller.
 *
 * The assignments below are unconditional — they overwrite whatever was
 * already on `env`, echoing back whatever `resolveProfile` resolved (which
 * itself let an explicit override outrank the profile). Because
 * terminalManager.sessionEnv spreads `...process.env` into every PTY, these
 * values become visible to every child process a session spawns — which is
 * why the repo's dev entry points (`dev:server`, `start`, `desktop`,
 * `desktop:nocdp`) blank STRADO_HOME/STRADO_CONFIG_DIR/PORT before setting
 * STRADO_PROFILE=dev: without that, an ambient value from an outer Strado
 * instance would win and a nested launch would collide with it.
 */
export function applyProfileEnv(profile: Profile, env: NodeJS.ProcessEnv = process.env): void {
  env.STRADO_PROFILE = profile.name;
  env.PORT = String(profile.port);
  env.STRADO_HOME = profile.homeDir;
  if (profile.configDir !== null) env.STRADO_CONFIG_DIR = profile.configDir;
}
