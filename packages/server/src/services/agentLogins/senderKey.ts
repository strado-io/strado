import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { generateSenderKey } from './seal.js';

// This laptop's Ed25519 identity: every sealed bundle is signed with it, and a
// runner pins the first one it sees, so only this laptop can push logins there.
// Made once and never replaced: a new key would make every runner refuse us.
// A 0600 ~/.strado JSON; honors STRADO_HOME.
const KeySchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type SenderKey = z.infer<typeof KeySchema>;

export function senderKeyPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'agent-login-sender.key');
}

async function read(file: string): Promise<SenderKey> {
  try {
    return KeySchema.parse(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch {
    throw new Error('sender key unreadable');
  }
}

export async function loadSenderKey(): Promise<SenderKey> {
  const file = senderKeyPath();
  try {
    await fsp.access(file);
    return await read(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Written whole to a 'wx' temp file, then linked into place: link fails if
  // another load got there first, and nobody ever reads a half-written key.
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(generateSenderKey()), { mode: 0o600, flag: 'wx' });
    await fsp.chmod(tmp, 0o600);
    await fsp.link(tmp, file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  return read(file);
}

let lastIssuedAt = 0;
/** ms epoch, strictly increasing within this process: two syncs in the same
 *  millisecond must not look like a replay to the runner. */
export function nextIssuedAt(): number {
  lastIssuedAt = Math.max(Date.now(), lastIssuedAt + 1);
  return lastIssuedAt;
}
