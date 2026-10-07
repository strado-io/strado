import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

// Two worktrees of one repo, both configured for the SAME port (the repo's
// fixed origin), run side by side behind the dev proxy.

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let proxyPort: number;
const worktrees: string[] = [];

async function freePort(): Promise<number> {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  await once(srv, 'close');
  return port;
}

function get(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

const enc = (p: string) => encodeURIComponent(p);

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-devproxy-')));
  repo = path.join(tmp, 'repo');
  const worktreesDir = path.join(tmp, 'home', 'worktrees', 'r');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(
    path.join(repo, 'server.js'),
    "const n=require('path').basename(process.cwd());require('http').createServer((q,s)=>s.end(n)).listen(process.env.PORT,'127.0.0.1',()=>console.log('up'));",
  );
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  proxyPort = await freePort();
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'r',
      name: 'r',
      path: repo,
      projectSubdir: null,
      startCommand: 'node server.js',
      defaultPort: proxyPort,
      editor: 'code',
      devProxy: { host: 'dev.strado.test', port: proxyPort },
    },
  });
  for (const name of ['FD-1_alpha', 'FD-2_beta']) {
    const wt = path.join(worktreesDir, name);
    await exec('git', ['-C', repo, 'worktree', 'add', wt, '-b', name, 'main']);
    await app.inject({
      method: 'POST',
      url: `/api/w/default/worktrees/${enc(wt)}/adopt`,
      payload: { repoId: 'r', ticketId: name.slice(0, 4), title: name, port: proxyPort },
    });
    worktrees.push(wt);
  }
});

afterEach(async () => {
  for (const wt of worktrees.splice(0)) {
    await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(wt)}/stop` }).catch(() => undefined);
  }
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('dev proxy routes', () => {
  it('runs two worktrees configured for the same port, each on its own subdomain', async () => {
    const ports: number[] = [];
    for (const wt of worktrees) {
      const res = await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(wt)}/start` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // moved off the proxy's port onto a private one
      expect(body.port).not.toBe(proxyPort);
      ports.push(body.port);
    }
    expect(new Set(ports).size).toBe(2);

    const statusOf = async (wt: string) =>
      (await app.inject({ method: 'GET', url: `/api/w/default/worktrees/${enc(wt)}/status` })).json();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const all = await Promise.all(worktrees.map(statusOf));
      if (all.every((s) => s.status === 'running')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const alpha = await statusOf(worktrees[0]!);
    expect(alpha.status).toBe('running');
    expect(alpha.proxyUrl).toBe(`http://fd-1-alpha.dev.strado.test:${proxyPort}`);
    expect((await statusOf(worktrees[1]!)).status).toBe('running');

    expect(await get(proxyPort, 'fd-1-alpha.dev.strado.test')).toEqual({ status: 200, body: 'FD-1_alpha' });
    expect(await get(proxyPort, 'fd-2-beta.dev.strado.test')).toEqual({ status: 200, body: 'FD-2_beta' });

    // the new private port is persisted, so it stays stable across restarts
    const rows = (await app.inject({ method: 'GET', url: '/api/w/default/worktrees' })).json();
    const list = (Array.isArray(rows) ? rows : rows.worktrees) as { path: string; meta: { port: number } | null }[];
    expect(list.find((r) => r.path === worktrees[0])?.meta?.port).toBe(ports[0]);

    // a stopped worktree answers 502 instead of hanging
    await app.inject({ method: 'POST', url: `/api/w/default/worktrees/${enc(worktrees[1]!)}/stop` });
    expect((await get(proxyPort, 'fd-2-beta.dev.strado.test')).status).toBe(502);
  }, 30_000);
});
