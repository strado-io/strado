import { describe, expect, it } from 'vitest';
import { refusal, warnings } from './checks.js';
import { podmanInstallCommand, podmanNeeded } from './podman.js';
import type { RemoteFacts } from './types.js';

const good: RemoteFacts = {
  system: 'Linux',
  machine: 'x86_64',
  glibc: '2.39',
  musl: false,
  machineId: 'a54ad838025745008989583d82ed7770',
  home: '/home/strado',
  user: 'strado',
  uid: 1000,
  hostname: 'runner-dev',
  freeKiB: 50_000_000,
  tools: { curl: true, tar: true, sha256sum: true },
  releaseReachable: true,
  systemdUser: true,
  linger: true,
  runner: { version: null, pairedRunnerId: null },
  podman: { version: '4.9.3', rootless: true, subuid: true, newuidmap: true, cgroup2: true },
  docker: false,
  distro: 'ubuntu',
  gh: 'signed-in',
};
const f = (over: Partial<RemoteFacts>): RemoteFacts => ({ ...good, ...over });
const pod = (over: Partial<RemoteFacts['podman']>, rest: Partial<RemoteFacts> = {}) =>
  f({ podman: { ...good.podman, ...over }, ...rest });

describe('refusal', () => {
  it('a good box passes', () => {
    expect(refusal(good)).toBeNull();
  });
  it.each([
    [f({ system: 'Darwin' }), /Linux only.*Darwin/],
    [f({ machine: 'aarch64' }), /x86_64 only.*aarch64/],
    [f({ musl: true, glibc: null }), /musl/],
    [f({ glibc: '2.27' }), /glibc 2\.27.*2\.28/],
    [f({ machineId: '' }), /machine-id/],
    [f({ tools: { curl: false, tar: true, sha256sum: false } }), /curl, sha256sum/],
  ])('refuses %#', (facts, msg) => {
    expect(refusal(facts)).toMatch(msg);
  });
  it('glibc 2.28 exactly is fine, and 2.100 compares numerically', () => {
    expect(refusal(f({ glibc: '2.28' }))).toBeNull();
    expect(refusal(f({ glibc: '2.100' }))).toBeNull();
  });
  it('amd64 is x86_64', () => {
    expect(refusal(f({ machine: 'amd64' }))).toBeNull();
  });
});

describe('warnings', () => {
  it('none for a good box', () => {
    expect(warnings(good)).toEqual([]);
  });
  it('low disk, unreachable feed, gh missing or signed out, no systemd, unknown glibc', () => {
    expect(warnings(f({ freeKiB: 2 * 1024 * 1024 }))[0]).toMatch(/2\.0 GB free.*3 GB/);
    expect(warnings(f({ releaseReachable: false }))[0]).toMatch(/release feed/);
    expect(warnings(f({ gh: null }))[0]).toMatch(/gh/);
    expect(warnings(f({ gh: 'signed-out' }))[0]).toMatch(/gh auth login/);
    expect(warnings(f({ systemdUser: false }))[0]).toMatch(/systemd/);
    expect(warnings(f({ glibc: null }))[0]).toMatch(/glibc/);
  });
  it('unknown free space is not a warning', () => {
    expect(warnings(f({ freeKiB: null }))).toEqual([]);
  });
});

describe('podmanNeeded', () => {
  it('not needed on a working rootless podman', () => {
    expect(podmanNeeded(good)).toBe(false);
  });
  it('needed when missing, unless docker works', () => {
    expect(podmanNeeded(pod({ version: null, rootless: null }))).toBe(true);
    expect(podmanNeeded(pod({ version: null, rootless: null }, { docker: true }))).toBe(false);
  });
  it('podman 3.4 is fine at uid 1000 (plain keep-id), not otherwise', () => {
    expect(podmanNeeded(pod({ version: '3.4.4' }))).toBe(false);
    expect(podmanNeeded(pod({ version: '3.4.4' }, { uid: 1001 }))).toBe(true);
    expect(podmanNeeded(pod({ version: '4.2.9' }, { uid: 1001 }))).toBe(true);
    expect(podmanNeeded(pod({ version: '4.3.0' }, { uid: 1001 }))).toBe(false);
    expect(podmanNeeded(pod({ version: '5.0.0' }, { uid: 1001 }))).toBe(false);
  });
  it('needed when rootless pieces are missing or info fails', () => {
    expect(podmanNeeded(pod({ subuid: false }))).toBe(true);
    expect(podmanNeeded(pod({ newuidmap: false }))).toBe(true);
    expect(podmanNeeded(pod({ rootless: null }))).toBe(true);
  });
});

describe('podmanInstallCommand', () => {
  it.each([
    ['ubuntu', 'sudo apt-get update && sudo apt-get install -y podman uidmap slirp4netns'],
    ['debian', 'sudo apt-get update && sudo apt-get install -y podman uidmap slirp4netns'],
    ['fedora', 'sudo dnf install -y podman'],
    ['rocky', 'sudo dnf install -y podman'],
    ['opensuse-tumbleweed', 'sudo zypper install -y podman'],
    ['arch', 'sudo pacman -S --noconfirm podman'],
  ])('%s', (distro, install) => {
    const cmd = podmanInstallCommand(f({ distro }))!;
    expect(cmd.startsWith(`${install} && `)).toBe(true);
    expect(cmd).toContain('--add-subuids 100000-165535 --add-subgids 100000-165535');
    expect(cmd).toContain('podman system migrate');
    // The job restarts the runner itself once this exits 0.
    expect(cmd.endsWith('podman system migrate')).toBe(true);
    expect(cmd).not.toContain('\\');
  });
  it('null for an unknown or missing distro', () => {
    expect(podmanInstallCommand(f({ distro: 'gentoo' }))).toBeNull();
    expect(podmanInstallCommand(f({ distro: null }))).toBeNull();
  });
});
