import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }));
vi.mock('../../shell.js', () => ({ exec: execMock }));

import { ensureBareRepo } from './bareRepo.js';

let tempRoot: string | null = null;

afterEach(() => {
  execMock.mockClear();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('bare repository HTTPS credentials', () => {
  it('uses askpass for private clone and fetch without putting the token in argv', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-bare-credential-'));
    const helpers: string[] = [];
    execMock.mockImplementation(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args.join(' ')).not.toContain('ghs_secret');
      if (options.env.STRADO_GIT_PASSWORD) {
        expect(options.env.STRADO_GIT_PASSWORD).toBe('ghs_secret');
        helpers.push(options.env.GIT_ASKPASS!);
        expect(fs.readFileSync(options.env.GIT_ASKPASS!, 'utf8')).not.toContain('ghs_secret');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    await ensureBareRepo({
      reposDir: path.join(tempRoot, 'repos'),
      repoId: 'private-repo',
      cloneUrl: 'https://github.com/strado-io/strado.git',
      credential: { username: 'x-access-token', password: 'ghs_secret' },
    });

    expect(execMock).toHaveBeenCalledTimes(3);
    const authenticated = [execMock.mock.calls[0], execMock.mock.calls[2]];
    for (const [, args, options] of authenticated) {
      expect(args.join(' ')).not.toContain('ghs_secret');
      expect(options.env.STRADO_GIT_PASSWORD).toBe('ghs_secret');
    }
    expect(execMock.mock.calls[1]?.[2].env.STRADO_GIT_PASSWORD).toBeUndefined();
    expect(helpers).toHaveLength(2);
    expect(helpers.every((helper) => !fs.existsSync(helper))).toBe(true);
  });
});

describe('existing bare clone', () => {
  it('moves origin to the URL the credential can speak before fetching', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-bare-seturl-'));
    const target = path.join(tempRoot, 'repos', 'app.git');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: 'git@gitlab.com:acme/app.git\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await ensureBareRepo({
      reposDir: path.join(tempRoot, 'repos'),
      repoId: 'app',
      cloneUrl: 'https://gitlab.com/acme/app.git',
      credential: { username: 'oauth2', password: 'gl-tok' },
    });
    const argv = execMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(argv).toContain('remote set-url origin https://gitlab.com/acme/app.git');
    expect(argv.indexOf('remote set-url origin https://gitlab.com/acme/app.git')).toBeLessThan(argv.indexOf('fetch origin'));
    expect(argv.some((a) => a.startsWith('clone'))).toBe(false);
  });
});

describe('concurrent first creates', () => {
  it('clone once: the second caller waits for the first', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-bare-race-'));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args[0] === 'clone') await gate;
      return { code: 0, stdout: '', stderr: '' };
    });
    const opts = { reposDir: path.join(tempRoot, 'repos'), repoId: 'app', cloneUrl: 'https://github.com/o/app.git' };
    const a = ensureBareRepo(opts);
    const b = ensureBareRepo(opts);
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await a).toBe(await b);
    const clones = execMock.mock.calls.filter(([, args]) => (args as string[])[0] === 'clone');
    expect(clones).toHaveLength(1);
  });
});

describe('fetch policy on an existing clone', () => {
  const existing = () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-bare-fetch-'));
    const target = path.join(tempRoot, 'repos', 'app.git');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
    execMock.mockImplementation(async (_c: string, args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: 'https://github.com/o/app.git\n', stderr: '' };
      if (args[0] === 'fetch') throw new Error('fatal: could not read Username for https://github.com');
      return { code: 0, stdout: '', stderr: '' };
    });
    return { reposDir: path.join(tempRoot, 'repos'), repoId: 'app', cloneUrl: 'https://github.com/o/app.git' };
  };
  it('required (default): a failed fetch fails the call', async () => {
    await expect(ensureBareRepo(existing())).rejects.toThrow(/could not read Username/);
  });
  it('best-effort: the clone is used and the caller hears why the tip may be stale', async () => {
    const stale: string[] = [];
    const target = await ensureBareRepo({ ...existing(), fetch: 'best-effort', onStale: (r) => stale.push(r) });
    expect(target).toContain('app.git');
    expect(stale[0]).toMatch(/could not read Username/);
  });
});
