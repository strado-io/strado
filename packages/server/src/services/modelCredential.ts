import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parseRemoteUrl, isGithubHost, isGitlabHost } from './gitProviders.js';
import { readGithubConfig, githubTokenFor, type GithubConfig } from './github.js';
import { readGitlabConfig, gitlabHostToken, type GitlabConfig } from './gitlab.js';

// The user's own Anthropic API key. It is what agents inside a runner sandbox
// bill against — the runner has no Claude subscription, only the raw API. Stored
// as a plain ~/.strado JSON, mode 600, exactly like github.json / gitlab.json:
// the renderer can't write files, and this never leaves the device (it is
// threaded into the sandbox's 0600 env-file, never into our cloud, an image, or
// any argv). Honors STRADO_HOME so throwaway instances stay isolated.
const CredentialSchema = z.object({ anthropicApiKey: z.string().min(1) });

export function modelCredentialPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'model-credential.json');
}

export async function readModelCredential(): Promise<string | null> {
  try {
    return CredentialSchema.parse(JSON.parse(await fsp.readFile(modelCredentialPath(), 'utf8'))).anthropicApiKey;
  } catch {
    return null;
  }
}

/** Passing null (or a blank string) clears the credential. */
export async function writeModelCredential(key: string | null): Promise<void> {
  const trimmed = key?.trim() ?? '';
  const file = modelCredentialPath();
  if (!trimmed) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ anthropicApiKey: trimmed }, null, 2), { mode: 0o600 });
}

/** What the GET route may reveal: that a key exists and its last four — never
 *  the key itself. A distinct pure function so the "no leak" guarantee is
 *  testable without standing up a server. */
export function credentialSummary(key: string | null): { present: boolean; last4: string | null } {
  return key ? { present: true, last4: key.slice(-4) } : { present: false, last4: null };
}

// ── Sandbox env assembly ─────────────────────────────────────────────────────

const execFileP = promisify(execFile);

/** `git config --get user.name` / `user.email` in the repo, or null when unset.
 *  Local only, no network. */
async function readGitIdentity(repoPath: string): Promise<{ name: string | null; email: string | null }> {
  const one = async (field: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileP('git', ['-C', repoPath, 'config', '--get', field], { timeout: 3_000 });
      const v = stdout.trim();
      return v || null;
    } catch {
      return null; // unset (git exits 1) or no repo — omit rather than fabricate
    }
  };
  const [name, email] = await Promise.all([one('user.name'), one('user.email')]);
  return { name, email };
}

// Injectable so the assembly logic is unit-testable without touching ~/.strado
// or spawning git — mirrors the resolver-default pattern in gitProviders.ts.
export type SandboxEnvDeps = {
  readModelKey: () => Promise<string | null>;
  gitIdentity: (repoPath: string) => Promise<{ name: string | null; email: string | null }>;
  readGithub: () => Promise<GithubConfig>;
  readGitlab: () => Promise<GitlabConfig>;
};

const defaultDeps: SandboxEnvDeps = {
  readModelKey: readModelCredential,
  gitIdentity: readGitIdentity,
  readGithub: readGithubConfig,
  readGitlab: readGitlabConfig,
};

// Same precedence as routes/gitProvider.ts classifyHost: an explicitly
// configured host wins over the other provider's heuristic.
function classifyHost(host: string, gitlabHosts: Set<string>, githubHosts: Set<string>): 'gitlab' | 'github' | null {
  if (gitlabHosts.has(host)) return 'gitlab';
  if (githubHosts.has(host)) return 'github';
  if (isGitlabHost(host, gitlabHosts)) return 'gitlab';
  if (isGithubHost(host, githubHosts)) return 'github';
  return null;
}

/**
 * The env a sandbox needs to act AS the user: the model key it bills against,
 * the git identity its commits are authored with, and a push token answered via
 * GIT_ASKPASS (so the token is read from the environment at push time and never
 * written to disk inside the container). Every piece is optional — an absent
 * source is omitted, never emitted as an empty string.
 */
export async function sandboxEnvForRepo(
  repo: { path: string; cloneUrl?: string | null },
  deps: SandboxEnvDeps = defaultDeps,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  const key = await deps.readModelKey();
  if (key) env.ANTHROPIC_API_KEY = key;

  const { name, email } = await deps.gitIdentity(repo.path);
  if (name) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME = name;
  }
  if (email) {
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_EMAIL = email;
  }

  const parsed = repo.cloneUrl ? parseRemoteUrl(repo.cloneUrl) : null;
  if (parsed) {
    const [ghCfg, glCfg] = await Promise.all([deps.readGithub(), deps.readGitlab()]);
    const githubHosts = new Set(Object.keys(ghCfg).map((k) => k.split('/')[0] ?? k));
    const gitlabHosts = new Set(Object.keys(glCfg));
    const provider = classifyHost(parsed.host, gitlabHosts, githubHosts);
    if (provider === 'github') {
      const token = githubTokenFor(ghCfg, parsed.host, parsed.projectPath.split('/')[0] ?? '');
      if (token) {
        env.GITHUB_TOKEN = token;
        env.GIT_ASKPASS = '/usr/local/bin/strado-askpass';
        env.GIT_HTTP_USER = 'x-access-token';
      }
    } else if (provider === 'gitlab') {
      const token = gitlabHostToken(glCfg, parsed.host);
      if (token) {
        env.GITLAB_TOKEN = token;
        env.GIT_ASKPASS = '/usr/local/bin/strado-askpass';
        env.GIT_HTTP_USER = 'oauth2';
      }
    }
  }

  return env;
}
