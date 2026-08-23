import { describe, expect, it } from 'vitest';
import { resolveProvider, resolveProviderAliased } from '../../src/routes/gitProvider';

describe('resolveProvider', () => {
  it('classifies gitlab.com and configured gitlab hosts', () => {
    expect(resolveProvider('git@gitlab.com:g/p.git', new Set(), new Set())).toMatchObject({
      provider: 'gitlab', host: 'gitlab.com', projectPath: 'g/p',
    });
    expect(resolveProvider('https://git.corp.io/g/p.git', new Set(['git.corp.io']), new Set()))
      .toMatchObject({ provider: 'gitlab' });
  });

  it('classifies github.com and configured GHE hosts', () => {
    expect(resolveProvider('git@github.com:octo/app.git', new Set(), new Set())).toMatchObject({
      provider: 'github', host: 'github.com', projectPath: 'octo/app',
    });
    expect(resolveProvider('https://ghe.corp.io/octo/app.git', new Set(), new Set(['ghe.corp.io'])))
      .toMatchObject({ provider: 'github' });
  });

  it('configured gitlab wins over github heuristics and vice versa', () => {
    // host literally named github.* but user saved it under gitlab config
    expect(resolveProvider('https://github.corp.io/g/p.git', new Set(['github.corp.io']), new Set()))
      .toMatchObject({ provider: 'gitlab' });
  });

  it('returns null for unknown hosts and unparseable urls', () => {
    expect(resolveProvider('https://bitbucket.org/o/r.git', new Set(), new Set())).toBeNull();
    expect(resolveProvider(null, new Set(), new Set())).toBeNull();
    expect(resolveProvider('not a url', new Set(), new Set())).toBeNull();
  });
});

describe('resolveProviderAliased', () => {
  const none = new Set<string>();

  it('resolves an ssh alias to its real host and classifies it', async () => {
    const r = await resolveProviderAliased(
      'git@github-strado:strado-io/site.git', none, none,
      async (h) => (h === 'github-strado' ? 'github.com' : null),
    );
    expect(r).toEqual({ provider: 'github', host: 'github.com', projectPath: 'strado-io/site' });
  });

  it('never probes https remotes', async () => {
    let probed = 0;
    const r = await resolveProviderAliased(
      'https://unknown-host.io/o/r.git', none, none,
      async () => { probed += 1; return 'github.com'; },
    );
    expect(r).toBeNull();
    expect(probed).toBe(0);
  });

  it('falls back to null when the alias is unresolvable or still unknown', async () => {
    expect(await resolveProviderAliased('git@mystery:o/r.git', none, none, async () => null)).toBeNull();
    expect(await resolveProviderAliased('git@mystery:o/r.git', none, none, async () => 'bitbucket.org')).toBeNull();
  });

  it('classified hosts skip the probe entirely', async () => {
    let probed = 0;
    const r = await resolveProviderAliased(
      'git@github.com:octo/app.git', none, none,
      async () => { probed += 1; return null; },
    );
    expect(r).toMatchObject({ provider: 'github', host: 'github.com' });
    expect(probed).toBe(0);
  });
});
