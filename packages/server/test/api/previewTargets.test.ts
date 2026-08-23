import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'api-pt-'));
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const put = (body: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/preview-targets', payload: body });
const del = (body: Record<string, unknown>) =>
  app.inject({ method: 'DELETE', url: '/api/preview-targets', payload: body });
const list = async () => (await app.inject({ method: 'GET', url: '/api/preview-targets' })).json().targets;

describe('preview targets registry (multi-tab)', () => {
  it('keys targets by path + tabId, defaulting tabId to 1', async () => {
    await put({ path: '/wt/a', targetId: 't1', wcId: 10, cdpPort: 9222 });
    await put({ path: '/wt/a', tabId: '2', targetId: 't2', wcId: 11, cdpPort: 9222 });
    expect(await list()).toEqual([
      { path: '/wt/a', tabId: '1', targetId: 't1', wcId: 10, cdpPort: 9222 },
      { path: '/wt/a', tabId: '2', targetId: 't2', wcId: 11, cdpPort: 9222 },
    ]);
  });

  it('re-registering the same path+tabId replaces, not duplicates', async () => {
    await put({ path: '/wt/a', tabId: '2', targetId: 'old', wcId: 11, cdpPort: 9222 });
    await put({ path: '/wt/a', tabId: '2', targetId: 'new', wcId: 12, cdpPort: 9222 });
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe('new');
  });

  it('deletes one tab, all tabs of a path, or everything', async () => {
    await put({ path: '/wt/a', targetId: 't1', wcId: 10, cdpPort: 9222 });
    await put({ path: '/wt/a', tabId: '2', targetId: 't2', wcId: 11, cdpPort: 9222 });
    await put({ path: '/wt/b', targetId: 't3', wcId: 12, cdpPort: 9222 });

    await del({ path: '/wt/a', tabId: '2' });
    expect((await list()).map((t: any) => t.targetId)).toEqual(['t1', 't3']);

    await del({ path: '/wt/a' });
    expect((await list()).map((t: any) => t.targetId)).toEqual(['t3']);

    await del({});
    expect(await list()).toEqual([]);
  });
});
