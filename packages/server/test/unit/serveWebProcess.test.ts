import { describe, it, expect, beforeEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findFreePort,
  killTree,
  readDaemonFile,
  writeDaemonFile,
  recordDaemon,
  forgetDaemon,
  isAlive,
  looksLikeServeWeb,
} from '../../src/services/serveWebProcess.js';

describe('findFreePort', () => {
  it('returns a bindable port', async () => {
    const p = await findFreePort();
    expect(p).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});

describe('killTree', () => {
  it('signals the negative pid (process group) with SIGTERM', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    killTree(1234, (pid, sig) => { calls.push([pid, sig]); });
    expect(calls).toEqual([[-1234, 'SIGTERM']]);
  });
  it('never throws when kill fails', () => {
    expect(() => killTree(1234, () => { throw new Error('ESRCH'); })).not.toThrow();
  });
  it('is a no-op for falsy pids (0 or undefined) so it never signals the caller\'s own process group', () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    const kill = (pid: number, sig: NodeJS.Signals) => { calls.push([pid, sig]); };
    killTree(0, kill);
    killTree(undefined as unknown as number, kill);
    expect(calls).toEqual([]);
  });
});

describe('daemon registry (pidfile)', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daemons-')), 'serve-web-daemons.json');
  });

  it('records, reads back, and forgets entries (dedup by pid)', () => {
    recordDaemon(file, { pid: 100, port: 5001 });
    recordDaemon(file, { pid: 200, port: 5002 });
    recordDaemon(file, { pid: 100, port: 5099 }); // same pid → replace, not duplicate
    const list = readDaemonFile(file);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.pid === 100)?.port).toBe(5099);

    forgetDaemon(file, 100);
    expect(readDaemonFile(file).map((e) => e.pid)).toEqual([200]);
  });

  it('readDaemonFile returns [] for a missing or malformed file', () => {
    expect(readDaemonFile(path.join(path.dirname(file), 'nope.json'))).toEqual([]);
    fs.writeFileSync(file, 'not json');
    expect(readDaemonFile(file)).toEqual([]);
    fs.writeFileSync(file, JSON.stringify([{ pid: 1 }, { bogus: true }, { pid: 2, port: 3 }]));
    expect(readDaemonFile(file)).toEqual([{ pid: 2, port: 3 }]);
  });

  it('writeDaemonFile creates the parent dir and never throws', () => {
    const nested = path.join(path.dirname(file), 'a', 'b', 'daemons.json');
    expect(() => writeDaemonFile(nested, [{ pid: 9, port: 9 }])).not.toThrow();
    expect(readDaemonFile(nested)).toEqual([{ pid: 9, port: 9 }]);
  });
});

describe('isAlive', () => {
  it('is true for the current process and false for a bogus/falsy pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(2 ** 30)).toBe(false); // almost certainly not a live pid
  });
});

describe('looksLikeServeWeb', () => {
  it('is true only when the command line contains serve-web (injected reader)', () => {
    expect(looksLikeServeWeb(1, () => 'bash /usr/local/bin/code serve-web --port 5001')).toBe(true);
    expect(looksLikeServeWeb(2, () => '/usr/bin/some-other-daemon')).toBe(false);
    expect(looksLikeServeWeb(3, () => '')).toBe(false); // ps failed / pid gone
  });
});
