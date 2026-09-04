import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backfillCloneUrls } from '../../src/services/repoBackfill.js';
import { matchRepo, portableCloneUrl, repoIdentity } from '../../src/services/repoIdentity.js';
import { uniqueRepoId } from '../../src/services/repoDetect.js';
import { runnerErrorMessage } from '../../src/routes/runners.js';
import { exec } from '../../src/shell.js';

describe('repoIdentity', () => {
  it('reduces every clone URL shape for one repo to the same key', () => {
    const keys = [
      'https://github.com/strado-io/strado.git',
      'https://github.com/strado-io/strado',
      'git@github.com:strado-io/strado.git',
      'ssh://git@github.com/strado-io/strado.git',
      'ssh://git@github.com:22/strado-io/strado',
      'https://github.com/strado-io/strado/',
    ].map((u) => repoIdentity(u)?.key);
    expect(new Set(keys)).toEqual(new Set(['github.com/strado-io/strado']));
  });

  it('keeps self-hosted hosts and nested groups intact', () => {
    expect(repoIdentity('ssh://git@gitlab.corp.internal:2222/team/sub/svc.git')).toEqual({
      key: 'gitlab.corp.internal/team/sub/svc',
      pathKey: 'team/sub/svc',
    });
  });

  it('returns null for things that are not clone URLs', () => {
    for (const bad of ['', '   ', null, undefined, '/Users/me/repo', 'file:///tmp/x', 'not a url']) {
      expect(repoIdentity(bad)).toBeNull();
    }
  });
});

describe('matchRepo', () => {
  const local = (id: string, cloneUrl: string | null) => ({ repo: id, cloneUrl });

  it('matches across https and scp-style forms', () => {
    const hit = matchRepo('git@github.com:strado-io/strado.git', [
      local('other', 'https://github.com/strado-io/website.git'),
      local('strado-app', 'https://github.com/strado-io/strado'),
    ]);
    expect(hit).toBe('strado-app');
  });

  it('matches through an ssh alias, where the hosts cannot agree', () => {
    // The runner clones over https; this machine uses an ssh alias whose real
    // host only its own ~/.ssh/config knows. Neither side can resolve the
    // other's host, so owner/repo is the only thing they share.
    const hit = matchRepo('https://github.com/strado-io/strado.git', [
      local('strado-app', 'git@github-strado:strado-io/strado.git'),
    ]);
    expect(hit).toBe('strado-app');
  });

  it('refuses an ambiguous owner/repo rather than filing it under the wrong repo', () => {
    const hit = matchRepo('https://github.com/acme/api.git', [
      local('public', 'git@alias-a:acme/api.git'),
      local('internal', 'git@alias-b:acme/api.git'),
    ]);
    expect(hit).toBeNull();
  });

  it('returns null when the remote has no clone URL, or nothing local does', () => {
    expect(matchRepo(null, [local('a', 'https://github.com/o/r.git')])).toBeNull();
    expect(matchRepo('https://github.com/o/r.git', [local('a', null)])).toBeNull();
  });
});

describe('backfillCloneUrls', () => {
  it('reads origin for repos registered before the field existed, and stores the answer', async () => {
    // Every repo on every existing install has no cloneUrl, because it is only
    // written at registration. Without this, matching a local repo to a
    // runner's copy silently matches nothing and the UI claims the repo has no
    // remote while .git/config plainly has one.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-backfill-'));
    try {
      await exec('git', ['init', '-q', '-b', 'main', '.'], { cwd: tmp });
      await exec('git', ['remote', 'add', 'origin', 'git@github-strado:strado-io/site.git'], { cwd: tmp });

      const patched: { id: string; cloneUrl: string | null | undefined }[] = [];
      const store = {
        patch: async (id: string, patch: { cloneUrl?: string | null }) => {
          patched.push({ id, cloneUrl: patch.cloneUrl });
          return {} as never;
        },
      } as unknown as Parameters<typeof backfillCloneUrls>[0];

      const out = await backfillCloneUrls(store, [
        { id: 'site', path: tmp } as never,
        { id: 'nowhere', path: path.join(tmp, 'missing') } as never,
        { id: 'stale-null', path: tmp, cloneUrl: null } as never,
        { id: 'already', path: tmp, cloneUrl: 'https://example.com/a/b.git' } as never,
      ], { recheckNull: true });

      expect(out[0]!.cloneUrl).toBe('git@github-strado:strado-io/site.git');
      // A repo with no origin records null — that is what stops this from
      // re-running `git remote` on every list forever.
      expect(out[1]!.cloneUrl).toBeNull();
      // A previously-null value can be refreshed after the user adds origin.
      expect(out[2]!.cloneUrl).toBe('git@github-strado:strado-io/site.git');
      // Already known: left alone, no git call, no write.
      expect(out[3]!.cloneUrl).toBe('https://example.com/a/b.git');
      expect(patched.map((p) => p.id).sort()).toEqual(['nowhere', 'site', 'stale-null']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('portableCloneUrl', () => {
  // github-strado is a Host alias in ~/.ssh/config; no other machine has it.
  const resolve = async (host: string) => (host === 'github-strado' ? 'github.com' : null);

  it('replaces an ssh alias with the real host in scp-style remotes', async () => {
    expect(await portableCloneUrl('git@github-strado:strado-io/site.git', resolve)).toBe(
      'git@github.com:strado-io/site.git',
    );
  });

  it('replaces it in ssh:// remotes, keeping user and port', async () => {
    expect(await portableCloneUrl('ssh://git@github-strado:2222/o/r.git', resolve)).toBe(
      'ssh://git@github.com:2222/o/r.git',
    );
  });

  it('leaves real hosts and https URLs untouched', async () => {
    expect(await portableCloneUrl('git@github.com:o/r.git', resolve)).toBe('git@github.com:o/r.git');
    expect(await portableCloneUrl('https://github.com/o/r.git', resolve)).toBe('https://github.com/o/r.git');
  });

  it('passes the URL through unchanged when resolution fails', async () => {
    // Better to let the runner try and report a real git error than to mangle
    // a URL on a guess.
    expect(await portableCloneUrl('git@weird-alias:o/r.git', async () => null)).toBe('git@weird-alias:o/r.git');
  });
});

describe('runnerErrorMessage', () => {
  it('surfaces the runner’s own sentence, not our error envelope', () => {
    const body = JSON.stringify({
      error: { code: 'SHELL_FAILED', message: 'clone failed: runner-dev has no credentials for git@github.com:o/r.git' },
    });
    expect(runnerErrorMessage(body, 'runner-dev-wq3p', 500)).toBe(
      'runner-dev-wq3p: clone failed: runner-dev has no credentials for git@github.com:o/r.git',
    );
  });

  it('falls back to naming the machine and status for unparseable bodies', () => {
    expect(runnerErrorMessage('<html>502</html>', 'runner-dev-wq3p', 502)).toContain('runner-dev-wq3p returned 502');
    expect(runnerErrorMessage('', 'runner-dev-wq3p', 500)).toBe('runner-dev-wq3p returned 500');
  });
});

describe('uniqueRepoId', () => {
  it('keeps the derived id when it is free', () => {
    expect(uniqueRepoId('api', '/Users/me/work/api', new Set())).toBe('api');
  });

  it('disambiguates by parent directory, which is meaningful', () => {
    // ~/work/api and ~/personal/api both derive `api`; the parent says which.
    expect(uniqueRepoId('api', '/Users/me/personal/api', new Set(['api']))).toBe('personal-api');
  });

  it('falls back to a short path hash when the parent collides too', () => {
    const id = uniqueRepoId('api', '/Users/me/personal/api', new Set(['api', 'personal-api']));
    expect(id).toMatch(/^api-[0-9a-f]{4}$/);
    // Deterministic: the same repo always gets the same id.
    expect(uniqueRepoId('api', '/Users/me/personal/api', new Set(['api', 'personal-api']))).toBe(id);
  });
});
