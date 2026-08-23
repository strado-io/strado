import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveProfile, listenErrorMessage } from './profile.js';

const HOME = '/Users/test';

describe('resolveProfile', () => {
  it('defaults to stable with today\'s exact values', () => {
    expect(resolveProfile({}, HOME)).toEqual({
      name: 'stable',
      homeDir: path.join(HOME, '.strado'),
      configDir: null,
      port: 7777,
      cdpPort: 9222,
    });
  });

  it('resolves dev when STRADO_PROFILE=dev', () => {
    expect(resolveProfile({ STRADO_PROFILE: 'dev' }, HOME)).toEqual({
      name: 'dev',
      homeDir: path.join(HOME, '.strado-dev'),
      configDir: path.join(HOME, '.strado-dev', 'config'),
      port: 7877,
      cdpPort: 9322,
    });
  });

  it('treats an explicit stable the same as no value', () => {
    expect(resolveProfile({ STRADO_PROFILE: 'stable' }, HOME)).toEqual(resolveProfile({}, HOME));
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveProfile({ STRADO_PROFILE: ' dev ' }, HOME).name).toBe('dev');
  });

  it('treats an empty value as unset', () => {
    expect(resolveProfile({ STRADO_PROFILE: '' }, HOME).name).toBe('stable');
  });

  it('throws on an unknown profile rather than falling back', () => {
    expect(() => resolveProfile({ STRADO_PROFILE: 'staging' }, HOME)).toThrow(
      'STRADO_PROFILE must be "stable" or "dev" (got "staging")',
    );
  });

  it('lets single-purpose env vars win over the profile', () => {
    const p = resolveProfile(
      {
        STRADO_PROFILE: 'dev',
        STRADO_HOME: '/tmp/home',
        STRADO_CONFIG_DIR: '/tmp/cfg',
        PORT: '9000',
        STRADO_CDP_PORT: '9100',
      },
      HOME,
    );
    expect(p).toEqual({
      name: 'dev',
      homeDir: '/tmp/home',
      configDir: '/tmp/cfg',
      port: 9000,
      cdpPort: 9100,
    });
  });

  it('honours STRADO_CONFIG_DIR even for stable, whose default is null', () => {
    expect(resolveProfile({ STRADO_CONFIG_DIR: '/tmp/cfg' }, HOME).configDir).toBe('/tmp/cfg');
  });

  it('allows STRADO_CDP_PORT=0 to disable CDP', () => {
    expect(resolveProfile({ STRADO_PROFILE: 'dev', STRADO_CDP_PORT: '0' }, HOME).cdpPort).toBe(0);
  });

  it('keeps a runner (no STRADO_PROFILE) on the stable home and cwd/config', () => {
    const p = resolveProfile({}, HOME);
    expect(p.homeDir).toBe(path.join(HOME, '.strado'));
    expect(p.configDir).toBeNull();
  });

  it('a nested dev launch cannot be subverted by an ambient stable env leaked into its process env', () => {
    // Reproduces what the repo's dev npm scripts do: STRADO_PROFILE=dev plus
    // empty-string overrides for the single-purpose vars, run inside a shell
    // that already has a stable instance's STRADO_HOME/PORT exported (e.g. a
    // terminal opened inside the installed app, whose sessionEnv spreads
    // process.env into every PTY). The empty overrides must win so the dev
    // instance never inherits stable's home dir or port.
    const ambientStable: NodeJS.ProcessEnv = {
      STRADO_HOME: path.join(HOME, '.strado'),
      PORT: '7777',
    };
    const nestedDevLaunch: NodeJS.ProcessEnv = {
      ...ambientStable,
      STRADO_HOME: '',
      STRADO_CONFIG_DIR: '',
      PORT: '',
      STRADO_PROFILE: 'dev',
    };
    const p = resolveProfile(nestedDevLaunch, HOME);
    expect(p.homeDir).toBe(path.join(HOME, '.strado-dev'));
    expect(p.port).toBe(7877);
  });
});

describe('listenErrorMessage', () => {
  it('names the profile and port on EADDRINUSE', () => {
    const profile = resolveProfile({ STRADO_PROFILE: 'dev' }, HOME);
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    expect(listenErrorMessage(err, profile)).toBe(
      'port 7877 is in use — another Strado instance may own the "dev" profile',
    );
  });

  it('passes other errors through unchanged', () => {
    const profile = resolveProfile({}, HOME);
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    expect(listenErrorMessage(err, profile)).toBe('EACCES');
  });
});
