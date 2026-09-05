import { describe, expect, it } from 'vitest';
import { resolveStartCommand } from '../../src/services/startCommand.js';
import type { RepoConfig } from '../../src/repoConfig.js';

const repo = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  id: 'r', name: 'R', path: '/r', projectSubdir: null, startCommand: 'npm run dev',
  defaultPort: 3000, editor: 'code',
  envProfiles: [{ name: 'DEFAULT', envFile: '.env' }, { name: 'PROD', envFile: '.env.prod' }],
  defaultEnvProfile: 'DEFAULT',
  ...over,
} as RepoConfig);

describe('resolveStartCommand', () => {
  it('interpolates the chosen profile into a command that asks for it', () => {
    const r = resolveStartCommand(repo({ startCommand: 'dotenv -e {ENV_FILE} -- npm run dev' }), 'PROD');
    expect(r).toEqual({
      command: 'dotenv -e .env.prod -- npm run dev', profile: 'PROD', envFile: '.env.prod', interpolated: true,
    });
  });

  it('keeps the profile for a command with no placeholder — the file is injected instead', () => {
    // Detection produces exactly this: a `.env` becomes a DEFAULT profile
    // while the package.json script stays `npm run dev`. Refusing to start
    // here made Run a dead button on every repo with a .env file.
    const r = resolveStartCommand(repo(), null);
    expect(r).toEqual({ command: 'npm run dev', profile: 'DEFAULT', envFile: '.env', interpolated: false });
  });

  it('honours the active profile without a placeholder too', () => {
    expect(resolveStartCommand(repo(), 'PROD')).toMatchObject({ profile: 'PROD', envFile: '.env.prod', interpolated: false });
  });

  it('a worktree override replaces the command and may still interpolate', () => {
    expect(resolveStartCommand(repo(), 'PROD', 'yarn start --env {ENV_FILE}')).toMatchObject({
      command: 'yarn start --env .env.prod', profile: 'PROD', interpolated: true,
    });
    expect(resolveStartCommand(repo(), 'PROD', 'yarn start')).toMatchObject({
      command: 'yarn start', profile: 'PROD', envFile: '.env.prod', interpolated: false,
    });
  });

  it('no profiles: the command runs as written, nothing to inject', () => {
    expect(resolveStartCommand(repo({ envProfiles: undefined, defaultEnvProfile: undefined }), null)).toEqual({
      command: 'npm run dev', profile: null, envFile: null, interpolated: false,
    });
  });
});
