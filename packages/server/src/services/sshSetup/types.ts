// The contract for "Add a host over SSH": shared by the remote scripts (probe,
// podman install), the server job that drives a run, and the dialog that shows
// it. The job owns every argv; the dialog only ever sends a destination, a
// name, and yes/no answers.

export type SshSetupStepId = 'connect' | 'check' | 'install' | 'pair' | 'service' | 'podman' | 'online';

export const SSH_SETUP_STEPS: { id: SshSetupStepId; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'check', label: 'Check machine' },
  { id: 'install', label: 'Install' },
  { id: 'pair', label: 'Pair' },
  { id: 'service', label: 'Service' },
  { id: 'podman', label: 'Podman' },
  { id: 'online', label: 'Online' },
];

/** What the probe script learns about the box. Never holds a secret: the
 *  paired runner id is read from runner.json's id field alone. */
export type RemoteFacts = {
  system: string;
  machine: string;
  /** e.g. "2.39"; null when not glibc or unreadable. */
  glibc: string | null;
  musl: boolean;
  machineId: string;
  home: string;
  user: string;
  uid: number | null;
  hostname: string;
  /** Free KiB in $HOME, null if unknown. */
  freeKiB: number | null;
  tools: { curl: boolean; tar: boolean; sha256sum: boolean };
  /** curl to the release feed succeeded from the box. */
  releaseReachable: boolean;
  systemdUser: boolean;
  linger: boolean | null;
  runner: { version: string | null; pairedRunnerId: string | null };
  podman: {
    version: string | null;
    rootless: boolean | null;
    subuid: boolean;
    newuidmap: boolean;
    cgroup2: boolean;
  };
  docker: boolean;
  /** ID from /etc/os-release, e.g. "ubuntu", "debian", "fedora". */
  distro: string | null;
  gh: 'signed-in' | 'signed-out' | null;
};

/** A point where the job stops and asks the person. The dialog shows message
 *  and, when present, the exact command that a yes will run in the terminal. */
export type SshSetupQuestion = {
  id: string;
  kind: 'repair-other-account' | 'overwrite-install' | 'linger' | 'podman';
  message: string;
  command?: string;
};

/** Carried in a job progress frame's data, alongside stepReporter's {step, detail}. */
export type SshSetupProgress =
  | { step: SshSetupStepId; detail?: string }
  | { question: SshSetupQuestion }
  /** A pty the dialog should attach to now (interactive step); ends when it exits. */
  | { terminal: { key: string } };

export type SshSetupResult = { runnerId: string; name: string; sandboxes: boolean; warnings: string[] };

export const SSH_SETUP_ROUTES = {
  start: '/api/runners/ssh-setup', // POST { destination, name? } → { jobId }
  answer: '/api/runners/ssh-setup/:jobId/answer', // POST { questionId, yes } → 204
  cancel: '/api/runners/ssh-setup/:jobId/cancel', // POST → 204
  /** GET → { lines: string[] }: the run's transcript so far (the last 2000
   *  lines), for a page that attaches late; kept 15 min after the run ends. */
  transcript: '/api/runners/ssh-setup/:jobId/transcript',
  terminal: '/ws/ssh-setup-terminal', // ?key=<terminal.key>
} as const;

/** Prefix for the setup ptys: excluded from sessions, Mission Control, parking. */
export const SSH_SETUP_KEY_PREFIX = '\0ssh-setup:';
