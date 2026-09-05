import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvFile, resolveStartEnv } from '../../src/services/startEnv.js';

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, quotes, export prefixes and skips comments', () => {
    const text = [
      '# database', 'DB_HOST=localhost', 'export DB_PORT=5432', '', 'NAME="Fleet X"', "MOTTO='keep it  simple'",
      'EMPTY=', 'URL=https://x.io/a?b=c#frag   # trailing comment', 'NOT A LINE', 'WITH_HASH="a#b"',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      DB_HOST: 'localhost', DB_PORT: '5432', NAME: 'Fleet X', MOTTO: 'keep it  simple', EMPTY: '',
      URL: 'https://x.io/a?b=c#frag', WITH_HASH: 'a#b',
    });
  });
});

describe('resolveStartEnv', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); dirs.length = 0; });
  const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'strado-env-')); dirs.push(d); return d; };

  it('injects the profile file when the command did not interpolate it, worktree vars winning', async () => {
    const cwd = await tmp();
    await fs.writeFile(path.join(cwd, '.env.prod'), 'API=https://prod\nREGION=eu\n');
    const env = await resolveStartEnv({ cwd, envFile: '.env.prod', interpolated: false, worktreeEnv: { REGION: 'in' } });
    expect(env).toEqual({ API: 'https://prod', REGION: 'in' });
  });

  it('leaves the file alone when the command already names it', async () => {
    const cwd = await tmp();
    await fs.writeFile(path.join(cwd, '.env'), 'API=x\n');
    expect(await resolveStartEnv({ cwd, envFile: '.env', interpolated: true, worktreeEnv: { A: '1' } })).toEqual({ A: '1' });
  });

  it('a missing file is not an error — the profile just has nothing to add', async () => {
    const cwd = await tmp();
    expect(await resolveStartEnv({ cwd, envFile: '.env.gone', interpolated: false, worktreeEnv: {} })).toEqual({});
  });
});
