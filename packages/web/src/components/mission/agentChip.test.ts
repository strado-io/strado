import { describe, expect, it } from 'vitest';
import { leadingAgent, setLeadingAgent } from './agentChip';

const c2 = { agentId: 'claude-2@x', label: 'claude-2' };

describe('the leading @agent chip: where the box\'s text goes', () => {
  it('a leading agent chip: that agent, and the rest of the text', () => {
    expect(leadingAgent('@claude-2 run the tests', [c2])).toEqual({ agentId: 'claude-2@x', label: 'claude-2', rest: 'run the tests' });
    expect(leadingAgent('  @claude-2 ', [c2])).toEqual({ agentId: 'claude-2@x', label: 'claude-2', rest: '' });
  });
  it('no chip, a chip later in the text, or the same words typed without a chip: none', () => {
    expect(leadingAgent('Open up Claude', [])).toBeNull();
    expect(leadingAgent('ask @claude-2 to run tests', [c2])).toBeNull();
    expect(leadingAgent('@claude-2 hi', [])).toBeNull();
    expect(leadingAgent('@claude-2x hi', [c2])).toBeNull();
    expect(leadingAgent('#{x} hi', [{ label: 'x', worktreePath: '/x' }])).toBeNull();
  });
  it('setLeadingAgent: adds a chip in front, replaces another agent\'s, or removes it; the typed text stays', () => {
    expect(setLeadingAgent('run tests', [], c2)).toEqual({ text: '@claude-2 run tests', chips: [c2] });
    const p1 = { agentId: 'pi-1@x', label: 'pi-1' };
    expect(setLeadingAgent('@claude-2 run tests', [c2], p1)).toEqual({ text: '@pi-1 run tests', chips: [p1] });
    expect(setLeadingAgent('@claude-2 run tests', [c2], null)).toEqual({ text: 'run tests', chips: [] });
    expect(setLeadingAgent('', [], c2)).toEqual({ text: '@claude-2 ', chips: [c2] });
    expect(setLeadingAgent('@claude-2 ', [c2], c2)).toEqual({ text: '@claude-2 ', chips: [c2] });
  });
  it('other chips in the text are kept', () => {
    const wt = { label: 'api', worktreePath: '/wt/api' };
    expect(setLeadingAgent('look at #api', [wt], c2)).toEqual({ text: '@claude-2 look at #api', chips: [wt, c2] });
  });
});
