// Runner identity (M2): what `strado-runner pair` writes and the daemon reads.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RunnerIdentity {
  runnerId: string;
  runnerToken: string;
  /** Stable across restarts — the browser session cookie is derived from it. */
  accessKey: string;
  apiUrl: string;
}

export function readIdentity(file: string): RunnerIdentity | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RunnerIdentity;
    return parsed.runnerId && parsed.runnerToken ? parsed : null;
  } catch {
    return null;
  }
}

export function writeIdentity(file: string, identity: RunnerIdentity): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

export async function pairRunner(opts: {
  apiUrl: string;
  code: string;
  name: string;
  runnerVersion?: string;
}): Promise<RunnerIdentity> {
  const res = await fetch(`${opts.apiUrl}/v1/runners/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: opts.code, name: opts.name, runnerVersion: opts.runnerVersion }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pairing failed (${res.status}): ${body || 'no response body'}`);
  }
  const { runnerId, runnerToken } = (await res.json()) as { runnerId: string; runnerToken: string };
  return { runnerId, runnerToken, accessKey: randomBytes(16).toString('hex'), apiUrl: opts.apiUrl };
}

/** Default runner name: the box's hostname, which is what the human recognizes. */
export function defaultRunnerName(): string {
  return os.hostname().split('.')[0] || 'runner';
}
