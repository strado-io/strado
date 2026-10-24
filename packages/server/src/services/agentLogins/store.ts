import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// The laptop's Claude setup-token (`claude setup-token`, about a year long, does
// not rotate): what remote sandboxes use instead of logging in. A plain 0600
// ~/.strado JSON like model-credential.json; honors STRADO_HOME.
const StoreSchema = z.object({ claudeToken: z.string().min(1) });

/** Owner-only, atomic: a fresh 0600 temp file renamed over the target, so a
 *  crash never leaves half a file and an older loose mode never survives. */
export async function writePrivateFile(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

export function agentLoginsPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'agent-logins.json');
}

export async function readClaudeToken(): Promise<string | null> {
  try {
    return StoreSchema.parse(JSON.parse(await fsp.readFile(agentLoginsPath(), 'utf8'))).claudeToken;
  } catch {
    return null;
  }
}

/** Passing null (or a blank string) clears the token. */
export async function writeClaudeToken(token: string | null): Promise<void> {
  const trimmed = token?.trim() ?? '';
  const file = agentLoginsPath();
  if (!trimmed) {
    await fsp.rm(file, { force: true });
    return;
  }
  await writePrivateFile(file, JSON.stringify({ claudeToken: trimmed }, null, 2));
}
