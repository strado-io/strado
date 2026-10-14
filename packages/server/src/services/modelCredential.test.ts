import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readModelCredential,
  writeModelCredential,
  modelCredentialPath,
  credentialSummary,
  sandboxEnvForRepo,
  cloneCredentialForRepo,
  credentialFromSandboxEnv,
} from './modelCredential.js';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'model-cred-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('model credential store', () => {
  it('round-trips a key and returns null when absent', async () => {
    expect(await readModelCredential()).toBeNull();
    await writeModelCredential('sk-ant-secret');
    expect(await readModelCredential()).toBe('sk-ant-secret');
  });

  it('writes the file mode 600 (owner-only)', async () => {
    await writeModelCredential('sk-ant-secret');
    const st = await fsp.stat(modelCredentialPath());
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('trims surrounding whitespace so a pasted key never carries a newline', async () => {
    await writeModelCredential('  sk-ant-secret\n');
    expect(await readModelCredential()).toBe('sk-ant-secret');
  });

  it('clears the credential on null or empty', async () => {
    await writeModelCredential('sk-ant-secret');
    await writeModelCredential(null);
    expect(await readModelCredential()).toBeNull();
    await writeModelCredential('sk-ant-secret');
    await writeModelCredential('   ');
    expect(await readModelCredential()).toBeNull();
  });
});

describe('credentialSummary', () => {
  it('never contains the key — only presence and last4', () => {
    const s = credentialSummary('sk-ant-1234567890');
    expect(s).toEqual({ present: true, last4: '7890' });
    expect(JSON.stringify(s)).not.toContain('sk-ant');
    expect(Object.keys(s)).toEqual(['present', 'last4']);
  });

  it('reports absence', () => {
    expect(credentialSummary(null)).toEqual({ present: false, last4: null });
  });
});

describe('sandboxEnvForRepo', () => {
  const identity = async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' });
  const noIdentity = async () => ({ name: null, email: null });

  it('picks GITHUB_TOKEN for a github cloneUrl, not GITLAB_TOKEN', async () => {
    const env = await sandboxEnvForRepo(
      { path: '/repo', cloneUrl: 'https://github.com/acme/app.git' },
      {
        readModelKey: async () => 'sk-ant-key',
        gitIdentity: identity,
        readGithub: async () => ({ 'github.com/acme': { token: 'gh-tok' } }),
        readGitlab: async () => ({ 'gitlab.com': { token: 'gl-tok' } }),
      },
    );
    expect(env.GITHUB_TOKEN).toBe('gh-tok');
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBe('/usr/local/bin/strado-askpass');
    expect(env.GIT_HTTP_USER).toBe('x-access-token');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-key');
    expect(env.GIT_AUTHOR_NAME).toBe('Ada Lovelace');
    expect(env.GIT_COMMITTER_EMAIL).toBe('ada@example.com');
  });

  it('picks GITLAB_TOKEN for a gitlab cloneUrl, not GITHUB_TOKEN', async () => {
    const env = await sandboxEnvForRepo(
      { path: '/repo', cloneUrl: 'git@gitlab.com:acme/app.git' },
      {
        readModelKey: async () => null,
        gitIdentity: identity,
        readGithub: async () => ({ 'github.com/acme': { token: 'gh-tok' } }),
        readGitlab: async () => ({ 'gitlab.com': { token: 'gl-tok' } }),
      },
    );
    expect(env.GITLAB_TOKEN).toBe('gl-tok');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBe('/usr/local/bin/strado-askpass');
    expect(env.GIT_HTTP_USER).toBe('oauth2');
  });

  it('omits ANTHROPIC_API_KEY entirely when no key is stored (never an empty string)', async () => {
    const env = await sandboxEnvForRepo(
      { path: '/repo', cloneUrl: 'https://github.com/acme/app.git' },
      {
        readModelKey: async () => null,
        gitIdentity: identity,
        readGithub: async () => ({}),
        readGitlab: async () => ({}),
      },
    );
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });

  it('omits git identity when unset rather than fabricating it', async () => {
    const env = await sandboxEnvForRepo(
      { path: '/repo', cloneUrl: null },
      {
        readModelKey: async () => 'sk-ant-key',
        gitIdentity: noIdentity,
        readGithub: async () => ({}),
        readGitlab: async () => ({}),
      },
    );
    expect('GIT_AUTHOR_NAME' in env).toBe(false);
    expect('GIT_AUTHOR_EMAIL' in env).toBe(false);
    expect('GIT_COMMITTER_NAME' in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-key');
  });

  it('omits the provider token (and askpass) when none is configured for the host', async () => {
    const env = await sandboxEnvForRepo(
      { path: '/repo', cloneUrl: 'https://github.com/acme/app.git' },
      {
        readModelKey: async () => null,
        gitIdentity: noIdentity,
        readGithub: async () => ({}),
        readGitlab: async () => ({}),
      },
    );
    expect('GITHUB_TOKEN' in env).toBe(false);
    expect('GIT_ASKPASS' in env).toBe(false);
    expect('GIT_HTTP_USER' in env).toBe(false);
  });

  it('prefers an owner-scoped github token over the bare-host entry', async () => {
    const env = await sandboxEnvForRepo(
      { path: '/repo', cloneUrl: 'https://github.com/acme/app.git' },
      {
        readModelKey: async () => null,
        gitIdentity: noIdentity,
        readGithub: async () => ({ 'github.com': { token: 'host-tok' }, 'github.com/acme': { token: 'owner-tok' } }),
        readGitlab: async () => ({}),
      },
    );
    expect(env.GITHUB_TOKEN).toBe('owner-tok');
  });
});

describe('cloneCredentialForRepo', () => {
  const cfg = {
    readGithub: async () => ({ 'github.com/acme': { token: 'gh-tok' } }),
    readGitlab: async () => ({ 'gitlab.stg-fleetx.io': { token: 'gl-tok' } }),
  };
  it('rewrites a GitLab SSH remote to HTTPS with the host token', async () => {
    const out = await cloneCredentialForRepo({ cloneUrl: 'git@gitlab.stg-fleetx.io:fleetxdev/fleetx-react-app.git' }, cfg);
    expect(out).toEqual({
      url: 'https://gitlab.stg-fleetx.io/fleetxdev/fleetx-react-app.git',
      credential: { username: 'oauth2', password: 'gl-tok' },
    });
  });
  it('uses the GitHub PAT for the owner', async () => {
    const out = await cloneCredentialForRepo({ cloneUrl: 'git@github.com:acme/app.git' }, cfg);
    expect(out).toEqual({
      url: 'https://github.com/acme/app.git',
      credential: { username: 'x-access-token', password: 'gh-tok' },
    });
  });
  it('null when nothing is connected for the host, or there is no remote', async () => {
    expect(await cloneCredentialForRepo({ cloneUrl: 'git@github.com:other/app.git' }, cfg)).toBeNull();
    expect(await cloneCredentialForRepo({ cloneUrl: 'https://bitbucket.org/x/y.git' }, cfg)).toBeNull();
    expect(await cloneCredentialForRepo({ cloneUrl: null }, cfg)).toBeNull();
  });
});

describe('credentialFromSandboxEnv', () => {
  it('reads back the token the desktop bundled, with its username', () => {
    expect(credentialFromSandboxEnv({ GITLAB_TOKEN: 'gl', GIT_HTTP_USER: 'oauth2' })).toEqual({ username: 'oauth2', password: 'gl' });
    expect(credentialFromSandboxEnv({ GITHUB_TOKEN: 'gh' })).toEqual({ username: 'x-access-token', password: 'gh' });
    expect(credentialFromSandboxEnv({ ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(credentialFromSandboxEnv(undefined)).toBeNull();
  });
});
