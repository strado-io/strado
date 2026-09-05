import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';

const TIMEOUT_MS = 10_000;

export type GitCredential = {
  username: string;
  token: string;
  expiresAt: string;
};

export async function readRunnerIdentity(): Promise<{ runnerId: string; runnerToken: string; apiUrl: string } | null> {
  if (process.env.STRADO_RUNNER !== '1') return null;
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(home, 'runner.json'), 'utf8')) as Record<string, unknown>;
    if (
      typeof parsed.runnerId !== 'string' || !parsed.runnerId ||
      typeof parsed.runnerToken !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.runnerToken) ||
      typeof parsed.apiUrl !== 'string' || !/^https?:\/\//.test(parsed.apiUrl)
    ) return null;
    return { runnerId: parsed.runnerId, runnerToken: parsed.runnerToken, apiUrl: parsed.apiUrl };
  } catch {
    return null;
  }
}

export function githubProjectFromCloneUrl(raw: string): { projectPath: string; httpsUrl: string } | null {
  const value = raw.trim();
  let path: string | null = null;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    path = url.pathname.replace(/^\/+/, '');
  } catch {
    const match = /^git@github\.com:([^\s]+)$/i.exec(value);
    path = match?.[1] ?? null;
  }
  if (!path) return null;
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!/^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(path)) return null;
  return { projectPath: path, httpsUrl: `https://github.com/${path}.git` };
}

/** Null means this is not a runner or the org has no matching installation. */
export async function runnerGitCredential(
  host: string,
  projectPath: string,
  operation: 'read' | 'write',
): Promise<GitCredential | null> {
  const identity = await readRunnerIdentity();
  if (!identity) return null;
  const apiUrl = identity.apiUrl.replace(/\/$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${apiUrl}/v1/runners/git-credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runnerId: identity.runnerId,
        runnerToken: identity.runnerToken,
        host,
        projectPath,
        operation,
      }),
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new AppError('VALIDATION', `cloud Git credential request failed (${response.status})`);
    }
    const body = (await response.json()) as Partial<GitCredential>;
    if (!body.username || !body.token || !body.expiresAt) {
      throw new AppError('VALIDATION', 'cloud returned an incomplete Git credential');
    }
    return body as GitCredential;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const reason = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
    throw new AppError('CLOUD_UNREACHABLE', `could not request a GitHub credential (${reason})`);
  } finally {
    clearTimeout(timer);
  }
}
