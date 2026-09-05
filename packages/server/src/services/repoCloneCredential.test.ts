import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
vi.mock('../shell.js', () => ({ exec: execMock }));

import { cloneRepo } from './repoClone.js';

let tempRoot: string | null = null;
afterEach(() => {
  execMock.mockReset();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('cloneRepo HTTPS credentials', () => {
  it('keeps the token out of argv and deletes the temporary askpass helper', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-clone-credential-'));
    const dest = path.join(tempRoot, 'repo');
    let askPassPath = '';
    execMock.mockImplementation(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args).toEqual(['clone', '--', 'https://github.com/strado-io/strado.git', dest]);
      expect(args.join(' ')).not.toContain('ghs_secret');
      expect(options.env.STRADO_GIT_PASSWORD).toBe('ghs_secret');
      askPassPath = options.env.GIT_ASKPASS!;
      expect(fs.readFileSync(askPassPath, 'utf8')).not.toContain('ghs_secret');
      return { stdout: '', stderr: '', code: 0 };
    });

    await cloneRepo({
      url: 'https://github.com/strado-io/strado.git',
      dest,
      credential: { username: 'x-access-token', password: 'ghs_secret' },
    });
    expect(askPassPath).not.toBe('');
    expect(fs.existsSync(askPassPath)).toBe(false);
  });
});
