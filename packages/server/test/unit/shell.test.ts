import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exec, ShellResult } from '../../src/shell';
import { AppError } from '../../src/errors';

describe('exec', () => {
  it('runs a command and returns stdout/stderr/code', async () => {
    const result: ShellResult = await exec('echo', ['hello']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('throws AppError SHELL_FAILED on non-zero exit', async () => {
    await expect(exec('sh', ['-c', 'exit 7'])).rejects.toMatchObject({
      code: 'SHELL_FAILED',
    });
  });

  it('honours cwd', async () => {
    const result = await exec('pwd', [], { cwd: '/tmp' });
    // macOS resolves /tmp -> /private/tmp via realpath; compare against the
    // physical path to keep the assertion portable while still proving cwd
    // was honoured.
    expect(result.stdout.trim()).toBe(realpathSync('/tmp'));
  });

  it('does not accept a string command (argv only)', async () => {
    // @ts-expect-error proves the type rejects strings
    await expect(exec('echo hi', [])).rejects.toBeInstanceOf(AppError);
  });
});
