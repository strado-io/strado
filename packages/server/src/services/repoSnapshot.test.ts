import { describe, expect, it } from 'vitest';
import { repoSnapshot, type ExecFn } from './repoSnapshot.js';

function fakeExec(byArgs: Record<string, { stdout: string; stderr?: string; code?: number }>): ExecFn {
  return async (command: string, args: string[]) => {
    const key = args.join(' ');
    const found = byArgs[key];
    if (!found) throw new Error(`unexpected git ${key}`);
    return { stdout: found.stdout, stderr: found.stderr ?? '', code: found.code ?? 0 };
  };
}

describe('repoSnapshot', () => {
  it('parses head, branch, status and combined diff stat from canned stdout', async () => {
    const exec = fakeExec({
      'rev-parse HEAD': { stdout: 'abc123\n' },
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --short': { stdout: ' M src/foo.ts\n?? bar.ts\n' },
      'diff --stat': { stdout: ' 1 file changed, 2 insertions(+)\n' },
      'diff --cached --stat': { stdout: '' },
    });
    const snap = await repoSnapshot('/repo/a', exec);
    expect(snap.worktreePath).toBe('/repo/a');
    expect(snap.head).toBe('abc123');
    expect(snap.branch).toBe('main');
    expect(snap.status).toEqual([' M src/foo.ts', '?? bar.ts']);
    expect(snap.diffStat).toContain('1 file changed, 2 insertions(+)');
    expect(snap.error).toBeUndefined();
  });

  it('treats a detached HEAD (branch name "HEAD") as null', async () => {
    const exec = fakeExec({
      'rev-parse HEAD': { stdout: 'deadbeef' },
      'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD' },
      'status --short': { stdout: '' },
      'diff --stat': { stdout: '' },
      'diff --cached --stat': { stdout: '' },
    });
    const snap = await repoSnapshot('/repo/a', exec);
    expect(snap.branch).toBeNull();
    expect(snap.status).toEqual([]);
    expect(snap.diffStat).toBe('');
  });

  it('returns an error shape when exec throws', async () => {
    const exec: ExecFn = async () => {
      throw new Error('not a git repository');
    };
    const snap = await repoSnapshot('/repo/a', exec);
    expect(snap.worktreePath).toBe('/repo/a');
    expect(snap.branch).toBeNull();
    expect(snap.head).toBe('');
    expect(snap.status).toEqual([]);
    expect(snap.diffStat).toBe('');
    expect(snap.error).toContain('not a git repository');
  });

  it('returns an error shape when the exec budget is exceeded', async () => {
    const exec: ExecFn = () => new Promise(() => {}); // never resolves
    const snap = await repoSnapshot('/repo/a', exec, 20);
    expect(snap.error).toBeTruthy();
    expect(snap.head).toBe('');
  });
});
