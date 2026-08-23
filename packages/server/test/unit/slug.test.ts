import { describe, expect, it } from 'vitest';
import { buildWorktreeSlug } from '../../src/slug';

describe('buildWorktreeSlug', () => {
  it('joins ticket id with snake-cased title', () => {
    expect(buildWorktreeSlug('FD-123', 'Show speed graph under alarm video')).toBe(
      'FD-123_Show_speed_graph_under_alarm_video',
    );
  });
  it('strips punctuation', () => {
    expect(buildWorktreeSlug('FD-1', 'API: support new endpoint!')).toBe(
      'FD-1_API_support_new_endpoint',
    );
  });
  it('collapses repeated separators', () => {
    expect(buildWorktreeSlug('FD-1', 'foo   bar---baz')).toBe('FD-1_foo_bar_baz');
  });
  it('keeps hyphens in a free-form ticket id', () => {
    expect(buildWorktreeSlug('ONBOARD-fix', 'header tweak')).toBe('ONBOARD-fix_header_tweak');
  });
  it('accepts a lower-case / non-Jira ticket id', () => {
    expect(buildWorktreeSlug('spike', 'try it out')).toBe('spike_try_it_out');
  });
  it('uses the title alone when the ticket is blank', () => {
    expect(buildWorktreeSlug('', 'fix the header')).toBe('fix_the_header');
  });
  it('falls back to "worktree" when both are empty', () => {
    expect(buildWorktreeSlug('', '')).toBe('worktree');
  });
});
