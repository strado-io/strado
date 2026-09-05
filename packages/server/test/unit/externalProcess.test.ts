import net from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { pidsOnPort } from '../../src/services/externalProcess.js';

describe('pidsOnPort', () => {
  it('finds the process listening on a port', async () => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const pids = await pidsOnPort(port);
      expect(pids).toContain(process.pid);
    } finally {
      srv.close();
    }
  });

  it('returns empty for a free port', async () => {
    // grab a port then release it so we know it is free
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as net.AddressInfo).port;
    srv.close();
    await once(srv, 'close');
    expect(await pidsOnPort(port)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach } from 'vitest';
import { findExternalProcesses } from '../../src/services/externalProcess.js';

async function reservePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    ports.push((srv.address() as net.AddressInfo).port);
    srv.close();
    await once(srv, 'close');
  }
  return ports;
}

// A stand-in dev server: listens on every port given, optionally keeps a file
// open (the way an editor or a watcher would), and says so on stdout.
function serveFrom(cwd: string, ports: number[], holdOpen?: string): Promise<ChildProcess> {
  const script = [
    holdOpen ? `require('fs').openSync(${JSON.stringify(holdOpen)}, 'r');` : '',
    `let n=0;for (const p of ${JSON.stringify(ports)}) {`,
    `  require('net').createServer().listen(p, '127.0.0.1', () => { if (++n === ${ports.length}) console.log('ready'); });`,
    '}',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (b) => { if (String(b).includes('ready')) resolve(child); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('stand-in server exited early')));
  });
}

describe('findExternalProcesses', () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strado-ext-')));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    children.length = 0;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('attributes a listener by its working directory, not by files it happens to hold open', async () => {
    const worktree = tmp();
    const elsewhere = tmp();
    fs.writeFileSync(path.join(worktree, 'index.ts'), '');
    const [servedPort, editorPort] = await reservePorts(2);
    // The dev server runs IN the worktree; the "editor" runs elsewhere but has a
    // worktree file open — exactly what made VS Code's server show up as a
    // dev server on a port nobody recognised.
    children.push(await serveFrom(worktree, [servedPort!]));
    children.push(await serveFrom(elsewhere, [editorPort!], path.join(worktree, 'index.ts')));

    const found = await findExternalProcesses(
      [{ worktreePath: worktree, projectSubdir: null }],
      new Set(),
    );
    expect(found.get(worktree)).toEqual({ pid: children[0]!.pid, port: servedPort });
  }, 20_000);

  it('prefers the configured port when a process listens on several, else the lowest', async () => {
    const worktree = tmp();
    const ports = (await reservePorts(2)).sort((a, b) => a - b);
    const [low, high] = ports;
    children.push(await serveFrom(worktree, [high!, low!]));

    const configured = await findExternalProcesses(
      [{ worktreePath: worktree, projectSubdir: null, port: high }],
      new Set(),
    );
    expect(configured.get(worktree)?.port).toBe(high);

    const unconfigured = await findExternalProcesses(
      [{ worktreePath: worktree, projectSubdir: null }],
      new Set(),
    );
    expect(unconfigured.get(worktree)?.port).toBe(low);
  }, 20_000);

  it('never reports a listener on an ignored port', async () => {
    const worktree = tmp();
    const [port] = await reservePorts(1);
    children.push(await serveFrom(worktree, [port!]));

    const found = await findExternalProcesses(
      [{ worktreePath: worktree, projectSubdir: null }],
      new Set(),
      { ignorePorts: new Set([port!]) },
    );
    expect(found.has(worktree)).toBe(false);
  }, 20_000);

  it('skips processes the manager already owns', async () => {
    const worktree = tmp();
    const [port] = await reservePorts(1);
    const child = await serveFrom(worktree, [port!]);
    children.push(child);

    const found = await findExternalProcesses(
      [{ worktreePath: worktree, projectSubdir: null }],
      new Set([child.pid!]),
    );
    expect(found.has(worktree)).toBe(false);
  }, 20_000);
});
