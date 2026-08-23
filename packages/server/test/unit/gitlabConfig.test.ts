import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-gl-'));
  process.env.STRADO_HOME = dir;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.STRADO_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function load() {
  return await import('../../src/services/gitlab.js');
}

describe('gitlab config', () => {
  it('validates the token, then persists 0600, keyed by host', async () => {
    const gl = await load();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ username: 'kamlesh' }), { status: 200 }),
    );
    const res = await gl.writeGitlabHost('gitlab.stg-acme.io', 'glpat-abc');
    expect(res.username).toBe('kamlesh');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.stg-acme.io/api/v4/user',
      expect.objectContaining({ headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'glpat-abc' }) }),
    );
    const cfg = await gl.readGitlabConfig();
    expect(cfg['gitlab.stg-acme.io']).toEqual({ token: 'glpat-abc' });
    const mode = fs.statSync(gl.gitlabConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects a bad token without persisting', async () => {
    const gl = await load();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(gl.writeGitlabHost('gitlab.com', 'bad')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await gl.readGitlabConfig()).toEqual({});
  });

  it('removes a host', async () => {
    const gl = await load();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await gl.writeGitlabHost('gitlab.com', 't');
    await gl.removeGitlabHost('gitlab.com');
    expect(await gl.readGitlabConfig()).toEqual({});
  });
});
