import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { z } from 'zod';

// Shared reader for ~/.strado/license.json. Two ways to be activated now:
// an invite code (7 of these are live in the field) or a login. `code` is
// therefore optional — but one of code/email must be present, or an empty object
// would parse as a valid license.
export const LicenseSchema = z
  .object({
    code: z.string().min(6).max(64).optional(),
    token: z.string().length(64),
    name: z.string().max(120),
    deviceId: z.string().min(8).max(128),
    email: z.string().max(254).optional(),
    // ISO timestamp of the last successful cloud confirmation. OPTIONAL and it
    // must stay that way: a license written by any build shipped before this
    // one has no such field, and a required field would make readLicense()
    // return null for it — the app would report "not activated" while holding a
    // working token, and the parse error is swallowed so nothing would say why.
    lastVerifiedAt: z.string().datetime().optional(),
  })
  .refine((l) => Boolean(l.code || l.email), {
    message: 'license must carry either an invite code or an email',
  });
export type License = z.infer<typeof LicenseSchema>;

export function licensePath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'license.json');
}

export async function readLicense(): Promise<License | null> {
  try {
    return LicenseSchema.parse(JSON.parse(await fsp.readFile(licensePath(), 'utf8')));
  } catch {
    return null; // absent or malformed — treated as not activated
  }
}
