import { describe, expect, it } from 'vitest';
import { agentCardKey } from './AgentCard';

describe('agentCardKey: the box input\'s keys while an agent is selected', () => {
  const k = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) =>
    agentCardKey({ key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift });
  it('↵ send (queue), ⌘↵ steer, ⌃C interrupt, ⌘O open', () => {
    expect(k('Enter')).toBe('send');
    expect(k('Enter', { meta: true })).toBe('steer');
    expect(k('c', { ctrl: true })).toBe('interrupt');
    expect(k('o', { meta: true })).toBe('open');
  });
  it('anything else is the box\'s own', () => {
    expect(k('Enter', { shift: true })).toBeNull();
    expect(k('c', { meta: true })).toBeNull();
    expect(k('a')).toBeNull();
  });
});
