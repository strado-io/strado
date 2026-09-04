import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type HttpGitCredential = { username: string; password: string };

/**
 * Gives one Git process an HTTPS credential without putting it in a URL,
 * argv, or helper file. The helper contains code only and is deleted after the
 * operation; the password exists solely in that child process's environment.
 */
export async function withGitAskPass<T>(
  credential: HttpGitCredential,
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'strado-askpass-'));
  const helper = path.join(dir, 'askpass.sh');
  try {
    await fsp.writeFile(
      helper,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$STRADO_GIT_USERNAME" ;; *) printf "%s\\n" "$STRADO_GIT_PASSWORD" ;; esac\n',
      { mode: 0o700 },
    );
    return await run({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: helper,
      STRADO_GIT_USERNAME: credential.username,
      STRADO_GIT_PASSWORD: credential.password,
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
