// The runner's long-lived X25519 box key. The laptop pins its fingerprint on
// first sync, so the key must survive restarts and upgrades: it lives beside
// the runner's other state, 0600, and is only regenerated if the file is gone.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { fingerprintOf, generateBoxKey } from './seal.js';

export type RunnerBoxKey = { publicKey: string; privateKey: string; fingerprint: string };

const KeyFile = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });

export function runnerBoxKeyPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'runner-box.key');
}

// One load per process, and one generation even when two requests race on a
// fresh runner — two writers would hand the laptop two different keys.
let loading: { file: string; key: Promise<RunnerBoxKey> } | null = null;

export function loadOrCreateBoxKey(): Promise<RunnerBoxKey> {
  const file = runnerBoxKeyPath();
  if (loading?.file !== file) {
    const key = load(file);
    loading = { file, key };
    key.catch(() => {
      if (loading?.key === key) loading = null;
    });
  }
  return loading.key;
}

async function load(file: string): Promise<RunnerBoxKey> {
  let raw: string | null = null;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('runner box key unreadable');
  }
  if (raw !== null) {
    // A corrupt key file is refused, not replaced: replacing it would silently
    // re-key the runner and every pinned laptop would see "key changed".
    const parsed = KeyFile.safeParse(safeJson(raw));
    if (!parsed.success) throw new Error('runner box key unreadable');
    return { ...parsed.data, fingerprint: fingerprintOf(parsed.data.publicKey) };
  }
  const fresh = generateBoxKey();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // 'wx': never overwrite a key another process wrote first.
  try {
    await fsp.writeFile(file, JSON.stringify(fresh) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return load(file);
    throw new Error('runner box key unwritable');
  }
  return { ...fresh, fingerprint: fingerprintOf(fresh.publicKey) };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
