import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-groups-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await fs.mkdir(path.join(tmp, 'home', 'worktrees', 'react-app'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'home') });
  app = await buildApp(deps);
  await app.inject({
    method: 'POST',
    url: '/api/w/default/repos',
    payload: { id: 'react-app', name: 'React App', path: repo, projectSubdir: null, startCommand: 'true', defaultPort: 9100, editor: 'code' },
  });
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const url = '/api/w/default/groups';

describe('focus group routes', () => {
  it('creates, lists, patches and deletes a group', async () => {
    const created = await app.inject({ method: 'POST', url, payload: { name: 'FX-412', members: ['local:/a'] } });
    expect(created.statusCode).toBe(200);
    const id = created.json().group.id as string;

    const patched = await app.inject({
      method: 'PATCH', url: `${url}/${id}`,
      payload: { name: 'checkout', addMembers: ['remote:r1:/x'], removeMembers: ['local:/a'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().group).toMatchObject({ name: 'checkout', members: ['remote:r1:/x'] });

    const list = await app.inject({ method: 'GET', url });
    expect(list.json().groups).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `${url}/${id}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url })).json().groups).toEqual([]);
  });

  it('400s on a blank name and 404s on an unknown id', async () => {
    expect((await app.inject({ method: 'POST', url, payload: { name: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `${url}/nope`, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${url}/nope` })).statusCode).toBe(404);
  });

  it('drops a deleted worktree from every group', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: { repoId: 'react-app', ticketId: 'FD-9', title: 'grouped', sourceBranch: 'main', sourceWorktree: repo },
    });
    await app.deps.jobs.wait(create.json().jobId);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const target = list.json().worktrees.find((w: any) => w.meta?.ticketId === 'FD-9').path as string;

    await app.inject({ method: 'POST', url, payload: { name: 'g', members: [`local:${target}`, 'local:/other'] } });

    const del = await app.inject({ method: 'DELETE', url: `/api/w/default/worktrees/${encodeURIComponent(target)}` });
    const final = await app.deps.jobs.wait(del.json().jobId);
    expect(final.status).toBe('done');

    const groups = (await app.inject({ method: 'GET', url })).json().groups;
    expect(groups[0].members).toEqual(['local:/other']);
  });

  it('still deletes a worktree cleanly when groups.json is corrupt', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/w/default/worktrees',
      payload: { repoId: 'react-app', ticketId: 'FD-10', title: 'corrupt groups', sourceBranch: 'main', sourceWorktree: repo },
    });
    await app.deps.jobs.wait(create.json().jobId);
    const list = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    const target = list.json().worktrees.find((w: any) => w.meta?.ticketId === 'FD-10').path as string;

    await fs.writeFile(path.join(tmp, 'config', 'workspaces', 'default', 'groups.json'), '{not json');

    const del = await app.inject({ method: 'DELETE', url: `/api/w/default/worktrees/${encodeURIComponent(target)}` });
    const final = await app.deps.jobs.wait(del.json().jobId);
    expect(final.status, JSON.stringify(final)).toBe('done');
    const after = await app.inject({ method: 'GET', url: '/api/w/default/worktrees' });
    expect(after.json().worktrees.map((w: any) => w.path)).not.toContain(target);
  });

  it('parks and unparks a group, and rejects any other state', async () => {
    const created = await app.inject({ method: 'POST', url, payload: { name: 'FX-9' } });
    const id = created.json().group.id as string;
    expect(created.json().group.state).toBeUndefined();

    const parked = await app.inject({ method: 'PATCH', url: `${url}/${id}`, payload: { state: 'parked' } });
    expect(parked.json().group.state).toBe('parked');
    const working = await app.inject({ method: 'PATCH', url: `${url}/${id}`, payload: { state: 'working' } });
    expect(working.json().group.state).toBe('working');

    const bad = await app.inject({ method: 'PATCH', url: `${url}/${id}`, payload: { state: 'done' } });
    expect(bad.statusCode).toBe(400);
  });
});
