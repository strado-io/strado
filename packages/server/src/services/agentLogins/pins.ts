import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { writePrivateFile } from './store.js';

// Trust on first use for each runner's sealing key: the first fingerprint seen
// is pinned, and a later different one is refused until the user re-pins it in
// Runners. Stops a relay (or a reinstalled box) from quietly swapping in a key
// it holds. A 0600 ~/.strado JSON {runnerId: fingerprint}; honors STRADO_HOME.
const PinsSchema = z.record(z.string(), z.string());

export function pinsPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'runner-key-pins.json');
}

async function readPins(): Promise<Record<string, string>> {
  try {
    return PinsSchema.parse(JSON.parse(await fsp.readFile(pinsPath(), 'utf8')));
  } catch {
    return {};
  }
}

async function writePins(pins: Record<string, string>): Promise<void> {
  await writePrivateFile(pinsPath(), JSON.stringify(pins, null, 2));
}

// Every read-modify-write goes through one chain, so two syncs at once can't
// each read the old file and drop the other's pin.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** The pinned fingerprint, or null. Never records one. */
export async function peekPin(runnerId: string): Promise<string | null> {
  return (await readPins())[runnerId] ?? null;
}

/** Records the fingerprint when the runner has no pin yet. */
export function checkPin(runnerId: string, fingerprint: string): Promise<'new' | 'match' | 'changed'> {
  return serial(async () => {
    const pins = await readPins();
    const pinned = pins[runnerId];
    if (pinned === undefined) {
      await writePins({ ...pins, [runnerId]: fingerprint });
      return 'new';
    }
    return pinned === fingerprint ? 'match' : 'changed';
  });
}

/** Re-pins a runner whose key changed, once the person said yes to `from` →
 *  `to`; false (and nothing written) if the pin moved meanwhile. */
export function replacePin(runnerId: string, from: string, to: string): Promise<boolean> {
  return serial(async () => {
    const pins = await readPins();
    if (pins[runnerId] !== from) return false;
    await writePins({ ...pins, [runnerId]: to });
    return true;
  });
}

export function resetPin(runnerId: string): Promise<void> {
  return serial(async () => {
    const pins = await readPins();
    if (!(runnerId in pins)) return;
    delete pins[runnerId];
    await writePins(pins);
  });
}
