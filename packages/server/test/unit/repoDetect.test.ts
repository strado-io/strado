import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { detectRepo } from '../../src/services/repoDetect';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'detect-')));
  await exec('git', ['init', '-q', tmp]);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('detectRepo', () => {
  it('detects name, start command, port, and env profiles from a vite app', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: '@acme/my-dashboard',
        scripts: { dev: 'vite --port 4000' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );
    await fs.writeFile(path.join(tmp, '.env.prod'), 'A=1');
    await fs.writeFile(path.join(tmp, '.env.dev'), 'A=2');
    await fs.writeFile(path.join(tmp, '.env.example'), 'A=');

    const d = await detectRepo(tmp);
    expect(d.id).toBe(path.basename(tmp).toLowerCase());
    expect(d.name).toBe('My Dashboard');
    expect(d.path).toBe(tmp);
    expect(d.projectSubdir).toBeNull();
    expect(d.startCommand).toBe('npm run dev');
    expect(d.defaultPort).toBe(4000);
    expect(d.envProfiles).toEqual([
      { name: 'DEV', envFile: '.env.dev' },
      { name: 'PROD', envFile: '.env.prod' },
    ]);
    expect(d.defaultEnvProfile).toBe('DEV');
    expect(d.warnings).toEqual([]);
  });

  it('falls back to framework default port when the script has none', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'web', scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }),
    );
    const d = await detectRepo(tmp);
    expect(d.defaultPort).toBe(3000);
    expect(d.warnings).toEqual([]);
  });

  it('resolves the git root and projectSubdir when pointed at a monorepo package', async () => {
    const sub = path.join(tmp, 'apps', 'web');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(
      path.join(sub, 'package.json'),
      JSON.stringify({ name: 'web', scripts: { start: 'node server.js' } }),
    );
    const d = await detectRepo(sub);
    expect(d.path).toBe(tmp);
    expect(d.projectSubdir).toBe(path.join('apps', 'web'));
    expect(d.startCommand).toBe('npm start');
  });

  it('warns when there is no package.json but still returns git-level detection', async () => {
    const d = await detectRepo(tmp);
    expect(d.path).toBe(tmp);
    expect(d.startCommand).toBe('npm run dev');
    expect(d.defaultPort).toBe(8080);
    expect(d.warnings.some((w) => w.includes('no package.json'))).toBe(true);
  });

  it('rejects a directory outside any git repo', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-'));
    try {
      await expect(detectRepo(plain)).rejects.toThrow(/not inside a git repository/);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('rejects a missing path', async () => {
    await expect(detectRepo(path.join(tmp, 'nope'))).rejects.toThrow(/not a directory/);
  });

  it('records origin as the clone URL, and null when there is no remote', async () => {
    // `path` only means something on this machine; cloneUrl is what lets the
    // same repo be materialized on a runner.
    const noRemote = await detectRepo(tmp);
    expect(noRemote.cloneUrl).toBeNull();
    expect(noRemote.warnings).not.toContain('no git remote "origin"');

    await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/thing.git'], { cwd: tmp });
    const withRemote = await detectRepo(tmp);
    expect(withRemote.cloneUrl).toBe('git@github.com:acme/thing.git');
  });

});
