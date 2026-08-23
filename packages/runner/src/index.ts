#!/usr/bin/env node
// strado-runner — the self-hosted runner CLI/daemon.
//
//   strado-runner                    run in foreground (what systemd invokes)
//   strado-runner pair --code …      claim this box for an account
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

const paths = runnerPaths();
loadEnvFile(paths.envFile);
const apiUrl = arg('api') ?? process.env.STRADO_API_URL ?? readIdentity(paths.identity)?.apiUrl ?? 'https://api.strado.io';

async function cmdPair(): Promise<void> {
  const code = arg('code');
  if (!code) {
    console.error('usage: strado-runner pair --code PAIR-XXXX-XXXX [--name <name>] [--api <url>]');
    process.exit(1);
  }
  const existing = readIdentity(paths.identity);
  if (existing && !flag('force')) {
    console.error(
      `this box is already paired as "${existing.runnerId}".\n` +
        'Re-pair with --force (the old identity stops working only when you revoke it from your account).',
    );
    process.exit(1);
  }
  const identity = await pairRunner({
    apiUrl,
    code,
    name: arg('name') ?? defaultRunnerName(),
    runnerVersion: bundleVersion(paths),
  });
  writeIdentity(paths.identity, identity);
  console.log(`paired as "${identity.runnerId}" — identity saved to ${paths.identity}`);
  if (hasSystemd() && fs.existsSync(unitPath())) {
    const r = systemctl(['restart', UNIT_NAME]);
    console.log(r.ok ? 'runner service restarted' : `start it yourself: systemctl --user restart ${UNIT_NAME}`);
  } else {
    console.log('start the runner with: strado-runner install-service   (or: strado-runner)');
  }
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

function cmdInstallService(): void {
  if (!hasSystemd()) {
    console.error('systemd not available — run the runner under your own supervisor:\n  strado-runner');
    process.exit(1);
  }
  // Always exec through `current`, never this bundle's own path: after an
  // upgrade the unit must point at the new version without being rewritten.
  const shim = path.join(paths.binDir, 'strado-runner');
  const execStart = fs.existsSync(shim)
    ? shim
    : `${process.execPath} ${path.join(paths.bundleDir, 'runner.mjs')}`;
  const file = writeUnit(renderUnit({ execStart, pathValue: captureLoginPath(), envFile: paths.envFile }));
  console.log(`wrote ${file}`);

  const linger = enableLinger();
  console.log(linger.ok ? 'linger enabled (starts at boot, survives logout)' : `WARNING: enable-linger failed: ${linger.out}`);
  systemctl(['daemon-reload']);
  const enabled = systemctl(['enable', '--now', UNIT_NAME]);
  console.log(enabled.ok ? 'service enabled and started' : `failed to start: ${enabled.out}`);
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

function cmdUnpair(): void {
  const identity = readIdentity(paths.identity);
  if (!identity) {
    console.log('not paired');
    return;
  }
  if (hasSystemd() && fs.existsSync(unitPath())) systemctl(['stop', UNIT_NAME]);
  fs.rmSync(paths.identity, { force: true });
  console.log(`forgot identity "${identity.runnerId}".`);
  console.log('IMPORTANT: also revoke it from your account, or the credential stays valid on any copy of this file.');
}

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
  console.error((err as Error).message);
  process.exit(1);
}
