import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.js';
import type { AgentDescriptor, Path, ScopeTarget } from './types.js';

export type ResolveCtx = { home: string; worktree?: string };

// Strado writes its own status hooks into this file (see
// services/claudeHooks.ts). Even though it lives right next to a descriptor's
// declared settings.json, it must never become reachable through this
// allowlist — a descriptor declaring settings.json is not a declaration of
// its .local sibling.
function isStradoOwnedFile(resolved: string): boolean {
  return (
    path.basename(resolved) === 'settings.local.json' &&
    path.basename(path.dirname(resolved)) === '.claude'
  );
}

// `ctx.worktree` stands in for an untrusted <worktree> token in a descriptor's
// declared path. It must already be a clean, fully-resolved absolute path —
// if resolving it changes it (a `..` segment, a trailing slash, `.`
// components), something upstream handed us a path we can't trust to mean
// what it says, so we refuse rather than silently normalize it into
// whatever it happens to collapse to.
function resolveWorktree(ctx: ResolveCtx): string {
  if (!ctx.worktree) {
    throw new AppError('VALIDATION', 'project scope requires a worktree path');
  }
  const resolved = path.resolve(ctx.worktree);
  if (resolved !== ctx.worktree) {
    throw new AppError(
      'VALIDATION',
      'worktree path must already be a fully-resolved absolute path',
    );
  }
  return resolved;
}

export function resolveTarget(target: ScopeTarget, ctx: ResolveCtx): string {
  let file = target.file;
  if (file.startsWith('~/')) file = path.join(ctx.home, file.slice(2));
  if (file.includes('<worktree>')) {
    file = file.replace('<worktree>', resolveWorktree(ctx));
  }
  return path.resolve(file);
}

export function resolvePath(target: ScopeTarget, ctx: ResolveCtx): Path {
  return target.path.map((segment) => (segment === '<worktree>' ? resolveWorktree(ctx) : segment));
}

export function allowedFiles(descriptor: AgentDescriptor, ctx: ResolveCtx): string[] {
  const out = new Set<string>();
  for (const surface of descriptor.surfaces) {
    for (const target of [surface.global, surface.project]) {
      if (!target) continue;
      if (target.file.includes('<worktree>') && !ctx.worktree) continue;
      const resolved = resolveTarget(target, ctx);
      if (isStradoOwnedFile(resolved)) continue;
      out.add(resolved);
    }
  }
  return [...out];
}

async function realpathOrSelf(p: string): Promise<string> {
  return fsp.realpath(p).catch(() => path.resolve(p));
}

// Symlinks are followed deliberately, on both the candidate and each allowed
// entry: a declared config file being a symlink (a dotfiles farm managed by
// chezmoi/stow/yadm is the common case) is legitimate and must be accepted,
// not rejected. This check is not what stands between an attacker and the
// symlink target — planting a redirect at a declared path already requires
// write access to $HOME, and anyone with that can read the target file
// directly, so refusing to follow it would buy no real access control while
// breaking a normal setup. What this check actually constrains is the
// untrusted `file=` parameter itself: it must name one of the descriptor's
// declared paths (or something that resolves to the same real file), nothing
// else.
/**
 * Same check as `assertAllowedFile`, but returns the path it validated
 * against instead of discarding it — specifically, the DESCRIPTOR's own
 * declared spelling for the matching surface (one of `allowedFiles`'
 * entries), never the caller's own string and never a realpath of either.
 *
 * That distinction matters for a caller that goes on to WRITE the file
 * through `resolveWriteTarget` (the raw-file route): `resolveWriteTarget`
 * leaves a non-symlink final path component untouched, so whatever string
 * this function hands back becomes that write's `withFileLock` key
 * verbatim. Two accepted spellings of the identical real file — the
 * descriptor's own (e.g. `~/.claude/settings.json` expanded against
 * `ctx.home`) and a caller-supplied one that only matches it by realpath
 * (e.g. the same file reached through a symlinked ANCESTOR directory,
 * `/mnt/home/u/...` vs. `/home/u/...`) — must resolve to ONE key, or a raw
 * PUT using the caller's own spelling and a surface PATCH using the
 * descriptor's own spelling would lock independently and race past each
 * other undetected. Returning the caller's realpath'd candidate (as this
 * function used to) fixes neither: it's a THIRD spelling, no more aligned
 * with `writeSurface`'s own `resolveTarget(target, ctx)` output than the
 * caller's was. Only the descriptor's own spelling is guaranteed identical
 * to what `writeSurface` computes independently for the same surface.
 */
export async function resolveAllowedFile(
  descriptor: AgentDescriptor,
  file: string,
  ctx: ResolveCtx,
): Promise<string> {
  const allowed = allowedFiles(descriptor, ctx);

  const candidate = await realpathOrSelf(file);
  const resolvedAllowed = await Promise.all(allowed.map(realpathOrSelf));

  const matchIndex = resolvedAllowed.indexOf(candidate);
  if (matchIndex !== -1) return allowed[matchIndex]!;

  throw new AppError('PATH_FORBIDDEN', `${file} is not a managed config file`, {
    target: file,
    allowedRoots: allowed,
  });
}

export async function assertAllowedFile(
  descriptor: AgentDescriptor,
  file: string,
  ctx: ResolveCtx,
): Promise<void> {
  await resolveAllowedFile(descriptor, file, ctx);
}
