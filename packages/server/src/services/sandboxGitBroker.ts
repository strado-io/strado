import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readRunnerIdentity } from './runnerGitCredential.js';

type BrokerPayload = {
  v: 1;
  worktreePath: string;
  projectPath: string;
};

// Keep the capability identifier lexical: dot path segments must never be
// accepted even though GitHub's ordinary name alphabet contains periods.
const PROJECT = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

function signature(payload: string, runnerToken: string): Buffer {
  return crypto.createHmac('sha256', runnerToken).update(payload).digest();
}

export async function issueSandboxGitBrokerToken(
  worktreePath: string,
  projectPath: string,
): Promise<string | null> {
  const identity = await readRunnerIdentity();
  if (!identity || !path.isAbsolute(worktreePath) || !PROJECT.test(projectPath)) return null;
  const payload = Buffer.from(JSON.stringify({ v: 1, worktreePath, projectPath } satisfies BrokerPayload)).toString('base64url');
  return `${payload}.${signature(payload, identity.runnerToken).toString('base64url')}`;
}

export async function resolveSandboxGitBrokerToken(token: string): Promise<BrokerPayload | null> {
  const identity = await readRunnerIdentity();
  if (!identity || token.length > 4096) return null;
  const [encoded, supplied] = token.split('.');
  if (!encoded || !supplied) return null;
  const expected = signature(encoded, identity.runnerToken);
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<BrokerPayload>;
    if (
      payload.v !== 1 || typeof payload.worktreePath !== 'string' || !path.isAbsolute(payload.worktreePath) ||
      typeof payload.projectPath !== 'string' || !PROJECT.test(payload.projectPath)
    ) return null;
    // A copied token stops working as soon as its worktree is deleted.
    const stat = await fsp.stat(payload.worktreePath);
    return stat.isDirectory() ? payload as BrokerPayload : null;
  } catch {
    return null;
  }
}
