import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeWatcher, type WorktreeWatcher } from '../../src/services/activityWatcher';

const cleanups: Array<() => void> = [];
const dirs: string[] = [];

function tmpWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

// Both backends run on any dev machine: the native branch uses fs.watch
// (FSEvents on macOS, inotify elsewhere) and chokidar is pure JS.
const BACKENDS: Array<{ name: string; platform: NodeJS.Platform }> = [
  { name: 'native/darwin', platform: 'darwin' },
  { name: 'chokidar/linux', platform: 'linux' },
];
let activePlatform: NodeJS.Platform = 'darwin';

function watching(touched: string[]): WorktreeWatcher {
  const watcher = createWorktreeWatcher({
    touch: (p) => touched.push(p),
    throttleMs: 0,
    platform: activePlatform,
  });
  cleanups.push(() => watcher.close());
  return watcher;
}

async function settle(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each(BACKENDS)('activityWatcher [$name]', ({ platform }) => {
  beforeEach(() => { activePlatform = platform; });
  it('beats when a file inside the worktree is written', async () => {
    const wt = tmpWorktree();
    const touched: string[] = [];
    watching(touched).ensure([wt]);
    await new Promise((r) => setTimeout(r, 100)); // FSEvents warm-up
    fs.writeFileSync(path.join(wt, 'src.ts'), 'x');
    await settle(() => touched.length > 0);
    expect(touched).toContain(wt);
  });

  it('ignores writes under .git and node_modules', async () => {
    const wt = tmpWorktree();
    fs.mkdirSync(path.join(wt, '.git'));
    fs.mkdirSync(path.join(wt, 'node_modules'));
    const touched: string[] = [];
    watching(touched).ensure([wt]);
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(wt, '.git', 'index'), 'x');
    fs.writeFileSync(path.join(wt, 'node_modules', 'pkg.js'), 'x');
    await new Promise((r) => setTimeout(r, 300)); // give events time to (not) arrive
    expect(touched).toEqual([]);
  });

  it('throttles bursts of writes to one beat per interval', async () => {
    const wt = tmpWorktree();
    const touched: string[] = [];
    const watcher = createWorktreeWatcher({ touch: (p) => touched.push(p), throttleMs: 60_000, platform });
    cleanups.push(() => watcher.close());
    watcher.ensure([wt]);
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(wt, `f${i}.ts`), 'x');
    await settle(() => touched.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(touched).toEqual([wt]);
  });

  it('ensure is additive and idempotent; remove stops beats', async () => {
    const wt = tmpWorktree();
    const touched: string[] = [];
    const watcher = watching(touched);
    watcher.ensure([wt]);
    watcher.ensure([wt]); // second call must not double-watch
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(wt, 'a.ts'), 'x');
    await settle(() => touched.length > 0);
    expect(touched).toEqual([wt]);

    watcher.remove(wt);
    fs.writeFileSync(path.join(wt, 'b.ts'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    expect(touched).toEqual([wt]);
  });

  it('skips paths that do not exist instead of throwing', () => {
    const touched: string[] = [];
    expect(() => watching(touched).ensure(['/definitely/not/a/dir'])).not.toThrow();
  });
});
