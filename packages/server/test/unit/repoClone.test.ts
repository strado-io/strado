import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneRepo, defaultReposDir, parseCloneUrl } from '../../src/services/repoClone.js';
import { exec } from '../../src/shell.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-clone-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.STRADO_REPOS_DIR;
});

describe('parseCloneUrl', () => {
  it('accepts the shapes git can clone and derives a directory name', () => {
    expect(parseCloneUrl('https://github.com/o/repo.git')).toEqual({
      url: 'https://github.com/o/repo.git',
      name: 'repo',
    });
    expect(parseCloneUrl('git@github.com:o/repo.git').name).toBe('repo');
    expect(parseCloneUrl('ssh://git@gitlab.internal:2222/team/svc').name).toBe('svc');
    expect(parseCloneUrl('https://gitlab.corp/group/sub/thing/').name).toBe('thing');
  });

  it('rejects anything that is not a clone URL', () => {
    for (const bad of ['', '   ', '/local/path', '../relative', 'file:///etc/passwd', 'not a url']) {
      expect(() => parseCloneUrl(bad)).toThrow();
    }
  });

  it('rejects a leading dash so the URL cannot become a git option', () => {
    // `--upload-pack=…` reaches git as argv; there is no shell involved, but it
    // would still be an injection into git's own flag parsing.
    expect(() => parseCloneUrl('--upload-pack=touch /tmp/pwned')).toThrow();
  });
});

describe('defaultReposDir', () => {
  it('honours STRADO_REPOS_DIR, else ~/repos', () => {
    process.env.STRADO_REPOS_DIR = '/srv/code';
    expect(defaultReposDir()).toBe('/srv/code');
    delete process.env.STRADO_REPOS_DIR;
    expect(defaultReposDir()).toBe(path.join(os.homedir(), 'repos'));
  });
});

describe('cloneRepo', () => {
  it('is idempotent when the target is already a clone', async () => {
    // Re-running "add repo" for something already on disk must register it,
    // not clone a second copy or error. No network needed: an initialised repo
    // at the destination is exactly the state a previous clone leaves behind.
    const dest = path.join(tmp, 'already-there');
    fs.mkdirSync(dest);
    await exec('git', ['init', '-q', '-b', 'main', '.'], { cwd: dest });
    const result = await cloneRepo({ url: 'https://github.com/o/already-there.git', dest });
    expect(result).toEqual({ path: dest, alreadyPresent: true });
  });

  it('refuses to clone over a non-empty directory that is not a repo', async () => {
    const dest = path.join(tmp, 'occupied');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'something.txt'), 'x');
    await expect(cloneRepo({ url: 'https://example.invalid/o/r.git', dest })).rejects.toThrow(/already exists/);
  });

  it('fails fast with an actionable message instead of hanging on credentials', async () => {
    // The real hazard: without GIT_TERMINAL_PROMPT=0 git blocks forever asking
    // for a username on a machine with no terminal, and the HTTP request hangs
    // until timeout with nothing to show the user.
    const dest = path.join(tmp, 'nope');
    await expect(
      cloneRepo({ url: 'https://github.com/strado-io/definitely-not-a-real-repo-xyz.git', dest, timeoutMs: 60_000 }),
    ).rejects.toThrow(/clone failed/);
    // A failed clone must leave nothing behind, or the retry hits "already exists".
    expect(fs.existsSync(dest)).toBe(false);
  }, 90_000);
});
