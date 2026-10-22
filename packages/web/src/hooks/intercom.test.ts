import { describe, expect, it } from 'vitest';
import { INITIAL_INTERCOM, intercomReducer } from './intercom';

const peers = [
  { agentId: 'claude-1@repo', alias: null, mode: 'claude' as const, worktreePath: '/w/repo', sessionId: '1', lifecycle: 'idle', live: true },
];

describe('intercom reducer (peers only)', () => {
  it('peers replaces the list and marks it loaded', () => {
    const s = intercomReducer(INITIAL_INTERCOM, { type: 'peers', peers });
    expect(s).toEqual({ peers, loaded: true, error: null });
  });
  it('a successful fetch clears a stale error; an error keeps the last list', () => {
    const failed = intercomReducer({ peers, loaded: true, error: null }, { type: 'error', message: 'boom' });
    expect(failed).toEqual({ peers, loaded: true, error: 'boom' });
    expect(intercomReducer(failed, { type: 'peers', peers: [] }).error).toBeNull();
  });
  it('reset blanks it for a workspace switch', () => {
    expect(intercomReducer({ peers, loaded: true, error: 'x' }, { type: 'reset' })).toBe(INITIAL_INTERCOM);
  });
});
