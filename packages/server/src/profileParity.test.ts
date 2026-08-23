// The Electron shell cannot import the server's ESM profile module, so the
// rules exist twice. This test is the only thing keeping them honest.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolveProfile } from './profile.js';

const require = createRequire(import.meta.url);
const desktop = require('../../desktop/profile.cjs') as {
  resolveProfile: (env?: NodeJS.ProcessEnv, homedir?: string) => unknown;
};

const HOME = '/Users/test';

const CASES: Array<[string, NodeJS.ProcessEnv]> = [
  ['default', {}],
  ['explicit stable', { STRADO_PROFILE: 'stable' }],
  ['dev', { STRADO_PROFILE: 'dev' }],
  ['dev with padded value', { STRADO_PROFILE: ' dev ' }],
  ['empty value', { STRADO_PROFILE: '' }],
  ['whitespace-only value', { STRADO_PROFILE: '   ' }],
  ['home override', { STRADO_PROFILE: 'dev', STRADO_HOME: '/tmp/home' }],
  ['config override', { STRADO_CONFIG_DIR: '/tmp/cfg' }],
  ['port override', { PORT: '9000' }],
  ['empty port', { PORT: '' }],
  ['whitespace port', { PORT: '  ' }],
  ['cdp disabled', { STRADO_PROFILE: 'dev', STRADO_CDP_PORT: '0' }],
  ['empty cdp port', { STRADO_CDP_PORT: '' }],
  ['whitespace cdp port', { STRADO_CDP_PORT: '  ' }],
  ['every override', {
    STRADO_PROFILE: 'dev',
    STRADO_HOME: '/tmp/home',
    STRADO_CONFIG_DIR: '/tmp/cfg',
    PORT: '9000',
    STRADO_CDP_PORT: '9100',
  }],
];

describe('profile resolver parity', () => {
  for (const [label, env] of CASES) {
    it(`agrees for ${label}`, () => {
      expect(desktop.resolveProfile(env, HOME)).toEqual(resolveProfile(env, HOME));
    });
  }

  it('agrees when both args omitted', () => {
    expect(desktop.resolveProfile()).toEqual(resolveProfile());
  });

  it('agrees that an unknown profile throws with identical message', () => {
    let tsError: Error | undefined;
    let cjsError: Error | undefined;

    try {
      resolveProfile({ STRADO_PROFILE: 'staging' }, HOME);
    } catch (e) {
      tsError = e as Error;
    }

    try {
      desktop.resolveProfile({ STRADO_PROFILE: 'staging' }, HOME);
    } catch (e) {
      cjsError = e as Error;
    }

    expect(tsError).toBeDefined();
    expect(cjsError).toBeDefined();
    expect(cjsError?.message).toBe(tsError?.message);
    expect(tsError?.message).toMatch(/STRADO_PROFILE must be "stable" or "dev"/);
  });
});
