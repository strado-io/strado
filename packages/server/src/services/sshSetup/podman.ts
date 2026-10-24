// Whether a box needs podman installed or fixed for sandboxes, and the exact
// command a yes runs in the setup terminal (sudo prompts happen there).
import type { RemoteFacts } from './types.js';

/** Rootless sandboxes map the host user onto the image's uid 1000. At uid
 *  1000 plain keep-id works on any podman; any other uid needs the
 *  `keep-id:uid=` form, which podman added in 4.3 (sandboxes.ts userArgs). */
const KEEP_ID_UID = 1000;

function atLeast43(v: string): boolean {
  const [a = 0, b = 0] = v.split('.').map((n) => Number.parseInt(n, 10));
  return a > 4 || (a === 4 && b >= 3);
}

export function podmanNeeded(f: RemoteFacts): boolean {
  const p = f.podman;
  // A working docker already gives sandboxes; nothing to install.
  if (!p.version) return !f.docker;
  if (f.uid !== KEEP_ID_UID && !atLeast43(p.version)) return true;
  // `podman info` failing (rootless null) is what subuid/migrate usually fix.
  return !p.subuid || !p.newuidmap || p.rootless === null;
}

const INSTALL: Record<string, string> = {
  apt: 'sudo apt-get update && sudo apt-get install -y podman uidmap slirp4netns',
  dnf: 'sudo dnf install -y podman',
  zypper: 'sudo zypper install -y podman',
  pacman: 'sudo pacman -S --noconfirm podman',
};

const FAMILY: Record<string, keyof typeof INSTALL> = {
  ubuntu: 'apt',
  debian: 'apt',
  linuxmint: 'apt',
  pop: 'apt',
  raspbian: 'apt',
  fedora: 'dnf',
  rhel: 'dnf',
  centos: 'dnf',
  rocky: 'dnf',
  almalinux: 'dnf',
  ol: 'dnf',
  'opensuse-leap': 'zypper',
  'opensuse-tumbleweed': 'zypper',
  sles: 'zypper',
  arch: 'pacman',
  manjaro: 'pacman',
  endeavouros: 'pacman',
};

/** null for a distro we have no command for: the job then continues without
 *  sandboxes and points at the docs. */
export function podmanInstallCommand(f: RemoteFacts): string | null {
  const family = f.distro ? FAMILY[f.distro] : undefined;
  if (!family) return null;
  return [
    INSTALL[family],
    // `id -un`, not $USER: a non-login ssh exec does not always set USER.
    'U="$(id -un)"',
    '{ grep -q "^$U:" /etc/subuid || sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$U"; }',
    'podman system migrate',
    // No runner restart here: the job runs it after this exits 0, so a box
    // without a user bus does not report a good install as a failed one.
  ].join(' && ');
}
