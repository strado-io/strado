// The gate between "every desktop today" and "a runner with a container
// runtime". The first test is the important one: with no sandbox on deps the
// creation path must be the one that has always shipped — same git call, same
// three steps, no bare clone anywhere on disk.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../shell.js';
import { buildApp, buildDeps } from '../app.js';
import type { JobContext } from '../services/jobs.js';
import { canonicalWorktreesDir } from '../services/worktreeRoot.js';
import { sandboxSlugFor } from '../services/sandbox/sandboxes.js';
import { bareRepoPath, sandboxReposDir } from '../services/sandbox/bareRepo.js';
import { hooksDir } from '../services/claudeHooks.js';

// The real one builds a container image. Stubbed for the whole file; the
// no-runtime test asserts it is never even reached.
const ensureBaseImage = vi.fn(async (_rt: unknown, opts: { node: string | null }) =>
  `strado-sandbox:node${opts.node ?? 'base'}-v3`,
);
vi.mock('../services/sandbox/image.js', () => ({
  ensureBaseImage: (rt: unknown, opts: { node: string | null }) => ensureBaseImage(rt, opts),
  imageTag: (node: string | null) => `strado-sandbox:node${node ?? 'base'}-v3`,
  dockerfilePath: () => '/nonexistent/Dockerfile',
}));

type CreateArgs = {
  worktreePath: string;
  slug: string;
  image: string;
  port: number | null;
  env: Record<string, string>;
  socketPath: string | null;
};

function sandboxStub(
  overrides: {
    create?: (c: CreateArgs) => Promise<void>;
    status?: 'running' | 'stopped' | 'absent';
    /** io.strado.worktree on the container `status` claims exists. */
    label?: string | null;
    envDir?: string;
  } = {},
) {
  const calls = {
    order: [] as string[],
    create: [] as CreateArgs[],
    start: [] as string[],
    remove: [] as string[],
    stop: [] as string[],
  };
  const envFilePath = (slug: string) => path.join(overrides.envDir ?? os.tmpdir(), `${slug}.env`);
  return {
    calls,
    envFilePath,
    service: {
      containerName: (slug: string) => `strado-sbx-${slug}`,
      envFilePath,
      async create(c: CreateArgs) {
        calls.order.push(`create:${c.slug}`);
        calls.create.push(c);
        if (overrides.create) await overrides.create(c);
      },
      async start(slug: string) { calls.order.push(`start:${slug}`); calls.start.push(slug); },
      async stop(slug: string) { calls.order.push(`stop:${slug}`); calls.stop.push(slug); },
      async remove(slug: string) { calls.order.push(`remove:${slug}`); calls.remove.push(slug); },
      async status() { return overrides.status ?? ('absent' as const); },
      async worktreeOf() { return overrides.label ?? null; },
      async listRunning() { return []; },
    },
  };
}

let tmp: string;
let repo: string;
let worktreesDir: string;
let home: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let steps: { message: string; data: unknown }[];

/** Record every step/progress event the create job emits. Wrapping `start` is
 * the only way to see the FIRST events: the job body runs before the caller
 * ever learns its id. */
function recordJobSteps(instance: Awaited<ReturnType<typeof buildApp>>) {
  const events: { message: string; data: unknown }[] = [];
  const real = instance.deps.jobs.start;
  instance.deps.jobs.start = ((kind: string, fn: (ctx: JobContext) => Promise<unknown>) =>
    real.call(instance.deps.jobs, kind, (ctx: JobContext) =>
      fn({
        progress(message, data) {
          events.push({ message, data });
          ctx.progress(message, data);
        },
      }),
    )) as typeof instance.deps.jobs.start;
  return events;
}

/** The steps the job ADVANCED to, in order — detail lines ride the current
 * step and would otherwise show up as duplicates. */
const stepIds = (events: { data: unknown }[]) =>
  events
    .map((e) => e.data as { step?: string; detail?: string })
    .filter((d) => d.step && d.detail === undefined)
    .map((d) => d.step);

beforeEach(async () => {
  vi.clearAllMocks();
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-create-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'react-app');
  home = path.join(tmp, 'home');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'p', engines: { node: '>=20' } }));
  await fs.mkdir(path.join(repo, 'node_modules', 'lodash'), { recursive: true }); // the link step needs a source
  // A monorepo-shaped second project, for the projectSubdir case: a DIFFERENT
  // node major, so a detection that read the wrong directory is visible.
  await fs.mkdir(path.join(repo, 'app'), { recursive: true });
  await fs.writeFile(path.join(repo, 'app', 'package.json'), JSON.stringify({ name: 'app', engines: { node: '22.x' } }));
  await fs.mkdir(path.join(repo, 'app', 'node_modules', 'lodash'), { recursive: true });
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: home });
  app = await buildApp(deps);
  steps = recordJobSteps(app);

  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: {
      id: 'react-app',
      name: 'React App',
      path: repo,
      projectSubdir: null,
      startCommand: 'true',
      defaultPort: 9100,
      editor: 'code',
    },
  });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function create(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/w/default/worktrees', payload });
  expect(res.statusCode).toBe(202);
  return app.deps.jobs.wait(res.json().jobId);
}

async function metaFor(ticketId: string) {
  const stores = await app.deps.registry.get('default');
  const entry = (await stores.state.list()).find((e) => e.meta.ticketId === ticketId);
  return entry ?? null;
}

/** Where the route WILL put this worktree — resolved with the same helper it
 * uses, because the container label gate compares against exactly this path
 * and the test has to know it before creation runs. */
async function plannedWorktreePath(repoId: string, slug: string) {
  const dir = canonicalWorktreesDir(app.deps.homeStateDir, repoId);
  await fs.mkdir(dir, { recursive: true });
  return path.join(await fs.realpath(dir), slug);
}

describe('POST /worktrees without a container runtime', () => {
  it('is unchanged: normal clone, three steps, no sandbox anywhere', async () => {
    // The default off any desktop — buildDeps found no runtime (or STRADO_RUNNER
    // is unset), so nothing sandbox-shaped may run.
    expect(app.deps.sandbox).toBeNull();

    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-1',
      title: 'plain feature',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });
    expect(final.status).toBe('done');

    expect(stepIds(steps)).toEqual(['worktree', 'link', 'finalize']);
    expect(ensureBaseImage).not.toHaveBeenCalled();

    const entry = await metaFor('FD-1');
    expect(entry).toBeTruthy();
    expect(entry!.meta.sandbox ?? null).toBeNull();

    // A normal `git worktree add` points back into the REPO's .git, and no bare
    // clone was made under the state dir.
    const pointer = await fs.readFile(path.join(entry!.path, '.git'), 'utf8');
    expect(pointer).toContain(path.join(repo, '.git'));
    await expect(fs.stat(path.join(home, 'sandbox'))).rejects.toThrow();
  });
});

describe('POST /worktrees with a sandbox', () => {
  let stub: ReturnType<typeof sandboxStub>;

  const enable = (s: ReturnType<typeof sandboxStub>) => {
    stub = s;
    app.deps.sandboxRuntime = { bin: 'podman' };
    app.deps.sandbox = s.service as unknown as NonNullable<typeof app.deps.sandbox>;
  };

  it('detects, builds, creates and starts the container, and persists meta.sandbox', async () => {
    enable(sandboxStub());

    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-2',
      title: 'sandboxed',
      sourceBranch: 'main',
      sourceWorktree: repo,
      port: 9111,
      sandboxEnv: { API_URL: 'http://localhost:3000' },
    });
    expect(final.status).toBe('done');

    // The two extra lines are appended, never inserted — the desktop's three
    // steps keep their order and ids.
    expect(stepIds(steps)).toEqual(['worktree', 'link', 'finalize', 'sandbox-detect', 'sandbox-build']);
    // The detection result has to be visible, not just acted on — and it has to
    // ride the BUILD step, which takes minutes. Attached to sandbox-detect it
    // would be on screen for the milliseconds detection takes.
    const detailEvents = steps
      .map((e) => e.data as { step?: string; detail?: string })
      .filter((d) => d.detail !== undefined);
    expect(detailEvents).toContainEqual({ step: 'sandbox-build', detail: 'sandbox: node 20 (engines) · npm (default)' });

    const entry = await metaFor('FD-2');
    // The sandbox identity is the worktree slug plus a hash of its path — the
    // slug alone is not unique across repos.
    const sbxSlug = sandboxSlugFor('FD-2_sandboxed', entry!.path);
    expect(sbxSlug).toMatch(/^FD-2_sandboxed-[0-9a-f]{8}$/);
    expect(entry!.meta.sandbox).toEqual({ slug: sbxSlug });
    // Host node_modules must never be symlinked into a sandbox: the source
    // checkout is not mounted there, so the link would be broken (and native
    // modules may not match the container). The sandbox owns its dependencies.
    expect(entry!.meta.linkedFrom).toBeNull();
    expect(entry!.meta.linkedAt).toBeNull();
    await expect(fs.lstat(path.join(entry!.path, 'node_modules'))).rejects.toThrow();

    const linkDetail = steps
      .map((e) => e.data as { step?: string; detail?: string })
      .find((d) => d.step === 'link' && d.detail !== undefined);
    expect(linkDetail?.detail).toBe('skipped — install dependencies inside the sandbox');

    expect(ensureBaseImage).toHaveBeenCalledWith({ bin: 'podman' }, { node: '20' });
    expect(stub.calls.create).toHaveLength(1);
    expect(stub.calls.create[0]).toEqual({
      worktreePath: entry!.path,
      slug: sbxSlug,
      image: 'strado-sandbox:node20-v3',
      port: 9111,
      env: { API_URL: 'http://localhost:3000' },
      // null here only because this app's sandbox is a stub: the forwarder is
      // started by buildDeps for a real sandbox service, and sets the path.
      socketPath: null,
      // Mounted into the container at this same absolute path — the hook
      // command written into the worktree's Claude settings names it.
      hooksPath: hooksDir(),
    });
    expect(stub.calls.start).toEqual([sbxSlug]);

    // Sandboxed worktrees hang off ONE bare clone per repo, not the developer's
    // normal checkout, and the path the container mounts is the canonical one.
    const pointer = await fs.readFile(path.join(entry!.path, '.git'), 'utf8');
    expect(pointer).toContain(path.join(home, 'sandbox', 'repos', 'react-app.git'));
    expect(entry!.path).toBe(await fs.realpath(entry!.path));
  });

  it('creates and lists worktrees when the registered repo is the hidden bare store', async () => {
    enable(sandboxStub());

    // Provision the shared bare repository once, then model the runner-native
    // registration shape: repo.path is the hidden backing store itself, with
    // no normal checkout of main beside it.
    const provisioned = await create({
      repoId: 'react-app',
      ticketId: 'FD-BARE-1',
      title: 'provision backing',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });
    expect(provisioned.status).toBe('done');

    const bare = bareRepoPath(sandboxReposDir(home), 'react-app');
    const stores = await app.deps.registry.get('default');
    await stores.repos.patch('react-app', { path: bare });

    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-BARE-2',
      title: 'from hidden backing',
      sourceBranch: 'main',
      // Ignored for sandbox dependency linking; a bare store has no checkout.
      sourceWorktree: bare,
    });
    expect(final.status, JSON.stringify(final)).toBe('done');

    const entry = await metaFor('FD-BARE-2');
    expect(entry).toBeTruthy();
    expect(await fs.readFile(path.join(entry!.path, '.git'), 'utf8')).toContain(bare);

    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const paths = (list.json().worktrees as { path: string }[]).map((w) => w.path);
    expect(paths).toContain(entry!.path);
    expect(paths).not.toContain(bare);
  });

  it('keeps the worktree and the sandbox artifacts when the build fails', async () => {
    enable(sandboxStub({ create: async () => { throw new Error('podman create: no space left'); } }));

    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-3',
      title: 'broken sandbox',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });

    // The job fails on the step that broke, so the dialog names it.
    expect(final.status).toBe('error');
    expect(String((final.error as Error).message)).toContain('no space left');
    expect(stepIds(steps).at(-1)).toBe('sandbox-build');

    // ...but the git worktree is real and usable, just unsandboxed.
    const entry = await metaFor('FD-3');
    expect(entry).toBeTruthy();
    expect((await fs.stat(entry!.path)).isDirectory()).toBe(true);
    expect(entry!.meta.sandbox ?? null).toBeNull();

    // Nothing is torn down: the half-built container and its env file are the
    // only evidence of why it failed.
    expect(stub.calls.remove).toEqual([]);
    expect(stub.calls.stop).toEqual([]);
  });

  it('rejects a sandboxEnv with more than 20 keys', async () => {
    enable(sandboxStub());
    const sandboxEnv = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, 'v']));
    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: {
        repoId: 'react-app',
        ticketId: 'FD-4',
        title: 'too much env',
        sourceBranch: 'main',
        sourceWorktree: repo,
        sandboxEnv,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(stub.calls.create).toEqual([]);
  });

  it('rejects a sandboxEnv key that is not a shell-legal identifier', async () => {
    // The keys land in an --env-file verbatim. Rejecting at the route means a
    // 400 the caller can read, not a job that dies halfway through creation.
    enable(sandboxStub());
    const res = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: {
        repoId: 'react-app',
        ticketId: 'FD-5',
        title: 'bad env key',
        sourceBranch: 'main',
        sourceWorktree: repo,
        sandboxEnv: { 'FOO=BAR': 'x' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(stub.calls.create).toEqual([]);
  });

  it('detects against the project subdir, not the worktree root', async () => {
    enable(sandboxStub());
    await app.inject({
      method: 'POST',
      url: '/api/w/default/repos',
      payload: {
        id: 'sub-app',
        name: 'Sub App',
        path: repo,
        projectSubdir: 'app',
        startCommand: 'true',
        defaultPort: 9400,
        editor: 'code',
      },
    });

    const final = await create({
      repoId: 'sub-app',
      ticketId: 'FD-6',
      title: 'monorepo',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });
    expect(final.status).toBe('done');
    // app/package.json says 22; the worktree root's says 20. Reading the root
    // would build an image the project cannot run on.
    expect(ensureBaseImage).toHaveBeenCalledWith({ bin: 'podman' }, { node: '22' });
  });

  it('removes a leftover container before recreating the same slug', async () => {
    // The retry case: a previous attempt failed after `create`, so the named
    // container still exists and a second `create` would collide on the name.
    const wt = await plannedWorktreePath('react-app', 'FD-7_retry_me');
    enable(sandboxStub({ status: 'stopped', label: wt }));

    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-7',
      title: 'retry me',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });
    expect(final.status).toBe('done');
    const slug = sandboxSlugFor('FD-7_retry_me', wt);
    expect(stub.calls.order).toEqual([`remove:${slug}`, `create:${slug}`, `start:${slug}`]);
  });

  it('refuses to remove a container labelled for a DIFFERENT worktree', async () => {
    // Belt and braces behind the hashed slug: rm -f'ing someone else's running
    // container is unrecoverable, so it happens only against a container we can
    // prove is ours.
    enable(sandboxStub({ status: 'running', label: '/somewhere/else/FD-9_intruder' }));

    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-9',
      title: 'intruder',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });
    expect(final.status).toBe('error');
    const message = String((final.error as Error).message);
    expect(message).toContain('/somewhere/else/FD-9_intruder');
    expect(message).toContain((await metaFor('FD-9'))!.path);
    expect(stub.calls.remove).toEqual([]);
    expect(stub.calls.create).toEqual([]);
  });

  it('gives two repos with the same ticket and title different sandboxes', async () => {
    // buildWorktreeSlug is not repo-scoped. Before the hash, both repos wanted
    // the container name strado-sbx-FD-10_same and the same <slug>.env.
    enable(sandboxStub());
    const other = path.join(tmp, 'other');
    await fs.mkdir(other);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: other });
    await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: other });
    await exec('git', ['config', 'user.name', 'x'], { cwd: other });
    await fs.writeFile(path.join(other, 'package.json'), '{"name":"other"}');
    await fs.mkdir(path.join(other, 'node_modules', 'lodash'), { recursive: true });
    await exec('git', ['add', '.'], { cwd: other });
    await exec('git', ['commit', '-q', '-m', 'i'], { cwd: other });
    await app.inject({
      method: 'POST',
      url: '/api/w/default/repos',
      payload: {
        id: 'other-app',
        name: 'Other App',
        path: other,
        projectSubdir: null,
        startCommand: 'true',
        defaultPort: 9500,
        editor: 'code',
      },
    });

    const payload = { ticketId: 'FD-10', title: 'same', sourceBranch: 'main' };
    expect((await create({ ...payload, repoId: 'react-app', sourceWorktree: repo })).status).toBe('done');
    expect((await create({ ...payload, repoId: 'other-app', sourceWorktree: other })).status).toBe('done');

    const [a, b] = stub.calls.create;
    expect(a!.slug).not.toBe(b!.slug);
    expect(a!.slug.startsWith('FD-10_same-')).toBe(true);
    expect(b!.slug.startsWith('FD-10_same-')).toBe(true);
    expect(a!.slug).toBe(sandboxSlugFor('FD-10_same', a!.worktreePath));
    expect(b!.slug).toBe(sandboxSlugFor('FD-10_same', b!.worktreePath));
    // ...which is what keeps their env files apart too.
    expect(stub.envFilePath(a!.slug)).not.toBe(stub.envFilePath(b!.slug));
  });
});

describe('sandboxed worktrees in the sidebar and on delete', () => {
  let stub: ReturnType<typeof sandboxStub>;
  let sbxSlug: string;

  beforeEach(async () => {
    stub = sandboxStub({ envDir: path.join(tmp, 'envs') });
    await fs.mkdir(path.join(tmp, 'envs'), { recursive: true });
    app.deps.sandboxRuntime = { bin: 'podman' };
    app.deps.sandbox = stub.service as unknown as NonNullable<typeof app.deps.sandbox>;
    const final = await create({
      repoId: 'react-app',
      ticketId: 'FD-8',
      title: 'listed',
      sourceBranch: 'main',
      sourceWorktree: repo,
    });
    expect(final.status).toBe('done');
    sbxSlug = (await metaFor('FD-8'))!.meta.sandbox!.slug;
    // The env file the real service would have written.
    await fs.writeFile(stub.envFilePath(sbxSlug), 'HOST=0.0.0.0\n');
  });

  it('GET /worktrees lists it — it lives in the bare repo, not the clone', async () => {
    const entry = await metaFor('FD-8');
    const res = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().worktrees as { path: string; repoId: string; branch: string; tracked: boolean }[];
    // A row per path, exactly once: the repo's own clone and the bare repo are
    // two `git worktree list` calls that both report the repo root.
    expect(rows.filter((r) => r.path === entry!.path)).toHaveLength(1);
    const row = rows.find((r) => r.path === entry!.path)!;
    expect(row.repoId).toBe('react-app');
    expect(row.branch).toBe('FD-8_listed');
    expect(row.tracked).toBe(true);
    // The bare repo itself is not a worktree and must never show up as a row.
    expect(rows.some((r) => r.path.endsWith('.git'))).toBe(false);
  });

  it('DELETE tears down the container, the env file and the bare-repo worktree', async () => {
    const entry = await metaFor('FD-8');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/w/default/worktrees/${encodeURIComponent(entry!.path)}`,
    });
    expect(res.statusCode).toBe(202);
    const final = await app.deps.jobs.wait(res.json().jobId);
    expect(final.status).toBe('done');

    expect(stub.calls.stop).toEqual([sbxSlug]);
    expect(stub.calls.remove).toEqual([sbxSlug]);
    await expect(fs.stat(stub.envFilePath(sbxSlug))).rejects.toThrow();
    // `git worktree remove` has to run against the BARE repo — the clone has
    // never heard of this worktree.
    await expect(fs.stat(entry!.path)).rejects.toThrow();
    const stores = await app.deps.registry.get('default');
    expect(await stores.state.get(entry!.path)).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    expect((list.json().worktrees as { path: string }[]).some((r) => r.path === entry!.path)).toBe(false);
  });

  it('finds the bare-repo owner when a previous partial delete cleared sandbox metadata', async () => {
    const entry = await metaFor('FD-8');
    const stores = await app.deps.registry.get('default');

    // Container cleanup is intentionally persisted before Git removal. A
    // failed first attempt therefore leaves a real bare-repo worktree whose
    // state no longer says "sandbox". Retrying used to aim at the normal clone
    // and fail with "is not a working tree".
    await stores.state.patch(entry!.path, { sandbox: null });
    app.deps.sandboxSlugs.delete(entry!.path);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/w/default/worktrees/${encodeURIComponent(entry!.path)}?force=1`,
    });
    expect(res.statusCode).toBe(202);
    const final = await app.deps.jobs.wait(res.json().jobId);
    expect(final.status, JSON.stringify(final)).toBe('done');

    await expect(fs.stat(entry!.path)).rejects.toThrow();
    expect(await stores.state.get(entry!.path)).toBeNull();
  });

  it('deletes a bare-repo worktree whose create failed before state was written', async () => {
    const entry = await metaFor('FD-8');
    const stores = await app.deps.registry.get('default');

    // Linking/finalizing used to fail after `git worktree add`, leaving the
    // path registered in the bare repo but absent from state. Deletion may
    // clean up the derived sandbox identity, but must not patch a record that
    // was never written.
    await stores.state.remove(entry!.path);
    app.deps.sandboxSlugs.delete(entry!.path);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/w/default/worktrees/${encodeURIComponent(entry!.path)}?force=1&deleteBranch=1`,
    });
    expect(res.statusCode).toBe(202);
    const final = await app.deps.jobs.wait(res.json().jobId);
    expect(final.status, JSON.stringify(final)).toBe('done');

    await expect(fs.stat(entry!.path)).rejects.toThrow();
    expect(await stores.state.get(entry!.path)).toBeNull();
  });
});
