import { describe, expect, it } from 'vitest';
import { findOwningRepo, worktreeRootsFor } from './worktreeRoot.js';

const HOME = '/u/.strado';
const repo = {
  id: 'site',
  path: '/u/dev/site',
};

describe('worktreeRootsFor', () => {
  it('is exactly the canonical root — no sibling, no .claude', () => {
    // Strict on purpose: the sidebar filters by this same predicate, so
    // anything outside <home>/worktrees/<id> is neither shown nor operable.
    expect(worktreeRootsFor(HOME, repo)).toEqual(['/u/.strado/worktrees/site']);
  });

  it('returns [] for an id that is not a safe path segment', () => {
    // A repo with a hostile id owns nothing; throwing here would 500 every
    // ownership scan that iterates the repo list.
    expect(worktreeRootsFor(HOME, { id: '..' })).toEqual([]);
  });
});

describe('findOwningRepo', () => {
  it('owns a worktree under the canonical root', () => {
    expect(findOwningRepo([repo], '/u/.strado/worktrees/site/feature-x', HOME)).toBe(repo);
  });

  it('does not own the legacy sibling or .claude locations', () => {
    expect(findOwningRepo([repo], '/u/dev/site.worktrees/feature-x', HOME)).toBeUndefined();
    expect(findOwningRepo([repo], '/u/dev/site/.claude/worktrees/social-media', HOME)).toBeUndefined();
  });

  it('stays separator-aware — a sibling with a shared prefix is not owned', () => {
    expect(findOwningRepo([repo], '/u/.strado/worktrees/site2/feature-x', HOME)).toBeUndefined();
  });

  it('does not own the repo root itself unless asked', () => {
    expect(findOwningRepo([repo], '/u/dev/site', HOME)).toBeUndefined();
    expect(findOwningRepo([repo], '/u/dev/site', HOME, { includeRepoRoot: true })).toBe(repo);
  });

  it('does not claim arbitrary paths inside the checkout', () => {
    expect(findOwningRepo([repo], '/u/dev/site/src/index.ts', HOME)).toBeUndefined();
  });
});
