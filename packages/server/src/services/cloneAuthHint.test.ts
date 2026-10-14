import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { explainCloneFailure, isGitAuthFailure } from './cloneAuthHint.js';

describe('explainCloneFailure', () => {
  it('names the host, the provider to connect, and the SSH alternative for an SSH auth failure', () => {
    const err = new AppError('SHELL_FAILED', 'git exited 128', {
      stderr: "git@gitlab.stg-fleetx.io: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    });
    const out = explainCloneFailure(err, 'git@gitlab.stg-fleetx.io:fleetxdev/fleetx-react-app.git');
    expect(out).toBeInstanceOf(AppError);
    expect(out!.code).toBe('VALIDATION');
    expect(out!.message).toContain('cannot authenticate to gitlab.stg-fleetx.io');
    expect(out!.message).toContain('connect GitLab under Settings → Integrations');
    expect(out!.message).toContain('install an SSH key for gitlab.stg-fleetx.io on the runner');
  });

  it('recognises HTTPS failures too, and names GitHub for github.com', () => {
    const out = explainCloneFailure(new Error('fatal: could not read Username for https://github.com'), 'https://github.com/o/r.git');
    expect(out!.message).toContain('connect GitHub');
  });

  it('leaves non-auth failures alone', () => {
    expect(explainCloneFailure(new Error('fatal: destination path exists'), 'https://github.com/o/r.git')).toBeNull();
    expect(isGitAuthFailure('error: RPC failed; curl 56')).toBe(false);
  });
});
