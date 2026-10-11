import { describe, expect, it } from 'vitest';
import type { Worktree } from '../../types';
import { cardLines, worktreeLabel, worktreeTitle } from './labels';

const wt = (over: Partial<Worktree> & { meta?: Worktree['meta'] }): Worktree =>
  ({ path: '/r/main', branch: 'main', meta: null, ...over } as Worktree);

describe('worktreeTitle', () => {
  it('shows a title that says something the row does not already', () => {
    const w = wt({ branch: 'FD-36306_fuel', meta: { title: 'fuel-calibration-issue' } as Worktree['meta'] });
    expect(worktreeTitle(w, 'Fleetx Dashboard')).toBe('fuel calibration issue');
  });

  it('drops a title that only echoes the ticket id, branch, or repo heading', () => {
    expect(worktreeTitle(wt({ meta: { ticketId: 'FD-1', title: 'FD-1' } as Worktree['meta'] }))).toBe('');
    // `test · test` — the branch is already the label.
    expect(worktreeTitle(wt({ branch: 'test', meta: { title: 'test' } as Worktree['meta'] }))).toBe('');
    // `main · Strado Website` under a "Strado Website" heading.
    expect(worktreeTitle(
      wt({ branch: 'main', meta: { title: 'strado-website' } as Worktree['meta'] }),
      'Strado Website',
    )).toBe('');
  });

  it('still falls back through ticket, branch, then folder for the label', () => {
    expect(worktreeLabel(wt({ meta: { ticketId: 'FD-9' } as Worktree['meta'] }))).toBe('FD-9');
    expect(worktreeLabel(wt({ branch: 'feature/x' }))).toBe('feature/x');
    expect(worktreeLabel(wt({ branch: '', path: '/repos/thing' }))).toBe('thing');
  });
});

describe('cardLines', () => {
  it('puts the title on top and the branch underneath', () => {
    const w = wt({ branch: 'FD-36306_fuel', meta: { ticketId: 'FD-36306', title: 'fuel-calibration-issue' } as Worktree['meta'] });
    expect(cardLines(w, 'Fleetx Dashboard')).toEqual({ title: 'fuel calibration issue', subtitle: 'FD-36306_fuel' });
  });

  it('uses the ticket id as the title when there is no readable title', () => {
    const w = wt({ branch: 'FD-9-login', meta: { ticketId: 'FD-9' } as Worktree['meta'] });
    expect(cardLines(w)).toEqual({ title: 'FD-9', subtitle: 'FD-9-login' });
  });

  it('fills a missing title from the ticket summary, then the PR title, before falling back to the ticket id', () => {
    const w = wt({ branch: 'FD-9-login', meta: { ticketId: 'FD-9' } as Worktree['meta'] });
    expect(cardLines(w, undefined, { ticketSummary: 'Fix login redirect', prTitle: 'FD-9: login' }).title).toBe('Fix login redirect');
    expect(cardLines(w, undefined, { ticketSummary: null, prTitle: 'FD-9: login' }).title).toBe('FD-9: login');
    expect(cardLines(w, undefined, { ticketSummary: '  ', prTitle: '' }).title).toBe('FD-9');
    // A stored title still wins over both.
    const titled = wt({ branch: 'x', meta: { ticketId: 'FD-9', title: 'my-name' } as Worktree['meta'] });
    expect(cardLines(titled, undefined, { ticketSummary: 'Fix login redirect' }).title).toBe('my name');
  });

  it('always shows the branch, even when it is also the title', () => {
    expect(cardLines(wt({ branch: 'master', path: '/code/fleetx' }))).toEqual({ title: 'master', subtitle: 'master' });
    expect(cardLines(wt({ branch: '', path: '/code/fleetx' }))).toEqual({ title: 'fleetx', subtitle: 'fleetx' });
  });
});
