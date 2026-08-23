import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { licenseState, recordVerification, GRACE_MS } from '../../src/services/licenseState.js';

function writeLicense(home: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'license.json'),
    JSON.stringify({ token: 'a'.repeat(64), name: 'Kam', deviceId: 'device-0001', email: 'k@example.com', ...extra }),
  );
}

describe('licenseState', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
    process.env.STRADO_HOME = home;
  });

  it('reports none when there is no license at all', async () => {
    expect((await licenseState(new Date())).status).toBe('none');
  });

  it('reports ok inside the grace window', async () => {
    const now = new Date('2026-08-10T00:00:00Z');
    writeLicense(home, { lastVerifiedAt: new Date(now.getTime() - GRACE_MS + 60_000).toISOString() });
    expect((await licenseState(now)).status).toBe('ok');
  });

  it('reports stale once the grace window has passed', async () => {
    const now = new Date('2026-08-10T00:00:00Z');
    writeLicense(home, { lastVerifiedAt: new Date(now.getTime() - GRACE_MS - 60_000).toISOString() });
    expect((await licenseState(now)).status).toBe('stale');
  });

  it('treats a license with no lastVerifiedAt as ok, not stale', async () => {
    // Every install in the field today predates the field. Treating its
    // absence as expiry would lock out every existing user on upgrade.
    writeLicense(home);
    expect((await licenseState(new Date())).status).toBe('ok');
  });

  it('reports none for a malformed license rather than throwing', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'license.json'), '{ not json');
    expect((await licenseState(new Date())).status).toBe('none');
  });

  it('stamps the license when the cloud confirms it', async () => {
    writeLicense(home);
    const now = new Date('2026-08-10T00:00:00Z');
    await recordVerification(now);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'license.json'), 'utf8'));
    expect(saved.lastVerifiedAt).toBe(now.toISOString());
    // The token must survive being re-written, or the app logs itself out.
    expect(saved.token).toBe('a'.repeat(64));
  });

  it('does nothing when there is no license to stamp', async () => {
    await expect(recordVerification(new Date())).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(home, 'license.json'))).toBe(false);
  });

  it('keeps the file at mode 0600', async () => {
    writeLicense(home);
    await recordVerification(new Date());
    const mode = fs.statSync(path.join(home, 'license.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
