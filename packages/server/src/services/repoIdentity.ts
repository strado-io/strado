// Deciding that a repo on THIS machine and a repo on a runner are the same repo.
//
// Filesystem paths can't do it (`/Users/me/strado` vs `/home/strado/strado`),
// which is why `cloneUrl` exists. But clone URLs for one repo legitimately
// differ per machine: scp-style vs https, an ssh alias instead of the real
// host, a trailing `.git`, a different port. So matching needs normalizing
// first, and a documented fallback for the alias case.
export type RepoIdentity = {
  /** `host/owner/repo`, lowercased — the strong key. */
  key: string;
  /** `owner/repo` — the weak key, used only when it is unambiguous. */
  pathKey: string;
};

/**
 * Reduce a clone URL to comparable parts. Returns null for anything that isn't
 * a clone URL (a local path, an empty remote), because "no identity" has to be
 * distinguishable from "identity that matches nothing".
 */
export function repoIdentity(raw: string | null | undefined): RepoIdentity | null {
  const url = (raw ?? '').trim();
  if (!url) return null;

  let host: string;
  let path: string;

  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/.exec(url);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    const scheme = /^(https?|ssh|git):\/\/(.+)$/.exec(url);
    if (!scheme) return null;
    const rest = scheme[2]!;
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    // Strip any `user@` and `:port` — neither says anything about which repo
    // this is, and both vary between machines.
    host = rest.slice(0, slash).replace(/^[^@]*@/, '').replace(/:\d+$/, '');
    path = rest.slice(slash + 1);
  }

  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  host = host.toLowerCase();
  if (!host || !path) return null;

  // Lowercased throughout: GitHub and GitLab both treat owner/repo
  // case-insensitively, and two repos differing only by case is a far rarer
  // problem than failing to match `Hello-World` with `hello-world`.
  return { key: `${host}/${path}`.toLowerCase(), pathKey: path.toLowerCase() };
}

/**
 * Find the local repo a remote clone URL belongs to.
 *
 * Exact `host/owner/repo` wins. Failing that, `owner/repo` alone is accepted
 * ONLY when exactly one local repo matches — which is what makes ssh aliases
 * work (`git@github-strado:strado-io/strado.git` on one machine,
 * `https://github.com/strado-io/strado.git` on the other, same repo, and
 * nothing on either machine can resolve the other's alias). When two local
 * repos share `owner/repo` on different hosts, the match is genuinely
 * ambiguous and guessing would silently file worktrees under the wrong repo.
 */
export function matchRepo<T>(
  remoteCloneUrl: string | null | undefined,
  locals: { repo: T; cloneUrl: string | null | undefined }[],
): T | null {
  const want = repoIdentity(remoteCloneUrl);
  if (!want) return null;
  const identified = locals
    .map((l) => ({ repo: l.repo, id: repoIdentity(l.cloneUrl) }))
    .filter((l): l is { repo: T; id: RepoIdentity } => l.id !== null);

  const exact = identified.filter((l) => l.id.key === want.key);
  if (exact.length === 1) return exact[0]!.repo;
  if (exact.length > 1) return exact[0]!.repo; // same host and path: genuinely the same repo

  const loose = identified.filter((l) => l.id.pathKey === want.pathKey);
  return loose.length === 1 ? loose[0]!.repo : null;
}

/**
 * Rewrite a clone URL so ANOTHER machine can use it.
 *
 * Multi-account setups put an `~/.ssh/config` alias in the remote
 * (`git@github-strado:strado-io/site.git`). That alias exists only in this
 * machine's config, so handing it to a runner produces "Could not resolve
 * hostname github-strado" — a confusing failure for a repo that clones fine
 * here. `ssh -G` evaluates the same config git uses and yields the real host.
 *
 * The scheme is deliberately left alone otherwise: the runner authenticates
 * with its OWN credentials, and https-vs-ssh is its business, not ours.
 */
export async function portableCloneUrl(
  raw: string,
  resolveAlias: (host: string) => Promise<string | null>,
): Promise<string> {
  const scp = /^([A-Za-z0-9._-]+@)([A-Za-z0-9._-]+):(.+)$/.exec(raw);
  if (scp) {
    const real = await resolveAlias(scp[2]!);
    return real ? `${scp[1]}${real}:${scp[3]}` : raw;
  }
  const ssh = /^ssh:\/\/(([^@/]+@)?)([^/:]+)(:\d+)?\/(.+)$/.exec(raw);
  if (ssh) {
    const real = await resolveAlias(ssh[3]!);
    return real ? `ssh://${ssh[2] ?? ''}${real}${ssh[4] ?? ''}/${ssh[5]}` : raw;
  }
  return raw; // https/git:// carry real hosts already
}
