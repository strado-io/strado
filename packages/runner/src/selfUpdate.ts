// Runner self-update: poll /v1/release, unpack beside the running version,
// swap the `current` symlink, restart the unit. Agent sessions survive because
// the PTYs live in ptyd, not in this process.
//
// Discipline copied from the desktop updater's scars (a past brick bug):
// verify the hash BEFORE the swap, never mutate a live directory in place,
// keep the previous version for rollback, and single-flight the whole thing.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RunnerPaths } from './paths.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000;
/** Back off after repeated failures instead of hot-looping the feed. */
const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;

export interface RunnerRelease {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

export async function fetchRunnerRelease(apiUrl: string): Promise<RunnerRelease | null> {
  const res = await fetch(`${apiUrl}/v1/release`);
  if (res.status === 204 || !res.ok) return null;
  const feed = (await res.json()) as { runner?: RunnerRelease };
  const runner = feed.runner;
  if (!runner?.version || !runner.url || !runner.sha256) return null;
  return runner;
}

/** Semver-ish compare; falls back to inequality so odd tags still update once. */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate === current) return false;
  if (current === 'dev') return false; // never auto-update a dev checkout
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));
  const a = parse(candidate);
  const b = parse(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const hash = crypto.createHash('sha256');
  const file = fs.createWriteStream(dest);
  await pipeline(
    // Tee the bytes through the hasher so we never read the file twice.
    (async function* () {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          hash.update(value);
          yield value;
        }
      }
    })(),
    file,
  );
  return hash.digest('hex');
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

export async function applyUpdate(release: RunnerRelease, paths: RunnerPaths, log: (l: string) => void): Promise<void> {
  const staging = path.join(paths.versions, `.staging-${release.version}`);
  const target = path.join(paths.versions, release.version);
  const tarball = path.join(paths.versions, `.download-${release.version}.tar.gz`);
  await fsp.mkdir(paths.versions, { recursive: true });
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.rm(tarball, { force: true });

  log(`downloading ${release.version}`);
  const sha = await download(release.url, tarball);
  if (sha !== release.sha256) {
    await fsp.rm(tarball, { force: true });
    throw new Error(`sha256 mismatch: expected ${release.sha256}, got ${sha}`);
  }

  await fsp.mkdir(staging, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', staging, '--strip-components=1']);
  await fsp.rm(tarball, { force: true });

  // Structural check before anything becomes reachable: a hollow bundle that
  // wins the symlink swap is the failure mode that bricked desktop installs.
  for (const required of ['runner.mjs', 'ptyd.cjs', path.join('bin', 'node'), 'web']) {
    if (!fs.existsSync(path.join(staging, required))) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw new Error(`staged bundle is missing ${required}`);
    }
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(staging, target);

  // Atomic-ish swap: write a temp symlink, then rename over `current`.
  const tmpLink = `${paths.current}.next`;
  await fsp.rm(tmpLink, { force: true });
  await fsp.symlink(target, tmpLink);
  await fsp.rename(tmpLink, paths.current);
  log(`installed ${release.version}; restarting`);

  await pruneOldVersions(paths, release.version, log);

  // Refresh the systemd unit from the NEW bundle, preserving the captured
  // PATH. Without this, unit-level fixes never reach existing installs —
  // exactly what happened with KillMode=process, whose absence killed every
  // agent session on restart.
  await refreshUnit(target, log);

  // systemd restarts us; the exit code says "intentional".
  try {
    await run('systemctl', ['--user', 'restart', 'strado-runner']);
  } catch {
    // Not under systemd (manual run): exit and let whatever supervises us
    // bring the new version up.
    log('not managed by systemd — exiting so a supervisor can restart');
    process.exit(0);
  }
}

/**
 * Rewrite the unit with this build's template, keeping the existing
 * Environment=PATH line (it was captured from the user's login shell and must
 * not be re-derived from systemd's minimal env).
 */
async function refreshUnit(_versionDir: string, log: (l: string) => void): Promise<void> {
  const { renderUnit, unitPath, writeUnit, systemctl } = await import('./systemd.js');
  const file = unitPath();
  let existing: string;
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    return; // not systemd-managed
  }
  const pathValue = /^Environment=PATH=(.*)$/m.exec(existing)?.[1];
  const execStart = /^ExecStart=(.*)$/m.exec(existing)?.[1];
  const envFile = /^EnvironmentFile=-(.*)$/m.exec(existing)?.[1];
  if (!pathValue || !execStart || !envFile) return;
  const next = renderUnit({ execStart, pathValue, envFile });
  if (next === existing) return;
  writeUnit(next);
  systemctl(['daemon-reload']);
  log('systemd unit refreshed');
}

/** Keep the new version plus one previous generation for rollback. */
async function pruneOldVersions(paths: RunnerPaths, keep: string, log: (l: string) => void): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(paths.versions);
  } catch {
    return;
  }
  const versions = entries.filter((e) => !e.startsWith('.')).sort((a, b) => (isNewer(a, b) ? 1 : -1));
  const doomed = versions.filter((v) => v !== keep).slice(0, Math.max(0, versions.length - 2));
  for (const v of doomed) {
    await fsp.rm(path.join(paths.versions, v), { recursive: true, force: true }).catch(() => {});
    log(`pruned old version ${v}`);
  }
}

export function startSelfUpdate(opts: {
  apiUrl: string;
  currentVersion: string;
  paths: RunnerPaths;
  log?: (line: string) => void;
}): () => void {
  const log = opts.log ?? ((l: string) => console.log(`[update] ${l}`));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let failures = 0;
  let stopped = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const release = await fetchRunnerRelease(opts.apiUrl);
      if (release && isNewer(release.version, opts.currentVersion)) {
        await applyUpdate(release, opts.paths, log);
      }
      failures = 0;
    } catch (err) {
      failures++;
      log(`update check failed (${failures}): ${(err as Error).message}`);
    } finally {
      busy = false;
      schedule();
    }
  };

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(POLL_INTERVAL_MS * 2 ** Math.min(failures, 5), MAX_BACKOFF_MS);
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
