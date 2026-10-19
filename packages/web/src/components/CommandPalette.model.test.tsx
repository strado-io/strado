import { act, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type JarvisPaletteProps, releaseKeyboard } from './CommandPalette';
import type { ActionId, ParseContext, Plan, Step, StepOf, TabRef } from '../lib/jarvis/types';
import type { ModelResult } from '../lib/jarvis/modelClient';
import { readFallthrough } from '../lib/jarvis/history';
import type { RepoConfig, Workspace, Worktree } from '../types';
import type { VoiceBridge } from '../hooks/voice';

afterEach(() => releaseKeyboard());

/** The bar is inert until focused (click or ⌘K): every test starts with it focused. */
const render = (ui: Parameters<typeof rtlRender>[0]) => {
  const r = rtlRender(ui);
  act(() => { (screen.getByLabelText('Global search') as HTMLInputElement).focus(); });
  return r;
};


vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { ...actual.api, worktrees: { ...actual.api.worktrees, list: vi.fn().mockResolvedValue([]) } } };
});

const P = '/wt/FD-1';
const ref = (mode: TabRef['mode'], sessionId: string): TabRef => ({ worktreePath: P, mode, sessionId });
function step<A extends ActionId>(action: A, args: StepOf<A>['args'], over: Partial<StepOf<A>> = {}): Step {
  return { action, args, target: { kind: 'none' }, risk: 'layout', where: 'hub', undoable: true, needsConfirm: false, chips: [], ...over } as Step;
}
const plan = (steps: Step[], over: Partial<Plan> = {}): Plan => ({ steps, source: 'rule', summary: 's', executable: true, ...over });
const askClaude = (text: string) => plan([step('agent.message', { agentId: 'claude-1@a', text }, { where: 'server', risk: 'exec', undoable: false, chips: [{ arg: 'agentId', label: 'Ask claude-1', candidates: [] }] })], { source: 'fallback', summary: `Ask claude-1: ${text}` });
function stubParse({ text }: { text: string }): Plan {
  const t = text.trim();
  if (t === 'close shell') return plan([step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, needsConfirm: true, confirmReason: 'closing a terminal', target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'target', label: 'Close Shell', candidates: [] }] })], { summary: 'Close Shell' });
  if (t === 'split down') return plan([step('tab.focus', {}, { target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'target', label: 'Split down', candidates: [] }] })], { summary: 'Split down' });
  return askClaude(t);
}
const modelPlan = (summary = 'Open shell below Claude'): Plan => plan([step('tab.open', { mode: 'shell', worktreePath: P, place: { split: 'down', anchor: { kind: 'tab', ref: ref('claude', '1') }, focus: false } }, { where: 'server', risk: 'spawn', chips: [{ arg: 'mode', label: 'Open shell', candidates: [] }, { arg: 'place', label: 'below Claude', candidates: [] }] })], { source: 'model', summary });
const ctx = (): ParseContext => ({
  tabs: [{ ...ref('shell', '1'), label: 'Shell', busy: false }, { ...ref('claude', '1'), label: 'Claude', busy: false }],
  focused: ref('shell', '1'), lastActedOn: null, currentWorktree: P, worktrees: [], focuses: [], packageScripts: {}, peers: [],
});

/** The desktop speech bridge, faked: tests emit its events. */
function fakeVoice() {
  let listener: ((e: StradoVoiceEvent) => void) | null = null;
  const bridge: VoiceBridge = {
    available: true, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
    onEvent: (cb) => { listener = cb; return () => { listener = null; }; },
  };
  return { bridge, emit: (e: StradoVoiceEvent) => act(() => { listener?.(e); }) };
}
const pause = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

type Deferred = { resolve: (r: ModelResult) => void; signal: AbortSignal; text: string; thread: unknown[]; ctx: ParseContext };
function setup(model: Partial<NonNullable<JarvisPaletteProps['model']>> = {}, voice: VoiceBridge | null = null) {
  const asks: Deferred[] = [];
  const hub = { path: P, snapshot: vi.fn(() => 'SNAP'), restore: vi.fn(), place: vi.fn().mockResolvedValue({ ok: true }), focus: vi.fn(() => true), openBrowser: vi.fn(), closeLocal: vi.fn() };
  const server = { spawn: vi.fn().mockResolvedValue({ tab: ref('shell', '4') }), run: vi.fn(), interrupt: vi.fn(), close: vi.fn(), message: vi.fn().mockResolvedValue({}), startServer: vi.fn(), stopServer: vi.fn(), answerCall: vi.fn(), dismissCall: vi.fn() };
  const toPlan = vi.fn((_steps: unknown, _ctx: ParseContext, _opts?: unknown) => modelPlan());
  const onOpenSettings = vi.fn();
  const jarvis: JarvisPaletteProps = {
    wsId: 'default', parse: stubParse, context: ctx,
    ports: () => ({ hub, server, nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), line: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() } }),
    onRan: vi.fn(), onActed: vi.fn(),
    model: {
      status: 'ready',
      ask: (text, thread, c, signal) => new Promise((resolve) => { asks.push({ resolve, signal, text, thread, ctx: c }); }),
      toPlan, onOpenSettings, ...model,
    },
  };
  const onClose = vi.fn();
  const view = render(<CommandPalette repos={[] as RepoConfig[]} worktrees={[{ path: P, branch: 'FD-1', meta: { ticketId: 'FD-1' }, process: { status: 'idle' } } as unknown as Worktree]}
    workspaces={[{ id: 'default', name: 'Personal' }] as Workspace[]} activeWorkspaceId="default"
    onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={onClose} jarvis={jarvis} voice={voice} />);
  const input = screen.getByLabelText('Global search');
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const key = (k: string, mods: Record<string, boolean> = {}) => fireEvent.keyDown(input, { key: k, ...mods });
  return { asks, hub, server, toPlan, onOpenSettings, onClose, jarvis, input, type, key, unmount: view.unmount };
}
const suggestedRun = (): Plan => ({ ...modelPlan('Run rm -rf build in Shell'), steps: [step('shell.run', { command: 'rm -rf build' }, { where: 'server', risk: 'exec', undoable: false, needsConfirm: true, confirmReason: 'suggested by the model — check the command before running it', target: { kind: 'tab', ref: ref('shell', '1') }, chips: [{ arg: 'command', label: 'rm -rf build', candidates: [] }] })] });
const answer = async (d: Deferred, r: ModelResult) => { await act(async () => { d.resolve(r); }); };

beforeEach(() => localStorage.clear());

describe('CommandPalette — natural language', () => {
  it('while typing nothing is suggested: no ask row, no agent fallback, no request — only "⏎ to run"', () => {
    const s = setup();
    s.type('put the dev server under claude');
    expect(screen.queryByTestId('jarvis-model-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jarvis-row-0')).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask claude-1/)).not.toBeInTheDocument();
    expect(screen.getByTestId('jarvis-submit')).toHaveTextContent('⏎ to run');
    expect(s.asks).toHaveLength(0);
  });

  it('⏎ asks the model ("Thinking…"); a plan that needs no confirm runs at once — no preview, no second ⏎ — and the box clears for the next', async () => {
    const s = setup();
    s.type('put the dev server under claude');
    s.key('Enter');
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/thinking/i);
    // Jev and Haiku race on the server: while waiting, nobody knows which will answer.
    expect(screen.getByTestId('jarvis-model-row')).not.toHaveTextContent(/via/);
    // A clear, quiet sign it is working; the text stays editable (editing aborts).
    expect(screen.getByRole('progressbar', { name: 'Thinking' })).toBeInTheDocument();
    expect(s.input).not.toBeDisabled();
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]!.text).toBe('put the dev server under claude');
    expect(s.server.spawn).not.toHaveBeenCalled();
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'claude-haiku-5-5', ms: 300 });
    expect(s.toPlan).toHaveBeenCalledWith([{ action: 'tab.open', args: {} }], expect.objectContaining({ currentWorktree: P }), { text: 'put the dev server under claude', thread: [] });
    await waitFor(() => expect(s.server.spawn).toHaveBeenCalledTimes(1));
    // A plain success raises no toast; the result is on screen.
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalledWith(expect.objectContaining({ ok: true, summary: 'Open shell below Claude' })));
    expect(vi.mocked(s.jarvis.onRan).mock.lastCall![0]).not.toHaveProperty('notice');
    expect(s.input).toHaveValue('');
  });

  it('the row says which model read it: "via Jev" for the fast path, else "via Haiku"', async () => {
    const s = setup();
    s.toPlan.mockReturnValue({ ...modelPlan('Close Shell'), steps: [step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, needsConfirm: true, confirmReason: 'closing a terminal', target: { kind: 'tab', ref: ref('shell', '1') } })] });
    s.type('close the shell');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.close', args: {} }], model: 'typesafe/jev-1.14', ms: 602 });
    expect(await screen.findByTestId('jarvis-row-0')).toHaveTextContent('via Jev · 0.6 s');
    s.type('what is running?');
    s.key('Enter');
    await answer(s.asks[1]!, { kind: 'answer', text: 'Nothing yet.', model: 'claude-haiku-5-5', ms: 300 });
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent('via Haiku · 0.3 s');
  });

  it('choices from an earlier answer go stale with the thread: "yes" in another worktree is asked, not replayed', async () => {
    const s = setup();
    s.type('what should I do?');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'answer', text: 'Pick one', choices: ['close shell-1', 'open claude'], model: 'm', ms: 1 });
    s.jarvis.context = () => ({ ...ctx(), currentWorktree: '/wt/other' }); // the user went to another worktree
    s.type('yes');
    s.key('Enter');
    await waitFor(() => expect(s.asks).toHaveLength(2));
    expect(s.asks[1]!.text).toBe('yes');
  });

  it('voice: a pause while still holding asks early; ⏎ on a final with the same words reuses that answer (no second ask)', async () => {
    const v = fakeVoice();
    const s = setup({}, v.bridge);
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'put the dev server under claude' });
    await pause(450); // ≥ 400 ms of quiet while held
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]!.text).toBe('put the dev server under claude');
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    v.emit({ type: 'final', text: 'Put the dev server under Claude.' }); // same words once normalised
    expect(s.asks).toHaveLength(1);
    s.key('Enter'); // a voice request waits for ⏎
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'typesafe/jev-1.14', ms: 400 });
    await waitFor(() => expect(s.server.spawn).toHaveBeenCalledTimes(1));
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]!.signal.aborted).toBe(false);
  });

  it('voice: a final that differs from the early ask drops it and asks ahead with the final text; ⏎ uses that (no third ask)', async () => {
    const v = fakeVoice();
    const s = setup({}, v.bridge);
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'put the dev server' });
    await pause(450);
    expect(s.asks).toHaveLength(1);
    v.emit({ type: 'partial', text: 'put the dev server under claude' });
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    v.emit({ type: 'final', text: 'put the dev server under claude' });
    await waitFor(() => expect(s.asks).toHaveLength(2));
    expect(s.asks[0]!.signal.aborted).toBe(true);
    expect(s.asks[1]!.text).toBe('put the dev server under claude');
    s.key('Enter');
    await answer(s.asks[1]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'typesafe/jev-1.14', ms: 400 });
    await waitFor(() => expect(s.server.spawn).toHaveBeenCalledTimes(1));
    expect(s.asks).toHaveLength(2);
  });

  it('voice: an error mid-talk (the mic went away) drops the early ask too', async () => {
    const v = fakeVoice();
    const s = setup({}, v.bridge);
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'close the shell' });
    await pause(450);
    expect(s.asks).toHaveLength(1);
    v.emit({ type: 'error', code: 'mic_denied' });
    expect(s.asks[0]!.signal.aborted).toBe(true);
  });

  it('voice: Esc drops an early ask', async () => {
    const v = fakeVoice();
    const s = setup({}, v.bridge);
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'close the shell' });
    await pause(450);
    s.key('Escape');
    expect(s.asks[0]!.signal.aborted).toBe(true);
  });

  it('auto-run is not stopped by a layout that moved on its own while Haiku was thinking (same tabs)', async () => {
    const s = setup();
    let n = 0;
    s.jarvis.context = () => ({ ...ctx(), focused: n++ % 2 ? ref('claude', '1') : ref('shell', '1') }); // every read differs
    s.type('open the shell in the right and check the git status');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    await waitFor(() => expect(s.server.spawn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/layout changed/i)).not.toBeInTheDocument();
  });

  it('a plan that needs a confirm arrives armed: "Haiku wants to: …"; one ⏎ runs it', async () => {
    const s = setup();
    s.toPlan.mockReturnValueOnce(suggestedRun());
    s.type('clean the build');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'shell.run', args: {} }], model: 'm', ms: 1 });
    expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent(/Haiku wants to: Run rm -rf build in Shell/);
    expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent(/⏎ to confirm/);
    expect(s.server.run).not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 550));
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalledTimes(1));
  });

  it('a shell found busy at arrival is never closed on its own: the plan waits for a confirm', async () => {
    const s = setup();
    s.jarvis.isBusy = vi.fn().mockResolvedValue(true);
    s.toPlan.mockReturnValueOnce({ ...modelPlan('Close Shell'), steps: [step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') }, chips: [] })] });
    s.type('get rid of the shell');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.close', args: {} }], model: 'm', ms: 1 });
    await waitFor(() => expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent(/Haiku wants to: Close Shell/));
    expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent(/Shell is running something — close it anyway\?/);
    expect(s.server.close).not.toHaveBeenCalled();
  });

  it('nothing runs if the box closed before the plan arrived', async () => {
    const s = setup();
    s.type('put the dev server under claude');
    s.key('Enter');
    const pending = s.asks[0]!;
    s.unmount();
    expect(pending.signal.aborted).toBe(true);
    await act(async () => { pending.resolve({ kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 }); });
    expect(s.server.spawn).not.toHaveBeenCalled();
  });

  it('the reply is resolved against the context the request described, not a later one', async () => {
    let focused = ref('shell', '1');
    const s = setup();
    s.jarvis.context = () => ({ ...ctx(), focused });
    s.type('put the dev server under claude');
    s.key('Enter');
    focused = ref('claude', '1');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    expect(s.asks[0]!.ctx.focused).toEqual(ref('shell', '1'));
    expect(s.toPlan.mock.calls[0]![1]).toBe(s.asks[0]!.ctx);
  });

  it('an answer is shown inline and runs nothing', async () => {
    const s = setup();
    s.type('what is claude-1 doing?');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'answer', text: 'claude-1 is idle; its last turn fixed the parser test.', model: 'm', ms: 1 });
    expect(screen.getByText('claude-1 is idle; its last turn fixed the parser test.')).toBeInTheDocument();
    s.key('Enter');
    expect(s.server.message).not.toHaveBeenCalled();
  });

  it('typing again aborts the in-flight request; esc cancels thinking first and closes on the next press', async () => {
    const s = setup();
    s.type('put the dev server under claude');
    s.key('Enter');
    s.type('put the dev server under claude please');
    expect(s.asks[0]!.signal.aborted).toBe(true);
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
    s.key('Enter');
    s.key('Escape');
    expect(s.asks[1]!.signal.aborted).toBe(true);
    expect(s.onClose).not.toHaveBeenCalled();
    s.key('Escape');
    expect(s.onClose).toHaveBeenCalled();
  });

  it('a follow-up carries the thread, with what the last plan actually did (not just its summary)', async () => {
    const s = setup();
    s.type('open a shell next to claude');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalled());
    act(() => { s.input.focus(); });
    s.type('no, below it');
    s.key('Enter');
    expect(s.asks[1]!.text).toBe('no, below it');
    expect(s.asks[1]!.thread).toEqual([{ role: 'user', text: 'open a shell next to claude' }, { role: 'assistant', text: expect.stringMatching(/^Ran: opened shell-4/) }]);
    // planFromModel sees the earlier turns (a command typed there counts as typed).
    await answer(s.asks[1]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    expect(s.toPlan.mock.calls[1]![2]).toEqual({ text: 'no, below it', thread: s.asks[1]!.thread });
  });

  it('a plan that failed partway is recorded as such, so the model never thinks the failed step happened', async () => {
    const s = setup();
    s.hub.place.mockResolvedValueOnce({ ok: false, reason: 'The new tab did not show up' });
    s.type('open a shell next to claude');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    await screen.findByText('The new tab did not show up');
    s.type('try again');
    s.key('Enter');
    expect(s.asks[1]!.thread[1]).toEqual({ role: 'assistant', text: expect.stringMatching(/^Partly ran/) });
  });

  it('no key: ⏎ says natural language needs the model, with a Settings link; ⏎ again opens Settings', () => {
    const s = setup({ status: 'no_key' });
    s.type('put the dev server under claude');
    expect(screen.queryByTestId('jarvis-model-row')).not.toBeInTheDocument();
    s.key('Enter');
    const row = screen.getByTestId('jarvis-model-row');
    expect(row).toHaveTextContent('Natural language needs the model — Settings');
    expect(within(row).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    s.key('Enter');
    expect(s.onOpenSettings).toHaveBeenCalled();
    expect(s.asks).toHaveLength(0);
  });

  it('model errors show inline (a rejected key links to Settings); ⏎ again retries', async () => {
    const s = setup();
    s.type('put the dev server under claude');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'error', reason: 'bad_key' });
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/key was rejected/i);
    s.type('something else');
    s.key('Enter');
    await answer(s.asks[1]!, { kind: 'error', reason: 'timeout' });
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/took too long/i);
    s.key('Enter');
    expect(s.asks).toHaveLength(3);
    expect(s.asks[2]!.text).toBe('something else');
    expect(s.server.message).not.toHaveBeenCalled();
  });

  it('local only: nothing is sent; ⏎ on plain text says it needs the model, and the Settings link opens Settings', () => {
    const s = setup({ status: 'local_only' });
    s.type('put the dev server under claude');
    s.key('Enter');
    const row = screen.getByTestId('jarvis-model-row');
    expect(row).toHaveTextContent('Natural language needs the model — Settings');
    fireEvent.click(within(row).getByRole('button', { name: 'Settings' }));
    expect(s.onOpenSettings).toHaveBeenCalled();
    expect(s.asks).toHaveLength(0);
    expect(s.server.message).not.toHaveBeenCalled();
  });

  it('secret-looking text is never sent; the row says why', () => {
    const s = setup();
    s.type('use token=abc123 for the deploy');
    s.key('Enter');
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/not sent/i);
    expect(s.asks).toHaveLength(0);
  });

  it('an exact rule hit runs on ⏎ without asking the model (fast path)', async () => {
    const s = setup();
    s.type('split down');
    s.key('Enter');
    await waitFor(() => expect(s.hub.focus).toHaveBeenCalled());
    expect(s.asks).toHaveLength(0);
  });

  it('a rule reading that needs a confirm goes to Haiku instead; the local confirm never shows', () => {
    const s = setup();
    s.type('close shell');
    s.key('Enter');
    expect(s.asks).toHaveLength(1);
    expect(screen.queryByText(/Confirm: closing a terminal/)).not.toBeInTheDocument();
    expect(s.server.close).not.toHaveBeenCalled();
  });

  it('pasted text is never sent on one ⏎: "Send pasted text to Haiku?" first; its plan still needs the second ⏎', async () => {
    const s = setup();
    fireEvent.paste(s.input);
    s.type('put the dev server under claude');
    s.key('Enter');
    expect(s.asks).toHaveLength(0);
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/send pasted text to haiku\?/i);
    expect(readFallthrough()).toEqual([]);
    s.key('Enter');
    expect(s.asks).toHaveLength(1);
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    await new Promise((r) => setTimeout(r, 550));
    s.key('Enter');
    expect(s.server.spawn).not.toHaveBeenCalled();
    expect(screen.getByText(/pasted/i)).toBeInTheDocument();
  });

  it('a stray ⏎ right after a confirm-needing plan arrives is ignored (500 ms guard)', async () => {
    const s = setup();
    s.toPlan.mockReturnValueOnce(suggestedRun());
    s.type('clean the build');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'shell.run', args: {} }], model: 'm', ms: 1 });
    s.key('Enter');
    expect(s.server.run).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 550));
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalled());
  });

  it('server refusals: a secret is reported inline; a bad thread resets the thread and retries once', async () => {
    const s = setup();
    s.type('open a shell next to claude');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 });
    act(() => { s.input.focus(); }); // the run handed focus back; ⌘K again
    s.type('no, below it');
    s.key('Enter');
    await answer(s.asks[1]!, { kind: 'error', reason: 'thread' });
    expect(s.asks).toHaveLength(3);
    expect(s.asks[2]!.thread).toEqual([]);
    await answer(s.asks[2]!, { kind: 'error', reason: 'thread' });
    expect(s.asks).toHaveLength(3); // only once
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/couldn’t|try again/i);
    s.type('deploy with this');
    s.key('Enter');
    await answer(s.asks[3]!, { kind: 'error', reason: 'secret' });
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/looks like a secret — not sent/i);
    s.type('another');
    s.key('Enter');
    await answer(s.asks[4]!, { kind: 'error', reason: 'rate_limited' });
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent(/too many requests, wait a moment/i);
  });

  it('ambiguity comes back as a pick list; a plan the box cannot use says why', async () => {
    const s = setup();
    s.toPlan.mockReturnValueOnce(plan([], { source: 'model', summary: 'Which claude?', alternatives: [modelPlan('Open shell below Claude'), modelPlan('Open shell below Claude 2')] }));
    s.type('shell under claude');
    s.key('Enter');
    await answer(s.asks[0]!, { kind: 'plan', steps: [], model: 'm', ms: 1 });
    expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent('Open shell');
    expect(screen.getByTestId('jarvis-row-1')).toHaveTextContent('Open shell');
    expect(s.server.spawn).not.toHaveBeenCalled(); // a pick list never runs on its own
    s.toPlan.mockReturnValueOnce(plan([], { source: 'model', summary: 'Haiku asked for an action this box does not have', executable: false }));
    s.type('do a barrel roll');
    s.key('Enter');
    await answer(s.asks[1]!, { kind: 'plan', steps: [{ action: 'nope', args: {} }], model: 'm', ms: 1 });
    expect(screen.getByTestId('jarvis-model-row')).toHaveTextContent('Haiku asked for an action this box does not have');
  });

  it('the first model row explains once what gets sent', () => {
    const s = setup();
    s.type('put the dev server under claude');
    expect(screen.getByText(/goes to Haiku/i)).toBeInTheDocument();
    s.key('Enter');
    s.type('again');
    expect(screen.queryByText(/goes to Haiku/i)).not.toBeInTheDocument();
  });

  describe('answers with choices (live: "yes" got the same question again)', () => {
    const which: ModelResult = { kind: 'answer', text: 'Which Claude?', choices: ['ask claude-1 how are you', 'ask claude-2 how are you', 'ask claude-3 how are you'], model: 'm', ms: 1 };

    it('shows the choices under the answer, the first selected; ⏎ asks it as the next turn of the same thread', async () => {
      const s = setup();
      s.type('ask @claude how are you ?');
      s.key('Enter');
      await answer(s.asks[0]!, which);
      expect(screen.getByText('Which Claude?')).toBeInTheDocument();
      expect(screen.getByTestId('jarvis-choice-0')).toHaveTextContent('ask claude-1 how are you');
      expect(screen.getByTestId('jarvis-choice-0')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('jarvis-choice-2')).toHaveTextContent('ask claude-3 how are you');
      s.key('Enter');
      expect(s.asks).toHaveLength(2);
      expect(s.asks[0]!.signal.aborted).toBe(false);
      expect(s.asks[1]!.text).toBe('ask claude-1 how are you');
      expect(s.asks[1]!.thread).toEqual([{ role: 'user', text: 'ask @claude how are you ?' }, { role: 'assistant', text: 'Which Claude?' }]);
      expect(s.input).toHaveValue('ask claude-1 how are you');
      expect(s.asks[1]!.signal.aborted).toBe(false); // the text change is this ask, not the user moving on
    });

    it('a click on another choice asks that one', async () => {
      const s = setup();
      s.type('ask @claude how are you ?');
      s.key('Enter');
      await answer(s.asks[0]!, which);
      fireEvent.click(screen.getByTestId('jarvis-choice-1'));
      expect(s.asks[1]!.text).toBe('ask claude-2 how are you');
    });

    it('"yes" takes the first choice and "2" the second, locally — the model is not asked to interpret them', async () => {
      const s = setup();
      s.type('ask @claude how are you ?');
      s.key('Enter');
      await answer(s.asks[0]!, which);
      s.type('yes');
      s.key('Enter');
      expect(s.asks[1]!.text).toBe('ask claude-1 how are you');
      await answer(s.asks[1]!, which);
      s.type('2');
      s.key('Enter');
      expect(s.asks[2]!.text).toBe('ask claude-2 how are you');
    });

    it('with no choices on the last answer, "yes" is just text for the model', async () => {
      const s = setup();
      s.type('should I restart the server?');
      s.key('Enter');
      await answer(s.asks[0]!, { kind: 'answer', text: 'Probably, it is stuck.', model: 'm', ms: 1 });
      s.type('yes');
      s.key('Enter');
      expect(s.asks[1]!.text).toBe('yes');
    });
  });
});
