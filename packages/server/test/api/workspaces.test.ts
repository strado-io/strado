import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp, buildDeps } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wsroutes-'));
  const deps = await buildDeps({ configDir: path.join(root, 'config'), homeStateDir: path.join(root, 'home') });
  const app = await buildApp(deps);
  return { app, root };
}

describe('/api/workspaces', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await ctx.app.close(); });

  it('GET returns the default workspace', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/workspaces' });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toHaveLength(1);
    expect(res.json().activeWorkspaceId).toBe('default');
  });

  it('POST creates a workspace + its dir', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/workspaces',
      payload: { id: 'strado', name: 'Strado', color: '#10b981', icon: 'S',
                 defaultEditor: 'code', defaultPortBase: 4000, logDir: null },
    });
    expect(res.statusCode).toBe(200);
    await fs.access(path.join(ctx.root, 'config', 'workspaces', 'strado', 'repos.json'));
  });

  it('DELETE refuses last workspace', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/workspaces/default?confirm=1' });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE removes a workspace + dir', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/workspaces',
      payload: { id: 'strado', name: 'Strado', color: '#10b981', icon: 'S',
                 defaultEditor: 'code', defaultPortBase: 4000, logDir: null },
    });
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/workspaces/strado?confirm=1' });
    expect(res.statusCode).toBe(204);
    await expect(fs.access(path.join(ctx.root, 'config', 'workspaces', 'strado'))).rejects.toBeTruthy();
  });

  it('POST /active changes active workspace', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/workspaces',
      payload: { id: 'strado', name: 'Strado', color: '#10b981', icon: 'S',
                 defaultEditor: 'code', defaultPortBase: 4000, logDir: null },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/workspaces/active', payload: { id: 'strado' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeWorkspaceId).toBe('strado');
  });

  it('unknown wsId returns 404', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/w/nope/repos' });
    expect(res.statusCode).toBe(404);
  });
});
