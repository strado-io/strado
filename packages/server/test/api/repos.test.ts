import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'api-repos-'));
  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/w/default/repos', () => {
  it('returns empty list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/w/default/repos' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repos: [] });
  });
});

describe('POST /api/w/default/repos', () => {
  it('adds a repo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/repos',
      payload: {
        id: 'react-app',
        name: 'React App',
        path: tmp,
        projectSubdir: null,
        startCommand: 'npm start',
        defaultPort: 8080,
        editor: 'code',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('react-app');
  });

  it('rejects unsupported editor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/repos',
      payload: {
        id: 'x',
        name: 'x',
        path: tmp,
        projectSubdir: null,
        startCommand: 'npm start',
        defaultPort: 8080,
        editor: 'vim',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('PATCH /api/w/default/repos/:id', () => {
  it('updates fields', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/w/default/repos',
      payload: {
        id: 'react-app',
        name: 'React App',
        path: tmp,
        projectSubdir: null,
        startCommand: 'npm start',
        defaultPort: 8080,
        editor: 'code',
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/w/default/repos/react-app',
      payload: { defaultPort: 9000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaultPort).toBe(9000);
  });
});

describe('DELETE /api/w/default/repos/:id', () => {
  it('removes the repo', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/w/default/repos',
      payload: {
        id: 'react-app',
        name: 'React App',
        path: tmp,
        projectSubdir: null,
        startCommand: 'npm start',
        defaultPort: 8080,
        editor: 'code',
      },
    });
    const res = await app.inject({ method: 'DELETE', url: '/api/w/default/repos/react-app' });
    expect(res.statusCode).toBe(204);
  });
});
