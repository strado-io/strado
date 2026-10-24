import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PROBE_SCRIPT, parseProbe } from './probe.js';

// Captured from runner-dev (Ubuntu 24.04, rootless podman 4.9.3, hand-built bundle).
const RUNNER_DEV = `system=Linux
machine=x86_64
glibc=2.39
musl=0
machineId=a54ad838025745008989583d82ed7770
home=/home/strado
user=strado
uid=1000
hostname=runner-dev
freeKiB=55964888
curl=1
tar=1
sha256sum=1
releaseReachable=1
systemdUser=1
linger=1
runnerVersion=0.1.31-als
pairedRunnerId=runner-dev-nhxl
podmanVersion=4.9.3
podmanRootless=true
subuid=1
newuidmap=1
cgroup2=1
docker=0
distro=ubuntu
gh=
`;

const swap = (base: string, over: Record<string, string>) =>
  base
    .split('\n')
    .map((l) => {
      const k = l.slice(0, l.indexOf('='));
      return k in over ? `${k}=${over[k]}` : l;
    })
    .join('\n');

describe('parseProbe', () => {
  it('runner-dev: Ubuntu 24.04, paired, hand-built, rootless podman', () => {
    expect(parseProbe(RUNNER_DEV)).toEqual({
      system: 'Linux',
      machine: 'x86_64',
      glibc: '2.39',
      musl: false,
      machineId: 'a54ad838025745008989583d82ed7770',
      home: '/home/strado',
      user: 'strado',
      uid: 1000,
      hostname: 'runner-dev',
      freeKiB: 55964888,
      tools: { curl: true, tar: true, sha256sum: true },
      releaseReachable: true,
      systemdUser: true,
      linger: true,
      runner: { version: '0.1.31-als', pairedRunnerId: 'runner-dev-nhxl' },
      podman: { version: '4.9.3', rootless: true, subuid: true, newuidmap: true, cgroup2: true },
      docker: false,
      distro: 'ubuntu',
      gh: null,
    });
  });

  it('Alpine: musl, no glibc, no systemd', () => {
    const f = parseProbe(
      swap(RUNNER_DEV, { glibc: '', musl: '1', systemdUser: '0', linger: '', distro: 'alpine', sha256sum: '0' }),
    );
    expect(f).toMatchObject({ glibc: null, musl: true, systemdUser: false, linger: null, distro: 'alpine' });
    expect(f.tools.sha256sum).toBe(false);
  });

  it('arm64 box', () => {
    expect(parseProbe(swap(RUNNER_DEV, { machine: 'aarch64' })).machine).toBe('aarch64');
  });

  it('bare box: nothing installed, not paired, no podman, gh signed out', () => {
    const f = parseProbe(
      swap(RUNNER_DEV, {
        runnerVersion: '',
        pairedRunnerId: '',
        podmanVersion: '',
        podmanRootless: '',
        subuid: '0',
        newuidmap: '0',
        linger: '0',
        gh: 'signed-out',
      }),
    );
    expect(f.runner).toEqual({ version: null, pairedRunnerId: null });
    expect(f.podman).toEqual({ version: null, rootless: null, subuid: false, newuidmap: false, cgroup2: true });
    expect(f.linger).toBe(false);
    expect(f.gh).toBe('signed-out');
  });

  it('a truncated or garbled probe yields unknowns, never throws', () => {
    const f = parseProbe('system=Linux\nnoise without equals\n=x\nuid=abc\nglibc=garbage\n');
    expect(f.system).toBe('Linux');
    expect(f.machine).toBe('');
    expect(f.uid).toBeNull();
    expect(f.glibc).toBeNull();
    expect(f.freeKiB).toBeNull();
    expect(f.tools.curl).toBe(false);
  });

  it('values may contain = (split at the first one only)', () => {
    expect(parseProbe('hostname=a=b').hostname).toBe('a=b');
  });
});

describe('PROBE_SCRIPT', () => {
  it('has no backslashes and never cats runner.json', () => {
    expect(PROBE_SCRIPT).not.toContain('\\');
    expect(PROBE_SCRIPT).not.toMatch(/cat [^\n]*runner\.json/);
    for (const line of PROBE_SCRIPT.split('\n').filter((l) => l.includes('runner.json'))) {
      expect(line).toContain('"runnerId"');
    }
  });

  it('runs under sh and reads only the runnerId from runner.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    try {
      const sh = path.join(home, '.strado');
      fs.mkdirSync(path.join(sh, 'runner', 'versions', '0.1.32'), { recursive: true });
      fs.writeFileSync(path.join(sh, 'runner', 'versions', '0.1.32', 'version'), '0.1.32\n');
      fs.symlinkSync(path.join(sh, 'runner', 'versions', '0.1.32'), path.join(sh, 'runner', 'current'));
      fs.writeFileSync(
        path.join(sh, 'runner.json'),
        JSON.stringify(
          { runnerId: 'box-a1b2', runnerToken: 'TOKENSECRET', accessKey: 'ACCESSSECRET', apiUrl: 'https://x' },
          null,
          2,
        ),
      );
      const out = execFileSync('sh', ['-s', '--', 'http://127.0.0.1:9'], {
        input: PROBE_SCRIPT,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(out).not.toContain('SECRET');
      const f = parseProbe(out);
      expect(f.runner).toEqual({ version: '0.1.32', pairedRunnerId: 'box-a1b2' });
      expect(f.home).toBe(home);
      expect(f.system).toBe(os.platform() === 'darwin' ? 'Darwin' : 'Linux');
      expect(f.releaseReachable).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports the directory a hand-built current points at', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    try {
      const v = path.join(home, '.strado', 'runner', 'versions', '0.1.31-als');
      fs.mkdirSync(v, { recursive: true });
      fs.writeFileSync(path.join(v, 'version'), '0.1.31\n');
      fs.symlinkSync(v, path.join(home, '.strado', 'runner', 'current'));
      const out = execFileSync('sh', ['-s', '--', 'http://127.0.0.1:9'], {
        input: PROBE_SCRIPT,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(parseProbe(out).runner.version).toBe('0.1.31-als');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes the API base from stdin when run as sh -c (the job\'s way)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    try {
      const out = execFileSync('sh', ['-c', `${PROBE_SCRIPT}\necho "api=$API"`], {
        input: 'http://127.0.0.1:9\n',
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(out).toContain('api=http://127.0.0.1:9');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
