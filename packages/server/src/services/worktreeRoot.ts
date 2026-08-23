// Where a repo's worktrees live.
//
// One place, not a choice: `<homeStateDir>/worktrees/<repoId>`, computed from
// the repo id alone — there is no per-repo `worktreesDir` field and no
// workspace setting any more. The location used to be configurable (sibling
// `<repo>.worktrees`, a workspace-chosen root, per-repo overrides), which
// scattered worktrees across layouts and made "is this path mine" answers
// drift between installs. Worktrees that still sit in the old locations (or
// wherever an agent created them) remain on disk and in git's registry, but
// Strado neither lists nor operates on them.
import path from 'node:path';
import { AppError } from '../errors.js';

/**
 * The single root for all worktrees: `<home>/worktrees`.
 *
 * Takes the home dir as an argument rather than reading STRADO_HOME itself.
 * The app already resolves its own home (env var, or `~/.strado`) and passes it
 * around as `homeStateDir`; a second, independent read here meant tests — which
 * pass a tmp homeStateDir but no env var — would have written worktrees into the
 * real user's `~/.strado`.
 *
 * Note what shares this directory: license.json, github.json, gitlab.json and
 * jira.json all hold credentials, so `~/.strado` is what someone deletes to
 * reset the app. Nothing in our code removes it wholesale today, and nothing
 * should start — under this layout that would take uncommitted work with it.
 */
export function defaultWorktreeRoot(homeStateDir: string): string {
  return path.join(homeStateDir, 'worktrees');
}

/**
 * Reject anything that isn't a single, safe path component.
 *
 * A repo id becomes a directory name under the shared root, and the id schema is
 * only `z.string().min(1)` — tightening it is not an option because repos.json
 * is validated on READ, so a stricter rule would make an existing nonconforming
 * id fail the whole config load. Guarding at the join closes the hole instead:
 * without it, an id of `..` escapes the root entirely and `assertPathUnder`
 * cannot catch it, because it validates against the already-escaped directory.
 */
export function assertPathSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new AppError('VALIDATION', `${label} cannot be used as a folder name: ${JSON.stringify(value)}`);
  }
}

/**
 * The one directory NEW worktrees for a repo go into:
 * `<homeStateDir>/worktrees/<repoId>`. Not configurable.
 */
export function canonicalWorktreesDir(homeStateDir: string, repoId: string): string {
  assertPathSegment(repoId, 'repo id');
  return path.join(defaultWorktreeRoot(homeStateDir), repoId);
}

/**
 * Every directory this repo's worktrees may live in — exactly one: the
 * canonical root. Deliberately strict: legacy sibling `.worktrees` folders and
 * agent-chosen locations (`<repo>/.claude/worktrees`, `~/.claude/…`) are NOT
 * owned. The sidebar filters by this same predicate, so a worktree Strado
 * cannot operate on is also never shown — listed and usable stay one set.
 *
 * Returns an array (not a string) so call sites can spread it next to
 * `repo.path`, and returns [] for a repo whose id is not a safe path segment —
 * such a repo owns nothing rather than throwing in the middle of an
 * ownership scan.
 */
export function worktreeRootsFor(homeStateDir: string, repo: { id: string }): string[] {
  try {
    return [canonicalWorktreesDir(homeStateDir, repo.id)];
  } catch {
    return [];
  }
}

/** True when `target` sits inside one of the repo's worktree roots. */
function underAnyRoot(target: string, roots: string[]): boolean {
  // Separator-aware on purpose: a bare startsWith made `app.worktrees2/x` look
  // like it belonged to `app.worktrees`.
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

/**
 * The repo that owns a path, by worktree root (and optionally its own checkout).
 *
 * Replaces fifteen hand-rolled `target.startsWith(r.worktreesDir)` checks that
 * had drifted apart — only two of them appended a separator.
 */
export function findOwningRepo<T extends { id: string; path: string }>(
  repos: T[],
  target: string,
  homeStateDir: string,
  opts: { includeRepoRoot?: boolean } = {},
): T | undefined {
  return repos.find(
    (r) =>
      (opts.includeRepoRoot && target === r.path) ||
      underAnyRoot(target, worktreeRootsFor(homeStateDir, r)),
  );
}
