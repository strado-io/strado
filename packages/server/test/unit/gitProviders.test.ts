import { describe, expect, it } from 'vitest';
import { parseRemoteUrl, isGitlabHost, isGithubHost, resolveSshAlias } from '../../src/services/gitProviders';

describe('parseRemoteUrl', () => {
  it('parses scp-style SSH remotes', () => {
    expect(parseRemoteUrl('git@gitlab.example.com:acmedev/acme-core.git'))
      .toEqual({ host: 'gitlab.example.com', projectPath: 'acmedev/acme-core', ssh: true });
  });
  it('parses HTTPS remotes and strips .git + creds', () => {
    expect(parseRemoteUrl('https://gitlab.com/group/sub/project.git'))
      .toEqual({ host: 'gitlab.com', projectPath: 'group/sub/project', ssh: false });
    expect(parseRemoteUrl('https://user@gitlab.com/group/project'))
      .toEqual({ host: 'gitlab.com', projectPath: 'group/project', ssh: false });
  });
  it('parses ssh:// with a port', () => {
    expect(parseRemoteUrl('ssh://git@gitlab.example.com:2222/team/app.git'))
      .toEqual({ host: 'gitlab.example.com', projectPath: 'team/app', ssh: true });
  });
  it('returns null for a path without a namespace or garbage', () => {
    expect(parseRemoteUrl('git@host:justrepo.git')).toBeNull();
    expect(parseRemoteUrl('not a url')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
  });
});

describe('isGitlabHost', () => {
  const none = new Set<string>();
  it('recognizes gitlab.com and gitlab.* hosts', () => {
    expect(isGitlabHost('gitlab.com', none)).toBe(true);
    expect(isGitlabHost('gitlab.stg-acme.io', none)).toBe(true);
  });
  it('recognizes a configured self-hosted host not named gitlab.*', () => {
    expect(isGitlabHost('git.acme.com', none)).toBe(false);
    expect(isGitlabHost('git.acme.com', new Set(['git.acme.com']))).toBe(true);
  });
  it('rejects github', () => {
    expect(isGitlabHost('github.com', none)).toBe(false);
  });
});

describe('isGithubHost', () => {
  it('recognizes github.com and github subdomains', () => {
    expect(isGithubHost('github.com', new Set())).toBe(true);
    expect(isGithubHost('github.mycorp.io', new Set())).toBe(true);
    expect(isGithubHost('code.github.internal', new Set())).toBe(true);
  });

  it('accepts any explicitly configured host (GHE at arbitrary domain)', () => {
    expect(isGithubHost('git.example.com', new Set(['git.example.com']))).toBe(true);
  });

  it('rejects gitlab and unknown hosts', () => {
    expect(isGithubHost('gitlab.com', new Set())).toBe(false);
    expect(isGithubHost('bitbucket.org', new Set())).toBe(false);
    expect(isGithubHost('git.example.com', new Set())).toBe(false);
  });
});

describe('parseRemoteUrl ssh flag', () => {
  it('marks scp and ssh:// remotes as ssh, https as not', () => {
    expect(parseRemoteUrl('git@github-strado:strado-io/site.git')?.ssh).toBe(true);
    expect(parseRemoteUrl('ssh://git@gitlab.com/g/p.git')?.ssh).toBe(true);
    expect(parseRemoteUrl('https://github.com/o/r.git')?.ssh).toBe(false);
  });
});

describe('resolveSshAlias', () => {
  it('returns the resolved hostname for an alias', async () => {
    const real = await resolveSshAlias('alias-a', async () => 'github.com');
    expect(real).toBe('github.com');
  });

  it('returns null when ssh echoes the host back (not an alias)', async () => {
    expect(await resolveSshAlias('alias-b', async () => 'alias-b')).toBeNull();
  });

  it('returns null on resolver failure', async () => {
    expect(await resolveSshAlias('alias-c', async () => null)).toBeNull();
  });

  it('caches per host — resolver runs once', async () => {
    let calls = 0;
    const resolver = async () => { calls += 1; return 'github.com'; };
    await resolveSshAlias('alias-d', resolver);
    await resolveSshAlias('alias-d', resolver);
    expect(calls).toBe(1);
  });
});
