import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTool, checkTools } from '../../src/services/toolCheck';

// A stand-in for the user's shell that records the argv it was invoked with,
// then runs `body`. Lets the probe be observed and steered without depending on
// what happens to be installed on the machine running the suite.
const tmpDirs: string[] = [];
async function fakeShell(body: string): Promise<{ shell: string; argvFile: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'toolcheck-'));
  tmpDirs.push(dir);
  const argvFile = path.join(dir, 'argv');
  const shell = path.join(dir, 'shell');
  await fsp.writeFile(shell, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\n${body}\n`);
  await fsp.chmod(shell, 0o755);
  return { shell, argvFile };
}

const originalShell = process.env.SHELL;
function withShell(shell: string) {
  process.env.SHELL = shell;
}

afterEach(async () => {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  await Promise.all(tmpDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

describe('checkTools', () => {
  it('includes an optional opencode entry', async () => {
    const tools = await checkTools();
    const oc = tools.find((t) => t.id === 'opencode');
    expect(oc).toBeDefined();
    expect(oc!.optional).toBe(true);
    expect(oc!.label).toBe('OpenCode');
  });

  it('includes an optional pi entry', async () => {
    const tools = await checkTools();
    const pi = tools.find((t) => t.id === 'pi');
    expect(pi).toBeDefined();
    expect(pi!.optional).toBe(true);
    expect(pi!.label).toBe('Pi');
  });

  // The probe has to measure the same shell the terminal routes launch agents
  // in (`defaultShell() -l -c`). A plain `-c` reads a different profile, which
  // is how a working pi ended up reported as missing.
  it('probes through a login shell, so PATH matches an agent tab', async () => {
    const { shell, argvFile } = await fakeShell('echo 1.2.3');
    withShell(shell);
    await checkTool('pi');
    expect((await fsp.readFile(argvFile, 'utf8')).trim().split('\n')).toEqual([
      '-l', '-c', 'pi --version',
    ]);
  });

  // An installed CLI that crashes on an old runtime is indistinguishable from
  // an absent one at the exit code, so the hint has to name the real reason —
  // "install pi" is actively wrong when pi is installed and node is too old.
  it('blames node, not a missing install, when the launch shell is below pi\'s floor', async () => {
    // `pi --version` crashes (exit 1) the way it does on old node; `node
    // --version` answers v20.19.4.
    const { shell } = await fakeShell('case "$3" in "node --version") echo v20.19.4;; *) exit 1;; esac');
    withShell(shell);
    const pi = await checkTool('pi');
    expect(pi!.found).toBe(false);
    expect(pi!.hint).toBe('Pi needs Node 22.19+ (found v20.19.4)');
  });

  it('falls back to the plain hint when the launch shell node is new enough', async () => {
    const { shell } = await fakeShell('case "$3" in "node --version") echo v22.19.0;; *) exit 1;; esac');
    withShell(shell);
    const pi = await checkTool('pi');
    expect(pi!.hint).toBe('Pi needs to be installed to use');
  });

  it('falls back to the plain hint when the launch shell has no node at all', async () => {
    const { shell } = await fakeShell('exit 1');
    withShell(shell);
    const pi = await checkTool('pi');
    expect(pi!.hint).toBe('Pi needs to be installed to use');
  });
});
