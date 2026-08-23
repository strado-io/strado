// Install layout:
//
//   ~/.strado/runner/
//   ├── versions/<v>/{bin/node, runner.mjs, ptyd.cjs, web/, hooks/, node_modules/}
//   ├── current -> versions/<v>        atomic upgrade = swap this symlink
//   └── bin/strado-runner              shim: exec current/bin/node current/runner.mjs
//
// The bundle self-locates from import.meta.url so nothing needs configuring:
// a runner started from versions/0.1.23 serves that version's web dist and
// ptyd, even while `current` points elsewhere mid-upgrade.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunnerPaths {
  /** ~/.strado (or STRADO_HOME) */
  home: string;
  /** ~/.strado/runner */
  root: string;
  versions: string;
  current: string;
  binDir: string;
  /** M2 identity file */
  identity: string;
  envFile: string;
  logDir: string;
  /** Directory of the RUNNING bundle (…/versions/<v>), not `current`. */
  bundleDir: string;
}

export function runnerPaths(): RunnerPaths {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  const root = path.join(home, 'runner');
  // dist/paths.js in dev, runner.mjs's dir once bundled — both sit at the
  // bundle root's top level, so one dirname is right in both cases.
  const bundleDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    home,
    root,
    versions: path.join(root, 'versions'),
    current: path.join(root, 'current'),
    binDir: path.join(root, 'bin'),
    identity: path.join(home, 'runner.json'),
    envFile: path.join(home, 'runner.env'),
    logDir: path.join(home, 'logs'),
    bundleDir,
  };
}

/** Version of the running bundle; 'dev' when the marker file is absent. */
export function bundleVersion(paths: RunnerPaths): string {
  try {
    return fs.readFileSync(path.join(paths.bundleDir, 'version'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * Point the server at THIS bundle's assets unless the operator overrode them.
 * Keeps the systemd unit free of paths that would go stale after an upgrade.
 */
export function applyBundleEnv(paths: RunnerPaths): void {
  const web = path.join(paths.bundleDir, 'web');
  const ptyd = path.join(paths.bundleDir, 'ptyd.cjs');
  const sandboxAssets = path.join(paths.bundleDir, 'assets', 'sandbox');
  const hooks = path.join(paths.bundleDir, 'hooks');
  if (!process.env.STRADO_WEB_DIST && fs.existsSync(web)) process.env.STRADO_WEB_DIST = web;
  if (!process.env.STRADO_PTYD_SCRIPT && fs.existsSync(ptyd)) process.env.STRADO_PTYD_SCRIPT = ptyd;
  // Base-image Dockerfile (image.ts) and the container hooks bind-mount
  // (claudeHooks.ts) both self-locate from these; a packaged runner stages them
  // beside the bundle, so point at that copy unless the operator overrode it.
  if (!process.env.STRADO_SANDBOX_ASSETS && fs.existsSync(sandboxAssets))
    process.env.STRADO_SANDBOX_ASSETS = sandboxAssets;
  if (!process.env.STRADO_HOOKS_DIR && fs.existsSync(hooks)) process.env.STRADO_HOOKS_DIR = hooks;
  if (!process.env.STRADO_HOME) process.env.STRADO_HOME = paths.home;
}

/** Minimal KEY=VALUE reader for runner.env (existing process env wins). */
export function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
