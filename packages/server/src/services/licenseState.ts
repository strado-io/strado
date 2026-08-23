import fsp from 'node:fs/promises';
import { licensePath, readLicense } from './licenseFile.js';

/** Seven days: long enough for a normal offline stretch, short enough that
 *  revoking a device actually means something. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type LicenseState =
  | { status: 'ok' }
  | { status: 'none' }
  | { status: 'stale'; since: string };

export async function licenseState(now: Date): Promise<LicenseState> {
  const license = await readLicense();
  if (!license) return { status: 'none' };
  // No timestamp means the license predates the field. Treating that as
  // expired would lock out every install in the field the moment they update.
  if (!license.lastVerifiedAt) return { status: 'ok' };
  const age = now.getTime() - new Date(license.lastVerifiedAt).getTime();
  if (age > GRACE_MS) return { status: 'stale', since: license.lastVerifiedAt };
  return { status: 'ok' };
}

/**
 * Records that the cloud confirmed this device, restarting the grace window.
 *
 * Re-writes the whole file rather than patching it, so the shape always matches
 * LicenseSchema. Mode 0600 is re-asserted on every write: this file holds the
 * plaintext device token, and inheriting a loose umask once would leak it.
 */
export async function recordVerification(now: Date): Promise<void> {
  const license = await readLicense();
  if (!license) return; // nothing to stamp; not an error
  const next = { ...license, lastVerifiedAt: now.toISOString() };
  // The `mode` option on writeFile only applies when the call creates the file;
  // this file already exists, so its permissions must be reasserted explicitly
  // or they'd stay whatever they were (and inherit the process umask if not).
  await fsp.writeFile(licensePath(), JSON.stringify(next, null, 2));
  await fsp.chmod(licensePath(), 0o600);
}
