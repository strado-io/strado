import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveProfile } from './profile.js';
import { applyProfileEnv } from './profileEnv.js';

const HOME = '/Users/test';

describe('applyProfileEnv', () => {
  it('writes the dev profile onto the environment', () => {
    const env: NodeJS.ProcessEnv = { STRADO_PROFILE: 'dev' };
    applyProfileEnv(resolveProfile(env, HOME), env);
    expect(env.STRADO_PROFILE).toBe('dev');
    expect(env.PORT).toBe('7877');
    expect(env.STRADO_HOME).toBe(path.join(HOME, '.strado-dev'));
    expect(env.STRADO_CONFIG_DIR).toBe(path.join(HOME, '.strado-dev', 'config'));
  });

  it('leaves STRADO_CONFIG_DIR unset for stable so cwd/config still applies', () => {
    const env: NodeJS.ProcessEnv = {};
    applyProfileEnv(resolveProfile(env, HOME), env);
    expect(env.STRADO_PROFILE).toBe('stable');
    expect(env.PORT).toBe('7777');
    expect(env.STRADO_HOME).toBe(path.join(HOME, '.strado'));
    expect('STRADO_CONFIG_DIR' in env).toBe(false);
  });

  it('does not clobber an explicit override', () => {
    const env: NodeJS.ProcessEnv = { STRADO_PROFILE: 'dev', PORT: '9000' };
    applyProfileEnv(resolveProfile(env, HOME), env);
    expect(env.PORT).toBe('9000');
  });
});
