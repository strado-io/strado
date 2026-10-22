import { describe, expect, it } from 'vitest';
import type { StationDto } from '../api';
import { nextSeenCalls } from './callNotifications';

const st = (over: Partial<StationDto> = {}): StationDto => ({
  agentId: 'claude-1@repo', alias: null, name: 'claude-1', mode: 'claude', worktreePath: '/w/repo', worktreeName: 'repo', sessionId: '1',
  lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
});
const call = (id: string, title = 'db?') => ({ id, title, body: 'pg or sqlite', createdAt: 1 });
const label = () => 'repo';

describe('nextSeenCalls: the desktop notifier over stations', () => {
  it('the first snapshot (prev null) fires nothing but seeds every open call', () => {
    const { seen, fire } = nextSeenCalls(null, [st({ calls: [call('E1')] })], label);
    expect(fire).toEqual([]);
    expect(seen).toEqual(new Set(['E1']));
  });

  it('a new call fires once, naming the agent, its worktree and the call; then it is seen', () => {
    const r1 = nextSeenCalls(new Set(), [st({ calls: [call('E1')] })], label);
    expect(r1.fire).toEqual([{ id: 'E1', agentId: 'claude-1@repo', path: '/w/repo', mode: 'claude', sessionId: '1', title: 'repo: claude-1 needs a decision — db?', body: 'pg or sqlite' }]);
    expect(nextSeenCalls(r1.seen, [st({ calls: [call('E1')] })], label).fire).toEqual([]);
  });

  it('uses the alias when there is one, and only the calls not seen before', () => {
    const { fire } = nextSeenCalls(new Set(['E1']), [st({ alias: 'bob', calls: [call('E1'), call('E2', 'which port?')] })], label);
    expect(fire.map((n) => [n.id, n.title])).toEqual([['E2', 'repo: bob needs a decision — which port?']]);
  });

  it('an orphan call (its asker has no tab) fires too, with nothing to open', () => {
    const orphan = { id: 'O1', from: 'claude-9@repo', name: 'claude-9', title: 'ship it?', body: '', createdAt: 1 };
    const { seen, fire } = nextSeenCalls(new Set(), [], label, [orphan]);
    expect(fire).toEqual([{ id: 'O1', agentId: null, path: null, mode: null, sessionId: null, title: 'claude-9 (tab closed) needs a decision — ship it?', body: '' }]);
    expect(seen).toEqual(new Set(['O1']));
    expect(nextSeenCalls(null, [], label, [orphan]).fire).toEqual([]);
  });

  it('an answered call drops out of seen, so seen never grows without bound', () => {
    const { seen } = nextSeenCalls(new Set(['E1', 'gone']), [st({ calls: [call('E1')] })], label);
    expect(seen).toEqual(new Set(['E1']));
  });
});
