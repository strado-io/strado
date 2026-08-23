// Materialize a repo on THIS machine from a clone URL.
//
// Why this exists: a repo registered by filesystem path can't be reproduced
// anywhere else, which is why adding a repo to a runner previously meant
// SSHing in and cloning by hand. With a URL, the machine that needs the repo
// clones it itself — using ITS OWN credentials, never credentials shipped from
// elsewhere. That matters for the VPN/self-hosted-GitLab case, where no cloud
// service can reach the git host at all.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import { exec } from '../shell.js';

/** Where clones land unless the caller names a directory. */
export function defaultReposDir(): string {
  return process.env.STRADO_REPOS_DIR || path.join(os.homedir(), 'repos');
}

/**
 * Only URL shapes git can actually clone. Rejects local paths and anything
 * with shell-ish characters: the URL reaches git as an argv entry (never a
 * shell), but a `--upload-pack=…`-style argument would still be an injection.
 */
export function parseCloneUrl(raw: string): { url: string; name: string } {
  const url = raw.trim();
  if (!url || url.startsWith('-')) throw new AppError('VALIDATION', 'invalid clone URL');
  const ok =
    /^(https?|git|ssh):\/\/[^\s]+$/.test(url) || // https://host/owner/repo(.git)
    /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(url); // git@host:owner/repo(.git)
  if (!ok) {
    throw new AppError('VALIDATION', `not a git clone URL: ${url}`);
  }
  // Trailing slashes and .git are noise; the last path segment is the name.
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/, '');
  const segment = cleaned.split(/[/:]/).filter(Boolean).pop() ?? '';
  const name = segment.replace(/[^A-Za-z0-9._-]/g, '');
  if (!name) throw new AppError('VALIDATION', `could not derive a directory name from ${url}`);
  return { url, name };
}

export type CloneResult = { path: string; alreadyPresent: boolean };

export async function cloneRepo(opts: {
  url: string;
  /** Absolute target directory; defaults to <reposDir>/<name>. */
  dest?: string;
  timeoutMs?: number;
}): Promise<CloneResult> {
  const { url, name } = parseCloneUrl(opts.url);
  const dest = opts.dest ? path.resolve(opts.dest) : path.join(defaultReposDir(), name);

  // Idempotent: re-running "add repo" for something already cloned should
  // register it, not fail or clone a second copy.
  if (fs.existsSync(path.join(dest, '.git'))) {
    return { path: dest, alreadyPresent: true };
  }
  if (fs.existsSync(dest) && (await fsp.readdir(dest)).length > 0) {
    throw new AppError('VALIDATION', `${dest} already exists and is not a git repository`);
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  try {
    await exec('git', ['clone', '--', url, dest], {
      timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      env: {
        // CRITICAL: without these a private repo makes git sit forever waiting
        // for a username or an SSH passphrase on a machine with no terminal —
        // the HTTP request would hang until the timeout with no explanation.
        // Failing fast turns it into an actionable "authentication failed".
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      },
    });
  } catch (err) {
    // exec rejects on non-zero exit with git's stderr in `details`; the bare
    // "git exited 128" it carries is useless to a user, so re-map it.
    const stderr = (err as { details?: { stderr?: string } }).details?.stderr ?? '';
    // Clean up a partial clone so a retry isn't blocked by a non-empty dir.
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new AppError('SHELL_FAILED', cloneFailureMessage(stderr, url));
  }
  return { path: dest, alreadyPresent: false };
}

/**
 * Turn git's stderr into something the user can act on.
 *
 * Names the actual host. These messages were written when a clone was always
 * local, so "the machine running Strado" was unambiguous; read from a desktop
 * after a runner failed, it points at the wrong computer. The machine that
 * needs the key is the one that ran the clone, and it knows its own name.
 */
function cloneFailureMessage(stderr: string, url: string): string {
  const text = stderr.trim();
  const lower = text.toLowerCase();
  const here = os.hostname().replace(/\.local$/, '');
  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('could not read username') ||
    lower.includes('terminal prompts disabled')
  ) {
    return `clone failed: ${here} has no credentials for ${url}. Add an SSH key or deploy key on ${here} (credentials are never copied from another machine), then retry.`;
  }
  if (lower.includes('could not resolve host') || lower.includes('connection timed out') || lower.includes('network is unreachable')) {
    return `clone failed: ${here} cannot reach ${url}. If the host is behind a VPN, ${here} has to be on that network.`;
  }
  if (lower.includes('repository not found') || lower.includes('not found')) {
    return `clone failed: ${url} not found, or not visible to ${here}'s credentials.`;
  }
  return `clone failed on ${here}: ${text.split('\n').slice(-3).join(' ') || 'git exited non-zero'}`;
}
