import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-profile-'));
  process.env.STRADO_HOME = tmp;
});
afterEach(() => {
  delete process.env.STRADO_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('profileStore', () => {
  it('returns defaults when the file is absent', async () => {
    const { readProfile } = await import('../../src/services/profileStore');
    expect(await readProfile()).toEqual({ fullName: '', callMe: '', telemetryOptOut: false });
  });

  it('writes a merged profile and reads it back at 0600', async () => {
    const { readProfile, writeProfile, profilePath } = await import('../../src/services/profileStore');
    const saved = await writeProfile({ fullName: 'Kamlesh Bishnoi', callMe: 'kamlesh' });
    expect(saved).toEqual({ fullName: 'Kamlesh Bishnoi', callMe: 'kamlesh', telemetryOptOut: false });
    expect(await readProfile()).toEqual(saved);
    const mode = (await fsp.stat(profilePath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('merges a partial patch over existing values', async () => {
    const { writeProfile } = await import('../../src/services/profileStore');
    await writeProfile({ fullName: 'Kamlesh Bishnoi', callMe: 'kamlesh' });
    const merged = await writeProfile({ telemetryOptOut: true });
    expect(merged).toEqual({ fullName: 'Kamlesh Bishnoi', callMe: 'kamlesh', telemetryOptOut: true });
  });

  it('falls back to defaults on malformed json', async () => {
    const { readProfile, profilePath } = await import('../../src/services/profileStore');
    await fsp.mkdir(path.dirname(profilePath()), { recursive: true });
    await fsp.writeFile(profilePath(), '{ not json');
    expect(await readProfile()).toEqual({ fullName: '', callMe: '', telemetryOptOut: false });
  });
});
