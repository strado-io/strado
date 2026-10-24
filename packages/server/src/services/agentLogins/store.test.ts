import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentLoginsPath, readClaudeToken, writeClaudeToken, writePrivateFile } from './store.js';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-logins-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('claude token store', () => {
  it('round-trips a token under STRADO_HOME and returns null when absent', async () => {
    expect(await readClaudeToken()).toBeNull();
    await writeClaudeToken('sk-ant-oat01-secret');
    expect(await readClaudeToken()).toBe('sk-ant-oat01-secret');
    expect(agentLoginsPath()).toBe(path.join(tmp, 'agent-logins.json'));
  });

  it('writes the file mode 600', async () => {
    await writeClaudeToken('sk-ant-oat01-secret');
    expect((await fsp.stat(agentLoginsPath())).mode & 0o777).toBe(0o600);
  });

  it('trims a pasted token', async () => {
    await writeClaudeToken('  sk-ant-oat01-secret\n');
    expect(await readClaudeToken()).toBe('sk-ant-oat01-secret');
  });

  it('null or blank clears it', async () => {
    await writeClaudeToken('sk-ant-oat01-secret');
    await writeClaudeToken(null);
    expect(await readClaudeToken()).toBeNull();
    await writeClaudeToken('sk-ant-oat01-secret');
    await writeClaudeToken('  ');
    expect(await readClaudeToken()).toBeNull();
  });

  it('a corrupt file reads as no token', async () => {
    await fsp.writeFile(agentLoginsPath(), '{nope');
    expect(await readClaudeToken()).toBeNull();
  });
});

describe('claude token store: hardening', () => {
  it('a loose existing file is tightened to 600 and no temp file is left', async () => {
    await fsp.writeFile(agentLoginsPath(), '{}');
    await fsp.chmod(agentLoginsPath(), 0o644);
    await writeClaudeToken('sk-ant-oat01-secret');
    expect((await fsp.stat(agentLoginsPath())).mode & 0o777).toBe(0o600);
    expect(await fsp.readdir(tmp)).toEqual(['agent-logins.json']);
  });
});

describe('writePrivateFile', () => {
  it('writes 600 via tmp + rename', async () => {
    const f = path.join(tmp, 'x.json');
    await writePrivateFile(f, 'a');
    await writePrivateFile(f, 'b');
    expect(await fsp.readFile(f, 'utf8')).toBe('b');
    expect((await fsp.stat(f)).mode & 0o777).toBe(0o600);
    expect(await fsp.readdir(tmp)).toEqual(['x.json']);
  });
});
