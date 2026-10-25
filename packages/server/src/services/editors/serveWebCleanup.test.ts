import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupServeWeb } from './serveWebCleanup.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-web-cleanup-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const write = (name: string, v: unknown) => fs.writeFile(path.join(home, name), JSON.stringify(v));
const exists = (name: string) => fs.stat(path.join(home, name)).then(() => true, () => false);

describe('cleanupServeWeb (the embedded VS Code is gone)', () => {
  it('stops recorded serve-web daemons still running, then deletes both records', async () => {
    await write('serve-web-daemons.json', [{ pid: 11, port: 5001 }, { pid: 22, port: 5002 }, { pid: 33, port: 5003 }]);
    await write('serve-web-ports.json', { app: 5001 });
    const killed: [number, string][] = [];
    const out = await cleanupServeWeb({
      home,
      alive: (pid) => pid !== 33,
      // 22 is a reused pid: something else now.
      command: (pid) => (pid === 11 ? '/usr/local/bin/code serve-web --port 5001' : '/usr/bin/vim notes'),
      kill: (pid, sig) => void killed.push([pid, sig]),
    });
    expect(killed).toEqual([[-11, 'SIGTERM']]);
    expect(out).toEqual({ stopped: [11] });
    expect(await exists('serve-web-daemons.json')).toBe(false);
    expect(await exists('serve-web-ports.json')).toBe(false);
  });

  it('a group kill that fails falls back to the pid itself', async () => {
    await write('serve-web-daemons.json', [{ pid: 11, port: 5001 }]);
    const killed: number[] = [];
    await cleanupServeWeb({
      home,
      alive: () => true,
      command: () => 'code serve-web',
      kill: (pid) => {
        killed.push(pid);
        if (pid < 0) throw new Error('ESRCH');
      },
    });
    expect(killed).toEqual([-11, 11]);
  });

  it('nothing recorded, or a broken record: no kills, files gone, never throws', async () => {
    const killed: number[] = [];
    const deps = { home, alive: () => true, command: () => 'code serve-web', kill: (p: number) => void killed.push(p) };
    expect(await cleanupServeWeb(deps)).toEqual({ stopped: [] });
    await fs.writeFile(path.join(home, 'serve-web-daemons.json'), '{not json');
    expect(await cleanupServeWeb(deps)).toEqual({ stopped: [] });
    expect(killed).toEqual([]);
    expect(await exists('serve-web-daemons.json')).toBe(false);
  });

  it("never touches VS Code's own CLI cache", async () => {
    const cli = path.join(home, '.vscode', 'cli', 'serve-web');
    await fs.mkdir(cli, { recursive: true });
    await cleanupServeWeb({ home, alive: () => false, command: () => '', kill: () => {} });
    expect((await fs.stat(cli)).isDirectory()).toBe(true);
  });
});
