import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiffStatsCache } from '../../src/services/diffStatsCache';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstats-')));
  dirs.push(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function setup(opts: { version?: number | null; now?: () => number } = {}) {
  let version: number | null = opts.version === undefined ? 0 : opts.version;
  const shortStat = vi.fn(async () => ({ additions: 1, deletions: 0, files: 1 }));
  const cache = createDiffStatsCache({ shortStat, version: () => version, now: opts.now });
  return { cache, shortStat, bump: () => { version = (version ?? 0) + 1; } };
}

describe('diffStatsCache', () => {
  it('reuses the result while nothing changed', async () => {
    const wt = repo();
    const { cache, shortStat } = setup();
    await cache.get(wt);
    await cache.get(wt);
    expect(shortStat).toHaveBeenCalledTimes(1);
  });

  it('recomputes after a working-tree change', async () => {
    const wt = repo();
    const { cache, shortStat, bump } = setup();
    await cache.get(wt);
    bump();
    await cache.get(wt);
    expect(shortStat).toHaveBeenCalledTimes(2);
  });

  it('recomputes after a commit moves HEAD', async () => {
    const wt = repo();
    const { cache, shortStat } = setup();
    await cache.get(wt);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'two');
    await cache.get(wt);
    expect(shortStat).toHaveBeenCalledTimes(2);
  });

  it('resolves a linked worktree through its .git file', async () => {
    const main = repo();
    const linked = path.join(path.dirname(main), `${path.basename(main)}-wt`);
    dirs.push(linked);
    git(main, 'worktree', 'add', '-q', linked);
    const { cache, shortStat } = setup();
    await cache.get(linked);
    await cache.get(linked);
    expect(shortStat).toHaveBeenCalledTimes(1);
    git(linked, 'commit', '-q', '--allow-empty', '-m', 'linked');
    await cache.get(linked);
    expect(shortStat).toHaveBeenCalledTimes(2);
  });

  it('never caches an unwatched worktree', async () => {
    const wt = repo();
    const { cache, shortStat } = setup({ version: null });
    await cache.get(wt);
    await cache.get(wt);
    expect(shortStat).toHaveBeenCalledTimes(2);
  });

  it('expires entries after the max age', async () => {
    const wt = repo();
    let t = 0;
    const { cache, shortStat } = setup({ now: () => t });
    await cache.get(wt);
    t = 5 * 60_000;
    await cache.get(wt);
    expect(shortStat).toHaveBeenCalledTimes(2);
  });

  it('shares one git run between concurrent listings', async () => {
    const wt = repo();
    const { cache, shortStat } = setup();
    await Promise.all([cache.get(wt), cache.get(wt)]);
    expect(shortStat).toHaveBeenCalledTimes(1);
  });
});
