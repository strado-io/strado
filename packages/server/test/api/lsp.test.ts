import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import type { LspManager } from '../../src/services/lsp/manager';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: unknown[][];
let closed: boolean;

const fake = (): LspManager => ({
  definition: async (...a) => (calls.push(['definition', ...a]), { source: 'lsp', server: 'typescript', hits: [] }),
  references: async (...a) => (calls.push(['references', ...a]), { source: 'search', fallback: 'not-installed', hits: [] }),
  hover: async (...a) => (calls.push(['hover', ...a]), { server: 'typescript', markdown: 'x' }),
  outline: async (...a) => (calls.push(['outline', ...a]), { server: null, symbols: [] }),
  servers: async () => [],
  running: () => [],
  setEnabled: async (...a) => void calls.push(['setEnabled', ...a]),
  stop: async (...a) => void calls.push(['stop', ...a]),
  sweep: async () => {},
  closeAll: async () => {
    closed = true;
  },
});

const base = () => `/api/w/default/worktrees/${encodeURIComponent(repo)}/lsp`;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-lsp-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  calls = [];
  closed = false;
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp({ ...deps, lsp: fake() });
  const res = await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: { id: 'r', name: 'r', path: repo, projectSubdir: null, startCommand: 'npm start', defaultPort: 8080, editor: 'code' },
  });
  expect(res.statusCode).toBe(200);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('navigation routes', () => {
  it('definition, references, hover, outline reach the manager with the worktree', async () => {
    const q = `path=${encodeURIComponent('src/a.ts')}&line=3&col=7`;
    expect((await app.inject({ method: 'GET', url: `${base()}/definition?${q}` })).json()).toEqual({ source: 'lsp', server: 'typescript', hits: [] });
    expect((await app.inject({ method: 'GET', url: `${base()}/references?${q}` })).json()).toMatchObject({ source: 'search', fallback: 'not-installed' });
    expect((await app.inject({ method: 'GET', url: `${base()}/hover?${q}` })).json()).toEqual({ server: 'typescript', markdown: 'x' });
    expect((await app.inject({ method: 'GET', url: `${base()}/outline?path=src%2Fa.ts` })).json()).toEqual({ server: null, symbols: [] });
    expect(calls).toEqual([
      ['definition', repo, 'src/a.ts', 3, 7],
      ['references', repo, 'src/a.ts', 3, 7],
      ['hover', repo, 'src/a.ts', 3, 7],
      ['outline', repo, 'src/a.ts'],
    ]);
  });

  it.each(['line=0&col=1', 'line=1', 'line=x&col=1', 'col=1&line=1.5'])('bad position %s → 400', async (q) => {
    expect((await app.inject({ method: 'GET', url: `${base()}/definition?path=a.ts&${q}` })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('a worktree no repo owns → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/w/default/worktrees/${encodeURIComponent(path.join(tmp, 'x'))}/lsp/outline?path=a.ts` });
    expect(res.statusCode).toBe(404);
  });
});

describe('admin routes', () => {
  it('GET servers', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/lsp/servers' })).json()).toEqual({ servers: [] });
  });

  it("stop with a worktree stops only that worktree's instance", async () => {
    const h = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' };
    const res = await app.inject({ method: 'POST', url: '/api/lsp/servers/typescript/stop', headers: h, payload: { worktreePath: '/wt/a' } });
    expect(res.statusCode).toBe(204);
    expect(calls).toEqual([['stop', 'typescript', '/wt/a']]);
    const bad = await app.inject({ method: 'POST', url: '/api/lsp/servers/typescript/stop', headers: h, payload: { worktreePath: '' } });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({ method: 'POST', url: '/api/lsp/servers/typescript/stop', headers: h, payload: { worktreePath: '/wt/a', all: true } });
    expect(extra.statusCode).toBe(400);
  });

  it('setEnabled and stop from the local hub', async () => {
    const h = { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' };
    expect((await app.inject({ method: 'POST', url: '/api/lsp/servers/gopls/enabled', headers: h, payload: { enabled: false } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/lsp/servers/gopls/stop', headers: h })).statusCode).toBe(204);
    expect(calls).toEqual([['setEnabled', 'gopls', false], ['stop', 'gopls']]);
  });

  it('refuses a relayed window, a foreign origin, an unknown id, a bad body', async () => {
    const url = '/api/lsp/servers/gopls/enabled';
    const r = (headers: Record<string, string>, payload: unknown = { enabled: true }, u = url) => app.inject({ method: 'POST', url: u, headers, payload: payload as object });
    expect((await r({ host: '127.0.0.1:4000', 'x-strado-via': 'relay' })).statusCode).toBe(403);
    expect((await r({ host: '127.0.0.1:4000', origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/lsp/servers/gopls/stop', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await r({ host: '127.0.0.1:4000' }, { enabled: true }, '/api/lsp/servers/bash/enabled')).statusCode).toBe(400);
    expect((await r({ host: '127.0.0.1:4000' }, { enabled: 'yes' })).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  // A laptop's POST /api/runners/:id/rpc reaches the runner's server through
  // its relay client, which always sets x-strado-via: relay (relay/src/client.ts)
  // and arrives from 127.0.0.1 with a loopback Host. It must not count as local.
  it('a POST forwarded by the relay (how rpc reaches a runner) is refused', async () => {
    const h = { host: '127.0.0.1:7777', 'x-strado-via': 'relay' };
    expect((await app.inject({ method: 'POST', url: '/api/lsp/servers/gopls/enabled', headers: h, payload: { enabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/lsp/servers/gopls/stop', headers: h })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('closing the app stops every server', async () => {
    await app.close();
    expect(closed).toBe(true);
  });
});
