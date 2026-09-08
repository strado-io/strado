import { describe, expect, it } from 'vitest';
import { agentCommand } from './terminal';
import type { HandoffRecord } from '../services/handoffStore';

function record(notes = ''): HandoffRecord {
  return {
    id: 'h1', workspaceId: 'default', worktreePath: '/repo', taskLabel: 'STR-1',
    source: { mode: 'claude', sessionId: '1' },
    target: { mode: 'codex', sessionId: '2' }, status: 'ready', notes,
    conversation: [{ role: 'assistant', content: 'work is half done' }],
    contextSource: 'claude-history',
    repository: { branch: 'feature', head: 'abc', status: [' M app.ts'], diffStat: '1 file changed' },
    createdAt: '2026-01-01T00:00:00.000Z', acceptedAt: null,
  };
}

// The route passes codexConfigFlags(target); the shape under test is "codex <flags> …".
const FLAGS = "-c 'notify=[]'";

describe('agentCommand', () => {
  it('starts handoff targets as fresh conversations with an initial prompt', () => {
    expect(agentCommand('claude', '2', FLAGS, record())).toContain('claude --');
    expect(agentCommand('codex', '2', FLAGS, record())).toContain("codex -c 'notify=[]' --");
    expect(agentCommand('opencode', '2', FLAGS, record())).toContain('opencode --prompt');
    expect(agentCommand('codex', '2', FLAGS, record())).not.toContain('resume');
    const pi = agentCommand('pi', '2', FLAGS, record());
    expect(pi).toMatch(/^pi -e "/);
    expect(pi).toContain(' -- ');
    expect(pi).not.toContain('-c -e');
  });

  it('shell-quotes user notes instead of allowing a command break-out', () => {
    const command = agentCommand('codex', '2', FLAGS, record("don't run $(touch /tmp/nope)"));
    expect(command).toContain("don'\\''t run $(touch /tmp/nope)");
    expect(command).toMatch(/^codex /);
  });

  it('launches Pi with its status extension and no handoff prompt otherwise', () => {
    expect(agentCommand('pi', '1', FLAGS)).toContain('pi -c -e');
    expect(agentCommand('pi', '2', FLAGS)).not.toContain('-c -e');
  });

  it('never forwards a legacy terminal snapshot', () => {
    const legacy = { ...record(), conversation: [], contextSource: 'none' as const, transcript: ['RAW TUI STATUS BAR'] };
    const command = agentCommand('codex', '2', FLAGS, legacy);
    expect(command).not.toContain('RAW TUI STATUS BAR');
    expect(command).toContain('no clean provider conversation was available');
  });
});
