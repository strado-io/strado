import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { createGitChangesService } from '../../src/services/gitChanges';

let tmp: string;
let repo: string;
const svc = createGitChangesService();

async function git(...args: string[]) {
  return exec('git', args, { cwd: repo });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-'));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await git('config', 'user.email', 'x@y.z');
  await git('config', 'user.name', 'x');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('listWorktreeChanges', () => {
  it('reports a clean tree as empty', async () => {
    expect((await svc.listWorktreeChanges(repo)).files).toEqual([]);
  });

  it('maps modified, staged, partial and untracked states', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');   // modified, unstaged
    await fs.writeFile(path.join(repo, 'b.txt'), 'new\n');               // untracked
    await fs.writeFile(path.join(repo, 'c.txt'), 'staged\n');
    await git('add', 'c.txt');                                           // added, fully staged
    const { files } = await svc.listWorktreeChanges(repo);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({ status: 'M', staged: 'none', untracked: false });
    expect(byPath['b.txt']).toMatchObject({ status: 'U', staged: 'none', untracked: true });
    expect(byPath['c.txt']).toMatchObject({ status: 'A', staged: 'full', untracked: false });

    // partial: stage a.txt then modify again
    await git('add', 'a.txt');
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\nTWO\nthree\n');
    const partial = (await svc.listWorktreeChanges(repo)).files.find((f) => f.path === 'a.txt');
    expect(partial).toMatchObject({ status: 'M', staged: 'partial' });
  });
});

describe('listBranchChanges', () => {
  it('diffs the branch against its merge-base with the default branch', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await fs.writeFile(path.join(repo, 'd.txt'), 'branch file\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'feature work');
    const res = await svc.listBranchChanges(repo);
    expect(res.baseBranch).toBe('main');
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({ status: 'M', additions: 1, deletions: 0 });
    expect(byPath['d.txt']).toMatchObject({ status: 'A', additions: 1 });
  });
});

describe('fileDiff', () => {
  it('returns unstaged, staged and untracked diffs', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    expect((await svc.fileDiff(repo, 'a.txt', 'unstaged')).diff).toContain('-one');
    await git('add', 'a.txt');
    expect((await svc.fileDiff(repo, 'a.txt', 'staged')).diff).toContain('+ONE');
    expect((await svc.fileDiff(repo, 'a.txt', 'unstaged')).diff).toBe('');
    await fs.writeFile(path.join(repo, 'b.txt'), 'new\n');
    expect((await svc.fileDiff(repo, 'b.txt', 'unstaged')).diff).toContain('+new');
  });

  it('returns the branch diff for one file', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'w');
    expect((await svc.fileDiff(repo, 'a.txt', 'branch')).diff).toContain('+four');
  });

  it('rejects path escapes', async () => {
    await expect(svc.fileDiff(repo, '../x', 'unstaged')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.fileDiff(repo, '/etc/passwd', 'unstaged')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('stage/unstage file', () => {
  it('round-trips a file through the index', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    await svc.stageFile(repo, 'a.txt');
    expect((await svc.listWorktreeChanges(repo)).files[0]).toMatchObject({ staged: 'full' });
    await svc.unstageFile(repo, 'a.txt');
    expect((await svc.listWorktreeChanges(repo)).files[0]).toMatchObject({ staged: 'none' });
  });
});

describe('discardFile', () => {
  it('reverts working-tree edits on a tracked file, preserving staged content', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    await git('add', 'a.txt');                                      // ONE staged
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\nTWO\nthree\n'); // TWO unstaged on top
    await svc.discardFile(repo, 'a.txt');
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree\n'); // index copy
    expect((await svc.fileDiff(repo, 'a.txt', 'staged')).diff).toContain('+ONE'); // staged survives
  });

  it('deletes an untracked file', async () => {
    await fs.writeFile(path.join(repo, 'b.txt'), 'new\n');
    await svc.discardFile(repo, 'b.txt');
    await expect(fs.access(path.join(repo, 'b.txt'))).rejects.toThrow();
    expect((await svc.listWorktreeChanges(repo)).files).toEqual([]);
  });

  it('rejects path escapes', async () => {
    await expect(svc.discardFile(repo, '../x')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('discardHunk', () => {
  it('reverse-applies a hunk to the working tree without touching the index', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    const { diff } = await svc.fileDiff(repo, 'a.txt', 'unstaged');
    await svc.discardHunk(repo, diff);
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect((await svc.fileDiff(repo, 'a.txt', 'staged')).diff).toBe('');
  });

  it('rejects a stale patch with VALIDATION', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    const { diff } = await svc.fileDiff(repo, 'a.txt', 'unstaged');
    await svc.discardHunk(repo, diff);
    await expect(svc.discardHunk(repo, diff)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('applyHunk', () => {
  it('stages and unstages a single hunk', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    const { diff } = await svc.fileDiff(repo, 'a.txt', 'unstaged');
    await svc.applyHunk(repo, diff, false);
    expect((await svc.fileDiff(repo, 'a.txt', 'staged')).diff).toContain('+ONE');
    await svc.applyHunk(repo, diff, true);
    expect((await svc.fileDiff(repo, 'a.txt', 'staged')).diff).toBe('');
  });

  it('rejects a stale patch with VALIDATION', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    const { diff } = await svc.fileDiff(repo, 'a.txt', 'unstaged');
    await svc.applyHunk(repo, diff, false);
    await expect(svc.applyHunk(repo, diff, false)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('mergeRequestUrl', () => {
  it('builds a GitLab MR url from an ssh remote', async () => {
    await git('remote', 'add', 'origin', 'git@gitlab.example.com:acmedev/acme-app.git');
    await git('checkout', '-q', '-b', 'FD-1_feature');
    const { url, sourceBranch } = await svc.mergeRequestUrl(repo, 'master');
    expect(sourceBranch).toBe('FD-1_feature');
    expect(url).toBe(
      'https://gitlab.example.com/acmedev/acme-app/-/merge_requests/new?merge_request%5Bsource_branch%5D=FD-1_feature&merge_request%5Btarget_branch%5D=master',
    );
  });

  it('builds a GitHub compare url', async () => {
    await git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    const { url } = await svc.mergeRequestUrl(repo, 'main');
    expect(url).toBe('https://github.com/acme/widgets/compare/main...main?expand=1');
  });

  it('rejects bad targets', async () => {
    await git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    await expect(svc.mergeRequestUrl(repo, '--evil')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('remotes / push / pull', () => {
  it('lists remotes, pushes HEAD, and pulls', async () => {
    const bare = path.join(tmp, 'origin.git');
    await exec('git', ['init', '-q', '--bare', bare]);
    await git('remote', 'add', 'origin', bare);
    expect((await svc.listRemotes(repo)).remotes).toEqual(['origin']);

    await fs.writeFile(path.join(repo, 'p.txt'), 'push me\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'to push');
    const pushed = await svc.push(repo, 'origin');
    expect(typeof pushed.output).toBe('string');
    const remoteLog = await exec('git', ['log', '--oneline', 'main'], { cwd: bare });
    expect(remoteLog.stdout).toContain('to push');

    const pulled = await svc.pull(repo, 'origin/main');
    expect(typeof pulled.output).toBe('string');
  });

  it('rejects unknown or option-shaped remotes', async () => {
    await expect(svc.push(repo, 'nope')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.pull(repo, '--force')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.pull(repo, 'no-such-branch')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('shortStat', () => {
  it('reports zero on a clean tree and counts staged+unstaged lines', async () => {
    expect(await svc.shortStat(repo)).toEqual({ additions: 0, deletions: 0, files: 0 });
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\n');
    await git('add', 'a.txt');
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n');
    const stats = await svc.shortStat(repo);
    expect(stats).toEqual({ additions: 3, deletions: 1, files: 1 });
  });

  it('returns null for a non-repo directory', async () => {
    expect(await svc.shortStat(tmp)).toBeNull();
  });
});

describe('log / commit details', () => {
  async function commitFile(name: string, content: string, msg: string) {
    await fs.writeFile(path.join(repo, name), content);
    await git('add', '.');
    await git('commit', '-q', '-m', msg);
  }

  it('log returns commits newest-first with hash, parents, refs and head', async () => {
    await commitFile('b.txt', 'b\n', 'second');
    const { head, commits } = await svc.log(repo, 100);
    expect(commits.length).toBe(2);
    expect(commits[0]!.subject).toBe('second');
    expect(commits[1]!.subject).toBe('init');
    expect(commits[0]!.parents).toEqual([commits[1]!.hash]);
    expect(commits[1]!.parents).toEqual([]);
    expect(head).toBe(commits[0]!.hash);
    expect(commits[0]!.refs).toContain('main');
    expect(commits[0]!.author).toBe('x');
    expect(commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('log spans all local branches and honors the limit', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await commitFile('f.txt', 'f\n', 'feature work');
    await git('checkout', '-q', 'main');
    const all = await svc.log(repo, 100);
    expect(all.commits.map((c) => c.subject)).toEqual(
      expect.arrayContaining(['feature work', 'init']),
    );
    expect((await svc.log(repo, 1)).commits.length).toBe(1);
  });

  it('log includes a merge commit with two parents', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await commitFile('f.txt', 'f\n', 'feature work');
    await git('checkout', '-q', 'main');
    await commitFile('m.txt', 'm\n', 'main work');
    await git('merge', '--no-ff', '-q', '-m', 'merge feature', 'feature');
    const { commits } = await svc.log(repo, 100);
    expect(commits[0]!.subject).toBe('merge feature');
    expect(commits[0]!.parents.length).toBe(2);
  });

  it('log with a query searches history by message, hash prefix and author', async () => {
    await commitFile('b.txt', 'b\n', 'fix: widget alpha');
    await commitFile('c.txt', 'c\n', 'feat: gadget beta');

    const byMsg = await svc.log(repo, 100, 'widget');
    expect(byMsg.commits.map((c) => c.subject)).toEqual(['fix: widget alpha']);

    const full = await svc.log(repo, 100);
    const target = full.commits[1]!;
    const byHash = await svc.log(repo, 100, target.hash.slice(0, 7));
    expect(byHash.commits[0]!.hash).toBe(target.hash);

    const byAuthor = await svc.log(repo, 100, 'x');
    expect(byAuthor.commits.length).toBe(3);

    expect((await svc.log(repo, 100, 'no-such-thing')).commits).toEqual([]);
  });

  it('log query treats regex metacharacters as literal text', async () => {
    await commitFile('b.txt', 'b\n', 'fix: handle a.*b pattern');
    const res = await svc.log(repo, 100, 'a.*b');
    expect(res.commits.map((c) => c.subject)).toEqual(['fix: handle a.*b pattern']);
  });

  it('commitInfo returns message, author and changed files', async () => {
    await commitFile('b.txt', 'b\n', 'add b');
    const { commits } = await svc.log(repo, 1);
    const info = await svc.commitInfo(repo, commits[0]!.hash);
    expect(info.message).toContain('add b');
    expect(info.author).toBe('x');
    expect(info.files).toEqual([expect.objectContaining({ path: 'b.txt', status: 'A' })]);
  });

  it('commitInfo works for the root commit', async () => {
    const { commits } = await svc.log(repo, 100);
    const root = commits[commits.length - 1]!;
    const info = await svc.commitInfo(repo, root.hash);
    expect(info.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'A' })]);
  });

  it('commitInfo diffs a merge commit against its first parent', async () => {
    await git('checkout', '-q', '-b', 'feature');
    await commitFile('f.txt', 'f\n', 'feature work');
    await git('checkout', '-q', 'main');
    await commitFile('m.txt', 'm\n', 'main work');
    await git('merge', '--no-ff', '-q', '-m', 'merge feature', 'feature');
    const { commits } = await svc.log(repo, 1);
    const info = await svc.commitInfo(repo, commits[0]!.hash);
    // vs first parent (main): the merge brings in f.txt only
    expect(info.files).toEqual([expect.objectContaining({ path: 'f.txt', status: 'A' })]);
  });

  it('commitFileDiff returns the file patch for a commit and its root commit', async () => {
    await commitFile('a.txt', 'one\ntwo\nthree\nfour\n', 'append four');
    const { commits } = await svc.log(repo, 100);
    const diff = await svc.commitFileDiff(repo, commits[0]!.hash, 'a.txt');
    expect(diff.diff).toContain('+four');
    const rootDiff = await svc.commitFileDiff(repo, commits[commits.length - 1]!.hash, 'a.txt');
    expect(rootDiff.diff).toContain('+one');
  });
});

describe('bulk stage / unstage / discard', () => {
  it('stageAll stages every change including untracked files', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
    await svc.stageAll(repo);
    const { files } = await svc.listWorktreeChanges(repo);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.staged === 'full')).toBe(true);
  });

  it('unstageAll moves everything out of the index', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
    await git('add', '.');
    await svc.unstageAll(repo);
    const { files } = await svc.listWorktreeChanges(repo);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.staged === 'none')).toBe(true);
  });

  it('discardAll drops unstaged edits and untracked files but staged copies survive', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'STAGED\n');
    await git('add', 'a.txt');
    await fs.writeFile(path.join(repo, 'a.txt'), 'STAGED\nplus unstaged\n');
    await fs.writeFile(path.join(repo, 'junk.txt'), 'junk\n');
    await fs.mkdir(path.join(repo, 'junkdir'));
    await fs.writeFile(path.join(repo, 'junkdir', 'inner.txt'), 'junk\n');

    await svc.discardAll(repo);

    const { files } = await svc.listWorktreeChanges(repo);
    expect(files).toEqual([expect.objectContaining({ path: 'a.txt', staged: 'full' })]);
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('STAGED\n');
    await expect(fs.access(path.join(repo, 'junk.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(repo, 'junkdir'))).rejects.toThrow();
  });

  it('discardAll on a clean tree is a no-op', async () => {
    await svc.discardAll(repo);
    expect((await svc.listWorktreeChanges(repo)).files).toEqual([]);
  });
});

describe('listBranches / base override', () => {
  it('lists local branches', async () => {
    await git('checkout', '-q', '-b', 'feature');
    const { branches } = await svc.listBranches(repo);
    expect(branches).toEqual(expect.arrayContaining(['main', 'feature']));
  });

  it('reports the currently checked-out branch, live', async () => {
    expect((await svc.listBranches(repo)).current).toBe('main');
    await git('checkout', '-q', '-b', 'feature');
    expect((await svc.listBranches(repo)).current).toBe('feature');
  });

  it('reports current: null on a detached HEAD', async () => {
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', '--detach', head);
    expect((await svc.listBranches(repo)).current).toBeNull();
  });

  it('compares against an explicit base ref', async () => {
    await git('checkout', '-q', '-b', 'other-base');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'base work');
    await git('checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repo, 'feat.txt'), 'feat\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'feature work');

    const vsMain = await svc.listBranchChanges(repo, 'main');
    expect(vsMain.baseBranch).toBe('main');
    expect(vsMain.files.map((f) => f.path)).toEqual(['base.txt', 'feat.txt']);

    const vsOther = await svc.listBranchChanges(repo, 'other-base');
    expect(vsOther.files.map((f) => f.path)).toEqual(['feat.txt']);

    const fileVs = await svc.fileDiff(repo, 'feat.txt', 'branch', 'other-base');
    expect(fileVs.diff).toContain('+feat');
  });

  it('rejects invalid or unresolvable base refs', async () => {
    await expect(svc.listBranchChanges(repo, '--evil')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.listBranchChanges(repo, 'no such ref')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.listBranchChanges(repo, 'does-not-exist')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('commit', () => {
  it('commits staged content only and returns the new head', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\n');
    await fs.writeFile(path.join(repo, 'b.txt'), 'not staged\n');
    await svc.stageFile(repo, 'a.txt');
    const res = await svc.commit(repo, 'change a');
    expect(res.summary).toContain('change a');
    expect(res.head).toMatch(/^[0-9a-f]{7,40}$/);
    const { files } = await svc.listWorktreeChanges(repo);
    expect(files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('rejects empty message and empty index', async () => {
    await expect(svc.commit(repo, '  ')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.commit(repo, 'msg')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
