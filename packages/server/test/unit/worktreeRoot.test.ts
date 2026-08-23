import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPathSegment,
  canonicalWorktreesDir,
  defaultWorktreeRoot,
  findOwningRepo,
} from '../../src/services/worktreeRoot.js';

const HOME = '/Users/me/.strado';

describe('defaultWorktreeRoot', () => {
  it('derives from the home it is GIVEN, not a global', () => {
    // It used to read process.env.STRADO_HOME directly, which meant tests —
    // which pass a tmp homeStateDir but set no env var — would have written
    // worktrees into the real user's ~/.strado.
    expect(defaultWorktreeRoot('/tmp/alt-home')).toBe('/tmp/alt-home/worktrees');
    expect(defaultWorktreeRoot(path.join(os.homedir(), '.strado'))).toBe(
      path.join(os.homedir(), '.strado', 'worktrees'),
    );
  });
});

describe('canonicalWorktreesDir', () => {
  it('is always <home>/worktrees/<repoId> — no layout choice, no stored field', () => {
    // The repo id, not the folder name: two repos with the same basename in
    // different parents must not collide under the shared root.
    expect(canonicalWorktreesDir(HOME, 'strado-app')).toBe('/Users/me/.strado/worktrees/strado-app');
  });

  it('blocks traversal through the repo id', () => {
    // Without the guard this returns /Users/me/.strado, and assertPathUnder
    // cannot catch it later because it validates against the escaped directory.
    expect(() => canonicalWorktreesDir(HOME, '..')).toThrow(/folder name/);
  });
});

describe('findOwningRepo', () => {
  const repo = { id: 'app', path: '/Users/me/app' };

  it('owns worktrees at the canonical location only', () => {
    expect(findOwningRepo([repo], '/Users/me/.strado/worktrees/app/FD-1', HOME)?.id).toBe('app');
    // Legacy layouts are deliberately NOT owned any more — the sidebar hides
    // them with the same predicate, so nothing shows a row it cannot open.
    expect(findOwningRepo([repo], '/Users/me/app.worktrees/FD-0', HOME)).toBeUndefined();
    expect(findOwningRepo([repo], '/Users/me/app/.claude/worktrees/x', HOME)).toBeUndefined();
  });

  it('does not own a same-prefix sibling directory', () => {
    expect(findOwningRepo([repo], '/Users/me/.strado/worktrees/app-evil/x', HOME)).toBeUndefined();
    expect(findOwningRepo([repo], '/Users/me/.strado/worktrees/app2/x', HOME)).toBeUndefined();
  });

  it('owns the repo checkout only when asked', () => {
    expect(findOwningRepo([repo], '/Users/me/app', HOME)).toBeUndefined();
    expect(findOwningRepo([repo], '/Users/me/app', HOME, { includeRepoRoot: true })?.id).toBe('app');
  });
});

describe('assertPathSegment', () => {
  it('refuses ids that would escape or nest under the shared root', () => {
    // The id schema is only z.string().min(1) and cannot be tightened —
    // repos.json is validated on READ, so a stricter rule would make an existing
    // nonconforming id fail the whole config load. Guarding at the join instead.
    for (const bad of ['..', '.', '', 'a/b', 'a\\b']) {
      expect(() => assertPathSegment(bad, 'repo id')).toThrow(/folder name/);
    }
    expect(() => assertPathSegment('strado-app', 'repo id')).not.toThrow();
  });
});
