import { describe, expect, it } from 'vitest';
import { agentTabStatus, shellAgentKey, shellHostedAgent } from './agentTabStatus';

describe('agentTabStatus', () => {
  it('reads the tab own session entry', () => {
    expect(agentTabStatus('2', { '1': 'idle', '2': 'working' }, 'working')).toBe('working');
  });

  it('keeps a Shell-hosted agent out of the dedicated tab of the same worktree', () => {
    // the worktree aggregate is 'working' because a Claude was launched by hand
    // inside Shell 1 — the dedicated Claude tab has no session of its own
    expect(agentTabStatus('1', { 'shell:1': 'working' }, 'working')).toBeUndefined();
  });

  it('falls back to the aggregate only when the server sent no by-id map', () => {
    expect(agentTabStatus('1', undefined, 'waiting')).toBe('waiting');
    expect(agentTabStatus('2', undefined, 'waiting')).toBeUndefined();
    expect(agentTabStatus('1', undefined, undefined)).toBeUndefined();
  });
});

describe('shellHostedAgent', () => {
  const key = shellAgentKey('2');

  it('names the agent running inside the Shell tab', () => {
    expect(shellHostedAgent('2', { codex: { [key]: 'working' } })).toEqual({ mode: 'codex', status: 'working' });
  });

  it('treats a launcher registration as hosted before the first turn', () => {
    expect(shellHostedAgent('2', { claude: { [key]: 'waiting' } })).toEqual({ mode: 'claude', status: 'waiting' });
  });

  it('keeps an idle agent — it is still open in the tab between turns', () => {
    expect(shellHostedAgent('2', { claude: { [key]: 'idle' } })).toEqual({ mode: 'claude', status: 'idle' });
  });

  it('is null for a plain shell, an exited agent, or another tab session', () => {
    expect(shellHostedAgent('2', {})).toBeNull();
    // the launcher's exit report removes the session outright
    expect(shellHostedAgent('2', { claude: {} })).toBeNull();
    expect(shellHostedAgent('2', { claude: { '2': 'working', 'shell:3': 'working' } })).toBeNull();
  });

  it('names Pi when it is the agent running inside the Shell tab', () => {
    expect(shellHostedAgent('2', { pi: { [key]: 'working' } })).toEqual({ mode: 'pi', status: 'working' });
  });

  it('prefers the busiest agent when a tab has hosted several', () => {
    expect(shellHostedAgent('2', { claude: { [key]: 'waiting' }, codex: { [key]: 'working' } }))
      .toEqual({ mode: 'codex', status: 'working' });
    expect(shellHostedAgent('2', { claude: { [key]: 'idle' }, codex: { [key]: 'waiting' } }))
      .toEqual({ mode: 'codex', status: 'waiting' });
  });
});
