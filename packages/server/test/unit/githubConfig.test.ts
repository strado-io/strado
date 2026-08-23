import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  githubConfigPath, readGithubConfig, githubTokenFor, writeGithubHost, removeGithubHost,
} from '../../src/services/github';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-gh-'));
  process.env.STRADO_HOME = dir;
});
afterEach(() => {
  delete process.env.STRADO_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('github config', () => {
  it('path lives under STRADO_HOME', () => {
    expect(githubConfigPath()).toBe(path.join(dir, 'github.json'));
  });

  it('reads {} when absent or malformed', async () => {
    expect(await readGithubConfig()).toEqual({});
    fs.writeFileSync(githubConfigPath(), 'not json');
    expect(await readGithubConfig()).toEqual({});
  });

  it('validates the token against /user, persists 0600, and returns the login', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://api.github.com/user');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer tok1');
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
      return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
    });
    const res = await writeGithubHost('github.com', 'tok1');
    expect(res.username).toBe('octocat');
    const st = fs.statSync(githubConfigPath());
    expect(st.mode & 0o777).toBe(0o600);
    const cfg = await readGithubConfig();
    expect(githubTokenFor(cfg, 'github.com', 'anyowner')).toBe('tok1');
  });

  it('uses /api/v3 for GHE hosts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe('https://github.mycorp.io/api/v3/user');
      return new Response(JSON.stringify({ login: 'me' }), { status: 200 });
    });
    await writeGithubHost('github.mycorp.io', 'tok2');
  });

  it('rejects a bad token with a VALIDATION error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await expect(writeGithubHost('github.com', 'bad')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('removeGithubHost deletes the entry and tolerates unknown hosts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ login: 'x' }), { status: 200 }),
    );
    await writeGithubHost('github.com', 't');
    await removeGithubHost('github.com');
    expect(await readGithubConfig()).toEqual({});
    await removeGithubHost('never-there'); // no throw
  });

  it('owner-scoped token beats the host default and falls back when absent', async () => {
    // fresh Response per call — writeGithubHost is invoked twice and each
    // reads the body via res.json(), which a shared Response can't survive.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ login: 'x' }), { status: 200 }),
    );
    await writeGithubHost('github.com', 'default-tok');
    await writeGithubHost('github.com', 'work-tok', 'workorg');
    const cfg = await readGithubConfig();
    expect(githubTokenFor(cfg, 'github.com', 'workorg')).toBe('work-tok');
    expect(githubTokenFor(cfg, 'github.com', 'kamlesh')).toBe('default-tok');
    expect(githubTokenFor({}, 'github.com', 'workorg')).toBeNull();
  });

  it('owner-only config has no fallback for other owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ login: 'x' }), { status: 200 }),
    );
    await writeGithubHost('github.com', 'work-tok', 'workorg');
    const cfg = await readGithubConfig();
    expect(Object.keys(cfg)).toEqual(['github.com/workorg']);
    expect(githubTokenFor(cfg, 'github.com', 'other')).toBeNull();
  });

  it('owner matching is case-insensitive', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ login: 'x' }), { status: 200 }),
    );
    await writeGithubHost('github.com', 'work-tok', 'WorkOrg');
    const cfg = await readGithubConfig();
    expect(Object.keys(cfg)).toEqual(['github.com/workorg']);
    expect(githubTokenFor(cfg, 'github.com', 'WORKORG')).toBe('work-tok');
  });

  it('removeGithubHost deletes a composite key and leaves siblings', async () => {
    // fresh Response per call — same reason as above.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ login: 'x' }), { status: 200 }),
    );
    await writeGithubHost('github.com', 'a');
    await writeGithubHost('github.com', 'b', 'workorg');
    await removeGithubHost('github.com/workorg');
    expect(Object.keys(await readGithubConfig())).toEqual(['github.com']);
  });
});
