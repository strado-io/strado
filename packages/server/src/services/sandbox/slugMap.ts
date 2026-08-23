// Which worktree paths have a container, in memory.
//
// BuildSpec is synchronous (the pty is spawned inside it), so the sandbox
// lookup cannot read state.json. This map is the synchronous face of
// `meta.sandbox.slug`: hydrated from every workspace's state store at boot,
// updated when a sandboxed worktree is created or deleted.
//
// The slug is only ever COPIED from state — never recomputed from ticket +
// title. Container identity is path-derived (sandboxSlugFor), and a second
// derivation is a second chance to disagree with the container that exists.

import path from 'node:path';

export type SandboxSlugMap = {
  /** The sandbox owning `cwd`, or null. Handles a cwd BELOW the worktree
   * root: a monorepo session spawns in `<worktree>/<projectSubdir>`. */
  slugOf(cwd: string): string | null;
  set(worktreePath: string, slug: string): void;
  delete(worktreePath: string): void;
};

/** Trailing separators are noise here: `/w/feat` and `/w/feat/` are one
 * worktree, and prefix matching needs one spelling. */
function norm(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith(path.sep)) out = out.slice(0, -1);
  return out;
}

export function createSandboxSlugMap(): SandboxSlugMap {
  const slugs = new Map<string, string>();
  return {
    set: (worktreePath, slug) => void slugs.set(norm(worktreePath), slug),
    delete: (worktreePath) => void slugs.delete(norm(worktreePath)),
    slugOf(cwd) {
      const target = norm(cwd);
      const exact = slugs.get(target);
      if (exact) return exact;
      // Longest prefix wins: worktree roots can nest (a repo checked out
      // inside another worktree), and the innermost one owns the session.
      let best: { root: string; slug: string } | null = null;
      for (const [root, slug] of slugs) {
        if (!target.startsWith(root + path.sep)) continue; // sibling paths that merely share a prefix
        if (!best || root.length > best.root.length) best = { root, slug };
      }
      return best?.slug ?? null;
    },
  };
}

type HydrateDeps = {
  workspaces: { list(): Promise<{ id: string }[]> };
  stores(wsId: string): Promise<{ state: { list(): Promise<{ path: string; meta: { sandbox?: { slug: string } | null } }[]> } }>;
  onError?: (wsId: string, err: Error) => void;
};

/** Adopt the sandboxes that existed before this server process did. Per
 * workspace, because one unreadable state file must not cost every other
 * workspace its sandboxed terminals — it would silently spawn agents on the
 * host instead, which is the failure this whole feature exists to prevent. */
export async function hydrateSandboxSlugs(map: SandboxSlugMap, deps: HydrateDeps): Promise<void> {
  const workspaces = await deps.workspaces.list();
  for (const ws of workspaces) {
    try {
      const { state } = await deps.stores(ws.id);
      for (const { path: p, meta } of await state.list()) {
        if (meta.sandbox?.slug) map.set(p, meta.sandbox.slug);
      }
    } catch (err) {
      deps.onError?.(ws.id, err as Error);
    }
  }
}
