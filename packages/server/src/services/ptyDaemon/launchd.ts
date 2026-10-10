// macOS: the daemon runs as a launchd user agent, not as a detached child of
// whichever app instance happened to start it.
//
// Why: macOS ties a process's privacy grants (Desktop, Documents, …) to its
// "responsible process", fixed at spawn and inherited by every descendant. A
// detached daemon's responsible process is the app instance that spawned it;
// the daemon outlives that instance by design, and from then on it — and every
// shell it spawns — is attributed to a dead pid. Grants stop applying, the
// Privacy pane sprouts a second, unexplained "Strado" entry, and `git` in a
// Desktop checkout fails with EPERM until someone restarts the daemon (and
// loses every session). A launchd-started process is its own responsible
// process, permanently, so the grant the user makes once keeps working across
// app restarts and updates.
//
// The plist lives under stateDir (not ~/Library/LaunchAgents): the app starts
// the daemon when it needs it, nothing should start it at login, and tests
// using tmp stateDirs leave nothing behind.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LAUNCHCTL_TIMEOUT_MS = 10_000;

/** macOS only; `STRADO_PTYD_LAUNCHD=0` forces the plain detached spawn. */
export function launchdEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'darwin' && env.STRADO_PTYD_LAUNCHD !== '0';
}

/** One job per stateDir: the stable and dev profiles (and test tmp dirs) never collide. */
export function launchdLabel(stateDir: string): string {
  const hash = createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 10);
  return `io.strado.ptyd.${hash}`;
}

export function launchdPlistPath(stateDir: string): string {
  return path.join(stateDir, 'ptyd', 'launchd.plist');
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Write the job definition. The daemon's own environment barely matters
 * (sessions get the server's env per spawn), so only what a launchd job
 * would otherwise lack is passed: the server's PATH, HOME, TMPDIR and locale.
 * Nothing secret goes into a file.
 */
export function writeLaunchdPlist(opts: {
  stateDir: string;
  execPath: string;
  script: string;
  socketPath: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
}): { label: string; plistPath: string } {
  const label = launchdLabel(opts.stateDir);
  const env = opts.env ?? process.env;
  const passEnv = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((k) => env[k]);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(opts.execPath)}</string>`,
    `    <string>${xml(opts.script)}</string>`,
    `    <string>${xml(`--socket=${opts.socketPath}`)}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(path.dirname(opts.socketPath))}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(opts.logPath)}</string>`,
    // Start now; never auto-restart. A crashed daemon has lost its sessions
    // already, and the next ensurePtyDaemon replaces it — the same contract as
    // the detached spawn. Auto-restart would also race the in-place upgrade's
    // successor for the socket.
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    // The in-place upgrade's successor shares the job's process group; without
    // this, launchd kills it the moment the predecessor exits.
    '  <key>AbandonProcessGroup</key><true/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...passEnv.map((k) => `    <key>${xml(k)}</key><string>${xml(env[k]!)}</string>`),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ];
  const plistPath = launchdPlistPath(opts.stateDir);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const tmp = `${plistPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, plistPath);
  return { label, plistPath };
}

function launchctl(args: string[]): { ok: boolean; detail: string } {
  const res = spawnSync('launchctl', args, { encoding: 'utf8', timeout: LAUNCHCTL_TIMEOUT_MS });
  if (res.error) return { ok: false, detail: res.error.message };
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0, detail: out || `exit ${res.status}` };
}

/** Remove the job (SIGTERM to a running daemon). Harmless when it is not loaded. */
export function bootoutLaunchdJob(label: string): void {
  launchctl(['bootout', `${domain()}/${label}`]);
}

/**
 * Load and start the job. A label that is already loaded — a daemon that
 * crashed, or one the caller found unresponsive — is booted out and loaded
 * again; the caller only gets here when the socket does not answer, so there
 * is nothing left to preserve.
 */
export function bootstrapLaunchdJob(label: string, plistPath: string): { ok: true } | { ok: false; error: string } {
  let res = launchctl(['bootstrap', domain(), plistPath]);
  if (!res.ok) {
    bootoutLaunchdJob(label);
    res = launchctl(['bootstrap', domain(), plistPath]);
  }
  return res.ok ? { ok: true } : { ok: false, error: res.detail };
}
