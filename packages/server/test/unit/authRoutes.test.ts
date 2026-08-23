import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LicenseSchema, readLicense } from '../../src/services/licenseFile.js';

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-home-'));
  prev = process.env.STRADO_HOME;
  process.env.STRADO_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('license file after login', () => {
  it('accepts a login license with no invite code', () => {
    const parsed = LicenseSchema.parse({
      token: 'a'.repeat(64), name: 'Kamlesh', deviceId: 'device-abcdefgh', email: 'a@b.com',
    });
    expect(parsed.code).toBeUndefined();
    expect(parsed.email).toBe('a@b.com');
  });

  it('still accepts an invite-code license — 7 of these are live', () => {
    const parsed = LicenseSchema.parse({
      code: 'STRADO-AAAA-BBBB', token: 'a'.repeat(64), name: 'Kamlesh', deviceId: 'device-abcdefgh',
    });
    expect(parsed.code).toBe('STRADO-AAAA-BBBB');
  });

  it('reads a login license off disk rather than reporting not-activated', async () => {
    fs.writeFileSync(
      path.join(home, 'license.json'),
      JSON.stringify({ token: 'b'.repeat(64), name: 'K', deviceId: 'device-abcdefgh', email: 'a@b.com' }),
    );
    // The trap: a required `code` made this return null, and the parse failure is
    // swallowed — so a signed-in app would look unactivated with no error.
    const lic = await readLicense();
    expect(lic).not.toBeNull();
    expect(lic!.email).toBe('a@b.com');
  });

  it('rejects a license with neither a code nor an email', () => {
    expect(() =>
      LicenseSchema.parse({ token: 'a'.repeat(64), name: 'K', deviceId: 'device-abcdefgh' }),
    ).toThrow();
  });
});
