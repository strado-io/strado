import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { z } from 'zod';

// Device-global user profile — name + how agents should address you, plus the
// telemetry opt-out. Plain JSON under ~/.strado (the renderer can't write
// files), mirroring jira.ts / license.ts. Honors STRADO_HOME so throwaway
// instances stay isolated.
const ProfileSchema = z.object({
  fullName: z.string().max(120).default(''),
  callMe: z.string().max(120).default(''),
  telemetryOptOut: z.boolean().default(false),
});

export type Profile = z.infer<typeof ProfileSchema>;

const DEFAULTS: Profile = { fullName: '', callMe: '', telemetryOptOut: false };

export function profilePath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'profile.json');
}

export async function readProfile(): Promise<Profile> {
  try {
    const raw = await fsp.readFile(profilePath(), 'utf8');
    return ProfileSchema.parse(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeProfile(patch: Partial<Profile>): Promise<Profile> {
  const current = await readProfile();
  const merged = ProfileSchema.parse({ ...current, ...patch });
  const file = profilePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}
