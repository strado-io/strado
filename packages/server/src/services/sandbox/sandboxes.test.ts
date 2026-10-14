import { mkdtemp } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { createSandboxService, sandboxSlugFor } from './sandboxes.js';
import type { ExecFn } from './runtime.js';

let stateDir: string;
let calls: string[][];
const exec = async (_file: string, args: string[]) => { calls.push(args); return { code: 0, stdout: '[]', stderr: '' }; };

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'sbx-state-'));
  calls = [];
});

// gitMountPaths needs a real pointer file; fake the minimal shape.
async function fakeWorktree(): Promise<{ wt: string; bare: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'sbx-fake-'));
  const bare = path.join(root, 'repo.git');
  await fsp.mkdir(path.join(bare, 'worktrees', 'x'), { recursive: true });
  const wt = path.join(root, 'wt');
  await fsp.mkdir(wt);
  await fsp.writeFile(path.join(wt, '.git'), `gitdir: ${path.join(bare, 'worktrees', 'x')}\n`);
  return { wt, bare };
}

describe('sandbox create', () => {
  it('mounts worktree and bare repo at identical paths, publishes the port on loopback, labels the container', async () => {
    const { wt, bare } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    await svc.create({ worktreePath: wt, slug: 'feat-x', image: 'strado-sandbox:node22-v1', port: 5173, env: { ANTHROPIC_API_KEY: 'sk-test' }, socketPath: null, hooksPath: null });
    const create = calls.find((a) => a[0] === 'create')!;
    const joined = create.join(' ');
    expect(joined).toContain(`-v ${wt}:${wt}`);
    expect(joined).toContain(`-v ${bare}:${bare}`);
    expect(joined).toContain('-p 127.0.0.1:5173:5173');
    expect(joined).toContain('--label io.strado.worktree=' + wt);
    expect(joined).toContain('--name strado-sbx-feat-x');
    expect(joined).toContain('--env-file');
    expect(joined).not.toContain('sk-test'); // never argv
  });

  it('writes the env file mode 600 with HOST=0.0.0.0 plus provided vars', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    await svc.create({ worktreePath: wt, slug: 'feat-x', image: 'i', port: null, env: { ANTHROPIC_API_KEY: 'sk-test' }, socketPath: null, hooksPath: null });
    const envPath = path.join(stateDir, 'sandboxes', 'feat-x.env');
    const st = await fsp.stat(envPath);
    expect(st.mode & 0o777).toBe(0o600);
    const body = await fsp.readFile(envPath, 'utf8');
    expect(body).toContain('ANTHROPIC_API_KEY=sk-test');
    expect(body).toContain('HOST=0.0.0.0');
  });

  it('enforces mode 600 even when overwriting an existing file', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    const envPath = path.join(stateDir, 'sandboxes', 'feat-x.env');
    // Pre-create with permissive mode
    await fsp.mkdir(path.dirname(envPath), { recursive: true });
    await fsp.writeFile(envPath, 'OLD=value', { mode: 0o644 });
    let st = await fsp.stat(envPath);
    expect(st.mode & 0o777).toBe(0o644); // verify it started permissive
    // Now overwrite via create()
    await svc.create({ worktreePath: wt, slug: 'feat-x', image: 'i', port: null, env: { NEW: 'secret' }, socketPath: null, hooksPath: null });
    st = await fsp.stat(envPath);
    expect(st.mode & 0o777).toBe(0o600); // must be 0600 after write
  });

  it('mounts the hooks socket when given', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    await svc.create({ worktreePath: wt, slug: 's', image: 'i', port: null, env: {}, socketPath: '/home/u/.strado/sandbox/sock/api.sock', hooksPath: null });
    // The DIRECTORY is mounted: the host unlinks and recreates the socket on
    // every restart, and a file mount would pin the dead inode.
    const create = calls.find((a) => a[0] === 'create')!.join(' ');
    expect(create).toContain('-v /home/u/.strado/sandbox/sock:/run/strado');
    expect(create).not.toContain('api.sock:');
    // The in-container path is fixed, so the host basename has to match it.
    await expect(
      svc.create({ worktreePath: wt, slug: 's2', image: 'i', port: null, env: {}, socketPath: '/tmp/strado-api.sock', hooksPath: null }),
    ).rejects.toThrow(/must be named api.sock/);
  });

  it('mounts the hooks dir read-only at its host path when given', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    await svc.create({ worktreePath: wt, slug: 's', image: 'i', port: null, env: {}, socketPath: null, hooksPath: '/opt/strado/hooks' });
    // Identical in and out, like the git mounts: the Claude settings file and
    // the codex notify flag both name the HOST path of the script.
    expect(calls.find((a) => a[0] === 'create')!.join(' ')).toContain('-v /opt/strado/hooks:/opt/strado/hooks:ro');
  });

  it('omits the hooks mount when there is none, and when an existing mount already covers it', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    await svc.create({ worktreePath: wt, slug: 's', image: 'i', port: null, env: {}, socketPath: null, hooksPath: null });
    expect(calls.find((a) => a[0] === 'create')!.join(' ')).not.toContain(':ro');
    calls = [];
    // Strado developed inside a sandboxed worktree: hooks/ is already mounted
    // as part of the worktree, and mounting it again would shadow it.
    await svc.create({ worktreePath: wt, slug: 's', image: 'i', port: null, env: {}, socketPath: null, hooksPath: path.join(wt, 'packages/server/hooks') });
    expect(calls.find((a) => a[0] === 'create')!.join(' ')).not.toContain(':ro');
  });

  const createArgs = () => calls.find((a) => a[0] === 'create')!.join(' ');
  const mk = (bin: 'podman' | 'docker', ids: { uid: number; gid: number }) =>
    createSandboxService({ bin }, { stateDir, exec, ids });
  const one = async (svc: ReturnType<typeof createSandboxService>, wt: string, slug = 'a') => {
    calls = [];
    await svc.create({ worktreePath: wt, slug, image: 'img', port: null, env: {}, socketPath: null, hooksPath: null });
  };

  it('maps the host user onto the image user: plain keep-id for uid 1000, the uid= form otherwise, --user on docker', async () => {
    const { wt } = await fakeWorktree();
    await one(mk('podman', { uid: 1000, gid: 1000 }), wt);
    expect(createArgs()).toContain('--userns=keep-id ');
    expect(createArgs()).not.toContain('keep-id:uid');
    // A second user or a service account: still uid 1000 inside, so the
    // worktree stays writable and the 0600 hook socket readable.
    await one(mk('podman', { uid: 1001, gid: 1001 }), wt);
    expect(createArgs()).toContain('--userns=keep-id:uid=1000,gid=1000');
    await one(mk('docker', { uid: 1001, gid: 1001 }), wt);
    expect(createArgs()).toContain('--user 1001:1001');
    expect(createArgs()).not.toContain('--userns');
  });

  it('gives every sandbox the shared HOME volume and an explicit HOME', async () => {
    const { wt } = await fakeWorktree();
    await one(mk('podman', { uid: 1000, gid: 1000 }), wt);
    expect(createArgs()).toContain('-v strado-sandbox-home:/home/node');
    expect(createArgs()).toContain('--env HOME=/home/node');
  });

  it('creates the HOME volume once, and chowns it for docker when the host uid is not 1000', async () => {
    const { wt } = await fakeWorktree();
    let volumeExists = false;
    const execVol: ExecFn = async (_f, args) => {
      if (args[0] === 'volume' && args[1] === 'inspect') return { code: volumeExists ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'create') { volumeExists = true; }
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };
    const docker = createSandboxService({ bin: 'docker' }, { stateDir, exec: execVol, ids: { uid: 1001, gid: 1001 } });
    calls = [];
    await docker.create({ worktreePath: wt, slug: 'a', image: 'img', port: null, env: {}, socketPath: null, hooksPath: null });
    const flat = calls.map((a) => a.join(' '));
    expect(flat).toContain('volume create strado-sandbox-home');
    expect(flat).toContain('run --rm --user 0:0 -v strado-sandbox-home:/home/node img chown -R 1001:1001 /home/node');
    // Second container: the volume is there, nothing to create or chown.
    calls = [];
    await docker.create({ worktreePath: wt, slug: 'b', image: 'img', port: null, env: {}, socketPath: null, hooksPath: null });
    expect(calls.map((a) => a[0])).not.toContain('volume');
    expect(calls.map((a) => a[0])).not.toContain('run');
    // podman never chowns: a fresh volume is populated from the image as 1000,
    // which is the uid the host user is mapped onto.
    volumeExists = false;
    calls = [];
    await createSandboxService({ bin: 'podman' }, { stateDir, exec: execVol, ids: { uid: 1001, gid: 1001 } })
      .create({ worktreePath: wt, slug: 'c', image: 'img', port: null, env: {}, socketPath: null, hooksPath: null });
    expect(calls.map((a) => a.join(' '))).toContain('volume create strado-sandbox-home');
    expect(calls.map((a) => a[0])).not.toContain('run');
  });

  it('rejects env values containing newlines or carriage returns', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    const envPath = path.join(stateDir, 'sandboxes', 'bad.env');
    // Reject value with \n
    await expect(
      svc.create({ worktreePath: wt, slug: 'bad', image: 'i', port: null, env: { KEY: 'val\nEVIL=1' }, socketPath: null, hooksPath: null })
    ).rejects.toThrow(/newline|carriage/i);
    // Ensure no file was written with the injection
    await expect(fsp.stat(envPath)).rejects.toThrow();
    // Reject value with \r
    await expect(
      svc.create({ worktreePath: wt, slug: 'bad2', image: 'i', port: null, env: { KEY: 'val\r' }, socketPath: null, hooksPath: null })
    ).rejects.toThrow(/newline|carriage/i);
  });

  it('rejects env keys containing =, whitespace, newlines, or carriage returns', async () => {
    const { wt } = await fakeWorktree();
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    await expect(
      svc.create({ worktreePath: wt, slug: 'bad', image: 'i', port: null, env: { 'KEY=bad': 'val' }, socketPath: null, hooksPath: null })
    ).rejects.toThrow();
    await expect(
      svc.create({ worktreePath: wt, slug: 'bad', image: 'i', port: null, env: { 'KEY BAD': 'val' }, socketPath: null, hooksPath: null })
    ).rejects.toThrow();
    await expect(
      svc.create({ worktreePath: wt, slug: 'bad', image: 'i', port: null, env: { 'KEY\nBAD': 'val' }, socketPath: null, hooksPath: null })
    ).rejects.toThrow();
  });
});

describe('status', () => {
  it('maps inspect output to running/stopped/absent', async () => {
    const svc = (out: { code: number; stdout: string }) =>
      createSandboxService({ bin: 'podman' }, { stateDir, exec: async () => ({ ...out, stderr: '' }) });
    expect(await svc({ code: 0, stdout: 'running' }).status('s')).toBe('running');
    expect(await svc({ code: 0, stdout: 'exited' }).status('s')).toBe('stopped');
    expect(await svc({ code: 1, stdout: '' }).status('s')).toBe('absent');
  });
});

describe('listRunning', () => {
  it('uses podman format string and parses name + label', async () => {
    const { wt } = await fakeWorktree();
    let capturedArgs: string[] = [];
    const exec = async (_bin: string, args: string[]) => {
      capturedArgs = args;
      // Simulate podman ps output with tab-separated format
      return { code: 0, stdout: `strado-sbx-feat-x\t${wt}`, stderr: '' };
    };
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    const result = await svc.listRunning();
    // Verify the format string is podman-specific
    expect(capturedArgs).toContain('--format');
    const fmtIdx = capturedArgs.indexOf('--format');
    expect(capturedArgs[fmtIdx + 1]).toMatch(/index.*Labels.*io\.strado\.worktree/);
    expect(result).toEqual([{ slug: 'feat-x', worktreePath: wt }]);
  });

  it('uses docker format string and parses name + label', async () => {
    const { wt } = await fakeWorktree();
    let capturedArgs: string[] = [];
    const exec = async (_bin: string, args: string[]) => {
      capturedArgs = args;
      // Simulate docker ps output with tab-separated format
      return { code: 0, stdout: `strado-sbx-feat-x\t${wt}`, stderr: '' };
    };
    const svc = createSandboxService({ bin: 'docker' }, { stateDir, exec });
    const result = await svc.listRunning();
    // Verify the format string is docker-specific
    expect(capturedArgs).toContain('--format');
    const fmtIdx = capturedArgs.indexOf('--format');
    expect(capturedArgs[fmtIdx + 1]).toMatch(/Label.*io\.strado\.worktree/);
    expect(result).toEqual([{ slug: 'feat-x', worktreePath: wt }]);
  });

  it('parses paths containing commas correctly', async () => {
    const pathWithComma = '/tmp/repo,broken/wt';
    const exec = async () => ({ code: 0, stdout: `strado-sbx-x\t${pathWithComma}`, stderr: '' });
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    const result = await svc.listRunning();
    expect(result).toEqual([{ slug: 'x', worktreePath: pathWithComma }]);
  });

  it('filters out non-strado containers', async () => {
    const { wt } = await fakeWorktree();
    const exec = async () => ({
      code: 0,
      stdout: `strado-sbx-x\t${wt}\nother-container\t${wt}\nstrado-sbx-y\t${wt}`,
      stderr: '',
    });
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    const result = await svc.listRunning();
    expect(result).toEqual([
      { slug: 'x', worktreePath: wt },
      { slug: 'y', worktreePath: wt },
    ]);
  });

  it('returns [] on nonzero exit', async () => {
    const exec = async () => ({ code: 1, stdout: '', stderr: 'error' });
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    expect(await svc.listRunning()).toEqual([]);
  });
});

describe('sandboxSlugFor', () => {
  it('separates two repos that produced the SAME worktree slug', () => {
    // buildWorktreeSlug is not repo-scoped: "FD-123 fix login" in two repos is
    // the same slug. Container names and env files are global, so identity has
    // to come from the one thing that is unique — the worktree path.
    const a = sandboxSlugFor('FD-123_fix_login', '/home/u/wt/api/FD-123_fix_login');
    const b = sandboxSlugFor('FD-123_fix_login', '/home/u/wt/web/FD-123_fix_login');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^FD-123_fix_login-[0-9a-f]{8}$/);
    expect(sandboxSlugFor('FD-123_fix_login', '/home/u/wt/api/FD-123_fix_login')).toBe(a);
  });
});

describe('worktreeOf', () => {
  it('returns the container label so callers can refuse to remove a stranger', async () => {
    let captured: string[] = [];
    const exec = async (_bin: string, args: string[]) => {
      captured = args;
      return { code: 0, stdout: '/home/u/wt/api/feat-x\n', stderr: '' };
    };
    const svc = createSandboxService({ bin: 'podman' }, { stateDir, exec });
    expect(await svc.worktreeOf('feat-x')).toBe('/home/u/wt/api/feat-x');
    expect(captured).toContain('strado-sbx-feat-x');
    expect(captured.join(' ')).toContain('io.strado.worktree');
  });

  it('is null for a missing container and for one without our label', async () => {
    const svc = (out: { code: number; stdout: string }) =>
      createSandboxService({ bin: 'docker' }, { stateDir, exec: async () => ({ ...out, stderr: '' }) });
    expect(await svc({ code: 1, stdout: '' }).worktreeOf('gone')).toBeNull();
    // docker's `index` on a label map with no such key prints this literal.
    expect(await svc({ code: 0, stdout: '<no value>\n' }).worktreeOf('unlabelled')).toBeNull();
    expect(await svc({ code: 0, stdout: '\n' }).worktreeOf('blank')).toBeNull();
  });
});
