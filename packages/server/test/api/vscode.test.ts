import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensure = vi.fn(async (_folder: string) => ({ url: 'http://127.0.0.1:5000/' }));
const drop = vi.fn(async (_folder: string) => {});
vi.mock('../../src/services/vscodeWeb.js', () => ({
  ensureVsCodeWeb: (f: string) => ensure(f),
  dropVsCodeWeb: (f: string) => drop(f),
  reapOrphans: async () => {},
  closeAll: async () => {},
}));

import { buildApp, buildDeps } from '../../src/app.js';

async function makeApp() {
  const deps = await buildDeps({});
  return buildApp(deps);
}

describe('vscode routes', () => {
  beforeEach(() => { ensure.mockClear(); drop.mockClear(); });

  it('POST /api/vscode ensures the folder daemon', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/vscode', payload: { folder: '/wt/a' } });
    expect(res.statusCode).toBe(200);
    expect(ensure).toHaveBeenCalledWith('/wt/a');
    expect(res.json()).toEqual({ url: 'http://127.0.0.1:5000/' });
    await app.close();
  });

  it('POST without folder is a 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/vscode', payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('DELETE /api/vscode drops the folder daemon', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/vscode', payload: { folder: '/wt/a' } });
    expect(res.statusCode).toBe(200);
    expect(drop).toHaveBeenCalledWith('/wt/a');
    await app.close();
  });
});
