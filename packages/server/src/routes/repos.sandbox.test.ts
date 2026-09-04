import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureBareRepo: vi.fn<[Record<string, unknown>], Promise<string>>(),
}));

vi.mock('../services/sandbox/bareRepo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sandbox/bareRepo.js')>();
  return { ...actual, ensureBareRepo: mocks.ensureBareRepo };
});

import { buildApp, buildDeps } from '../app.js';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repos-sandbox-')));
  const homeStateDir = path.join(tmp, 'home');
  const bare = path.join(homeStateDir, 'sandbox', 'repos', 'site.git');
  mocks.ensureBareRepo.mockReset();
  mocks.ensureBareRepo.mockResolvedValue(bare);

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir });
  // The route checks the runtime capability at request time. A full container
  // stub is unnecessary: this endpoint only needs the capability gate.
  deps.sandbox = {} as NonNullable<typeof deps.sandbox>;
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('POST /repos/clone on a sandbox-capable runner', () => {
  it('registers a hidden bare backing repo without creating a main checkout', async () => {
    const payload = {
      url: 'https://git.example.test/acme/site.git',
      config: {
        id: 'site',
        name: 'Site',
        projectSubdir: null,
        startCommand: 'npm run dev',
        defaultPort: 5173,
        editor: 'code',
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/w/default/repos/clone',
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      alreadyRegistered: false,
      backing: 'bare',
      path: path.join(tmp, 'home', 'sandbox', 'repos', 'site.git'),
      repo: {
        id: 'site',
        path: path.join(tmp, 'home', 'sandbox', 'repos', 'site.git'),
        cloneUrl: payload.url,
      },
    });
    expect(mocks.ensureBareRepo).toHaveBeenCalledWith(expect.objectContaining({
      reposDir: path.join(tmp, 'home', 'sandbox', 'repos'),
      repoId: 'site',
      cloneUrl: payload.url,
    }));

    const second = await app.inject({
      method: 'POST',
      url: '/api/w/default/repos/clone',
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ alreadyRegistered: true, backing: 'bare' });

    const repos = await app.inject({ method: 'GET', url: '/api/w/default/repos' });
    expect(repos.json().repos).toHaveLength(1);
  });
});
