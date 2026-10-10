import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchdEnabled, launchdLabel, launchdPlistPath, writeLaunchdPlist } from './launchd.js';

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-ld-')); });
afterEach(() => { fs.rmSync(stateDir, { recursive: true, force: true }); });

describe('launchd job definition', () => {
  it('is on for macOS only, and STRADO_PTYD_LAUNCHD=0 turns it off', () => {
    expect(launchdEnabled({})).toBe(process.platform === 'darwin');
    expect(launchdEnabled({ STRADO_PTYD_LAUNCHD: '0' })).toBe(false);
  });

  it('labels one job per stateDir, stable across calls', () => {
    expect(launchdLabel(stateDir)).toBe(launchdLabel(stateDir));
    expect(launchdLabel(stateDir)).not.toBe(launchdLabel(path.join(stateDir, 'other')));
    expect(launchdLabel(stateDir)).toMatch(/^io\.strado\.ptyd\.[0-9a-f]{10}$/);
  });

  it('writes the daemon command, log and a curated environment — never secrets', () => {
    const { label, plistPath } = writeLaunchdPlist({
      stateDir,
      execPath: '/opt/node',
      script: '/state/ptyd/bin/ptyd.cjs',
      socketPath: `${stateDir}/ptyd/ptyd.sock`,
      logPath: `${stateDir}/ptyd/ptyd.log`,
      env: { PATH: '/usr/bin:/bin', HOME: '/Users/me', STRADO_AGENT_TOKEN: 'hunter2', AWS_SECRET_ACCESS_KEY: 'nope' },
    });
    expect(plistPath).toBe(launchdPlistPath(stateDir));
    const text = fs.readFileSync(plistPath, 'utf8');
    expect(text).toContain(`<string>${label}</string>`);
    expect(text).toContain('<string>/opt/node</string>');
    expect(text).toContain('<string>/state/ptyd/bin/ptyd.cjs</string>');
    expect(text).toContain(`<string>--socket=${stateDir}/ptyd/ptyd.sock</string>`);
    expect(text).toContain(`<key>StandardErrorPath</key><string>${stateDir}/ptyd/ptyd.log</string>`);
    expect(text).toContain('<key>PATH</key><string>/usr/bin:/bin</string>');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('AWS_SECRET');
    expect(text).toContain('<key>KeepAlive</key><false/>');
    expect(text).toContain('<key>AbandonProcessGroup</key><true/>');
    expect(fs.statSync(plistPath).mode & 0o777).toBe(0o600);
    if (process.platform === 'darwin') {
      expect(execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' })).toContain('OK');
    }
  });

  it('escapes XML in paths', () => {
    const { plistPath } = writeLaunchdPlist({
      stateDir, execPath: '/a&b/node', script: '/x<y>/ptyd.cjs', socketPath: `${stateDir}/s`, logPath: `${stateDir}/l`, env: {},
    });
    const text = fs.readFileSync(plistPath, 'utf8');
    expect(text).toContain('/a&amp;b/node');
    expect(text).toContain('/x&lt;y&gt;/ptyd.cjs');
  });
});
