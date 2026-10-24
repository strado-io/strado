import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { writePrivateFile } from '../agentLogins/store.js';

// Runners this laptop set up over ssh, keyed by runnerId, so a row can later
// offer "Reinstall over SSH". Where and what only: never a key, a password, or
// anything read off the box. A 0600 ~/.strado JSON; honors STRADO_HOME.
const HostSchema = z.object({
  target: z.string().min(1),
  port: z.number().int().nullable(),
  addedAt: z.string(),
  lastInstallVersion: z.string().nullable(),
}).strict();
const HostsSchema = z.record(z.string(), HostSchema);
export type SshHost = z.infer<typeof HostSchema>;

export function sshHostsPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'ssh-hosts.json');
}

export async function readSshHosts(): Promise<Record<string, SshHost>> {
  try {
    return HostsSchema.parse(JSON.parse(await fsp.readFile(sshHostsPath(), 'utf8')));
  } catch {
    return {};
  }
}

let chain: Promise<unknown> = Promise.resolve();

export function recordSshHost(runnerId: string, host: SshHost): Promise<void> {
  const run = chain.then(async () => {
    const hosts = await readSshHosts();
    await writePrivateFile(sshHostsPath(), JSON.stringify({ ...hosts, [runnerId]: host }, null, 2));
  });
  chain = run.catch(() => undefined);
  return run;
}
