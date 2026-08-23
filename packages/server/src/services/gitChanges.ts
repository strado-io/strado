import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../shell.js';
import { AppError } from '../errors.js';
import { resolveSshAlias } from './gitProviders.js';

export type ChangedFile = {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  staged: 'none' | 'partial' | 'full';
  untracked: boolean;
  renamedFrom?: string;
};

export type BranchFile = {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  renamedFrom?: string;
};

export type DiffStats = { additions: number; deletions: number; files: number };

export type LogCommit = {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
};

export type CommitFile = {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  renamedFrom?: string;
};

export type CommitInfo = {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: CommitFile[];
};

export type GitChangesService = {
  listWorktreeChanges(worktreePath: string): Promise<{ files: ChangedFile[] }>;
  shortStat(worktreePath: string): Promise<DiffStats | null>;
  listBranches(worktreePath: string): Promise<{ branches: string[]; current: string | null }>;
  listBranchChanges(worktreePath: string, base?: string): Promise<{ base: string; baseBranch: string; files: BranchFile[] }>;
  fileDiff(worktreePath: string, file: string, scope: 'unstaged' | 'staged' | 'branch', base?: string): Promise<{ diff: string }>;
  stageFile(worktreePath: string, file: string): Promise<void>;
  unstageFile(worktreePath: string, file: string): Promise<void>;
  stageAll(worktreePath: string): Promise<void>;
  unstageAll(worktreePath: string): Promise<void>;
  discardAll(worktreePath: string): Promise<void>;
  discardFile(worktreePath: string, file: string): Promise<void>;
  applyHunk(worktreePath: string, patch: string, reverse: boolean): Promise<void>;
  discardHunk(worktreePath: string, patch: string): Promise<void>;
  commit(worktreePath: string, message: string): Promise<{ head: string; summary: string }>;
  log(worktreePath: string, limit: number, query?: string): Promise<{ head: string | null; commits: LogCommit[] }>;
  commitInfo(worktreePath: string, hash: string): Promise<CommitInfo>;
  commitFileDiff(worktreePath: string, hash: string, file: string): Promise<{ diff: string }>;
  listRemotes(worktreePath: string): Promise<{ remotes: string[] }>;
  mergeRequestUrl(worktreePath: string, target: string): Promise<{ url: string; sourceBranch: string }>;
  push(worktreePath: string, remote: string): Promise<{ output: string }>;
  pull(worktreePath: string, source: string): Promise<{ output: string }>;
};

function assertRelativeFile(file: string): void {
  if (!file || file.startsWith('/') || file.split('/').includes('..')) {
    throw new AppError('VALIDATION', `invalid file path: ${file}`);
  }
}

function statusLetter(x: string): ChangedFile['status'] {
  if (x === 'A' || x === 'M' || x === 'D' || x === 'R') return x;
  return 'M';
}

function assertCommitHash(hash: string): void {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    throw new AppError('VALIDATION', `invalid commit hash: ${hash}`);
  }
}

// `--name-status -z` tokens: status, path (renames/copies carry two paths).
function parseNameStatusZ(out: string): CommitFile[] {
  const parts = out.split('\0').filter((s) => s.length > 0);
  const files: CommitFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i++]!;
    if (st.startsWith('R') || st.startsWith('C')) {
      const from = parts[i++]!;
      const to = parts[i++]!;
      files.push({ path: to, status: 'R', renamedFrom: from });
    } else {
      const p = parts[i++]!;
      files.push({ path: p, status: statusLetter(st[0]!) as CommitFile['status'] });
    }
  }
  return files;
}

async function refResolves(cwd: string, ref: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

// A base ref chosen by the user must be a plausible ref name (no option
// injection, no whitespace) AND resolve to a commit in this repo.
async function assertBaseRef(cwd: string, ref: string): Promise<void> {
  if (!ref || ref.startsWith('-') || /[\s~^:?*[\\]/.test(ref)) {
    throw new AppError('VALIDATION', `invalid base ref: ${ref}`);
  }
  if (!(await refResolves(cwd, ref))) {
    throw new AppError('VALIDATION', `base ref does not resolve: ${ref}`);
  }
}

// Remotes come from `git remote` output only — a name outside that list
// (or option-shaped) never reaches a git argv.
async function assertRemote(cwd: string, remote: string): Promise<void> {
  if (!remote || remote.startsWith('-')) throw new AppError('VALIDATION', `invalid remote: ${remote}`);
  const res = await exec('git', ['remote'], { cwd });
  const remotes = res.stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  if (!remotes.includes(remote)) throw new AppError('VALIDATION', `unknown remote: ${remote}`);
}

async function detectBaseBranch(cwd: string): Promise<string> {
  try {
    const head = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    const name = head.stdout.trim().replace(/^origin\//, '');
    // origin/HEAD names the default branch, but only a resolvable ref is
    // usable: prefer the local branch, fall back to the remote-tracking one.
    if (name) {
      if (await refResolves(cwd, name)) return name;
      if (await refResolves(cwd, `origin/${name}`)) return `origin/${name}`;
    }
  } catch { /* no origin HEAD */ }
  for (const candidate of ['master', 'main']) {
    if (await refResolves(cwd, candidate)) return candidate;
  }
  throw new AppError('NOT_FOUND', 'no base branch (origin/HEAD, master, main) found');
}

export function createGitChangesService(): GitChangesService {
  return {
    async listWorktreeChanges(worktreePath) {
      const res = await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: worktreePath });
      const entries = res.stdout.split('\0').filter(Boolean);
      const files: ChangedFile[] = [];
      // -z format: "XY path" entries; for renames the NEXT entry is the old path.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const x = entry[0]!;
        const y = entry[1]!;
        const p = entry.slice(3);
        if (x === '?' && y === '?') {
          files.push({ path: p, status: 'U', staged: 'none', untracked: true });
          continue;
        }
        let renamedFrom: string | undefined;
        if (x === 'R' || y === 'R') {
          renamedFrom = entries[i + 1];
          i++;
        }
        const stagedLetter = x !== ' ' && x !== '?';
        const unstagedLetter = y !== ' ' && y !== '?';
        const staged: ChangedFile['staged'] =
          stagedLetter && unstagedLetter ? 'partial' : stagedLetter ? 'full' : 'none';
        const letter = stagedLetter ? x : y;
        files.push({ path: p, status: statusLetter(letter), staged, untracked: false, ...(renamedFrom ? { renamedFrom } : {}) });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { files };
    },

    async shortStat(worktreePath) {
      // Staged + unstaged vs HEAD in one call. Untracked files aren't counted
      // (matches git's own shortstat semantics). Null on unborn HEAD etc.
      try {
        const res = await exec('git', ['diff', '--shortstat', 'HEAD'], { cwd: worktreePath });
        const s = res.stdout.trim();
        if (!s) return { additions: 0, deletions: 0, files: 0 };
        const files = Number(/(\d+) files? changed/.exec(s)?.[1] ?? 0);
        const additions = Number(/(\d+) insertions?\(\+\)/.exec(s)?.[1] ?? 0);
        const deletions = Number(/(\d+) deletions?\(-\)/.exec(s)?.[1] ?? 0);
        return { additions, deletions, files };
      } catch {
        return null;
      }
    },

    async listBranches(worktreePath) {
      const [res, cur] = await Promise.all([
        exec(
          'git',
          ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
          { cwd: worktreePath },
        ),
        exec('git', ['branch', '--show-current'], { cwd: worktreePath }),
      ]);
      const branches = res.stdout
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b && b !== 'origin/HEAD' && !b.endsWith('/HEAD'));
      // Empty on a detached HEAD.
      return { branches, current: cur.stdout.trim() || null };
    },

    async listBranchChanges(worktreePath, requestedBase) {
      let baseBranch: string;
      if (requestedBase) {
        await assertBaseRef(worktreePath, requestedBase);
        baseBranch = requestedBase;
      } else {
        baseBranch = await detectBaseBranch(worktreePath);
      }
      const baseRes = await exec('git', ['merge-base', 'HEAD', baseBranch], { cwd: worktreePath });
      const base = baseRes.stdout.trim();
      const nameStatus = await exec('git', ['diff', '--name-status', '-z', `${base}...HEAD`], { cwd: worktreePath });
      const numstat = await exec('git', ['diff', '--numstat', '-z', `${base}...HEAD`], { cwd: worktreePath });

      const counts = new Map<string, { additions: number; deletions: number }>();
      const numParts = numstat.stdout.split('\0').filter(Boolean);
      // numstat -z: "adds\tdels\tpath" (renames: "adds\tdels\t" then old, then new)
      for (let i = 0; i < numParts.length; i++) {
        const part = numParts[i]!;
        const [a, d, p] = part.split('\t');
        if (p === '' || p === undefined) {
          const newPath = numParts[i + 2];
          if (newPath) counts.set(newPath, { additions: Number(a) || 0, deletions: Number(d) || 0 });
          i += 2;
        } else {
          counts.set(p, { additions: Number(a) || 0, deletions: Number(d) || 0 });
        }
      }

      const files: BranchFile[] = [];
      const parts = nameStatus.stdout.split('\0').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const status = parts[i]![0]!;
        if (status === 'R' || status === 'C') {
          const from = parts[i + 1]!;
          const to = parts[i + 2]!;
          i += 2;
          const c = counts.get(to) ?? { additions: 0, deletions: 0 };
          files.push({ path: to, status: 'R', renamedFrom: from, ...c });
        } else {
          const p = parts[i + 1]!;
          i += 1;
          const c = counts.get(p) ?? { additions: 0, deletions: 0 };
          files.push({ path: p, status: status === 'A' ? 'A' : status === 'D' ? 'D' : 'M', ...c });
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { base, baseBranch, files };
    },

    async fileDiff(worktreePath, file, scope, baseOverride) {
      assertRelativeFile(file);
      if (scope === 'branch') {
        let baseBranch: string;
        if (baseOverride) {
          await assertBaseRef(worktreePath, baseOverride);
          baseBranch = baseOverride;
        } else {
          baseBranch = await detectBaseBranch(worktreePath);
        }
        const base = (await exec('git', ['merge-base', 'HEAD', baseBranch], { cwd: worktreePath })).stdout.trim();
        const res = await exec('git', ['diff', `${base}...HEAD`, '--', file], { cwd: worktreePath });
        return { diff: res.stdout };
      }
      if (scope === 'staged') {
        const res = await exec('git', ['diff', '--cached', '--', file], { cwd: worktreePath });
        return { diff: res.stdout };
      }
      // unstaged — untracked files need --no-index against /dev/null
      const tracked = await exec('git', ['ls-files', '--error-unmatch', '--', file], { cwd: worktreePath })
        .then(() => true)
        .catch(() => false);
      if (!tracked) {
        try {
          const res = await exec('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd: worktreePath });
          return { diff: res.stdout };
        } catch (err) {
          // git diff --no-index exits 1 when the files differ — that's the success path here;
          // shell.ts's AppError carries stdout/stderr/code in `details`.
          if (err instanceof AppError) {
            const details = err.details as { stdout?: string; code?: number } | undefined;
            if (details?.code === 1 && typeof details.stdout === 'string') {
              return { diff: details.stdout };
            }
          }
          throw err;
        }
      }
      const res = await exec('git', ['diff', '--', file], { cwd: worktreePath });
      return { diff: res.stdout };
    },

    async stageFile(worktreePath, file) {
      assertRelativeFile(file);
      await exec('git', ['add', '--', file], { cwd: worktreePath });
    },

    async unstageFile(worktreePath, file) {
      assertRelativeFile(file);
      await exec('git', ['restore', '--staged', '--', file], { cwd: worktreePath });
    },

    async stageAll(worktreePath) {
      await exec('git', ['add', '-A'], { cwd: worktreePath });
    },

    async unstageAll(worktreePath) {
      // `restore --staged .` errors on an empty index diff; reset is a no-op then.
      await exec('git', ['reset', '-q', '--', '.'], { cwd: worktreePath });
    },

    async discardAll(worktreePath) {
      // Same semantics as discardFile, tree-wide: working tree is restored
      // from the index (staged content survives), then untracked files and
      // directories are removed.
      await exec('git', ['restore', '--worktree', '--', '.'], { cwd: worktreePath }).catch((err) => {
        // `restore` fails with "pathspec did not match" when nothing is
        // tracked-and-modified; that just means there is nothing to restore.
        if (!/did not match/i.test(String((err as Error).message))) throw err;
      });
      await exec('git', ['clean', '-fd'], { cwd: worktreePath });
    },

    async log(worktreePath, limit, query) {
      const n = Math.max(1, Math.min(500, Math.floor(limit)));
      const FORMAT = '%H%x00%P%x00%an%x00%aI%x00%D%x00%s';
      const base = ['log', '--topo-order', `-n${n}`, `--format=${FORMAT}`];

      const parse = (stdout: string): LogCommit[] =>
        stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash, parents, author, date, refs, subject] = line.split('\0');
            return {
              hash: hash ?? '',
              parents: (parents ?? '').split(' ').filter(Boolean),
              author: author ?? '',
              date: date ?? '',
              refs: (refs ?? '')
                .split(',')
                .map((r) => r.replace(/^\s*HEAD -> /, '').trim())
                .filter((r) => r && r !== 'HEAD'),
              subject: subject ?? '',
            };
          });

      // HEAD covers a detached checkout; --branches covers every local
      // branch; an unborn HEAD (fresh repo) drops the HEAD rev.
      const runLog = async (extra: string[]): Promise<LogCommit[]> => {
        try {
          return parse((await exec('git', [...base, ...extra, 'HEAD', '--branches'], { cwd: worktreePath })).stdout);
        } catch {
          try {
            return parse((await exec('git', [...base, ...extra, '--branches'], { cwd: worktreePath })).stdout);
          } catch {
            return [];
          }
        }
      };

      const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
        .then((r) => r.stdout.trim())
        .catch(() => null);

      if (!query) return { head, commits: await runLog([]) };

      // Full-history search: exact-hash lookup plus fixed-string (no regex)
      // case-insensitive message and author matches, deduped in that order.
      const q = query.trim();
      const byHash = /^[0-9a-f]{4,40}$/i.test(q)
        ? await exec('git', ['log', '-1', `--format=${FORMAT}`, '--end-of-options', q], { cwd: worktreePath })
            .then((r) => parse(r.stdout))
            .catch(() => [])
        : [];
      const [byMsg, byAuthor] = await Promise.all([
        runLog(['-i', '--fixed-strings', `--grep=${q}`]),
        runLog(['-i', '--fixed-strings', `--author=${q}`]),
      ]);
      const seen = new Set<string>();
      const commits = [...byHash, ...byMsg, ...byAuthor]
        .filter((c) => !seen.has(c.hash) && (seen.add(c.hash), true))
        .slice(0, n);
      return { head, commits };
    },

    async commitInfo(worktreePath, hash) {
      assertCommitHash(hash);
      const header = await exec(
        'git',
        ['show', '-s', '--format=%H%x00%an%x00%aI%x00%B', '--end-of-options', hash],
        { cwd: worktreePath },
      );
      const [full, author, date, message] = header.stdout.split('\0');
      let files: CommitFile[];
      try {
        // Diff vs first parent — well-defined for merges too.
        const res = await exec(
          'git',
          ['diff', '--name-status', '-z', '--find-renames', `${hash}^1`, hash],
          { cwd: worktreePath },
        );
        files = parseNameStatusZ(res.stdout);
      } catch {
        // Root commit has no parent.
        const res = await exec(
          'git',
          ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '-z', hash],
          { cwd: worktreePath },
        );
        files = parseNameStatusZ(res.stdout);
      }
      return {
        hash: (full ?? hash).trim(),
        author: author ?? '',
        date: date ?? '',
        message: (message ?? '').trim(),
        files,
      };
    },

    async commitFileDiff(worktreePath, hash, file) {
      assertCommitHash(hash);
      assertRelativeFile(file);
      try {
        const res = await exec(
          'git',
          ['diff', '--find-renames', `${hash}^1`, hash, '--', file],
          { cwd: worktreePath },
        );
        return { diff: res.stdout };
      } catch {
        const res = await exec(
          'git',
          ['diff-tree', '-p', '--root', '--no-commit-id', hash, '--', file],
          { cwd: worktreePath },
        );
        return { diff: res.stdout };
      }
    },

    async discardFile(worktreePath, file) {
      assertRelativeFile(file);
      const tracked = await exec('git', ['ls-files', '--error-unmatch', '--', file], { cwd: worktreePath })
        .then(() => true)
        .catch(() => false);
      if (tracked) {
        // Drop working-tree edits, restoring from the index — staged content
        // survives (VS Code "Discard Changes" semantics for the Changes list).
        await exec('git', ['restore', '--worktree', '--', file], { cwd: worktreePath });
      } else {
        // Untracked file or directory — remove it (git clean handles both and
        // refuses anything outside the repo).
        await exec('git', ['clean', '-fd', '--', file], { cwd: worktreePath });
      }
    },

    async applyHunk(worktreePath, patch, reverse) {
      if (!patch.trim()) throw new AppError('VALIDATION', 'empty patch');
      const tmp = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'hunk-')), 'p.patch');
      await fsp.writeFile(tmp, patch.endsWith('\n') ? patch : patch + '\n');
      try {
        const args = ['apply', '--cached', '--whitespace=nowarn'];
        if (reverse) args.push('--reverse');
        args.push(tmp);
        await exec('git', args, { cwd: worktreePath });
      } catch (err) {
        throw new AppError('VALIDATION', `hunk no longer applies: ${(err as Error).message}`);
      } finally {
        await fsp.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async discardHunk(worktreePath, patch) {
      // Reverse-apply to the working tree only — the index is untouched, so a
      // staged copy of the same lines survives the discard.
      if (!patch.trim()) throw new AppError('VALIDATION', 'empty patch');
      const tmp = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'hunk-')), 'p.patch');
      await fsp.writeFile(tmp, patch.endsWith('\n') ? patch : patch + '\n');
      try {
        await exec('git', ['apply', '--reverse', '--whitespace=nowarn', tmp], { cwd: worktreePath });
      } catch (err) {
        throw new AppError('VALIDATION', `hunk no longer applies: ${(err as Error).message}`);
      } finally {
        await fsp.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async mergeRequestUrl(worktreePath, target) {
      if (!target || target.startsWith('-') || /[\s]/.test(target)) {
        throw new AppError('VALIDATION', `invalid target branch: ${target}`);
      }
      const sourceBranch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath })).stdout.trim();
      if (sourceBranch === 'HEAD') throw new AppError('VALIDATION', 'cannot create an MR from a detached HEAD');
      const remoteUrl = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath })).stdout.trim();

      // Normalize ssh/https remote to a web base URL.
      // git@host:group/repo.git → https://host/group/repo
      let web = remoteUrl.replace(/\.git$/, '');
      const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(web);
      if (ssh) web = `https://${ssh[1]}/${ssh[2]}`;
      web = web.replace(/^http:\/\//, 'https://');
      if (!/^https:\/\//.test(web)) throw new AppError('VALIDATION', `unsupported remote url: ${remoteUrl}`);

      let host = new URL(web).hostname;
      // SSH aliases (git@github-strado:…) aren't real hostnames — resolve to
      // the actual host so the compare/MR page opens in a browser.
      const realHost = await resolveSshAlias(host);
      if (realHost) {
        const u = new URL(web);
        u.hostname = realHost;
        web = u.toString();
        host = realHost;
      }
      const src = encodeURIComponent(sourceBranch);
      const dst = encodeURIComponent(target);
      let url: string;
      if (host.includes('github')) {
        url = `${web}/compare/${dst}...${src}?expand=1`;
      } else if (host.includes('bitbucket')) {
        url = `${web}/pull-requests/new?source=${src}&dest=${dst}`;
      } else {
        // GitLab (and self-hosted GitLab instances)
        url = `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${src}&merge_request%5Btarget_branch%5D=${dst}`;
      }
      return { url, sourceBranch };
    },

    async listRemotes(worktreePath) {
      const res = await exec('git', ['remote'], { cwd: worktreePath });
      return { remotes: res.stdout.split('\n').map((r) => r.trim()).filter(Boolean) };
    },

    async push(worktreePath, remote) {
      await assertRemote(worktreePath, remote);
      const res = await exec('git', ['push', remote, 'HEAD'], { cwd: worktreePath, timeoutMs: 120_000 });
      return { output: (res.stderr || res.stdout).trim() };
    },

    async pull(worktreePath, source) {
      // `source` is the branch to bring INTO the current branch:
      // "origin/master" → git pull origin master; a local branch → merge it.
      const branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath })).stdout.trim();
      if (branch === 'HEAD') throw new AppError('VALIDATION', 'cannot pull on a detached HEAD');
      if (!source || source.startsWith('-')) throw new AppError('VALIDATION', `invalid pull source: ${source}`);

      const slash = source.indexOf('/');
      if (slash > 0) {
        const remote = source.slice(0, slash);
        const remoteBranch = source.slice(slash + 1);
        const known = (await exec('git', ['remote'], { cwd: worktreePath })).stdout
          .split('\n').map((r) => r.trim()).filter(Boolean);
        if (known.includes(remote)) {
          if (!remoteBranch || remoteBranch.startsWith('-')) {
            throw new AppError('VALIDATION', `invalid pull source: ${source}`);
          }
          const res = await exec('git', ['pull', remote, remoteBranch], { cwd: worktreePath, timeoutMs: 120_000 });
          return { output: (res.stdout || res.stderr).trim() };
        }
      }
      await assertBaseRef(worktreePath, source);
      const res = await exec('git', ['merge', '--no-edit', source], { cwd: worktreePath, timeoutMs: 120_000 });
      return { output: (res.stdout || res.stderr).trim() };
    },

    async commit(worktreePath, message) {
      if (!message.trim()) throw new AppError('VALIDATION', 'commit message is required');
      const stagedRes = await exec('git', ['diff', '--cached', '--name-only'], { cwd: worktreePath });
      if (!stagedRes.stdout.trim()) throw new AppError('VALIDATION', 'nothing staged to commit');
      const res = await exec('git', ['commit', '-m', message], { cwd: worktreePath });
      const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
      return { head, summary: res.stdout.trim().split('\n')[0] ?? '' };
    },
  };
}
