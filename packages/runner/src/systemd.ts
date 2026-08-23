// systemd --user unit management.
//
// A USER unit (plus linger) rather than a system service, because the runner
// must be able to do everything the human could: read their SSH keys and git
// config, and exec claude/codex/opencode with their credentials.
//
// THE PATH TRAP: systemd user services get a minimal environment — no
// ~/.zshrc, no nvm, no ~/.local/bin — which is exactly where the agent CLIs
// live. Without capturing the interactive PATH, remote terminals fail with
// "claude: command not found" and nothing explains why. So we snapshot the
// login shell's PATH into the unit, and `strado-runner env` re-snapshots it
// after the user installs a new CLI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UNIT_NAME = 'strado-runner.service';

export function unitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user', UNIT_NAME);
}

/**
 * The PATH a login shell would give the user. Falls back to the current
 * process PATH when the shell can't be interrogated (odd shells, containers).
 */
export function captureLoginPath(): string {
  const shell = process.env.SHELL || '/bin/sh';
  try {
    // -l so profile files run, -i so interactive-only rc files (.zshrc, where
    // nvm and asdf usually live) run too.
    const out = execFileSync(shell, ['-lic', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    if (out.includes('/')) return dedupePath(out);
  } catch {
    /* fall through */
  }
  return dedupePath(process.env.PATH || '/usr/local/bin:/usr/bin:/bin');
}

function dedupePath(value: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of value.split(':')) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }
  return parts.join(':');
}

export function renderUnit(opts: { execStart: string; pathValue: string; envFile: string }): string {
  return `[Unit]
Description=Strado runner
Documentation=https://strado.io
After=network-online.target

[Service]
Type=simple
ExecStart=${opts.execStart}
# Captured from the user's login shell at install time so agent CLIs (claude,
# codex, opencode) resolve; re-run 'strado-runner env' after installing a new one.
Environment=PATH=${opts.pathValue}
EnvironmentFile=-${opts.envFile}
Restart=always
RestartSec=3
# Exit 2 = "not paired yet". Restarting can't fix that (only a human running
# 'strado-runner pair' can), so don't spin every 3s filling the journal — the
# pair command starts the service itself once an identity exists.
RestartPreventExitStatus=2
# CRITICAL: signal ONLY the main process. systemd's default
# (KillMode=control-group) SIGKILLs everything in the unit's cgroup, which
# includes the detached ptyd daemon — that killed every agent session on
# restart and defeated the entire point of ptyd. KillMode=process leaves
# ptyd running, so the new process reattaches to live PTYs.
KillMode=process
TimeoutStopSec=15
KillSignal=SIGTERM

[Install]
WantedBy=default.target
`;
}

export function writeUnit(content: string): string {
  const file = unitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export function systemctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('systemctl', ['--user', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (e.stdout || e.stderr || e.message || '').trim() };
  }
}

export function hasSystemd(): boolean {
  return process.platform === 'linux' && fs.existsSync('/run/systemd/system');
}

/**
 * Without linger a user unit dies at logout and never starts at boot — the
 * whole point of a runner is that it's there without anyone logging in.
 */
export function enableLinger(): { ok: boolean; out: string } {
  try {
    const out = execFileSync('loginctl', ['enable-linger', os.userInfo().username], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, out: (e.stderr || e.message || '').trim() };
  }
}

export function lingerEnabled(): boolean {
  return fs.existsSync(path.join('/var/lib/systemd/linger', os.userInfo().username));
}
