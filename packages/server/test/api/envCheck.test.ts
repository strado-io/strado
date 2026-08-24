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
      expect(typeof t.installable).toBe('boolean');
      if (!t.found) expect(t.hint).toBeTruthy();
      // Whatever onboarding offers to install, it must also be able to show
      // the command — that string is the fallback when the install fails.
      if (t.installable) expect(t.installCommand).toBeTruthy();
    }
  });

  it('marks the npm-global agents installable and the GUI-installed tools not', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/env-check' });
    const byId: Record<string, any> = Object.fromEntries(res.json().tools.map((t: any) => [t.id, t]));
    expect(byId.claude.installable).toBe(true);
    expect(byId.claude.installCommand).toBe('npm install -g @anthropic-ai/claude-code');
    // git comes from Xcode's GUI installer and `code` is installed from inside
    // VS Code: offering an Install button for either would be a lie.
    expect(byId.git.installable).toBe(false);
    expect(byId.vscode.installable).toBe(false);
  });
});

describe('POST /api/env-check/install/:id', () => {
  it('refuses a tool it has no install command for', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/env-check/install/git' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  // The whole safety property: the client picks an id, never a command, and an
  // id outside the table runs nothing at all.
  it('refuses an unknown id rather than running anything', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/env-check/install/rm -rf ~' });
    expect(res.statusCode).toBe(400);
  });
});
