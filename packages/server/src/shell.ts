import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export type ShellResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type ShellOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const COMMAND_PATTERN = /^[A-Za-z0-9._/-]+$/;

export async function exec(
  command: string,
  args: string[],
  options: ShellOptions = {},
): Promise<ShellResult> {
  if (!COMMAND_PATTERN.test(command)) {
    throw new AppError('SHELL_FAILED', `invalid command: ${command}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    }

    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new AppError('SHELL_FAILED', err.message));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(
          new AppError('SHELL_FAILED', `${command} exited ${exitCode}`, {
            command,
            args,
            stdout,
            stderr,
            code: exitCode,
          }),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}
