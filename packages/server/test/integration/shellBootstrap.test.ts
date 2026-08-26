import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hooks');
const BOOTSTRAP = path.join(HOOKS, 'strado-shell-bootstrap');
const AGENT_BIN = path.join(HOOKS, 'bin');
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

type ShellCase = {
  name: string;
  candidates: string[];
  rcPath(home: string): string;
  rcContents(realBin: string): string;
};

const shells: ShellCase[] = [
  {
    name: 'zsh',
    candidates: ['/bin/zsh', '/usr/bin/zsh'],
    rcPath: (home) => path.join(home, '.zshrc'),
    rcContents: (realBin) => `export PATH="${realBin}:$PATH"\nexport STRADO_RC_MARKER=loaded\n`,
  },
  {
    name: 'bash',
    candidates: ['/bin/bash', '/usr/bin/bash'],
    rcPath: (home) => path.join(home, '.bashrc'),
    rcContents: (realBin) => `export PATH="${realBin}:$PATH"\nexport STRADO_RC_MARKER=loaded\n`,
  },
  {
    name: 'fish',
    candidates: ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'],
    rcPath: (home) => path.join(home, '.config', 'fish', 'config.fish'),
    rcContents: (realBin) => `set -gx PATH "${realBin}" $PATH\nset -gx STRADO_RC_MARKER loaded\n`,
  },
];

async function run(shellCase: ShellCase, shell: string): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-bootstrap-'));
  const home = path.join(tmp, 'home');
  const realBin = path.join(tmp, 'profile-bin');
  await fs.mkdir(realBin, { recursive: true });
  await fs.mkdir(path.dirname(shellCase.rcPath(home)), { recursive: true });
  await fs.writeFile(shellCase.rcPath(home), shellCase.rcContents(realBin));
  const realCodex = path.join(realBin, 'codex');
  await fs.writeFile(realCodex, '#!/bin/sh\nexit 0\n');
  await fs.chmod(realCodex, 0o755);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(BOOTSTRAP, [], {
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        PATH: `/usr/bin:/bin:${realBin}`,
        STRADO_AGENT_BIN_DIR: AGENT_BIN,
        STRADO_INNER_SHELL: shell,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${shellCase.name} bootstrap timed out: ${output}`));
    }, 5_000);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${shellCase.name} exited ${code}: ${output}`));
      else resolve(output);
    });
    child.stdin.end('echo STRADO_RC_MARKER=$STRADO_RC_MARKER\ncommand -v codex\nexit\n');
  });
}

describe('Shell bootstrap', () => {
  it.each(shells)('loads the user $name profile before making agent launchers authoritative', async (shellCase) => {
    const shell = shellCase.candidates.find(fsSync.existsSync);
    if (!shell) return;

    const output = await run(shellCase, shell);
    expect(output).toContain('STRADO_RC_MARKER=loaded');
    expect(output).toContain(path.join(AGENT_BIN, 'codex'));
  });
});
