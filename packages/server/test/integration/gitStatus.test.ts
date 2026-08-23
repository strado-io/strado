import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../src/shell';
import { createGitStatusService } from '../../src/services/gitStatus';

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-'));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await exec('git', ['config', 'user.email', 'x@y.z'], { cwd: repo });
  await exec('git', ['config', 'user.name', 'x'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a.txt'), '1');
  await exec('git', ['add', '.'], { cwd: repo });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('git status service', () => {
  it('returns branch and clean state', async () => {
    const svc = createGitStatusService();
    const status = await svc.status(repo);
    expect(status.branch).toBe('main');
    expect(status.dirty).toBe(false);
  });

  it('detects dirty tree', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), '2');
    const svc = createGitStatusService();
    const status = await svc.status(repo);
    expect(status.dirty).toBe(true);
  });

  it('returns 0/0 ahead/behind when no upstream', async () => {
    const svc = createGitStatusService();
    const status = await svc.status(repo);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });
});
