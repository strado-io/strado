import { describe, expect, it, vi } from 'vitest';
import { createAgentControl, describeTool } from './agentControl.js';

const ask = { kind: 'command' as const, title: 'run a command', detail: 'rm -rf dist' };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('agentControl: approvals', () => {
  it('a request waits for the human; their decision resolves it and it leaves the list', async () => {
    const onChange = vi.fn();
    const c = createAgentControl({ onChange });
    const p = c.request('ws', 'claude-1@a', ask);
    const [a] = c.approvals('ws', 'claude-1@a');
    expect(a).toMatchObject({ kind: 'command', title: 'run a command', detail: 'rm -rf dist' });
    expect(onChange).toHaveBeenCalledWith('ws', 'claude-1@a');
    expect(c.decide('ws', a!.id, 'allow')).toBe('ok');
    await expect(p).resolves.toBe('allow');
    expect(c.approvals('ws', 'claude-1@a')).toEqual([]);
  });

  it('answered in the tab first (the hook is cancelled): null, and a late click is gone', async () => {
    const c = createAgentControl({ onChange: () => {} });
    const ac = new AbortController();
    const p = c.request('ws', 'claude-1@a', ask, ac.signal);
    const id = c.approvals('ws', 'claude-1@a')[0]!.id;
    ac.abort();
    await expect(p).resolves.toBeNull();
    expect(c.approvals('ws', 'claude-1@a')).toEqual([]);
    expect(c.decide('ws', id, 'allow')).toBe('gone');
  });

  it('nobody answers: the wait runs out and the tab\'s own dialog is the way', async () => {
    vi.useFakeTimers();
    try {
      const c = createAgentControl({ onChange: () => {}, waitMs: 1000 });
      const p = c.request('ws', 'claude-1@a', ask);
      vi.advanceTimersByTime(1001);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('decisions are per workspace: another workspace cannot answer it', async () => {
    const c = createAgentControl({ onChange: () => {} });
    void c.request('ws', 'claude-1@a', ask);
    const id = c.approvals('ws', 'claude-1@a')[0]!.id;
    expect(c.decide('other', id, 'allow')).toBe('gone');
    expect(c.approvals('ws', 'claude-1@a')).toHaveLength(1);
    expect(c.decide('ws', 'nope', 'deny')).toBe('gone');
  });

  it('several requests list oldest first, per agent', async () => {
    let t = 0;
    const c = createAgentControl({ onChange: () => {}, now: () => ++t });
    void c.request('ws', 'a', { ...ask, detail: 'one' });
    void c.request('ws', 'b', { ...ask, detail: 'other agent' });
    void c.request('ws', 'a', { ...ask, detail: 'two' });
    await tick();
    expect(c.approvals('ws', 'a').map((x) => x.detail)).toEqual(['one', 'two']);
  });
});

describe('agentControl: activity', () => {
  it('a tool start is the live line; the turn end clears it and keeps the final words', () => {
    let t = 100;
    const onChange = vi.fn();
    const c = createAgentControl({ onChange, now: () => t });
    expect(c.activityOf('ws', 'a')).toEqual({ activity: null, lastResult: null });
    c.toolStarted('ws', 'a', 'Bash: npm test');
    expect(c.activityOf('ws', 'a').activity).toEqual({ text: 'Bash: npm test', at: 100 });
    t = 200;
    c.turnEnded('ws', 'a', 'All 40 tests pass.');
    expect(c.activityOf('ws', 'a')).toEqual({ activity: null, lastResult: { text: 'All 40 tests pass.', at: 200 } });
    // A turn with no final text keeps the previous result.
    c.turnEnded('ws', 'a', null);
    expect(c.activityOf('ws', 'a').lastResult?.text).toBe('All 40 tests pass.');
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('describeTool', () => {
  const keep = (s: string) => s;
  it('names commands, edits, reads and fetches the way a person reads them', () => {
    expect(describeTool('Bash', { command: 'npm test\n--watch' }, '/wt', keep)).toMatchObject({ kind: 'command', title: 'run a command', detail: 'npm test\n--watch', line: 'Bash: npm test' });
    expect(describeTool('Edit', { file_path: '/wt/src/app.ts' }, '/wt', keep)).toMatchObject({ kind: 'file-change', title: 'edit src/app.ts', line: 'Edit: src/app.ts' });
    expect(describeTool('Write', { file_path: '/elsewhere/x.txt' }, '/wt', keep)).toMatchObject({ kind: 'file-change', title: 'write /elsewhere/x.txt' });
    expect(describeTool('Read', { file_path: '/wt/a.md' }, '/wt', keep)).toMatchObject({ kind: 'file-read', line: 'Read: a.md' });
    expect(describeTool('WebFetch', { url: 'https://x.io' }, null, keep)).toMatchObject({ kind: 'web', title: 'fetch a URL', detail: 'https://x.io' });
    expect(describeTool('mcp__strado__read_tab', { tab: 'shell-1' }, null, keep)).toMatchObject({ kind: 'tool', title: 'use mcp__strado__read_tab', detail: '{"tab":"shell-1"}', line: 'mcp__strado__read_tab' });
  });
  it('scrubs through `hide`, and caps long lines and details', () => {
    const hide = (s: string) => s.replace(/SECRET\S*/g, '[hidden]');
    const d = describeTool('Bash', { command: `export TOKEN=SECRETabc && ${'x'.repeat(300)}` }, null, hide);
    expect(d.detail).not.toContain('SECRETabc');
    expect(d.line.length).toBeLessThanOrEqual(120);
    expect(describeTool('Bash', { command: Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') }, null, keep).detail.split('\n')).toHaveLength(8);
  });
});
