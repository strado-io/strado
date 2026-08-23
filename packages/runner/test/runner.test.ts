import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIdentity, writeIdentity } from '../src/identity.js';
import { applyBundleEnv, bundleVersion, loadEnvFile, runnerPaths } from '../src/paths.js';
import { isNewer } from '../src/selfUpdate.js';
import { renderUnit } from '../src/systemd.js';

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-runner-'));
  process.env.STRADO_HOME = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('identity', () => {
  it('round-trips and writes 0600', () => {
    const file = path.join(dir, 'runner.json');
    writeIdentity(file, { runnerId: 'box-a1b2', runnerToken: 'f'.repeat(64), accessKey: 'a'.repeat(32), apiUrl: 'https://api.strado.io' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readIdentity(file)?.runnerId).toBe('box-a1b2');
  });

  it('treats malformed or partial identity as unpaired', () => {
    const file = path.join(dir, 'runner.json');
    fs.writeFileSync(file, '{ not json');
    expect(readIdentity(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ runnerId: 'box' }));
    expect(readIdentity(file)).toBeNull();
    expect(readIdentity(path.join(dir, 'nope.json'))).toBeNull();
  });
});

describe('paths', () => {
  it('derives the install layout from STRADO_HOME', () => {
    const p = runnerPaths();
    expect(p.home).toBe(dir);
    expect(p.root).toBe(path.join(dir, 'runner'));
    expect(p.current).toBe(path.join(dir, 'runner', 'current'));
    expect(p.identity).toBe(path.join(dir, 'runner.json'));
  });

  it('reports dev when the bundle has no version marker', () => {
    expect(bundleVersion(runnerPaths())).toBe('dev');
  });

  it('points the server at the running bundle without clobbering overrides', () => {
    const p = runnerPaths();
    // Fake a bundle dir containing web/ and ptyd.cjs.
    fs.mkdirSync(path.join(p.bundleDir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(p.bundleDir, 'ptyd.cjs'), '');
    try {
      process.env.STRADO_WEB_DIST = '/operator/override';
      delete process.env.STRADO_PTYD_SCRIPT;
      applyBundleEnv(p);
      expect(process.env.STRADO_WEB_DIST).toBe('/operator/override');
      expect(process.env.STRADO_PTYD_SCRIPT).toBe(path.join(p.bundleDir, 'ptyd.cjs'));
    } finally {
      fs.rmSync(path.join(p.bundleDir, 'web'), { recursive: true, force: true });
      fs.rmSync(path.join(p.bundleDir, 'ptyd.cjs'), { force: true });
    }
  });

  it('points the server at the staged sandbox assets + hooks when they exist', () => {
    const p = runnerPaths();
    const sandboxAssets = path.join(p.bundleDir, 'assets', 'sandbox');
    const hooks = path.join(p.bundleDir, 'hooks');
    fs.mkdirSync(sandboxAssets, { recursive: true });
    fs.mkdirSync(hooks, { recursive: true });
    try {
      delete process.env.STRADO_SANDBOX_ASSETS;
      delete process.env.STRADO_HOOKS_DIR;
      applyBundleEnv(p);
      expect(process.env.STRADO_SANDBOX_ASSETS).toBe(sandboxAssets);
      expect(process.env.STRADO_HOOKS_DIR).toBe(hooks);
    } finally {
      fs.rmSync(path.join(p.bundleDir, 'assets'), { recursive: true, force: true });
      fs.rmSync(hooks, { recursive: true, force: true });
      delete process.env.STRADO_SANDBOX_ASSETS;
      delete process.env.STRADO_HOOKS_DIR;
    }
  });

  it('leaves sandbox assets + hooks unset when the bundle lacks them (dev)', () => {
    const p = runnerPaths();
    // Ensure neither staged dir exists beside the source module.
    fs.rmSync(path.join(p.bundleDir, 'assets'), { recursive: true, force: true });
    fs.rmSync(path.join(p.bundleDir, 'hooks'), { recursive: true, force: true });
    delete process.env.STRADO_SANDBOX_ASSETS;
    delete process.env.STRADO_HOOKS_DIR;
    applyBundleEnv(p);
    expect(process.env.STRADO_SANDBOX_ASSETS).toBeUndefined();
    expect(process.env.STRADO_HOOKS_DIR).toBeUndefined();
  });

  it('reads runner.env without overriding the real environment', () => {
    const file = path.join(dir, 'runner.env');
    fs.writeFileSync(file, '# comment\nPORT=8123\nRELAY_URL="wss://staging.example"\nSTRADO_HOME=/should-not-win\n');
    loadEnvFile(file);
    expect(process.env.PORT).toBe('8123');
    expect(process.env.RELAY_URL).toBe('wss://staging.example');
    expect(process.env.STRADO_HOME).toBe(dir); // already set — file must not win
  });
});

describe('update version comparison', () => {
  it('upgrades forward only', () => {
    expect(isNewer('0.1.23', '0.1.22')).toBe(true);
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.22', '0.1.22')).toBe(false);
    expect(isNewer('0.1.21', '0.1.22')).toBe(false);
  });

  it('never auto-updates a dev bundle', () => {
    // Otherwise a developer running from source gets their checkout replaced
    // by a published tarball.
    expect(isNewer('9.9.9', 'dev')).toBe(false);
  });

  it('will not drag an unreleased -dev build back to the last release', () => {
    // A dogfood box hand-built at 0.1.25-dev must not have the published 0.1.24
    // installed over it by the background updater. This works because parseInt
    // truncates the suffix, so 0.1.25-dev compares as 0.1.25 — load-bearing, and
    // silent enough to deserve pinning.
    expect(isNewer('0.1.24', '0.1.25-dev')).toBe(false);
    // The consequence of that truncation, stated so it isn't a surprise: a real
    // 0.1.25 compares EQUAL and will not auto-install either. A -dev box has
    // left the auto-update track until it is rebuilt or reinstalled.
    expect(isNewer('0.1.25', '0.1.25-dev')).toBe(false);
    expect(isNewer('0.1.26', '0.1.25-dev')).toBe(true);
  });
});

describe('systemd unit', () => {
  const unit = () =>
    renderUnit({ execStart: '/home/u/.strado/runner/bin/strado-runner', pathValue: '/opt/node/bin:/usr/bin', envFile: '/home/u/.strado/runner.env' });

  it('carries the captured PATH so agent CLIs resolve', () => {
    expect(unit()).toContain('Environment=PATH=/opt/node/bin:/usr/bin');
  });

  it('execs through the current symlink, not a versioned path', () => {
    // An upgrade swaps `current`; a versioned ExecStart would pin the unit to
    // the old bundle forever.
    expect(unit()).toContain('ExecStart=/home/u/.strado/runner/bin/strado-runner');
    expect(unit()).not.toMatch(/ExecStart=.*versions/);
  });

  it('tolerates a missing env file and restarts on failure', () => {
    expect(unit()).toContain('EnvironmentFile=-/home/u/.strado/runner.env');
    expect(unit()).toContain('Restart=always');
    expect(unit()).toContain('WantedBy=default.target');
  });

  it('does not restart-loop an unpaired runner', () => {
    // Observed on the first real install: 6 restarts in 18s, each printing
    // "no runner identity". Only a human can fix that, so exit 2 must be
    // excluded from the restart policy.
    expect(unit()).toContain('RestartPreventExitStatus=2');
  });
});
