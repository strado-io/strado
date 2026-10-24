// The laptop this runner accepts agent logins from: its Ed25519 public key,
// pinned on the first sync that verifies and opens. Deleting the file is the
// reset, for a new laptop or a reinstalled app.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const PinFile = z.object({ spk: z.string().min(1) });

export function runnerSenderPinPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'runner-sender-pin.json');
}

/** null when no laptop is pinned yet. Throws when the file exists but will not
 *  parse — that must never read as "unpinned" and let any sender in. */
export async function readSenderPin(): Promise<string | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(runnerSenderPinPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('sender pin unreadable');
  }
  try {
    return PinFile.parse(JSON.parse(raw)).spk;
  } catch {
    throw new Error('sender pin unreadable');
  }
}

export async function writeSenderPin(spk: string): Promise<void> {
  const p = runnerSenderPinPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ spk }) + '\n', { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, p);
}
