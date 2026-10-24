import { describe, it, expect } from 'vitest';
import type { ExecFn } from '../sandbox/runtime.js';
import { listContainers, parseSize, type ContainerDeps } from './containers.js';

// Captured from runner-test (podman 4.9.3), trimmed to the fields we read.
const PODMAN_PS = JSON.stringify([
  {
    Names: ['strado-sbx-e2e_ssh_e2e-55080622'],
    State: 'running',
    Image: 'localhost/strado-sandbox:base-v4',
    Created: 1792829980,
    StartedAt: 1792830122,
    Labels: { 'io.buildah.version': '1.33.7', 'io.strado.worktree': '/home/strado/.strado/worktrees/hello-world/e2e_ssh_e2e' },
  },
  {
    Names: ['strado-sbx-testset-cd5739c0'],
    State: 'exited',
    Image: 'localhost/strado-sandbox:base-v4',
    Created: 1792835649,
    StartedAt: 1792835649,
    Labels: { 'io.strado.worktree': '/home/strado/.strado/worktrees/strado-website/testset' },
  },
  { Names: ['strado-sbx-stranger'], State: 'created', Image: 'alpine', Created: 1792830000, StartedAt: 0, Labels: null },
  { Names: ['not-ours'], State: 'running', Image: 'x', Created: 1, StartedAt: 1, Labels: {} },
]);
const PODMAN_STATS = JSON.stringify([
  { name: 'strado-sbx-e2e_ssh_e2e-55080622', cpu_percent: '0.67%', mem_usage: '86.61MB / 6.213GB' },
]);

function fake(replies: Record<string, { code: number; stdout: string }>) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_f, args) => {
    calls.push(args);
    const r = replies[args[0]!] ?? { code: 1, stdout: '' };
    return { ...r, stderr: '' };
  };
  return { calls, exec };
}

const describeWt = async (p: string) =>
  p.endsWith('e2e_ssh_e2e') ? { repoName: 'hello-world', worktreeName: 'E2E ssh' } : null;

const deps = (exec: ExecFn, over: Partial<ContainerDeps> = {}): ContainerDeps => ({
  rt: { bin: 'podman' },
  exec,
  describe: describeWt,
  changedAt: async () => ({}),
  ...over,
});

describe('listContainers (podman)', () => {
  it('lists every strado-sbx container with one stats sample, never env', async () => {
    const { calls, exec } = fake({ ps: { code: 0, stdout: PODMAN_PS }, stats: { code: 0, stdout: PODMAN_STATS } });
    const rows = await listContainers(deps(exec));
    expect(calls[0]).toEqual(['ps', '-a', '--filter', 'name=^strado-sbx-', '--format', 'json']);
    expect(calls[1]).toEqual(['stats', '--no-stream', '--format', 'json']);
    expect(calls.some((c) => c[0] === 'inspect')).toBe(false);
    expect(rows).toEqual([
      {
        slug: 'e2e_ssh_e2e-55080622',
        worktreePath: '/home/strado/.strado/worktrees/hello-world/e2e_ssh_e2e',
        repoName: 'hello-world',
        worktreeName: 'E2E ssh',
        status: 'running',
        image: 'localhost/strado-sandbox:base-v4',
        createdAt: 1792829980_000,
        startedAt: 1792830122_000,
        cpuPercent: 0.67,
        memBytes: 86_610_000,
        memLimitBytes: 6_213_000_000,
        staleLogins: [],
      },
      {
        slug: 'testset-cd5739c0',
        worktreePath: '/home/strado/.strado/worktrees/strado-website/testset',
        repoName: null,
        worktreeName: null,
        status: 'stopped',
        image: 'localhost/strado-sandbox:base-v4',
        createdAt: 1792835649_000,
        startedAt: null,
        cpuPercent: null,
        memBytes: null,
        memLimitBytes: null,
        staleLogins: [],
      },
      expect.objectContaining({ slug: 'stranger', worktreePath: null, status: 'creating', startedAt: null }),
    ]);
  });

  it('a container made before Claude changed is stale; volume logins never are', async () => {
    const { exec } = fake({ ps: { code: 0, stdout: PODMAN_PS }, stats: { code: 0, stdout: '[]' } });
    const rows = await listContainers(
      deps(exec, { changedAt: async () => ({ claude: 1792830000_000, codex: 1792999999_000, pi: 1792999999_000 }) }),
    );
    expect(rows.map((r) => [r.slug, r.staleLogins])).toEqual([
      ['e2e_ssh_e2e-55080622', ['claude']],
      ['testset-cd5739c0', []],
      ['stranger', []],
    ]);
  });

  it('stats failing leaves usage null; ps failing is an empty list', async () => {
    const a = fake({ ps: { code: 0, stdout: PODMAN_PS }, stats: { code: 125, stdout: '' } });
    expect((await listContainers(deps(a.exec)))[0]!.cpuPercent).toBeNull();
    const b = fake({ ps: { code: 125, stdout: '' } });
    expect(await listContainers(deps(b.exec))).toEqual([]);
  });
});

describe('listContainers (docker)', () => {
  it('reads the tab-separated template and docker stats lines', async () => {
    const ps = [
      'strado-sbx-a-1\trunning\tstrado-sandbox:node\t2026-10-24 08:19:40 +0000 UTC\t/w/a',
      'strado-sbx-b-2\texited\tstrado-sandbox:node\t2026-10-24 09:00:00 +0000 UTC\t',
    ].join('\n');
    const stats = JSON.stringify({ Name: 'strado-sbx-a-1', CPUPerc: '12.50%', MemUsage: '12.5MiB / 7.5GiB' });
    const { calls, exec } = fake({ ps: { code: 0, stdout: ps }, stats: { code: 0, stdout: stats } });
    const rows = await listContainers(deps(exec, { rt: { bin: 'docker' }, describe: async () => null }));
    expect(calls[0]!.slice(0, 4)).toEqual(['ps', '-a', '--filter', 'name=^strado-sbx-']);
    expect(rows).toEqual([
      expect.objectContaining({
        slug: 'a-1',
        worktreePath: '/w/a',
        status: 'running',
        createdAt: Date.UTC(2026, 9, 24, 8, 19, 40),
        startedAt: null,
        cpuPercent: 12.5,
        memBytes: 12.5 * 1024 ** 2,
        memLimitBytes: 7.5 * 1024 ** 3,
      }),
      expect.objectContaining({ slug: 'b-2', worktreePath: null, status: 'stopped' }),
    ]);
  });
});

describe('parseSize', () => {
  it.each([
    ['98.3kB', 98_300],
    ['86.61MB', 86_610_000],
    ['6.213GB', 6_213_000_000],
    ['12.5MiB', 12.5 * 1024 ** 2],
    ['1KiB', 1024],
    ['0B', 0],
    ['--', null],
  ])('%s', (s, n) => {
    expect(parseSize(s)).toBe(n);
  });
});
