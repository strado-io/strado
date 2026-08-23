// Parses a git remote URL into { host, projectPath } and classifies GitLab
// hosts. Provider-agnostic on purpose: a GitHub provider can reuse the parser
// and add its own host check later.
import { execFile } from 'node:child_process';

export function parseRemoteUrl(url: string): { host: string; projectPath: string; ssh: boolean } | null {
  const s = (url ?? '').trim();
  if (!s) return null;
  let host: string | undefined;
  let rawPath: string | undefined;
  let isSsh = false;

  const scp = /^[^@\s]+@([^:/\s]+):(.+)$/.exec(s); // git@host:group/proj.git
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/.exec(s);
  const https = /^https?:\/\/(?:[^@/]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/.exec(s);

  if (ssh) { host = ssh[1]; rawPath = ssh[2]; isSsh = true; }
  else if (https) { host = https[1]; rawPath = https[2]; }
  else if (scp) { host = scp[1]; rawPath = scp[2]; isSsh = true; }
  else return null;

  const projectPath = rawPath!.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!host || !projectPath.includes('/')) return null; // need namespace/project
  return { host, projectPath, ssh: isSsh };
}

export function isGitlabHost(host: string, configuredHosts: Set<string>): boolean {
  if (configuredHosts.has(host)) return true;
  return host === 'gitlab.com' || /^gitlab\./i.test(host) || /\.gitlab\./i.test(host);
}

export function isGithubHost(host: string, configuredHosts: Set<string>): boolean {
  if (configuredHosts.has(host)) return true;
  return host === 'github.com' || /^github\./i.test(host) || /\.github\./i.test(host);
}

// ── SSH alias resolution ─────────────────────────────────────────────────────
// Multi-account git setups use ~/.ssh/config aliases (Host github-strado →
// HostName github.com) as remote "hosts". Those aliases aren't real hostnames,
// so provider classification and web-URL building both miss. `ssh -G <host>`
// makes OpenSSH print its RESOLVED config for the destination — the same
// evaluation git itself uses — and its `hostname` line is the real host. It
// is purely local: no network, no auth, just config evaluation.

type SshResolver = (host: string) => Promise<string | null>;

const realSshResolve: SshResolver = (host) =>
  new Promise((resolve) => {
    execFile('ssh', ['-G', host], { timeout: 3_000 }, (err, stdout) => {
      if (err) return resolve(null); // no ssh binary / bad host — fail closed
      const m = /^hostname (.+)$/m.exec(stdout);
      resolve(m?.[1]?.trim() || null);
    });
  });

// Aliases change ~never; cache per process so worktree polls don't respawn ssh.
const aliasCache = new Map<string, string | null>();

/**
 * Real hostname behind an SSH alias, or null when the name is not an alias
 * (ssh -G echoes unknown hosts back unchanged) or resolution fails.
 */
export async function resolveSshAlias(
  host: string,
  resolver: SshResolver = realSshResolve,
): Promise<string | null> {
  const hit = aliasCache.get(host);
  if (hit !== undefined) return hit;
  const resolved = await resolver(host);
  const value = resolved && resolved !== host ? resolved : null;
  aliasCache.set(host, value);
  return value;
}
