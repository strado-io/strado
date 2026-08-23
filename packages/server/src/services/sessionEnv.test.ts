import { describe, it, expect, afterEach } from 'vitest';
import { sessionEnv } from './terminalManager.js';

const original = process.env.PORT;
const originalServer = process.env.STRADO_SERVER;
const originalStatusPort = process.env.STRADO_STATUS_PORT;
const originalHome = process.env.STRADO_HOME;
const originalConfigDir = process.env.STRADO_CONFIG_DIR;
const originalProfile = process.env.STRADO_PROFILE;
const originalEmbeds = process.env.STRADO_EMBEDS;
const originalWebDist = process.env.STRADO_WEB_DIST;
const originalHooksDir = process.env.STRADO_HOOKS_DIR;
const originalCdpPort = process.env.STRADO_CDP_PORT;
const originalInprocPty = process.env.STRADO_INPROC_PTY;

afterEach(() => {
  if (original === undefined) delete process.env.PORT;
  else process.env.PORT = original;
  if (originalServer === undefined) delete process.env.STRADO_SERVER;
  else process.env.STRADO_SERVER = originalServer;
  if (originalStatusPort === undefined) delete process.env.STRADO_STATUS_PORT;
  else process.env.STRADO_STATUS_PORT = originalStatusPort;
  if (originalHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.STRADO_CONFIG_DIR;
  else process.env.STRADO_CONFIG_DIR = originalConfigDir;
  if (originalProfile === undefined) delete process.env.STRADO_PROFILE;
  else process.env.STRADO_PROFILE = originalProfile;
  if (originalEmbeds === undefined) delete process.env.STRADO_EMBEDS;
  else process.env.STRADO_EMBEDS = originalEmbeds;
  if (originalWebDist === undefined) delete process.env.STRADO_WEB_DIST;
  else process.env.STRADO_WEB_DIST = originalWebDist;
  if (originalHooksDir === undefined) delete process.env.STRADO_HOOKS_DIR;
  else process.env.STRADO_HOOKS_DIR = originalHooksDir;
  if (originalCdpPort === undefined) delete process.env.STRADO_CDP_PORT;
  else process.env.STRADO_CDP_PORT = originalCdpPort;
  if (originalInprocPty === undefined) delete process.env.STRADO_INPROC_PTY;
  else process.env.STRADO_INPROC_PTY = originalInprocPty;
});

describe('sessionEnv', () => {
  it('points STRADO_SERVER at this instance, not a hardcoded 7777', () => {
    process.env.PORT = '7778';
    delete process.env.STRADO_SERVER;
    const env = sessionEnv('claude:1', '/tmp/wt');
    expect(env.STRADO_SERVER).toBe('http://127.0.0.1:7778');
  });

  it('keeps STRADO_STATUS_PORT in step with it', () => {
    process.env.PORT = '7778';
    delete process.env.STRADO_STATUS_PORT;
    expect(sessionEnv('claude:1', '/tmp/wt').STRADO_STATUS_PORT).toBe('7778');
  });

  it('still exports the worktree', () => {
    expect(sessionEnv('claude:1', '/tmp/wt').STRADO_WORKTREE).toBe('/tmp/wt');
  });

  it('does not export this instance\'s identity into the session, but keeps the sanctioned interface', () => {
    process.env.STRADO_HOME = '/Users/x/.strado-dev';
    process.env.STRADO_CONFIG_DIR = '/Users/x/.strado-dev/config';
    process.env.STRADO_PROFILE = 'dev';
    process.env.PORT = '7877';
    process.env.STRADO_EMBEDS = '1';
    process.env.STRADO_WEB_DIST = '/Applications/Strado.app/Contents/Resources/web';
    process.env.STRADO_HOOKS_DIR = '/Applications/Strado.app/Contents/Resources/server/hooks';
    process.env.STRADO_CDP_PORT = '9222';
    process.env.STRADO_INPROC_PTY = '1';

    const env = sessionEnv('claude:1', '/tmp/wt');

    // The instance's identity must not leak — a session that runs
    // `STRADO_PROFILE=dev npm run dev -w packages/server` (or any other
    // nested Strado launch) must resolve its own profile, not inherit this
    // instance's identity, hooks, web dist, or CDP port.
    expect(env).not.toHaveProperty('STRADO_HOME');
    expect(env).not.toHaveProperty('STRADO_CONFIG_DIR');
    expect(env).not.toHaveProperty('STRADO_PROFILE');
    expect(env).not.toHaveProperty('PORT');
    expect(env).not.toHaveProperty('STRADO_EMBEDS');
    expect(env).not.toHaveProperty('STRADO_WEB_DIST');
    expect(env).not.toHaveProperty('STRADO_HOOKS_DIR');
    expect(env).not.toHaveProperty('STRADO_CDP_PORT');

    // STRADO_INPROC_PTY is deliberately inherited — it is a test/break-glass
    // toggle, not an instance-identity var.
    expect(env.STRADO_INPROC_PTY).toBe('1');

    // The sanctioned interface — computed by sessionEnv itself, not
    // inherited via the spread — must keep working.
    expect(env.STRADO_WORKTREE).toBe('/tmp/wt');
    expect(env.STRADO_STATUS_PORT).toBe('7877');
    expect(env.STRADO_SERVER).toBe('http://127.0.0.1:7877');
    expect(env.STRADO_SESSION_ID).toBe('1');
  });
});
