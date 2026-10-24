#!/usr/bin/env node
// strado-runner — the self-hosted runner CLI/daemon.
//
//   strado-runner                    run in foreground (what systemd invokes)
//   strado-runner pair --code …      claim this box for an account (--code - reads stdin)
//   strado-runner status             identity, tunnel, sessions, version
//   strado-runner install-service    write + enable the systemd user unit
//   strado-runner env                re-capture PATH into the unit, restart
//   strado-runner logs [-f]          tail the runner log
//   strado-runner update             check for an update now
//   strado-runner unpair             forget this box's identity
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runDaemon } from './daemon.js';
import { defaultRunnerName, pairRunner, readIdentity, writeIdentity } from './identity.js';
import { applyBundleEnv, bundleVersion, loadEnvFile, runnerPaths } from './paths.js';
import { applyUpdate, fetchRunnerRelease, isNewer } from './selfUpdate.js';
import { applyProxyFromEnv } from './proxy.js';
import {
  UNIT_NAME,
  captureLoginPath,
  enableLinger,
  hasSystemd,
  lingerEnabled,
  renderUnit,
  systemctl,
  unitPath,
  writeUnit,
} from './systemd.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`) || process.argv.includes(`-${name[0]}`);

// `strado-runner status | head` closes stdout while async output is still
// pending; an unhandled EPIPE crashed the CLI with a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

export function resolveApiUrl(
  cliApi = arg('api'),
  envApi = process.env.STRADO_API_URL,
  identityApi = readIdentity(paths.identity)?.apiUrl,
): string {
  return (cliApi ?? envApi ?? identityApi ?? 'https://api.strado.io').replace(/\/+$/, '');
}

const paths = runnerPaths();
loadEnvFile(paths.envFile);
// After the env file: a proxy configured in runner.env must reach pair/update too.
applyProxyFromEnv();
const apiUrl = resolveApiUrl();

/** What laptops synced to this box: tied to its owner, not to the box. */
export function wipeSyncedLogins(home: string): void {
  for (const f of ['agent-logins-runner.json', 'runner-sender-pin.json']) fs.rmSync(path.join(home, f), { force: true });
}

export async function cmdPair(
  deps: {
    pairRunner: typeof pairRunner;
    readStdin: () => string;
    /** null when there was nothing to restart; otherwise whether it worked. */
    restartService: () => boolean | null;
    log: (line: string) => void;
  } = {
    pairRunner,
    readStdin: () => fs.readFileSync(0, 'utf8'),
    restartService: () => (hasSystemd() && fs.existsSync(unitPath()) ? systemctl(['restart', UNIT_NAME]).ok : null),
    log: (line) => console.log(line),
  },
): Promise<void> {
  const p = runnerPaths();
  // `--code -` takes it from stdin, so a setup driven over ssh never puts it
  // in argv, shell history or `ps`.
  const raw = arg('code');
  if (!raw) {
    console.error('usage: strado-runner pair --code PAIR-XXXX-XXXX|- [--name <name>] [--api <url>] [--force]');
    process.exit(1);
  }
  const code = raw === '-' ? deps.readStdin().trim() : raw;
  if (!code) throw new Error('no pairing code on stdin');
  const force = flag('force');
  const existing = readIdentity(p.identity);
  if (existing && !force) {
    console.error(
      `this box is already paired as "${existing.runnerId}".\n` +
        'Re-pair with --force (the old identity stops working only when you revoke it from your account).',
    );
    process.exit(1);
  }
  const identity = await deps.pairRunner({
    apiUrl,
    code,
    name: arg('name') ?? defaultRunnerName(),
    runnerVersion: bundleVersion(p),
  });
  // A new identity on this box — first pair, after an unpair, or a --force to
  // another account — may be a new owner. What the previous owner synced must
  // not outlive that: their Claude token would log the new owner's sandboxes
  // in as them, and their laptop pin would refuse the new owner's sync. Only
  // after the pair succeeded, so a failed one keeps the box as it was; and not
  // for a re-pair that lands on the same runner id.
  if (existing?.runnerId !== identity.runnerId) wipeSyncedLogins(p.home);
  writeIdentity(p.identity, identity);
  deps.log(`paired as "${identity.runnerId}" — identity saved to ${p.identity}`);
  // Machine-readable, on its own line, for a setup driving this over ssh.
  deps.log(`runnerId=${identity.runnerId}`);
  const restarted = deps.restartService();
  if (restarted === null) deps.log('start the runner with: strado-runner install-service   (or: strado-runner)');
  else deps.log(restarted ? 'runner service restarted' : `start it yourself: systemctl --user restart ${UNIT_NAME}`);
}

async function cmdStatus(): Promise<void> {
  const identity = readIdentity(paths.identity);
  console.log(`version:  ${bundleVersion(paths)}`);
  console.log(`identity: ${identity ? `${identity.runnerId} (${paths.identity})` : 'NOT PAIRED'}`);
  if (!identity) {
    console.log('\npair this box:  strado-runner pair --code PAIR-XXXX-XXXX');
    return;
  }
  console.log(`api:      ${identity.apiUrl}`);
  console.log(`relay:    ${process.env.RELAY_URL ?? 'wss://api.strado.io'}`);

  if (hasSystemd()) {
    const active = systemctl(['is-active', UNIT_NAME]);
    console.log(`service:  ${active.out || 'not installed'}${lingerEnabled() ? ' (linger on)' : ' (LINGER OFF — dies at logout)'}`);
  }

  // Presence as the cloud sees it — the runner's own opinion is not evidence.
  try {
    const res = await fetch(`${identity.apiUrl}/v1/runners/self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runnerId: identity.runnerId, runnerToken: identity.runnerToken }),
    });
    if (res.status === 403) console.log('cloud:    REVOKED or unknown (re-pair this box)');
    else if (!res.ok) console.log(`cloud:    error (${res.status})`);
    else {
      const body = (await res.json()) as { online: boolean; revoked: boolean };
      console.log(`cloud:    ${body.revoked ? 'REVOKED' : body.online ? 'online' : 'offline'}`);
    }
  } catch {
    console.log('cloud:    unreachable');
  }

  const port = Number(process.env.PORT ?? 7777);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await res.json()) as { sessions?: number };
    console.log(`local:    up on :${port}${body.sessions != null ? `, ${body.sessions} live session(s)` : ''}`);
  } catch {
    console.log(`local:    not listening on :${port}`);
  }
}

export function cmdInstallService(
  deps = { hasSystemd, captureLoginPath, writeUnit, enableLinger, systemctl },
): void {
  if (!deps.hasSystemd()) {
    console.error('systemd not available — run the runner under your own supervisor:\n  strado-runner');
    process.exit(1);
  }
  const currentPaths = runnerPaths();
  const paired = Boolean(readIdentity(currentPaths.identity));
  // Always exec through `current`, never this bundle's own path: after an
  // upgrade the unit must point at the new version without being rewritten.
  const shim = path.join(currentPaths.binDir, 'strado-runner');
  const execStart = fs.existsSync(shim)
    ? shim
    : `${process.execPath} ${path.join(currentPaths.bundleDir, 'runner.mjs')}`;
  const file = deps.writeUnit(renderUnit({ execStart, pathValue: deps.captureLoginPath(), envFile: currentPaths.envFile }));
  console.log(`wrote ${file}`);

  const linger = deps.enableLinger();
  console.log(linger.ok ? 'linger enabled (starts at boot, survives logout)' : `WARNING: enable-linger failed: ${linger.out}`);
  deps.systemctl(['daemon-reload']);
  const enabled = deps.systemctl(paired ? ['enable', '--now', UNIT_NAME] : ['enable', UNIT_NAME]);
  if (!enabled.ok) {
    console.log(`failed to start: ${enabled.out}`);
    if (enabled.out.includes('Failed to connect to bus')) {
      console.log('hint: run `loginctl enable-linger $USER` and log in via ssh (not `su -`) so the user bus is active');
    }
  } else if (paired) {
    console.log('service enabled and started');
  } else {
    console.log('installed; it will start once you run strado-runner pair --code …');
  }
  console.log(`\nlogs: journalctl --user -u ${UNIT_NAME} -f`);
}

function cmdEnv(): void {
  if (!fs.existsSync(unitPath())) {
    console.error(`no unit at ${unitPath()} — run: strado-runner install-service`);
    process.exit(1);
  }
  const current = fs.readFileSync(unitPath(), 'utf8');
  const execStart = /^ExecStart=(.*)$/m.exec(current)?.[1] ?? path.join(paths.binDir, 'strado-runner');
  const pathValue = captureLoginPath();
  writeUnit(renderUnit({ execStart, pathValue, envFile: paths.envFile }));
  systemctl(['daemon-reload']);
  const r = systemctl(['restart', UNIT_NAME]);
  console.log(`PATH re-captured (${pathValue.split(':').length} entries)`);
  console.log(r.ok ? 'service restarted' : `restart failed: ${r.out}`);
}

function cmdLogs(): void {
  if (hasSystemd() && fs.existsSync(unitPath())) {
    const args = ['--user', '-u', UNIT_NAME, '-n', '200'];
    if (flag('follow')) args.push('-f');
    spawn('journalctl', args, { stdio: 'inherit' });
    return;
  }
  const log = path.join(paths.logDir, 'server.log');
  if (!fs.existsSync(log)) {
    console.error(`no logs yet (looked for the unit and ${log})`);
    process.exit(1);
  }
  spawn('tail', [flag('follow') ? '-f' : '-n200', log], { stdio: 'inherit' });
}

async function cmdUpdate(): Promise<void> {
  const version = bundleVersion(paths);
  const release = await fetchRunnerRelease(apiUrl);
  if (!release) {
    console.log('no runner release published');
    return;
  }
  if (!isNewer(release.version, version)) {
    console.log(`up to date (${version}${version === 'dev' ? ' — dev bundles never auto-update' : ''})`);
    return;
  }
  console.log(`updating ${version} → ${release.version}`);
  await applyUpdate(release, paths, (l) => console.log(`[update] ${l}`));
}

export function cmdUnpair(): void {
  const p = runnerPaths();
  const identity = readIdentity(p.identity);
  if (!identity) {
    console.log('not paired');
    return;
  }
  if (hasSystemd() && fs.existsSync(unitPath())) systemctl(['stop', UNIT_NAME]);
  fs.rmSync(p.identity, { force: true });
  wipeSyncedLogins(p.home);
  console.log(`forgot identity "${identity.runnerId}" and the logins synced to it.`);
  console.log('IMPORTANT: also revoke it from your account, or the credential stays valid on any copy of this file.');
}

export function formatCliError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const message = e?.message ?? String(err);
  const cause = e?.cause && typeof e.cause === 'object' ? e.cause : undefined;
  return `${message}${cause ? `: ${cause.code ?? ''} ${cause.message ?? ''}`.trimEnd() : ''}`;
}

if (!process.env.VITEST) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'pair') await cmdPair();
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'install-service') cmdInstallService();
    else if (cmd === 'env') cmdEnv();
    else if (cmd === 'logs') cmdLogs();
    else if (cmd === 'update') await cmdUpdate();
    else if (cmd === 'unpair') cmdUnpair();
    else if (cmd === 'version' || cmd === '--version') console.log(bundleVersion(paths));
    else if (cmd && cmd !== 'run' && cmd !== '--port' && !cmd.startsWith('--')) {
      console.error(`unknown command "${cmd}" — try: pair, status, install-service, env, logs, update, unpair`);
      process.exit(1);
    } else {
      applyBundleEnv(paths);
      await runDaemon();
    }
  } catch (err) {
    console.error(formatCliError(err));
    process.exit(1);
  }
}
