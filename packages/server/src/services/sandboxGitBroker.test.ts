import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSandboxGitBrokerToken, resolveSandboxGitBrokerToken } from './sandboxGitBroker.js';

let home: string;
let worktree: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'strado-sandbox-git-broker-'));
  worktree = path.join(home, 'worktree');
  await fsp.mkdir(worktree);
  await fsp.writeFile(path.join(home, 'runner.json'), JSON.stringify({
    runnerId: 'runner-1',
    runnerToken: 'a'.repeat(64),
    apiUrl: 'https://api.strado.test',
  }), { mode: 0o600 });
  process.env.STRADO_HOME = home;
  process.env.STRADO_RUNNER = '1';
});

afterEach(async () => {
  delete process.env.STRADO_HOME;
  delete process.env.STRADO_RUNNER;
  await fsp.rm(home, { recursive: true, force: true });
});

describe('sandbox Git broker capability', () => {
  it('is bound to one existing worktree and repository', async () => {
    const token = await issueSandboxGitBrokerToken(worktree, 'strado-io/strado');
    expect(token).toBeTruthy();
    await expect(resolveSandboxGitBrokerToken(token!)).resolves.toEqual({
      v: 1,
      worktreePath: worktree,
      projectPath: 'strado-io/strado',
    });
  });

  it('rejects tampering and stops working after the worktree is removed', async () => {
    const token = await issueSandboxGitBrokerToken(worktree, 'strado-io/strado');
    expect(token).toBeTruthy();
    await expect(resolveSandboxGitBrokerToken(`${token}x`)).resolves.toBeNull();
    await fsp.rm(worktree, { recursive: true, force: true });
    await expect(resolveSandboxGitBrokerToken(token!)).resolves.toBeNull();
  });

  it('cannot be issued outside runner mode or for a malformed project', async () => {
    delete process.env.STRADO_RUNNER;
    await expect(issueSandboxGitBrokerToken(worktree, 'strado-io/strado')).resolves.toBeNull();
    process.env.STRADO_RUNNER = '1';
    await expect(issueSandboxGitBrokerToken(worktree, '../secret')).resolves.toBeNull();
  });
});
