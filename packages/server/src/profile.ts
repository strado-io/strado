// Which instance of Strado is this? The installed release ("stable") and a
// build run from the repo ("dev") must never share a state dir, a port, or a
// CDP endpoint, or restarting one disturbs the other.
//
// The default is deliberately `stable`, opted out of by the repo's own npm
// scripts. The tempting rule — "unpackaged means dev" — cannot live here: the
// server also runs headless on a runner, which is equally unpackaged and must
// keep using ~/.strado.
//
// MUST stay in agreement with packages/desktop/profile.cjs (the Electron shell
// is CommonJS and cannot import this module). profileParity.test.ts pins that.
import os from 'node:os';
import path from 'node:path';

export type ProfileName = 'stable' | 'dev';

export interface Profile {
  name: ProfileName;
  homeDir: string;
  /** null = leave the existing cwd/config default alone (see DEFAULTS below). */
  configDir: string | null;
  port: number;
  cdpPort: number;
}

const DEFAULTS: Record<ProfileName, { dirName: string; port: number; cdpPort: number }> = {
  // Every value here is today's shipped default. Changing one is a regression.
  stable: { dirName: '.strado', port: 7777, cdpPort: 9222 },
  dev: { dirName: '.strado-dev', port: 7877, cdpPort: 9322 },
};

export function resolveProfile(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): Profile {
  const raw = env.STRADO_PROFILE?.trim();
  if (raw !== undefined && raw !== '' && raw !== 'stable' && raw !== 'dev') {
    throw new Error(`STRADO_PROFILE must be "stable" or "dev" (got "${raw}")`);
  }
  const name: ProfileName = raw === 'dev' ? 'dev' : 'stable';
  const base = DEFAULTS[name];
  const home = path.join(homedir, base.dirName);
  const portStr = env.PORT?.trim();
  const cdpPortStr = env.STRADO_CDP_PORT?.trim();
  return {
    name,
    homeDir: env.STRADO_HOME || home,
    // stable keeps app.ts's cwd/config default: a runner resolves to stable,
    // and relocating its workspaces.json would bring it back up with no repos.
    configDir: env.STRADO_CONFIG_DIR || (name === 'dev' ? path.join(home, 'config') : null),
    port: Number(portStr || base.port),
    cdpPort: Number(cdpPortStr || base.cdpPort),
  };
}

/**
 * A bare EADDRINUSE sends you log-diving for a one-line problem, so name the
 * likely cause: the other instance already owns this profile's port.
 */
export function listenErrorMessage(err: NodeJS.ErrnoException, profile: Profile): string {
  if (err.code === 'EADDRINUSE') {
    return `port ${profile.port} is in use — another Strado instance may own the "${profile.name}" profile`;
  }
  return err.message;
}
