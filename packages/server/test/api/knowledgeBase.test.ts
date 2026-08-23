import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { buildApp, buildDeps } from '../../src/app';

let tmp: string;
let repo: string;
let worktreesDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-kb-')));
  repo = path.join(tmp, 'repo');
  worktreesDir = path.join(tmp, 'home', 'worktrees', 'react-app');
  await fs.mkdir(repo);
  await fs.mkdir(worktreesDir, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'pkg.json'), '{}');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'i'], { cwd: repo });

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);

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

  // Markdown at a couple of depths, plus a node_modules README that must never
  // surface — proves the walk's SKIP_DIRS exclusions hold through the HTTP layer.
  await fs.writeFile(path.join(repo, 'README.md'), '# top level\n');
  await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
  await fs.writeFile(path.join(repo, 'docs', 'guide.md'), '# guide\n');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'not markdown\n');
  await fs.mkdir(path.join(repo, 'node_modules', 'somepkg'), { recursive: true });
  await fs.writeFile(path.join(repo, 'node_modules', 'somepkg', 'README.md'), '# should be skipped\n');
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/w/default/worktrees/:encodedPath/kb/files', () => {
  it('lists markdown at a couple of depths and reports truncated/cap', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/files`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(false);
    expect(body.cap).toBe(2000);
    const paths = body.files.map((f: any) => f.path);
    // worktree-relative, POSIX-separated ('/' not the platform path.sep)
    expect(paths).toContain('README.md');
    expect(paths).toContain('docs/guide.md');
    expect(paths.some((p: string) => p.includes('\\'))).toBe(false);
  });

  it('skips markdown under node_modules', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/files`,
    });
    expect(res.statusCode).toBe(200);
    const paths = res.json().files.map((f: any) => f.path);
    expect(paths.some((p: string) => p.includes('node_modules'))).toBe(false);
  });

  it('404s for a path no repo owns', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent('/etc')}/kb/files`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s a resolveTarget-originated rejection with no details in the wire body', async () => {
    // A path INSIDE worktreesDir that escapes it: ownership passes, then
    // assertPathUnder rejects on the resolved path. This is the only route that
    // exercises resolveTargetSafe's own catch (readMarkdownFile's guard never
    // reaches this branch), and the only 403 here that actually has `details`
    // ({ target, allowedRoots }) to strip.
    const res = await app.inject({
      method: 'GET',
      // NOT path.join: it would normalise the `..` away and lose the prefix that
      // makes ownership pass. assertPathUnder resolves it and rejects.
      url: `/api/w/default/worktrees/${encodeURIComponent(`${worktreesDir}${path.sep}..${path.sep}escape`)}/kb/files`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain(worktreesDir);
  });

  it('does not treat a same-prefix sibling directory as owned', async () => {
    // A `<worktreesDir>-evil` sibling used to pass ownership on a bare startsWith and only
    // fail later at assertPathUnder. It is not this repo's worktree at all, so
    // "no repo owns it" is the honest answer.
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(worktreesDir + '-evil')}/kb/files`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/w/default/worktrees/:encodedPath/kb/file', () => {
  it('returns content, size, mtimeMs for a real file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/file?file=README.md`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('# top level\n');
    expect(typeof body.size).toBe('number');
    expect(typeof body.mtimeMs).toBe('number');
  });

  it('403s a traversal attempt with no leaked host path in the wire body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/file?file=../../etc/passwd.md`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PATH_FORBIDDEN');
    expect(res.json().error.details).toBeUndefined();
    const wire = JSON.stringify(res.json());
    expect(wire).not.toContain(repo);
    expect(wire).not.toContain(worktreesDir);
    expect(wire).not.toContain(tmp);
  });

  it('400s a missing file param (the ZodError path)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/file`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('400s a non-markdown file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/file?file=notes.txt`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('404s a missing markdown file', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/w/default/worktrees/${encodeURIComponent(repo)}/kb/file?file=nope.md`,
    });
    expect(res.statusCode).toBe(404);
  });
});
