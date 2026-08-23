import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'api-env-'));
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/env-check', () => {
  it('reports tool availability with the expected shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/env-check' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json();
    const ids = tools.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['git', 'claude', 'codex', 'vscode']));
    // git exists everywhere this test runs
    const git = tools.find((t: any) => t.id === 'git');
    expect(git.found).toBe(true);
    expect(git.version).toMatch(/git/);
    for (const t of tools) {
      expect(typeof t.found).toBe('boolean');
      expect(typeof t.optional).toBe('boolean');
      if (!t.found) expect(t.hint).toBeTruthy();
    }
  });
});
