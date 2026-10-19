import { act, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type JarvisPaletteProps, releaseKeyboard } from './CommandPalette';
import type { Plan, Step, StepOf, ActionId, ParseContext, TabRef } from '../lib/jarvis/types';
import { readHistory, rememberCommand } from '../lib/jarvis/history';
import { __resetAgentAnswers } from '../hooks/agentAnswers';
import type { RepoConfig, Workspace, Worktree } from '../types';

afterEach(() => releaseKeyboard());

/** The bar is inert until focused (click or ⌘K): every test starts with it focused. */
const render = (ui: Parameters<typeof rtlRender>[0]) => {
  const r = rtlRender(ui);
  act(() => { (screen.getByLabelText('Global search') as HTMLInputElement).focus(); });
  return r;
};


const feed = vi.hoisted(() => vi.fn());
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { ...actual.api, worktrees: { ...actual.api.worktrees, list: vi.fn().mockResolvedValue([]) }, intercom: { ...actual.api.intercom, feed: (...a: unknown[]) => feed(...a) } } };
});
// The intercom stream, faked: tests send the server's events.
const sse = vi.hoisted(() => ({ handler: null as null | ((evt: { type: string; data: Record<string, unknown> }) => void) }));
vi.mock('../eventStream', async () => ({
  ...(await vi.importActual<typeof import('../eventStream')>('../eventStream')),
  subscribeIntercom: (_ws: string, h: (evt: { type: string; data: Record<string, unknown> }) => void) => { sse.handler = h; return () => { sse.handler = null; }; },
}));

const P = '/wt/FD-1';
const ref = (mode: TabRef['mode'], sessionId: string): TabRef => ({ worktreePath: P, mode, sessionId });
function step<A extends ActionId>(action: A, args: StepOf<A>['args'], over: Partial<StepOf<A>> = {}): Step {
  return { action, args, target: { kind: 'none' }, risk: 'layout', where: 'hub', undoable: true, needsConfirm: false, chips: [], ...over } as Step;
}
const SPLITS = [{ label: 'right', value: 'right' }, { label: 'down', value: 'down' }, { label: 'as tab', value: 'tab' }];
const shellRight = (split = 'right'): Step => step('tab.open', { mode: 'shell', worktreePath: P, place: { split: split as 'right', anchor: { kind: 'none' }, focus: false } }, {
  where: 'server', risk: 'spawn',
  chips: [{ arg: 'mode', label: 'Open shell', candidates: [] }, { arg: 'place.split', label: split, candidates: SPLITS }],
});
const plan = (steps: Step[], over: Partial<Plan> = {}): Plan => ({ steps, source: 'rule', summary: steps.map((s) => s.action).join(', '), executable: true, ...over });

function stubParse({ text, pasted }: { text: string; pasted?: boolean }): Plan {
  const t = text.trim();
  if (t === 'shell right') return plan([shellRight()], { summary: 'Open shell right', executable: !pasted });
  if (t === '$ rm -rf build') return plan([step('shell.run', { command: 'rm -rf build' }, { where: 'server', risk: 'destructive', undoable: false, needsConfirm: true, confirmReason: 'deletes files', target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'command', label: 'rm -rf build', candidates: [] }] })], { source: 'prefix', summary: 'Run rm -rf build' });
  if (t === 'two') return plan([
    step('shell.run', { command: 'ls' }, { where: 'server', risk: 'exec', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'command', label: 'run ls', candidates: [] }] }),
    step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1') }, chips: [{ arg: 'target', label: 'focus claude', candidates: [] }] }),
  ], { summary: 'Run ls, then focus claude' });
  if (t === '@claude-1 how are you') return plan([step('agent.message', { agentId: 'claude-1@a', text: 'how are you' }, { where: 'server', risk: 'exec', undoable: false })], { source: 'prefix', summary: 'Ask claude-1: how are you' });
  if (t === 'ask claude-1 if the tests pass') return plan([step('agent.ask', { agentId: 'claude-1@a', question: 'do the tests pass?' }, { where: 'server', risk: 'exec', undoable: false })], { source: 'model', summary: 'Ask claude-1: do the tests pass?' });
  if (t === 'ask the claudes in this focus if their tests pass') return plan([
    step('agent.ask', { agentId: 'claude-1@a', question: 'do your tests pass?' }, { where: 'server', risk: 'exec', undoable: false }),
    step('agent.ask', { agentId: 'claude-2@b', question: 'do your tests pass?' }, { where: 'server', risk: 'exec', undoable: false }),
  ], { source: 'model', summary: 'Ask 2 agents' });
  if (t === 'what is claude-1 doing') return plan([step('agent.recap', { agentIds: ['claude-1@a'] }, { where: 'server', risk: 'read', undoable: false })], { source: 'model', summary: 'Recap claude-1' });
  if (t === 'make it pop') return plan([step('agent.message', { agentId: 'claude-1@a', text: 'make it pop' }, { where: 'server', risk: 'exec', undoable: false, chips: [{ arg: 'agentId', label: 'Ask claude-1', candidates: [] }] })], { source: 'fallback', summary: 'Ask claude-1: make it pop' });
  if (t === 'close tab') {
    const t1 = { kind: 'tab' as const, ref: ref('claude', '1') };
    const t2 = { kind: 'tab' as const, ref: ref('claude', '2') };
    return plan([step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, target: t1,
      chips: [{ arg: 'target', label: 'Close Claude', candidates: [{ label: 'Close Claude', value: t1 }, { label: 'Close Claude 2', value: t2 }] }] })], { summary: 'Close tab' });
  }
  if (t === 'close shells') return plan([
    step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, needsConfirm: true, confirmReason: 'it holds unsaved work', target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'target', label: 'Close Shell', candidates: [] }] }),
    step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('shell', '2') }, chips: [{ arg: 'target', label: 'Close Shell 2', candidates: [] }] }),
  ], { summary: 'Close shells' });
  if (t === 'stop shell') return plan([step('tab.interrupt', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'target', label: 'Interrupt Shell', candidates: [] }] })], { summary: 'Interrupt Shell' });
  if (t === 'close claude') return plan([], { summary: 'Which claude?', alternatives: [
    plan([step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('claude', '1') }, chips: [{ arg: 'target', label: 'Close Claude', candidates: [] }] })], { summary: 'Close Claude' }),
    plan([step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('claude', '2') }, chips: [{ arg: 'target', label: 'Close Claude 2', candidates: [] }] })], { summary: 'Close Claude 2' }),
  ] });
  return plan([]);
}

const ctx = (): ParseContext => ({
  tabs: [{ ...ref('shell', '1'), label: 'Shell', busy: false }, { ...ref('shell', '2'), label: 'Shell 2', busy: false }, { ...ref('claude', '1'), label: 'Claude', busy: false }, { ...ref('claude', '2'), label: 'Claude 2', busy: true }],
  focused: ref('shell', '1'), lastActedOn: null, currentWorktree: P, worktrees: [], focuses: [], packageScripts: {}, peers: [],
});

const repos = [] as RepoConfig[];
const workspaces = [{ id: 'default', name: 'Personal' }] as Workspace[];
const wt = { path: P, repoId: 'r1', branch: 'FD-1', meta: { ticketId: 'FD-1', title: 'fix login' }, process: { status: 'idle' } } as unknown as Worktree;

function setup(over: Partial<JarvisPaletteProps> = {}) {
  const hub = {
    path: P, snapshot: vi.fn(() => 'SNAP'), restore: vi.fn(),
    place: vi.fn().mockResolvedValue({ ok: true }), focus: vi.fn(() => true),
    openBrowser: vi.fn(), closeLocal: vi.fn(),
  };
  const server = {
    spawn: vi.fn().mockResolvedValue({ tab: ref('shell', '4') }), run: vi.fn().mockResolvedValue({ settled: true, output: '', durationMs: 1 }),
    interrupt: vi.fn(), close: vi.fn().mockResolvedValue({ ok: true }), message: vi.fn().mockResolvedValue({}), recap: vi.fn(),
    startServer: vi.fn(), stopServer: vi.fn(), answerCall: vi.fn(), dismissCall: vi.fn(),
  };
  const nav = { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), line: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() };
  const jarvis: JarvisPaletteProps = {
    wsId: 'default', parse: vi.fn(stubParse), context: vi.fn(ctx),
    ports: () => ({ hub, server, nav }), onRan: vi.fn(), onActed: vi.fn(), ...over,
  };
  const onClose = vi.fn();
  render(<CommandPalette repos={repos} worktrees={[wt]} workspaces={workspaces} activeWorkspaceId="default"
    onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={onClose} jarvis={jarvis} />);
  const input = screen.getByLabelText('Global search');
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const key = (k: string, mods: Record<string, boolean> = {}) => fireEvent.keyDown(input, { key: k, ...mods });
  return { hub, server, nav, jarvis, onClose, input, type, key };
}

beforeEach(() => localStorage.clear());

describe('CommandPalette — Jarvis', () => {
  it('nothing is suggested while typing — one quiet "⏎ to run" line; ⏎ runs an exact rule hit at once, remembers it and clears', async () => {
    const s = setup();
    s.type('shell right');
    expect(screen.queryByTestId('jarvis-row-0')).not.toBeInTheDocument();
    expect(screen.queryByText('Open shell')).not.toBeInTheDocument();
    expect(screen.getByTestId('jarvis-submit')).toHaveTextContent('⏎ to run');
    s.key('Enter');
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalled());
    expect(s.input).toHaveValue('');
    expect(s.server.spawn).toHaveBeenCalledWith({ mode: 'shell', worktreePath: P });
    expect(s.hub.place).toHaveBeenCalled();
    expect(s.jarvis.onRan).toHaveBeenCalledWith(expect.objectContaining({ ok: true, summary: 'Open shell right', undoable: true }));
    expect(s.jarvis.onActed).toHaveBeenCalledWith(ref('shell', '4'));
    expect(readHistory('default')).toEqual(['shell right']);
  });

  it('⌘⏎ runs and keeps the box open, cleared for the next command', async () => {
    const s = setup();
    s.type('shell right');
    s.key('Enter', { metaKey: true });
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalled());
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.input).toHaveValue('');
  });

  it('a step that needs a confirm asks first: the first ⏎ shows why, the second runs', async () => {
    const s = setup();
    s.type('$ rm -rf build');
    s.key('Enter');
    expect(screen.getByText(/deletes files/)).toBeInTheDocument();
    expect(screen.getByText(/not undoable/i)).toBeInTheDocument();
    expect(s.server.run).not.toHaveBeenCalled();
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'rm -rf build'));
  });

  it('a pasted command never runs on the first ⏎', async () => {
    const s = setup();
    fireEvent.paste(s.input);
    s.type('shell right');
    s.key('Enter');
    expect(s.server.spawn).not.toHaveBeenCalled();
    expect(screen.getByText(/pasted/i)).toBeInTheDocument();
    s.key('Enter');
    await waitFor(() => expect(s.server.spawn).toHaveBeenCalled());
  });

  it('multi-step plans are numbered, stop at the first failure and show the error in the row', async () => {
    const s = setup();
    s.server.run.mockRejectedValueOnce(new Error('the user is typing in that tab'));
    s.type('two');
    s.key('Enter');
    const row = screen.getByTestId('jarvis-row-0');
    expect(within(row).getByText('1.')).toBeInTheDocument();
    expect(within(row).getByText('2.')).toBeInTheDocument();
    expect(await within(row).findByText('the user is typing in that tab')).toBeInTheDocument();
    expect(s.hub.focus).not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
  });

  it('a target tab that went away before the run aborts before anything runs', async () => {
    let gone = false;
    const s = setup({ context: () => (gone ? { ...ctx(), tabs: ctx().tabs.filter((t) => !(t.mode === 'shell' && t.sessionId === '1')) } : ctx()) });
    s.type('$ rm -rf build');
    s.key('Enter');
    gone = true;
    s.key('Enter');
    expect(await screen.findByText(/that tab is gone/i)).toBeInTheDocument();
    expect(s.server.run).not.toHaveBeenCalled();
  });

  it('an ambiguous target is a pick list on ⏎, never a guess', () => {
    const s = setup();
    s.type('close claude');
    expect(screen.queryByTestId('jarvis-row-0')).not.toBeInTheDocument();
    s.key('Enter');
    expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent('Close Claude');
    expect(screen.getByTestId('jarvis-row-1')).toHaveTextContent('Close Claude 2');
    expect(s.server.close).not.toHaveBeenCalled();
  });

  it('plain text with no model: ⏎ says natural language needs the model and asks no agent', () => {
    const s = setup();
    s.type('make it pop');
    expect(screen.queryByText(/Ask claude-1/)).not.toBeInTheDocument();
    s.key('Enter');
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent('Natural language needs the model');
    expect(s.server.message).not.toHaveBeenCalled();
  });

  it('a name-like query keeps navigation results first', () => {
    const s = setup();
    s.type('FD');
    expect(screen.getByText('FD-1')).toBeInTheDocument();
    expect(screen.queryByTestId('jarvis-row-0')).not.toBeInTheDocument();
  });

  it('empty box: recent commands under the Focuses, and ↑ recalls the last one', () => {
    rememberCommand('default', 'split down');
    rememberCommand('default', 'shell right');
    const s = setup();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('split down')).toBeInTheDocument();
    s.key('ArrowUp');
    expect(s.input).toHaveValue('shell right');
    s.key('ArrowUp');
    expect(s.input).toHaveValue('split down');
  });

  it('a failure after partial work still offers its undo (the spawned tab)', async () => {
    const s = setup();
    s.hub.place.mockResolvedValueOnce({ ok: false, reason: 'The new tab did not show up' });
    s.type('shell right');
    await act(async () => { s.key('Enter'); });
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalledWith(expect.objectContaining({ ok: false, undo: [{ kind: 'close', tab: ref('shell', '4') }, { kind: 'restore', path: P, snapshot: 'SNAP' }] })));
    expect(screen.getByText('The new tab did not show up')).toBeInTheDocument();
  });
  it('a failure with nothing done reports only inline', async () => {
    const s = setup();
    s.server.run.mockRejectedValueOnce(new Error('boom'));
    s.type('two');
    await act(async () => { s.key('Enter'); });
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(s.jarvis.onRan).not.toHaveBeenCalled();
  });
});

describe('CommandPalette — Jarvis QA fixes', () => {
  it('closing or interrupting a shell with a running process asks first (busy checked at ⏎)', async () => {
    const isBusy = vi.fn().mockResolvedValue(true);
    const s = setup({ isBusy });
    s.type('stop shell');
    s.key('Enter');
    // The same words the model path uses, with the verb of the action.
    expect(await screen.findByText(/Shell is running something — interrupt it anyway\?/)).toBeInTheDocument();
    expect(isBusy).toHaveBeenCalledWith(ref('shell', '1'));
    expect(s.server.interrupt).not.toHaveBeenCalled();
    s.key('Enter');
    await waitFor(() => expect(s.server.interrupt).toHaveBeenCalledWith(ref('shell', '1')));
  });

  it('the busy reason lands on the busy step only, even when the plan already needed a confirm', async () => {
    const isBusy = vi.fn(async (r: TabRef) => r.sessionId === '1');
    const s = setup({ isBusy });
    s.type('close shells');
    s.key('Enter');
    const confirm = await screen.findByText(/Confirm:/);
    await waitFor(() => expect(confirm.textContent).toMatch(/Shell is running something — close it anyway\?/));
    expect(confirm.textContent).toMatch(/unsaved work/);
    expect(confirm.textContent!.match(/is running something/g)).toHaveLength(1);
    expect(s.server.close).not.toHaveBeenCalled();
    s.key('Enter');
    await waitFor(() => expect(s.server.close).toHaveBeenCalledTimes(2));
  });

  it('a recalled command that was pasted stays pasted (no one-key replay)', async () => {
    const s = setup();
    fireEvent.paste(s.input);
    s.type('shell right');
    s.key('Enter');
    s.key('Enter', { metaKey: true }); // ran, box kept open and cleared
    await waitFor(() => expect(s.server.spawn).toHaveBeenCalledTimes(1));
    s.key('ArrowUp');
    expect(s.input).toHaveValue('shell right');
    s.key('Enter');
    expect(screen.getByText(/pasted/i)).toBeInTheDocument();
    expect(s.server.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('CommandPalette — Jarvis history privacy', () => {
  it('"Clear history" in the empty box forgets recent commands', () => {
    rememberCommand('default', 'split down');
    setup();
    expect(screen.getByText('split down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear history/i }));
    expect(screen.queryByText('split down')).not.toBeInTheDocument();
    expect(readHistory('default')).toEqual([]);
  });
});

describe('CommandPalette — Jarvis with the real parser', () => {
  it('"$ git status" runs in the focused shell; "split down" shows and runs as a layout step', async () => {
    const { parse } = await import('../lib/jarvis/parse');
    const s = setup({ parse });
    s.type('$ git status');
    s.key('Enter');
    if (screen.queryByText(/Confirm:/)) s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'git status'));
  });
});

describe('CommandPalette — messages to agents', () => {
  const withAgent = (): ParseContext => ({ ...ctx(), tabs: ctx().tabs.map((t) => (t.mode === 'claude' && t.sessionId === '1' ? { ...t, agentId: 'claude-1@a' } : t)) });

  for (const delivered of ['sent', 'typed' /* an older server */] as const) {
    it(`sent to an agent at rest (${delivered}): "Sent to claude-1 via intercom", and its tab comes up`, async () => {
      const s = setup({ context: withAgent });
      s.server.message.mockResolvedValueOnce({ delivered, to: { agentId: 'claude-1@a', alias: null } });
      s.type('@claude-1 how are you');
      s.key('Enter');
      await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalledWith(expect.objectContaining({ ok: true, summary: 'Sent to claude-1 via intercom' })));
      expect(s.hub.focus).toHaveBeenCalledWith(ref('claude', '1'));
    });
  }

  it('queued for a busy agent: says so, and leaves the layout alone', async () => {
    const s = setup({ context: withAgent });
    s.server.message.mockResolvedValueOnce({ delivered: 'queued', id: 'm1', to: { agentId: 'claude-1@a', alias: 'reviewer' } });
    s.type('@claude-1 how are you');
    s.key('Enter');
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalledWith(expect.objectContaining({ ok: true, summary: 'reviewer is busy — it’ll read it after this turn', notice: true })));
    expect(s.hub.focus).not.toHaveBeenCalled();
  });
});

describe('CommandPalette — asking agents, and recaps', () => {
  beforeEach(() => {
    __resetAgentAnswers();
    sse.handler = null;
    feed.mockReset().mockResolvedValue([{ id: 'r1', from: { agentId: 'claude-1@a' }, to: 'human', kind: 'reply', body: 'Yes, all 40 pass.', createdAt: 2 }]);
  });
  const answerArrives = async () => {
    await act(async () => {
      sse.handler?.({ type: 'message.queued', data: { scopeId: 's', id: 'r1', from: 'claude-1@a', to: 'human', kind: 'reply', replyTo: 'q1' } });
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('a recap shows its text as the box\'s answer (the question stays above it)', async () => {
    const s = setup();
    (s.server.recap as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'claude-1 is fixing the login test; 3 of 4 pass.' });
    s.type('what is claude-1 doing');
    s.key('Enter');
    expect(await screen.findByText('claude-1 is fixing the login test; 3 of 4 pass.')).toBeInTheDocument();
    expect((s.server.recap as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual(['claude-1@a']);
    expect(s.input).toHaveValue('what is claude-1 doing');
  });

  it('an ask says it was asked; the reply lands in the box as "claude-1: …"', async () => {
    const s = setup();
    s.server.message.mockResolvedValue({ delivered: 'sent', id: 'q1', ask: true, to: { agentId: 'claude-1@a', alias: null } });
    s.type('ask claude-1 if the tests pass');
    s.key('Enter');
    expect(await screen.findByText('Asked claude-1, the answer will show here')).toBeInTheDocument();
    expect(s.server.message).toHaveBeenCalledWith('claude-1@a', 'do the tests pass?', { ask: true });
    expect(s.jarvis.onRan).not.toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/via intercom/) }));
    await answerArrives();
    expect(feed).toHaveBeenCalledWith('default', expect.objectContaining({ agent: 'claude-1@a' }));
    expect(await screen.findByText('claude-1: Yes, all 40 pass.')).toBeInTheDocument();
  });

  it('a recap that needs the key: the reason, and a Settings button that opens Command box settings', async () => {
    const onOpenSettings = vi.fn();
    const s = setup({ model: { status: 'ready', ask: vi.fn(), toPlan: vi.fn(), onOpenSettings } as unknown as JarvisPaletteProps['model'] });
    (s.server.recap as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('Recaps need an Anthropic API key — Settings'), { reason: 'no_key' }));
    s.type('what is claude-1 doing');
    s.key('Enter');
    expect(await screen.findByRole('alert')).toHaveTextContent('Recaps need an Anthropic API key');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('a recap that fails for another reason (unknown agent): just the reason, no Settings', async () => {
    const s = setup({ model: { status: 'ready', ask: vi.fn(), toPlan: vi.fn(), onOpenSettings: vi.fn() } as unknown as JarvisPaletteProps['model'] });
    (s.server.recap as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No agent claude-9 here'));
    s.type('what is claude-1 doing');
    s.key('Enter');
    expect(await screen.findByRole('alert')).toHaveTextContent('No agent claude-9 here');
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('asking several (a Focus): one line per agent; each answer replaces its own line as it arrives', async () => {
    const s = setup();
    s.server.message
      .mockResolvedValueOnce({ delivered: 'sent', id: 'q1', ask: true, to: { agentId: 'claude-1@a', alias: null } })
      .mockResolvedValueOnce({ delivered: 'queued', id: 'q2', ask: true, to: { agentId: 'claude-2@b', alias: null } });
    feed.mockImplementation(async (_ws: string, o: { agent: string }) => o.agent === 'claude-1@a'
      ? [{ id: 'r1', from: { agentId: 'claude-1@a' }, to: 'human', kind: 'reply', body: 'Yes, all 40 pass.', createdAt: 2 }]
      : [{ id: 'r2', from: { agentId: 'claude-2@b' }, to: 'human', kind: 'reply', body: '2 fail in auth.', createdAt: 3 }]);
    s.type('ask the claudes in this focus if their tests pass');
    s.key('Enter');
    await screen.findByText(/Asked claude-1, the answer will show here/);
    expect(screen.getByTestId('jarvis-answer')).toHaveTextContent('claude-2 is busy, it’ll answer after this turn');
    await answerArrives();
    await screen.findByText(/claude-1: Yes, all 40 pass\./);
    expect(screen.getByTestId('jarvis-answer')).toHaveTextContent('claude-2 is busy, it’ll answer after this turn');
    await act(async () => {
      sse.handler?.({ type: 'message.queued', data: { scopeId: 's', id: 'r2', from: 'claude-2@b', to: 'human', kind: 'reply', replyTo: 'q2' } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByText(/claude-2: 2 fail in auth\./);
    const both = screen.getByTestId('jarvis-answer');
    expect(both).toHaveTextContent('claude-1: Yes, all 40 pass.');
    expect(both).not.toHaveTextContent('Asked');
  });

  it('an ask to a busy agent says it will answer after this turn', async () => {
    const s = setup();
    s.server.message.mockResolvedValue({ delivered: 'queued', id: 'q1', ask: true, to: { agentId: 'claude-1@a', alias: 'reviewer' } });
    s.type('ask claude-1 if the tests pass');
    s.key('Enter');
    expect(await screen.findByText('reviewer is busy, it’ll answer after this turn')).toBeInTheDocument();
  });

  it('the box is closed when the reply lands: a toast says it, and its Show opens the box with the answer', async () => {
    const s = setup();
    s.server.message.mockResolvedValue({ delivered: 'sent', id: 'q1', ask: true, to: { agentId: 'claude-1@a', alias: null } });
    s.type('ask claude-1 if the tests pass');
    s.key('Enter');
    await screen.findByText('Asked claude-1, the answer will show here');
    s.key('Escape');
    act(() => { s.input.blur(); });
    await answerArrives();
    const toast = (s.jarvis.onRan as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).find((r) => r.summary === 'claude-1: Yes, all 40 pass.');
    expect(toast).toEqual(expect.objectContaining({ ok: true, notice: true, action: expect.objectContaining({ label: 'Show' }) }));
    act(() => toast.action.run());
    expect(document.activeElement).toBe(s.input);
    expect(await screen.findByText('claude-1: Yes, all 40 pass.')).toBeInTheDocument();
  });
});
