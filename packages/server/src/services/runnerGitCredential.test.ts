import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubProjectFromCloneUrl, runnerGitCredential } from './runnerGitCredential.js';

afterEach(() => {
  const home = process.env.STRADO_HOME;
  for (const key of ['STRADO_RUNNER', 'STRADO_HOME']) {
    delete process.env[key];
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('runner GitHub credentials', () => {
  it('normalizes GitHub HTTPS and SSH clone URLs', () => {
    expect(githubProjectFromCloneUrl('git@github.com:strado-io/strado.git')).toEqual({
      projectPath: 'strado-io/strado',
      httpsUrl: 'https://github.com/strado-io/strado.git',
    });
    expect(githubProjectFromCloneUrl('https://github.com/strado-io/strado')).toEqual({
      projectPath: 'strado-io/strado',
      httpsUrl: 'https://github.com/strado-io/strado.git',
    });
    expect(githubProjectFromCloneUrl('git@gitlab.com:strado-io/strado.git')).toBeNull();
  });

  it('does nothing off a runner', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runnerGitCredential('github.com', 'strado-io/strado', 'read')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authenticates as the runner and returns a short-lived credential', async () => {
    process.env.STRADO_RUNNER = '1';
    process.env.STRADO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-runner-git-'));
    fs.writeFileSync(path.join(process.env.STRADO_HOME, 'runner.json'), JSON.stringify({
      runnerId: 'runner-1', runnerToken: 'f'.repeat(64), apiUrl: 'https://api.strado.io/',
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      username: 'x-access-token',
      token: 'ghs_short',
      expiresAt: '2026-09-01T00:00:00Z',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runnerGitCredential('github.com', 'strado-io/strado', 'write')).resolves.toEqual({
      username: 'x-access-token',
      token: 'ghs_short',
      expiresAt: '2026-09-01T00:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.strado.io/v1/runners/git-credential',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          runnerId: 'runner-1',
          runnerToken: 'f'.repeat(64),
          host: 'github.com',
          projectPath: 'strado-io/strado',
          operation: 'write',
        }),
      }),
    );
  });
});
