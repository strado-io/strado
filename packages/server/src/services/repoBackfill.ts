// Fill in `cloneUrl` for repos registered before the field existed.
//
// cloneUrl is written at registration time, so every repo added before it was
// introduced has none — which is every repo on every existing install. Anything
// built on it (matching a local repo to a runner's copy, telling a runner which
// repo to clone) silently does nothing for those, and the honest-looking
// "this repo has no git remote" message is simply wrong: the remote is right
// there in .git/config, nobody ever read it.
//
// So read it on demand and persist the answer. `undefined` means never checked;
// `null` means the last check found no origin. Callers that need a clone URL can
// explicitly recheck null entries because users may add an origin later.
import type { RepoConfig, RepoConfigStore } from '../repoConfig.js';
import { readOriginUrl } from './repoDetect.js';

export async function backfillCloneUrls(
  store: RepoConfigStore,
  repos: RepoConfig[],
  opts: { recheckNull?: boolean } = {},
): Promise<RepoConfig[]> {
  const pending = repos.filter((r) =>
    r.cloneUrl === undefined || (opts.recheckNull === true && r.cloneUrl === null));
  if (pending.length === 0) return repos;

  const found = new Map<string, string | null>();
  await Promise.all(
    pending.map(async (repo) => {
      const url = await readOriginUrl(repo.path);
      found.set(repo.id, url);
      try {
        await store.patch(repo.id, { cloneUrl: url });
      } catch {
        // A repo removed mid-flight, or an unwritable config: the caller still
        // gets the URL for this request, we just don't remember it.
      }
    }),
  );

  return repos.map((r) => (found.has(r.id) ? { ...r, cloneUrl: found.get(r.id)! } : r));
}
