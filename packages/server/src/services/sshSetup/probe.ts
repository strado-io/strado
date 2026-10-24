// What "Add a host over SSH" learns about a box before touching it. One POSIX
// sh script printing one key=value per line; parseProbe turns that into
// RemoteFacts. The API base comes as $1 (`sh -s -- <api>`) or, when there is
// no $1, as the first line of stdin (`sh -c <script>` with params on stdin,
// which is how the setup job runs it).
//
// Rules the script keeps: it changes nothing on the box; it never reads
// runner.json beyond its runnerId field (the file holds the runner token and
// access key); and it has no backslashes, so it survives any quoting layer
// between here and the remote shell untouched.
import type { RemoteFacts } from './types.js';

export const PROBE_SCRIPT = `
API="\${1:-}"
[ -n "$API" ] || read -r API
ok() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }
has() { command -v "$1" >/dev/null 2>&1; }
kv() { echo "$1=$2"; }
SH="\${STRADO_HOME:-$HOME/.strado}"
U="$(id -un 2>/dev/null)"

kv system "$(uname -s 2>/dev/null)"
kv machine "$(uname -m 2>/dev/null)"
kv glibc "$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then kv musl 1; else kv musl 0; fi
kv machineId "$(head -n1 /etc/machine-id 2>/dev/null)"
kv home "$HOME"
kv user "$U"
kv uid "$(id -u 2>/dev/null)"
kv hostname "$(hostname 2>/dev/null || uname -n)"
kv freeKiB "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
kv curl "$(ok has curl)"
kv tar "$(ok has tar)"
kv sha256sum "$(ok has sha256sum)"
if has curl; then kv releaseReachable "$(ok curl -fsS -m 10 -o /dev/null "$API/v1/release")"; else kv releaseReachable 0; fi
kv systemdUser "$(ok systemctl --user show-environment)"
L="$(loginctl show-user "$U" -p Linger --value 2>/dev/null)"
if [ "$L" = yes ]; then kv linger 1; elif [ "$L" = no ]; then kv linger 0
elif [ -d /var/lib/systemd/linger ]; then kv linger "$(ok test -e "/var/lib/systemd/linger/$U")"
else kv linger ""; fi
# The directory current points at wins when it differs from the version file:
# a hand-built bundle (versions/0.1.31-als) keeps the version it was cut from.
V="$(head -n1 "$SH/runner/current/version" 2>/dev/null)"
D="$(basename "$(readlink "$SH/runner/current" 2>/dev/null)" 2>/dev/null)"
if [ -n "$D" ] && [ "$D" != "$V" ] && [ "$D" != . ]; then V="$D"; fi
kv runnerVersion "$V"
kv pairedRunnerId "$(grep -o '"runnerId"[ ]*:[ ]*"[^"]*"' "$SH/runner.json" 2>/dev/null | head -n1 | cut -d'"' -f4)"
if has podman; then
  kv podmanVersion "$(podman version --format '{{.Client.Version}}' 2>/dev/null || podman --version 2>/dev/null | awk '{print $3}')"
  kv podmanRootless "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)"
else
  kv podmanVersion ""
  kv podmanRootless ""
fi
if grep -q "^$U:" /etc/subuid 2>/dev/null && grep -q "^$U:" /etc/subgid 2>/dev/null; then kv subuid 1; else kv subuid 0; fi
kv newuidmap "$(ok has newuidmap)"
if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ]; then kv cgroup2 1; else kv cgroup2 0; fi
if has docker; then kv docker "$(ok docker info)"; else kv docker 0; fi
kv distro "$( (. /etc/os-release 2>/dev/null && echo "$ID") )"
if has gh; then
  if gh auth status >/dev/null 2>&1; then kv gh signed-in; else kv gh signed-out; fi
else kv gh ""; fi
`;

/** Lenient by design: a missing or garbled line becomes the unknown value for
 *  its field, so a half-printed probe still yields a refusal, not a crash. */
export function parseProbe(out: string): RemoteFacts {
  const kv = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const str = (k: string) => kv.get(k) ?? '';
  const opt = (k: string) => str(k) || null;
  const bool = (k: string) => str(k) === '1';
  const tri = (k: string) => (str(k) === '1' ? true : str(k) === '0' ? false : null);
  const int = (k: string) => (/^\d+$/.test(str(k)) ? Number(str(k)) : null);
  const rootless = str('podmanRootless');
  const gh = str('gh');
  return {
    system: str('system'),
    machine: str('machine'),
    glibc: /^\d+\.\d+/.test(str('glibc')) ? str('glibc') : null,
    musl: bool('musl'),
    machineId: str('machineId'),
    home: str('home'),
    user: str('user'),
    uid: int('uid'),
    hostname: str('hostname'),
    freeKiB: int('freeKiB'),
    tools: { curl: bool('curl'), tar: bool('tar'), sha256sum: bool('sha256sum') },
    releaseReachable: bool('releaseReachable'),
    systemdUser: bool('systemdUser'),
    linger: tri('linger'),
    runner: { version: opt('runnerVersion'), pairedRunnerId: opt('pairedRunnerId') },
    podman: {
      version: opt('podmanVersion'),
      rootless: rootless === 'true' ? true : rootless === 'false' ? false : null,
      subuid: bool('subuid'),
      newuidmap: bool('newuidmap'),
      cgroup2: bool('cgroup2'),
    },
    docker: bool('docker'),
    distro: opt('distro'),
    gh: gh === 'signed-in' || gh === 'signed-out' ? gh : null,
  };
}
