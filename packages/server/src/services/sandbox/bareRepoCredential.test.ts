import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }));
vi.mock('../../shell.js', () => ({ exec: execMock }));

import { ensureBareRepo } from './bareRepo.js';

let tempRoot: string | null = null;

afterEach(() => {
  execMock.mockClear();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('bare repository HTTPS credentials', () => {
  it('uses askpass for private clone and fetch without putting the token in argv', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-bare-credential-'));
    const helpers: string[] = [];
    execMock.mockImplementation(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args.join(' ')).not.toContain('ghs_secret');
      if (options.env.STRADO_GIT_PASSWORD) {
        expect(options.env.STRADO_GIT_PASSWORD).toBe('ghs_secret');
        helpers.push(options.env.GIT_ASKPASS!);
        expect(fs.readFileSync(options.env.GIT_ASKPASS!, 'utf8')).not.toContain('ghs_secret');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    await ensureBareRepo({
      reposDir: path.join(tempRoot, 'repos'),
      repoId: 'private-repo',
      cloneUrl: 'https://github.com/strado-io/strado.git',
      credential: { username: 'x-access-token', password: 'ghs_secret' },
    });

    expect(execMock).toHaveBeenCalledTimes(3);
    const authenticated = [execMock.mock.calls[0], execMock.mock.calls[2]];
    for (const [, args, options] of authenticated) {
      expect(args.join(' ')).not.toContain('ghs_secret');
      expect(options.env.STRADO_GIT_PASSWORD).toBe('ghs_secret');
    }
    expect(execMock.mock.calls[1]?.[2].env.STRADO_GIT_PASSWORD).toBeUndefined();
    expect(helpers).toHaveLength(2);
    expect(helpers.every((helper) => !fs.existsSync(helper))).toBe(true);
  });
});
