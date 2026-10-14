import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teeConsoleToLog } from '../src/daemon.js';
import { pairRunner, readIdentity, writeIdentity } from '../src/identity.js';
import { cmdInstallService, formatCliError, resolveApiUrl } from '../src/index.js';
import { applyBundleEnv, bundleVersion, loadEnvFile, runnerPaths } from '../src/paths.js';
import { DOWNLOAD_TIMEOUT_MS, FEED_TIMEOUT_MS, applyUpdate, download, fetchRunnerRelease, isNewer } from '../src/selfUpdate.js';
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

  it('strips trailing slashes from apiUrl when pairing and resolving', async () => {
    expect(resolveApiUrl('https://x.example///')).toBe('https://x.example');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ runnerId: 'box-1', runnerToken: 't'.repeat(64) }), { status: 200 }),
    );
    try {
      const id = await pairRunner({ apiUrl: 'https://x.example/', code: 'PAIR-1234-5678', name: 'box' });
      expect(fetchSpy).toHaveBeenCalledWith('https://x.example/v1/runners/pair', expect.anything());
      expect(id.apiUrl).toBe('https://x.example');
    } finally {
      fetchSpy.mockRestore();
    }
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

  it('strips leading v and returns false (logging) when either side parses to NaN', () => {
    expect(isNewer('v0.1.30', '0.1.30')).toBe(false);
    expect(isNewer('0.1.30', 'v0.1.30')).toBe(false);
    expect(isNewer('v0.1.31', '0.1.30')).toBe(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(isNewer('nightly-abc', '0.1.30')).toBe(false);
      expect(isNewer('0.1.30', 'custom-build')).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('passes AbortSignal.timeout to release feed (30s) and tarball download (10m)', async () => {
    expect(FEED_TIMEOUT_MS).toBe(30_000);
    expect(DOWNLOAD_TIMEOUT_MS).toBe(10 * 60 * 1000);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('tarball-bytes', { status: 200 }));
    try {
      await fetchRunnerRelease('https://api.strado.io');
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

      const dest = path.join(dir, 'bundle.tar.gz');
      await download('https://cdn.strado.io/bundle.tar.gz', dest);
      expect(timeoutSpy).toHaveBeenCalledWith(10 * 60 * 1000);
      expect(fetchSpy.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('refuses an update when <staging>/bin/node --version fails and keeps current', async () => {
    const { execFileSync } = await import('node:child_process');
    const crypto = await import('node:crypto');
    const p = runnerPaths();
    const prevTarget = path.join(p.versions, '0.1.0');
    fs.mkdirSync(prevTarget, { recursive: true });
    fs.symlinkSync(prevTarget, p.current);

    const srcBundle = path.join(dir, 'pkg', 'strado-runner');
    fs.mkdirSync(path.join(srcBundle, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(srcBundle, 'web'), { recursive: true });
    fs.writeFileSync(path.join(srcBundle, 'runner.mjs'), '');
    fs.writeFileSync(path.join(srcBundle, 'ptyd.cjs'), '');
    const brokenNode = path.join(srcBundle, 'bin', 'node');
    fs.writeFileSync(brokenNode, '#!/bin/sh\necho "GLIBC_2.99 not found" >&2\nexit 1\n', { mode: 0o755 });

    const archive = path.join(dir, 'release.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'pkg'), 'strado-runner']);
    const bytes = fs.readFileSync(archive);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    try {
      await expect(
        applyUpdate({ version: '0.1.1', url: 'https://cdn.strado.io/r.tar.gz', sha256 }, p, () => {}),
      ).rejects.toThrow(/node/i);
      expect(fs.readlinkSync(p.current)).toBe(prevTarget);
      expect(fs.existsSync(prevTarget)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
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

describe('CLI error formatting', () => {
  it('surfaces undici err.cause code and message alongside err.message', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.strado.io'), { code: 'ENOTFOUND' });
    const err = new TypeError('fetch failed', { cause });
    expect(formatCliError(err)).toBe('fetch failed: ENOTFOUND getaddrinfo ENOTFOUND api.strado.io');
  });

  it('prints plain err.message when there is no cause', () => {
    expect(formatCliError(new Error('pairing failed (404): no such code'))).toBe('pairing failed (404): no such code');
  });
});

describe('install-service', () => {
  it('installs the unit when unpaired but says it will start after pair instead of reporting started', () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      cmdInstallService({
        hasSystemd: () => true,
        captureLoginPath: () => '/usr/bin',
        writeUnit: () => '/home/u/.config/systemd/user/strado-runner.service',
        enableLinger: () => ({ ok: true, out: '' }),
        systemctl: () => ({ ok: true, out: '' }),
      });
      expect(logs.join('\n')).toContain('installed; it will start once you run strado-runner pair --code');
      expect(logs.join('\n')).not.toContain('service enabled and started');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints a hint about enable-linger and ssh (not su -) when systemctl fails to connect to bus', () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      cmdInstallService({
        hasSystemd: () => true,
        captureLoginPath: () => '/usr/bin',
        writeUnit: () => '/home/u/.config/systemd/user/strado-runner.service',
        enableLinger: () => ({ ok: true, out: '' }),
        systemctl: () => ({ ok: false, out: 'Failed to connect to bus: No medium found' }),
      });
      const output = logs.join('\n');
      expect(output).toContain('loginctl enable-linger $USER');
      expect(output).toContain('ssh');
      expect(output).toContain('su -');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('daemon log tee', () => {
  it('tees console output to logs/server.log when INVOCATION_ID is unset', async () => {
    delete process.env.INVOCATION_ID;
    const p = runnerPaths();
    const stop = teeConsoleToLog(p.logDir);
    try {
      console.log('[runner] hello world');
      console.error('[runner] oops', 42);
    } finally {
      await stop();
    }
    const content = fs.readFileSync(path.join(p.logDir, 'server.log'), 'utf8');
    expect(content).toContain('[runner] hello world');
    expect(content).toContain('[runner] oops 42');
  });

  it('skips file logging when running under systemd (INVOCATION_ID set)', async () => {
    process.env.INVOCATION_ID = 'systemd-123';
    const p = runnerPaths();
    const stop = teeConsoleToLog(p.logDir);
    await stop();
    expect(fs.existsSync(path.join(p.logDir, 'server.log'))).toBe(false);
  });
});
