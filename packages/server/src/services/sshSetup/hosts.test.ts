import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSshHosts, recordSshHost, sshHostsPath } from './hosts.js';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-hosts-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('ssh hosts record', () => {
  it('records per runner, 0600, under STRADO_HOME; a re-run replaces the entry', async () => {
    expect(await readSshHosts()).toEqual({});
    await recordSshHost('r1', { target: 'u@h', port: 2222, addedAt: '2026-10-24T00:00:00.000Z', lastInstallVersion: '0.1.32' });
    await recordSshHost('r2', { target: 'box', port: null, addedAt: '2026-10-24T00:00:00.000Z', lastInstallVersion: null });
    await recordSshHost('r1', { target: 'u@h', port: 2222, addedAt: '2026-10-25T00:00:00.000Z', lastInstallVersion: '0.1.33' });
    expect(sshHostsPath()).toBe(path.join(tmp, 'ssh-hosts.json'));
    expect((await fsp.stat(sshHostsPath())).mode & 0o777).toBe(0o600);
    const hosts = await readSshHosts();
    expect(Object.keys(hosts).sort()).toEqual(['r1', 'r2']);
    expect(hosts.r1!.lastInstallVersion).toBe('0.1.33');
  });

  it('a corrupt or foreign-shaped file reads as empty', async () => {
    await fsp.writeFile(sshHostsPath(), JSON.stringify({ r1: { target: 'x', privateKey: 'nope' } }));
    expect(await readSshHosts()).toEqual({});
    await fsp.writeFile(sshHostsPath(), 'garbage');
    expect(await readSshHosts()).toEqual({});
  });
});
