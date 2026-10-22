import { describe, expect, it } from 'vitest';
import { planFromModel, type ModelStep } from './model';
import type { ParseContext, TabInfo, TabRef } from './types';

// Model output is untrusted: every malformed or hostile shape must come back
// as a refused (non-executable, step-less) plan, never a throw or a step.
const W = '/wt/app';
const ref = (mode: TabRef['mode'], sessionId: string): TabRef => ({ worktreePath: W, mode, sessionId });
const C1 = ref('claude', '1');
const S1 = ref('shell', '1');
const tab = (r: TabRef, extra: Partial<TabInfo> = {}): TabInfo => ({ ...r, label: `${r.mode} ${r.sessionId}`, busy: false, ...extra });
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [tab(C1, { agentId: 'claude-1@app' }), tab(S1, { agentId: 'shell-1@app' })],
  focused: S1, lastActedOn: null, currentWorktree: W, worktrees: [{ path: W, name: 'app' }],
  focuses: [], packageScripts: {}, peers: [{ agentId: 'claude-1@app', alias: null, mode: 'claude', worktreePath: W }],
  calls: [{ id: 'e1', agentId: 'claude-1@app', title: 'Which DB?' }],
  ...over,
});
const refused = (steps: unknown) => {
  const p = planFromModel(steps as ModelStep[], ctx());
  expect(p.steps).toHaveLength(0);
  expect(p.executable).toBe(false);
  return p;
};
const big = 'x'.repeat(100_000);

describe('planFromModel: hostile and malformed model output is refused', () => {
  const cases: [string, unknown][] = [
    ['steps is not an array', { action: 'tab.focus' }],
    ['steps is null', null],
    ['a step is null', [null]],
    ['a step is a string', ['tab.focus']],
    ['action missing', [{ args: {} }]],
    ['action is a number', [{ action: 7, args: {} }]],
    ['args is an array', [{ action: 'tab.focus', args: ['shell-1'] }]],
    ['args is a string', [{ action: 'tab.focus', args: 'shell-1' }]],
    ['required arg missing', [{ action: 'tab.focus', args: {} }]],
    ['required arg null', [{ action: 'tab.close', args: { tab: null } }]],
    ['arg of the wrong type', [{ action: 'tab.close', args: { tab: 3 } }]],
    ['arg is an object', [{ action: 'shell.run', args: { tab: null, command: { toString: 'rm -rf /' } } }]],
    ['unknown tab', [{ action: 'tab.close', args: { tab: 'shell-99' } }]],
    ['#0', [{ action: 'tab.focus', args: { tab: '#0' } }]],
    ['#N out of range', [{ action: 'tab.focus', args: { tab: '#5' } }]],
    ['#N pointing at itself', [{ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: 'right', anchor: '#1', worktree: null } }]],
    ['#N pointing at a later step', [{ action: 'tab.focus', args: { tab: '#2' } }, { action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: null, anchor: null, worktree: null } }]],
    ['#N at a step that opens nothing', [{ action: 'ui.state', args: {} }, { action: 'tab.focus', args: { tab: '#1' } }]],
    ['a huge command', [{ action: 'shell.run', args: { tab: null, command: big } }]],
    ['a huge message', [{ action: 'agent.message', args: { to: 'claude-1', text: big } }]],
    ['a huge tab name', [{ action: 'tab.focus', args: { tab: big } }]],
    ['a multi-line command', [{ action: 'shell.run', args: { tab: null, command: 'ls\nrm -rf ~' } }]],
    ['a command with an escape sequence', [{ action: 'shell.run', args: { tab: null, command: 'echo \u001b[2J' } }]],
    ['a command with ctrl-c', [{ action: 'shell.run', args: { tab: null, command: 'sleep 1\u0003' } }]],
    ['a command with a NUL', [{ action: 'shell.run', args: { tab: null, command: 'ls\u0000' } }]],
    ['a command with a Unicode line separator', [{ action: 'shell.run', args: { tab: null, command: 'ls rm -rf ~' } }]],
    ['a new shell whose command has a control char', [{ action: 'tab.open', args: { mode: 'shell', command: 'ls\u0004', prompt: null, split: null, anchor: null, worktree: null } }]],
    ['an agent prompt with ctrl-c', [{ action: 'tab.open', args: { mode: 'claude', command: null, prompt: 'hi\u0003', split: null, anchor: null, worktree: null } }]],
    ['a message with an escape sequence', [{ action: 'agent.message', args: { to: 'claude-1', text: 'hi \u001b[A' } }]],
    ['a call answer with ctrl-c', [{ action: 'call.answer', args: { caller: 'claude-1', text: 'yes\u0003' } }]],
    ['a bad split', [{ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: 'left', anchor: null, worktree: null } }]],
    ['a bad mode', [{ action: 'tab.open', args: { mode: 'bash', command: null, prompt: null, split: null, anchor: null, worktree: null } }]],
    ['a browser mode through tab.open', [{ action: 'tab.open', args: { mode: 'browser', command: null, prompt: null, split: null, anchor: null, worktree: null } }]],
    ['a command for an agent', [{ action: 'tab.open', args: { mode: 'claude', command: 'rm -rf /', prompt: null, split: null, anchor: null, worktree: null } }]],
    ['a non-http URL', [{ action: 'browser.open', args: { url: 'javascript:alert(1)', split: null, anchor: null, worktree: null } }]],
    ['a file URL', [{ action: 'browser.open', args: { url: 'file:///etc/passwd', split: null, anchor: null, worktree: null } }]],
    ['an unknown worktree', [{ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: null, anchor: null, worktree: 'nope' } }]],
    ['an unknown action', [{ action: 'fs.delete', args: { path: '/' } }]],
    ['an agent-side action', [{ action: 'agent.wait', args: { agentId: 'claude-1@app' } }]],
    ['a prototype key as an action', [{ action: '__proto__', args: {} }]],
    ['a prototype key as a setting', [{ action: 'settings.set', args: { setting: 'constructor', value: 'x' } }]],
    ['__proto__ as a setting', [{ action: 'settings.set', args: { setting: '__proto__', value: 'x' } }]],
    ['toString as a setting', [{ action: 'settings.set', args: { setting: 'toString', value: 'x' } }]],
    ['a setting value out of range', [{ action: 'settings.set', args: { setting: 'appearance.theme', value: 'hotpink' } }]],
    ['an unknown page', [{ action: 'nav.page', args: { page: 'admin' } }]],
    ['a page from the prototype', [{ action: 'nav.page', args: { page: 'constructor' } }]],
    ['an unknown Settings section', [{ action: 'settings.open', args: { section: 'secrets' } }]],
    ['a message to a shell', [{ action: 'agent.message', args: { to: 'shell-1', text: 'ls' } }]],
    ['a message to nobody', [{ action: 'agent.message', args: { to: 'ghost', text: 'hi' } }]],
    ['an answer to someone not calling', [{ action: 'call.answer', args: { caller: 'ghost', text: 'yes' } }]],
    ['a shell.run in an agent tab', [{ action: 'shell.run', args: { tab: 'claude-1', command: 'ls' } }]],
    ['a tab placed beside itself', [{ action: 'tab.place', args: { tab: 'shell-1', split: 'right', anchor: 'shell-1' } }]],
    ['one bad step in an otherwise fine plan', [{ action: 'tab.focus', args: { tab: 'shell-1' } }, { action: 'tab.close', args: { tab: 'nope' } }]],
  ];
  for (const [name, steps] of cases) it(name, () => { refused(steps); });

  it('never throws, whatever the shape', () => {
    for (const junk of [undefined, 0, '', 'x', true, {}, [[]], [{}], [{ action: 'tab.open' }], [{ action: 'tab.open', args: null }], [{ action: 'settings.set', args: { setting: 'hasOwnProperty', value: 'on' } }]]) {
      expect(() => planFromModel(junk as unknown as ModelStep[], ctx())).not.toThrow();
    }
  });

  it('nulls on optional args are fine (the non-strict tools send them)', () => {
    const p = planFromModel([{ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: null, anchor: null, worktree: null } }], ctx());
    expect(p.steps).toHaveLength(1);
    expect(planFromModel([{ action: 'nav.addRepo', args: { path: null } }], ctx()).steps).toHaveLength(1);
    expect(planFromModel([{ action: 'nav.newWorktree', args: { repo: null } }], ctx()).steps).toHaveLength(1);
    expect(planFromModel([{ action: 'server.stop', args: {} }], ctx()).steps).toHaveLength(1);
  });

  it('tabs and newlines stay allowed where text may span lines (an agent prompt, a message)', () => {
    expect(planFromModel([{ action: 'agent.message', args: { to: 'claude-1', text: 'line 1\n\tline 2' } }], ctx()).steps).toHaveLength(1);
  });

  it('there is no wake-word setting any more', () => {
    expect(planFromModel([{ action: 'settings.set', args: { setting: 'commandbox.wakeWord', value: 'on' } }], ctx()).steps).toHaveLength(0);
  });

  it('turning telemetry on from the model needs the user\'s confirm; other plain settings do not', () => {
    const on = planFromModel([{ action: 'settings.set', args: { setting: 'privacy.telemetry', value: 'on' } }], ctx()).steps[0]!;
    expect(on).toMatchObject({ needsConfirm: true, confirmReason: expect.stringMatching(/telemetry/i) });
    expect(planFromModel([{ action: 'settings.set', args: { setting: 'privacy.telemetry', value: 'off' } }], ctx()).steps[0]!.needsConfirm).toBe(false);
    expect(planFromModel([{ action: 'settings.set', args: { setting: 'appearance.theme', value: 'nord' } }], ctx()).steps[0]!.needsConfirm).toBe(false);
  });
});
