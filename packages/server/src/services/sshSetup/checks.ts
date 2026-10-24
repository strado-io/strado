// What a probed box must have before setup touches it (refusal), and what is
// worth telling the person without stopping (warnings). Every message is one
// sentence the dialog can show as is.
import type { RemoteFacts } from './types.js';

/** The bundled Node is an official linux-x64 build, which needs glibc 2.28. */
const MIN_GLIBC: [number, number] = [2, 28];
/** About what the sandbox image takes on a first build. */
const MIN_FREE_KIB = 3 * 1024 * 1024;

const versionAtLeast = (v: string, min: [number, number]) => {
  const [a = 0, b = 0] = v.split('.').map((n) => Number.parseInt(n, 10));
  return a > min[0] || (a === min[0] && b >= min[1]);
};

export function refusal(f: RemoteFacts): string | null {
  if (f.system !== 'Linux') return `The runner supports Linux only; this box is ${f.system || 'not Linux'}.`;
  if (f.machine !== 'x86_64' && f.machine !== 'amd64') {
    return `The runner supports x86_64 only; this box is ${f.machine || 'an unknown architecture'}.`;
  }
  if (f.musl) return 'This box uses musl (e.g. Alpine); the runner needs a glibc distro.';
  if (f.glibc && !versionAtLeast(f.glibc, MIN_GLIBC)) {
    return `This box has glibc ${f.glibc}; the runner needs ${MIN_GLIBC.join('.')} or newer.`;
  }
  if (!f.machineId) return 'This box has no /etc/machine-id, so it cannot be told apart from others.';
  const missing = (['curl', 'tar', 'sha256sum'] as const).filter((t) => !f.tools[t]);
  if (missing.length) return `Install ${missing.join(', ')} on the box first; the runner installer needs them.`;
  return null;
}

export function warnings(f: RemoteFacts): string[] {
  const out: string[] = [];
  if (f.freeKiB !== null && f.freeKiB < MIN_FREE_KIB) {
    out.push(`Only ${(f.freeKiB / 1024 / 1024).toFixed(1)} GB free in ${f.home || 'home'}; the sandbox image needs about 3 GB.`);
  }
  if (!f.releaseReachable) {
    out.push('The box could not reach the Strado release feed; if it is behind a proxy, set it in ~/.strado/runner.env.');
  }
  if (!f.systemdUser) out.push('No systemd user session on the box, so the runner will not survive logout or reboot.');
  if (!f.glibc && !f.musl) out.push('Could not read the glibc version; the runner needs 2.28 or newer.');
  if (f.gh === null) out.push('GitHub CLI (gh) is not installed on the box; agents there cannot open pull requests.');
  else if (f.gh === 'signed-out') out.push('GitHub CLI (gh) is signed out on the box; run gh auth login there.');
  return out;
}
