import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type CommandBarHandle, type JarvisPaletteProps, releaseKeyboard } from './CommandPalette';
import type { ActionId, ParseContext, Plan, Step, StepOf, TabRef } from '../lib/jarvis/types';
import type { ModelResult } from '../lib/jarvis/modelClient';
import type { RepoConfig, Workspace, Worktree } from '../types';
import type { StationDto } from '../api';
import { readHistoryEntries, rememberCommand } from '../lib/jarvis/history';

afterEach(() => releaseKeyboard());

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
function stubParse({ text }: { text: string }): Plan {
  const t = text.trim();
  if (t === 'focus claude' || t === 'focus claude for @{claude-2@app}') return plan([step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1') } })], { summary: 'Focus Claude' });
  if (t === 'close shell') return plan([step('tab.close', {}, { where: 'server', risk: 'destructive', undoable: false, needsConfirm: true, confirmReason: 'a process is running in that tab', target: { kind: 'tab', ref: ref('shell', '1') } })], { summary: 'Close Shell' });
  if (t === 'what is claude-1 doing') return plan([step('agent.recap', { agentIds: ['claude-1@a'] }, { where: 'server', risk: 'read', undoable: false })], { summary: 'Recap claude-1' });
  if (t === 'run ls') return plan([step('shell.run', { command: 'ls' }, { where: 'server', risk: 'exec', undoable: false, target: { kind: 'tab', ref: ref('shell', '1') } })], { summary: 'Run ls' });
  return plan([], { source: 'fallback', executable: false });
}

/** The desktop shell's speech bridge, faked: tests emit its events. */
function fakeVoice() {
  let listener: ((e: StradoVoiceEvent) => void) | null = null;
  const bridge = {
    available: true,
    start: vi.fn(async (_names: string[]) => {}), stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onEvent: (cb: (e: StradoVoiceEvent) => void) => { listener = cb; return () => { listener = null; }; },
  };
  return { bridge, emit: (e: StradoVoiceEvent) => act(() => { listener?.(e); }) };
}

type Deferred = { resolve: (r: ModelResult) => void; text: string; thread: unknown[]; ctx: ParseContext };

/** A board with a shell pane (focused before the bar), a claude pane, and the bar. */
function setup(opts: { model?: boolean; toPlan?: () => Plan; stations?: StationDto[]; hero?: boolean; voice?: ReturnType<typeof fakeVoice>['bridge']; dialogOpen?: boolean } = {}) {
  const where = { worktree: P };
  let focused: TabRef | null = ref('shell', '1');
  const asks: Deferred[] = [];
  const hub = {
    path: P, snapshot: vi.fn(() => 'SNAP'), restore: vi.fn(), place: vi.fn().mockResolvedValue({ ok: true }),
    focus: vi.fn((r: TabRef) => { focused = r; return true; }), openBrowser: vi.fn(), closeLocal: vi.fn(),
  };
  const server = { spawn: vi.fn(), run: vi.fn().mockResolvedValue({ settled: true, output: '', durationMs: 1 }), interrupt: vi.fn(), close: vi.fn(), message: vi.fn(), startServer: vi.fn(), stopServer: vi.fn(), answerCall: vi.fn(), dismissCall: vi.fn(),
    recap: vi.fn().mockResolvedValue({ text: 'claude-1 is fixing the login test.' }) };
  const ctx = vi.fn((): ParseContext => ({
    tabs: [{ ...ref('shell', '1'), label: 'Shell', busy: false }, { ...ref('claude', '1'), label: 'Claude', busy: false }],
    focused, lastActedOn: null, currentWorktree: where.worktree, worktrees: [], focuses: [], packageScripts: {}, peers: [],
  }));
  const jarvis: JarvisPaletteProps = {
    wsId: 'default', parse: vi.fn(stubParse), context: ctx,
    ports: () => ({ hub, server, nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() } }),
    onRan: vi.fn(), onActed: vi.fn(),
    ...(opts.model ? { model: {
      status: 'ready' as const,
      ask: (text: string, thread: unknown[], c: ParseContext) => new Promise<ModelResult>((resolve) => { asks.push({ resolve, text, thread, ctx: c }); }),
      toPlan: opts.toPlan ?? (() => plan([step('tab.focus', {}, { target: { kind: 'tab', ref: ref('claude', '1') } })], { source: 'model', summary: 'Focus Claude' })),
      onOpenSettings: vi.fn(),
    } } : {}),
  };
  const onClose = vi.fn();
  const barRef: { current: CommandBarHandle | null } = { current: null };
  function Board() {
    return (
      <div>
        <div data-pane-key="shell:1"><textarea aria-label="shell 1 terminal" /></div>
        <div data-pane-key="claude:1"><textarea aria-label="claude 1 terminal" /></div>
        <CommandPalette barRef={barRef} stations={opts.stations} hero={opts.hero} voice={opts.voice} dialogOpen={opts.dialogOpen} repos={[] as RepoConfig[]} worktrees={[{ path: P, branch: 'FD-1', meta: { ticketId: 'FD-1' }, process: { status: 'idle' } } as unknown as Worktree]}
          workspaces={[{ id: 'default', name: 'Personal' }] as Workspace[]} activeWorkspaceId="default"
          onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={onClose} jarvis={jarvis} />
      </div>
    );
  }
  const view = render(<Board />);
  const input = screen.getByLabelText('Global search') as HTMLInputElement;
  const shellPane = screen.getByLabelText('shell 1 terminal');
  const claudePane = screen.getByLabelText('claude 1 terminal');
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const key = (k: string, mods: Record<string, boolean> = {}) => fireEvent.keyDown(input, { key: k, ...mods });
  return { input, shellPane, claudePane, type, key, hub, server, ctx, asks, onClose, jarvis, view, barRef, where };
}

beforeEach(() => localStorage.clear());
afterEach(() => { vi.useRealTimers(); });

describe('CommandPalette: talk to Strado (push-to-talk)', () => {
  // A modal owns the keyboard: Space acts on its controls, and nothing behind it starts listening.
  const modal = () => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = '<button type="button">Delete</button>';
    document.body.appendChild(d);
    return { button: d.querySelector('button')!, remove: () => d.remove() };
  };

  it('hold Space on a button inside a modal does not start listening (the dialog keeps the keyboard)', () => {
    vi.useFakeTimers();
    const v = fakeVoice();
    setup({ voice: v.bridge });
    const m = modal();
    m.button.focus();
    fireEvent.keyDown(m.button, { key: ' ', code: 'Space' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(v.bridge.start).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(m.button);
    m.remove();
  });

  it('a dialog the app has open (not marked up as one): hold Space and ⌥Space do nothing', () => {
    vi.useFakeTimers();
    const v = fakeVoice();
    setup({ voice: v.bridge, dialogOpen: true });
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space', altKey: true });
    expect(v.bridge.start).not.toHaveBeenCalled();
  });

  it('while the app has a dialog open, the box never pulls the keyboard back from it', async () => {
    const s = setup({ dialogOpen: true });
    act(() => s.input.focus());
    s.type('half typed'); // the box holds the keyboard now
    const b = document.createElement('button');
    b.textContent = 'Install update';
    document.body.appendChild(b);
    act(() => b.focus());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(document.activeElement).toBe(b);
    b.remove();
  });

  it('⌥Space while a modal is open does not start listening behind it', () => {
    const v = fakeVoice();
    setup({ voice: v.bridge });
    const m = modal();
    m.button.focus();
    fireEvent.keyDown(m.button, { key: ' ', code: 'Space', altKey: true });
    expect(v.bridge.start).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(m.button);
    m.remove();
  });

  it('no mic button: talking is the keys only (hold Space in the box, ⌥Space anywhere)', () => {
    setup({ voice: fakeVoice().bridge });
    expect(screen.queryByRole('button', { name: /talk to strado/i })).not.toBeInTheDocument();
    expect(screen.queryByText('🎤')).not.toBeInTheDocument();
  });

  it('hold ⌥Space anywhere (even in a terminal): listening with a meter, partials fill the box, release puts the final in the box; ⏎ sends it as typed', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    s.shellPane.focus();
    fireEvent.keyDown(s.shellPane, { key: ' ', code: 'Space', altKey: true });
    fireEvent.keyDown(s.shellPane, { key: ' ', code: 'Space', altKey: true, repeat: true }); // auto-repeat is ignored
    expect(v.bridge.start).toHaveBeenCalledTimes(1);
    expect(v.bridge.start.mock.calls[0]![0]).toEqual(expect.arrayContaining(['Shell', 'Claude'])); // the names it may hear
    expect(document.activeElement).toBe(s.input);
    expect(screen.getByText('Listening…')).toBeInTheDocument();
    v.emit({ type: 'level', rms: 0.5 });
    expect(screen.getByRole('meter', { name: 'Mic level' })).toHaveAttribute('aria-valuenow', '0.5');
    v.emit({ type: 'partial', text: 'run' });
    v.emit({ type: 'partial', text: 'run ls' });
    expect(s.input).toHaveValue('run ls');
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    expect(v.bridge.stop).toHaveBeenCalled();
    v.emit({ type: 'final', text: 'run ls' });
    expect(s.server.run).not.toHaveBeenCalled(); // waits for ⏎
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'ls'));
  });

  it('while listening, the cursor is a live waveform right after the words (as in Claude Code); it goes when listening ends', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'open a shell' });
    const caret = screen.getByTestId('voice-caret');
    expect(caret.previousSibling).toHaveTextContent('open a shell'); // sits where the cursor is
    expect(s.input.className).toContain('caret-transparent'); // the real cursor is hidden
    expect(s.input).toHaveAttribute('placeholder', ''); // nothing under the waveform
    const bars = within(caret).getAllByTestId('voice-bar');
    const before = bars.map((b) => b.style.height);
    v.emit({ type: 'level', rms: 0.9 });
    expect(within(screen.getByTestId('voice-caret')).getAllByTestId('voice-bar').map((b) => b.style.height)).not.toEqual(before);
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: '' });
    expect(screen.queryByTestId('voice-caret')).not.toBeInTheDocument();
    expect(s.input.className).not.toContain('caret-transparent');
  });

  it('Esc while listening cancels and puts back what was in the box', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    act(() => s.input.focus());
    s.type('half typed');
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'something else' });
    s.key('Escape');
    expect(v.bridge.cancel).toHaveBeenCalled();
    expect(s.input).toHaveValue('half typed');
    expect(screen.queryByText('Listening…')).not.toBeInTheDocument();
  });

  it('a permission it lacks is named inline, with a link to System Settings', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'error', code: 'speech_denied', message: 'no' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Strado needs speech recognition permission');
    expect(within(alert).getByRole('link', { name: 'Open System Settings' })).toHaveAttribute('href', 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(within(alert).getByRole('link', { name: 'Open System Settings' }));
    expect(open).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition', '_blank');
    open.mockRestore();
  });

  describe('Space outside the box is never ours (Claude Code\'s own hold-Space dictation needs it)', () => {
    const space = (el: Element, over: Record<string, unknown> = {}) => fireEvent.keyDown(el, { key: ' ', code: 'Space', ...over });

    it('held in a terminal: every Space (repeats included) reaches it, and nothing starts listening', () => {
      vi.useFakeTimers();
      const v = fakeVoice();
      const s = setup({ voice: v.bridge });
      s.shellPane.focus();
      expect(space(s.shellPane)).toBe(true);
      expect(space(s.shellPane, { repeat: true })).toBe(true);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(space(s.shellPane, { repeat: true })).toBe(true);
      expect(fireEvent.keyUp(s.shellPane, { key: ' ', code: 'Space' })).toBe(true);
      expect(v.bridge.start).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(s.shellPane);
    });

    it('held with nothing focused (or on a button): nothing starts listening, nothing is prevented', () => {
      vi.useFakeTimers();
      const v = fakeVoice();
      setup({ voice: v.bridge });
      expect(space(document.body)).toBe(true);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(fireEvent.keyUp(document.body, { key: ' ', code: 'Space' })).toBe(true);
      expect(v.bridge.start).not.toHaveBeenCalled();
    });

    it('⌥Space still talks from anywhere, a terminal included', () => {
      const v = fakeVoice();
      const s = setup({ voice: v.bridge });
      s.shellPane.focus();
      expect(fireEvent.keyDown(s.shellPane, { key: ' ', code: 'Space', altKey: true })).toBe(false);
      expect(v.bridge.start).toHaveBeenCalledTimes(1);
      fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
      expect(v.bridge.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('hold Space in the box (as in Claude Code)', () => {
    const space = (el: Element, over: Record<string, unknown> = {}) => fireEvent.keyDown(el, { key: ' ', code: 'Space', ...over });

    it('a tap types a space and never listens', () => {
      vi.useFakeTimers();
      const v = fakeVoice();
      const s = setup({ voice: v.bridge });
      act(() => s.input.focus());
      s.type('run');
      expect(space(s.input)).toBe(true); // not prevented: the browser types it
      s.type('run ');
      fireEvent.keyUp(window, { key: ' ', code: 'Space' });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(v.bridge.start).not.toHaveBeenCalled();
      expect(s.input).toHaveValue('run ');
    });

    it('held: the typed space comes back out, it listens, repeats type nothing, release submits', async () => {
      vi.useFakeTimers();
      const v = fakeVoice();
      const s = setup({ voice: v.bridge });
      act(() => s.input.focus());
      space(s.input);
      s.type(' ');
      expect(space(s.input, { repeat: true })).toBe(false); // deciding: repeats are swallowed
      act(() => { vi.advanceTimersByTime(400); });
      expect(v.bridge.start).toHaveBeenCalledTimes(1);
      expect(s.input).toHaveValue('');
      expect(screen.getByText('Listening…')).toBeInTheDocument();
      expect(space(s.input, { repeat: true })).toBe(false); // talking: still swallowed
      v.emit({ type: 'partial', text: 'run ls' });
      fireEvent.keyUp(window, { key: ' ', code: 'Space' });
      expect(v.bridge.stop).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      v.emit({ type: 'final', text: 'run ls' });
      expect(s.server.run).not.toHaveBeenCalled(); // waits for ⏎
      s.key('Enter');
      await waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'ls'));
    });

    it('Esc while held puts back what was typed, without the space', () => {
      vi.useFakeTimers();
      const v = fakeVoice();
      const s = setup({ voice: v.bridge });
      act(() => s.input.focus());
      s.type('half');
      space(s.input);
      s.type('half ');
      act(() => { vi.advanceTimersByTime(400); });
      v.emit({ type: 'partial', text: 'other' });
      s.key('Escape');
      expect(v.bridge.cancel).toHaveBeenCalled();
      expect(s.input).toHaveValue('half');
    });

    it('the window losing focus mid-hold stops listening (the key-up never comes)', () => {
      vi.useFakeTimers();
      const v = fakeVoice();
      const s = setup({ voice: v.bridge });
      act(() => s.input.focus());
      space(s.input);
      act(() => { vi.advanceTimersByTime(400); });
      expect(v.bridge.start).toHaveBeenCalledTimes(1);
      fireEvent.blur(window);
      expect(v.bridge.stop).toHaveBeenCalledTimes(1);
    });
  });
});

describe('CommandPalette as the home screen\'s big box (hero)', () => {
  it('is focused on arrival with the example placeholder, and shows nothing until you type', () => {
    const s = setup({ hero: true });
    expect(document.activeElement).toBe(s.input);
    expect(s.input).toHaveAttribute('placeholder', 'Tell Strado…  e.g. open master and run dev   ⌘K');
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
    s.type('run ls');
    expect(screen.getByTestId('command-bar-popover')).toHaveAttribute('data-placement', 'below');
  });

  it('the docked bar keeps its popover above', () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('run ls');
    expect(screen.getByTestId('command-bar-popover')).toHaveAttribute('data-placement', 'above');
  });
});

describe('CommandPalette as the always-visible command bar', () => {
  it('after a run it keeps the keyboard but no suggestions panel (it would hide a Browser preview); typing, a click or ⌘K bring it back', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('run ls');
    s.key('Enter');
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(s.input);
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
    act(() => s.shellPane.focus()); act(() => s.input.focus()); // the box takes the keyboard back by itself
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
    s.type('f');
    expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument();
    s.type('');
    act(() => s.barRef.current!.focus()); // ⌘K
    expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument();
  });

  it('is always there, never takes focus by itself, and shows no popover until focused', () => {
    const s = setup();
    expect(s.input).toHaveAttribute('placeholder', expect.stringMatching(/^Tell Strado what to do…/));
    expect(document.activeElement).not.toBe(s.input);
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
    act(() => s.input.focus());
    expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument(); // empty state: Focuses / Recent
  });

  it('never captures keystrokes while blurred: keys in a pane stay in the pane', () => {
    const s = setup();
    act(() => s.shellPane.focus());
    fireEvent.keyDown(s.shellPane, { key: 'Enter' });
    fireEvent.keyDown(s.shellPane, { key: 'ArrowUp' });
    expect(s.input).toHaveValue('');
    expect(document.activeElement).toBe(s.shellPane);
    expect(s.server.run).not.toHaveBeenCalled();
  });

  it('the handle (⌘K) focuses it; Esc clears it and returns focus to the pane that had it', async () => {
    const s = setup();
    act(() => s.shellPane.focus());
    act(() => s.barRef.current!.focus());
    expect(document.activeElement).toBe(s.input);
    s.type('something');
    s.key('Escape');
    await waitFor(() => expect(document.activeElement).toBe(s.shellPane));
    expect(s.input).toHaveValue('');
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
  });

  it('"this" is the pane focused before the bar: the context is read as it was, the bar is not a tab', () => {
    const s = setup();
    act(() => s.shellPane.focus());
    act(() => s.input.focus());
    s.type('run ls');
    s.key('Enter');
    return waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'ls'));
  });

  it('after a run, the keyboard stays in the bar, cleared, for the next command (no ⌘K again)', async () => {
    const s = setup();
    act(() => s.shellPane.focus());
    act(() => s.input.focus());
    s.type('run ls');
    s.key('Enter');
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(s.input);
    expect(s.input).toHaveValue('');
  });

  it('holds the keyboard: the app moving focus into a pane (no click) is taken back; a click is you leaving', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('switch to master');
    act(() => s.shellPane.focus()); // a tab opened / a worktree remounted and grabbed it
    await waitFor(() => expect(document.activeElement).toBe(s.input));
    fireEvent.pointerDown(s.claudePane); act(() => s.claudePane.focus());
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(s.claudePane);
  });

  it('a home-screen box that goes away mid-run hands the keyboard to the bar that replaces it', async () => {
    const s = setup({ hero: true });
    s.server.run.mockImplementationOnce(() => new Promise(() => {})); // still running
    act(() => s.input.focus());
    s.type('run ls');
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalled());
    s.view.unmount(); // home gave way to the worktree
    const next = setup();
    await waitFor(() => expect(document.activeElement).toBe(next.input));
  });

  it('after a run that focused another tab, focus goes to that tab instead', async () => {
    const s = setup();
    act(() => s.shellPane.focus());
    act(() => s.input.focus());
    s.type('focus claude');
    s.key('Enter');
    await waitFor(() => expect(s.hub.focus).toHaveBeenCalledWith(ref('claude', '1')));
    await waitFor(() => expect(document.activeElement).toBe(s.claudePane));
  });

  it('an error keeps the bar focused with its text', async () => {
    const s = setup();
    s.server.run.mockRejectedValueOnce(new Error('boom'));
    act(() => s.shellPane.focus());
    act(() => s.input.focus());
    s.type('run ls');
    s.key('Enter');
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(document.activeElement).toBe(s.input);
    expect(s.input).toHaveValue('run ls');
  });

  it('clicking a popover row does not blur the bar first (the row still gets the click)', () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('FD');
    const row = screen.getByText('FD-1');
    const down = fireEvent.mouseDown(row);
    expect(down).toBe(false); // default prevented: focus stays in the bar
  });

  it('the thread is forgotten on Esc and after 2 minutes idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    const s = setup({ model: true });
    act(() => s.input.focus());
    s.type('look at the other one');
    s.key('Enter');
    await act(async () => { s.asks[0]!.resolve({ kind: 'answer', text: 'which one?', model: 'm', ms: 1 }); });
    s.type('the claude one');
    s.key('Enter');
    expect(s.asks[1]!.thread).toHaveLength(2); // the follow-up carries the thread
    await act(async () => { s.asks[1]!.resolve({ kind: 'answer', text: 'ok', model: 'm', ms: 1 }); });
    vi.setSystemTime(new Date('2026-10-17T10:02:30Z'));
    s.type('and now?');
    s.key('Enter');
    expect(s.asks[2]!.thread).toEqual([]); // idle > 2 min: a new conversation
    await act(async () => { s.asks[2]!.resolve({ kind: 'answer', text: 'fine', model: 'm', ms: 1 }); });
    s.key('Escape');
    act(() => s.input.focus());
    s.type('again');
    s.key('Enter');
    expect(s.asks[3]!.thread).toEqual([]); // Esc ended the conversation
  });

  it('⏎ that accepts an IME candidate never submits the half-composed text', () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('run ls');
    fireEvent.keyDown(s.input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(s.input, { key: 'Enter', keyCode: 229 });
    expect(s.server.run).not.toHaveBeenCalled();
  });

  it('a plan that lands after the user clicked away never runs or moves focus; back in the bar it waits for ⏎', async () => {
    const s = setup({ model: true });
    act(() => s.shellPane.focus());
    act(() => s.input.focus());
    s.type('look at claude');
    s.key('Enter');
    fireEvent.pointerDown(s.shellPane); act(() => s.shellPane.focus()); // clicked into the terminal while Haiku thinks
    await act(async () => { s.asks[0]!.resolve({ kind: 'plan', steps: [{ action: 'tab.focus', args: {} }], model: 'm', ms: 1 }); });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.hub.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(s.shellPane);
    act(() => s.input.focus());
    await new Promise((r) => setTimeout(r, 10));
    expect(s.hub.focus).not.toHaveBeenCalled(); // re-focus does not re-trigger it
    expect(screen.getByTestId('jarvis-row-0')).toHaveTextContent('Focus Claude');
    await new Promise((r) => setTimeout(r, 550)); // past the stray-⏎ guard
    s.key('Enter');
    await waitFor(() => expect(s.hub.focus).toHaveBeenCalledWith(ref('claude', '1')));
  });

  it('a run that finishes after the user clicked away does not pull focus out of their pane', async () => {
    const s = setup();
    let finish!: () => void;
    s.server.run.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ settled: true, output: '', durationMs: 1 }); }));
    act(() => s.input.focus());
    s.type('run ls');
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalled());
    fireEvent.pointerDown(s.claudePane); act(() => s.claudePane.focus());
    await act(async () => { finish(); });
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(s.claudePane);
  });

  it('the thread never crosses a worktree switch: names like shell-1 mean the new worktree', async () => {
    const s = setup({ model: true });
    act(() => s.input.focus());
    s.type('run the tests in shell-1');
    s.key('Enter');
    await act(async () => { s.asks[0]!.resolve({ kind: 'answer', text: 'which tests?', model: 'm', ms: 1 }); });
    s.where.worktree = '/wt/FD-2';
    s.type('npm test');
    s.key('Enter');
    expect(s.asks[1]!.thread).toEqual([]);
  });

  it('a confirm armed before the bar lost focus is gone when it comes back: ⏎ re-checks, never runs on the old confirm', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('close shell');
    s.key('Enter');
    expect(screen.getByText(/process is running/)).toBeInTheDocument();
    act(() => s.shellPane.focus());
    act(() => s.input.focus());
    s.key('Enter');
    await new Promise((r) => setTimeout(r, 10));
    expect(s.server.close).not.toHaveBeenCalled();
    expect(screen.getByText(/process is running/)).toBeInTheDocument(); // armed afresh
  });

  it('a run that opens a tab makes it the focused tab, so the next "this" is the new tab (live: "now open one more below this")', async () => {
    const openRight = plan([step('tab.open', { mode: 'shell', worktreePath: P, place: { split: 'right', anchor: { kind: 'tab', ref: ref('claude', '1') }, focus: false }, command: 'git status' }, { where: 'server', risk: 'spawn', target: { kind: 'none' } })], { source: 'model', summary: 'Open shell right of claude-1, run git status' });
    const s = setup({ model: true, toPlan: () => openRight });
    s.server.spawn.mockResolvedValue({ tab: ref('shell', '4') });
    fireEvent.pointerDown(s.claudePane); act(() => s.claudePane.focus());
    act(() => s.input.focus());
    s.type('open the shell in the right and check the git status');
    s.key('Enter');
    await act(async () => { s.asks[0]!.resolve({ kind: 'plan', steps: [{ action: 'tab.open', args: {} }], model: 'm', ms: 1 }); });
    await waitFor(() => expect(s.jarvis.onRan).toHaveBeenCalled());
    expect(s.hub.focus).toHaveBeenCalledWith(ref('shell', '4'));
    expect(s.ctx().focused).toEqual(ref('shell', '4'));
    act(() => s.input.focus()); // ⌘K again
    s.type('now open one more below this');
    s.key('Enter');
    expect(s.asks[1]!.ctx.focused).toEqual(ref('shell', '4'));
  });

  it('no browse mode: the handle only focuses (the Dock\'s location is a label now)', () => {
    const s = setup();
    expect(s.barRef.current).not.toHaveProperty('browse');
  });

  describe('the @ picker', () => {
    const station = (over: Partial<StationDto>): StationDto => ({
      agentId: 'claude-1@app', alias: null, name: 'claude-1', mode: 'claude', worktreePath: P, worktreeName: 'FD-1', sessionId: '1',
      lifecycle: 'idle', live: true, calls: [], lastActivityAt: null, ...over,
    });
    const stations = [
      station({}),
      station({ agentId: 'claude-2@app', name: 'claude-2', sessionId: '2', lifecycle: 'working' }),
      station({ agentId: 'claude-1@api', worktreePath: '/wt/api', worktreeName: 'api' }),
    ];

    it('"@" opens a list of stations above the caret and nothing else; the best match is selected', () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('@');
      const picker = screen.getByRole('listbox', { name: 'Stations' });
      const rows = screen.getAllByRole('option').filter((o) => picker.contains(o));
      expect(rows.map((r) => r.getAttribute('data-agent'))).toEqual(['claude-1@app', 'claude-2@app', 'claude-1@api']);
      expect(rows[0]).toHaveAttribute('aria-selected', 'true');
      expect(rows[1]).toHaveTextContent('working');
      expect(picker).toHaveTextContent('other worktrees');
      expect(screen.queryByTestId('jarvis-submit')).not.toBeInTheDocument();
    });

    describe('Recent commands', () => {
      const chips = [{ label: 'claude-2', agentId: 'claude-2@app' }, { label: 'FD-1', worktreePath: P }];
      const long = `tell @claude-2 to review #FD-1 ${'and then some more dictated words '.repeat(8)}`;

      it('the empty box lists no Recent rows; ↑ recalls the last command with its chips', () => {
        rememberCommand('default', 'tell @claude-2 hi', { chips: [chips[0]!] });
        const s = setup({ stations });
        act(() => s.input.focus());
        expect(screen.queryByText('tell @claude-2 hi')).not.toBeInTheDocument();
        expect(screen.queryByText(/recent/i)).not.toBeInTheDocument();
        s.key('ArrowUp');
        expect(s.input).toHaveValue('tell @claude-2 hi');
        expect(screen.getByTestId('chip-claude-2@app')).toBeInTheDocument();
      });

      it('running a command remembers its chips', async () => {
        const s = setup({ stations });
        act(() => s.input.focus());
        s.type('focus claude for @cl');
        s.key('ArrowDown');
        s.key('Enter');
        expect(s.input).toHaveValue('focus claude for @claude-2 ');
        s.key('Enter');
        await waitFor(() => expect(readHistoryEntries('default')[0]).toEqual({ text: 'focus claude for @claude-2', pasted: false, chips: [chips[0]] }));
      });
    });

    it('⏎ picks a chip; what runs carries the exact agent (@{id}), whatever the name', async () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('@cl');
      s.key('ArrowDown');
      s.key('Enter');
      expect(s.input).toHaveValue('@claude-2 ');
      expect(screen.queryByRole('listbox', { name: 'Stations' })).not.toBeInTheDocument();
      expect(screen.getByTestId('chip-claude-2@app')).toHaveTextContent('@claude-2');
      s.type('@claude-2 run ls');
      s.key('Enter');
      await waitFor(() => expect(s.jarvis.parse).toHaveBeenLastCalledWith(expect.objectContaining({ text: '@{claude-2@app} run ls' }), expect.anything()));
    });

    it('a chip for another worktree\'s agent reads <worktree>/<name>, so recalling it can\'t reach this worktree\'s namesake', async () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('@claude-1');
      s.key('ArrowDown');
      s.key('Enter');
      expect(s.input).toHaveValue('@api/claude-1 ');
      expect(screen.getByTestId('chip-claude-1@api')).toHaveTextContent('@api/claude-1');
      s.type('@api/claude-1 hi');
      s.key('Enter');
      await waitFor(() => expect(s.jarvis.parse).toHaveBeenLastCalledWith(expect.objectContaining({ text: '@{claude-1@api} hi' }), expect.anything()));
    });

    it('"#" names a worktree: a Worktrees list (recent first); ⏎ makes a #chip, submitted as #{path}', async () => {
      localStorage.setItem('strado:worktree-lru', JSON.stringify({ [P]: Date.now() - 3_600_000 }));
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('open claude in #');
      const list = screen.getByRole('listbox', { name: 'Worktrees' });
      const rows = screen.getAllByRole('option').filter((o) => list.contains(o));
      expect(rows.map((r) => r.getAttribute('data-path'))).toEqual([P]);
      expect(rows[0]).toHaveTextContent('FD-1');
      expect(rows[0]).toHaveTextContent('1h');
      s.key('Enter');
      expect(s.input).toHaveValue('open claude in #FD-1 ');
      expect(screen.getByTestId(`chip-#${P}`)).toHaveTextContent('#FD-1');
      s.type('open claude in #FD-1 now');
      s.key('Enter');
      await waitFor(() => expect(s.jarvis.parse).toHaveBeenLastCalledWith(expect.objectContaining({ text: `open claude in #{${encodeURIComponent(P)}} now` }), expect.anything()));
    });

    it('"#" with no match says so; backspace after a #chip removes it whole', () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('#zzz');
      expect(screen.getByRole('listbox', { name: 'Worktrees' })).toHaveTextContent('No worktree matches');
      s.type('#FD');
      s.key('Tab');
      expect(s.input).toHaveValue('#FD-1 ');
      fireEvent.change(s.input, { target: { value: '#FD-1', selectionStart: 5 } });
      s.input.setSelectionRange(5, 5);
      s.key('Backspace');
      expect(s.input).toHaveValue('');
    });

    it('Tab picks too; typing filters (prefix first)', () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('tell @claude-2');
      s.key('Tab');
      expect(s.input).toHaveValue('tell @claude-2 ');
    });

    it('Esc closes the picker but keeps the @; the next Esc is the box\'s own', () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('@cl');
      s.key('Escape');
      expect(screen.queryByRole('listbox', { name: 'Stations' })).not.toBeInTheDocument();
      expect(s.input).toHaveValue('@cl');
      expect(document.activeElement).toBe(s.input);
    });

    it('backspace right after a chip removes it whole', () => {
      const s = setup({ stations });
      act(() => s.input.focus());
      s.type('@cl');
      s.key('Enter');
      expect(s.input).toHaveValue('@claude-1 ');
      s.input.setSelectionRange(9, 9);
      fireEvent.change(s.input, { target: { value: '@claude-1', selectionStart: 9 } });
      s.input.setSelectionRange(9, 9);
      s.key('Backspace');
      expect(s.input).toHaveValue('');
    });
  });
});

describe('CommandPalette: dictation preview (committed words normal, in-flight words dimmed)', () => {
  const said = () => screen.getByTestId('voice-said');
  const inflight = () => screen.getByTestId('voice-inflight');

  it('ElevenLabs: the committed prefix in the normal colour, the rest dimmed, the waveform after; the real text is hidden under it', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'open master and run', stable: 'open master' });
    expect(said()).toHaveTextContent('open master');
    expect(said().className).toContain('text-zinc-100');
    expect(inflight()).toHaveTextContent('and run');
    expect(inflight().className).toContain('text-zinc-500');
    expect(screen.getByTestId('voice-caret').previousSibling).toBe(inflight());
    expect(s.input.className).toContain('text-transparent');
    v.emit({ type: 'partial', text: 'open master and run dev', stable: 'open master and run dev' });
    expect(said()).toHaveTextContent('open master and run dev');
    expect(inflight()).toHaveTextContent('');
  });

  it('Apple (no committed prefix): all of this go is dimmed until the final; what was typed before stays normal', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    act(() => s.input.focus());
    s.type('run');
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'ls' });
    expect(said()).toHaveTextContent('run');
    expect(inflight()).toHaveTextContent('ls');
  });

  it('the final: everything normal again, the preview gone, and it waits for ⏎', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'run l', stable: 'run' });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'run ls' });
    expect(screen.queryByTestId('voice-inflight')).not.toBeInTheDocument();
    expect(s.input.className).not.toContain('text-transparent');
    expect(s.input).toHaveValue('run ls');
    expect(s.server.run).not.toHaveBeenCalled();
  });
});

describe('CommandPalette: a voice command is never sent by itself', () => {
  const talk = (v: ReturnType<typeof fakeVoice>, s: ReturnType<typeof setup>, words: string) => {
    fireEvent.keyDown(s.shellPane, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: words });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: words });
  };

  it('the final lands in the box (focused, caret at the end) and waits: nothing runs until ⏎', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    talk(v, s, 'run ls');
    expect(s.input).toHaveValue('run ls');
    expect(document.activeElement).toBe(s.input);
    expect(s.input.selectionStart).toBe('run ls'.length);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(s.server.run).not.toHaveBeenCalled();
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'ls'));
  });

  it('talking again adds to what is there (with a space), so a request can be said in several goes', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    talk(v, s, 'run');
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'ls' });
    expect(s.input).toHaveValue('run ls'); // live, after what was there
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'ls' });
    expect(s.input).toHaveValue('run ls');
    expect(s.server.run).not.toHaveBeenCalled();
    s.key('Enter');
    await waitFor(() => expect(s.server.run).toHaveBeenCalledWith(ref('shell', '1'), 'ls'));
  });

  it('Esc while talking again puts back the text from before that go', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    talk(v, s, 'run');
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'something else' });
    s.key('Escape');
    expect(s.input).toHaveValue('run');
  });
});

describe('CommandPalette: a long request grows the box upward (up to 4 lines), never cut off', () => {
  // jsdom lays nothing out: the content height is faked from the text's length.
  const tall = (v: string) => (v.length > 60 ? 200 : v.length > 30 ? 52 : 32);
  beforeEach(() => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLTextAreaElement) { return tall(this.value); } });
  });
  afterEach(() => { delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: number }).scrollHeight; });
  const long = 'open a claude in every worktree in this focus and ask each of them whether their tests pass';

  it('the box is a one-row field that wraps words; it grows with the text, then scrolls inside past 4 lines', () => {
    const s = setup();
    expect(s.input.tagName).toBe('TEXTAREA');
    expect(s.input).toHaveAttribute('rows', '1');
    expect(s.input.className).toContain('whitespace-pre-wrap');
    act(() => s.input.focus());
    s.type('run ls');
    expect(s.input.style.height).toBe('32px');
    expect(s.input.style.overflowY).toBe('hidden');
    s.type('open a claude in every worktree in this');
    expect(s.input.style.height).toBe('52px');
    s.type(long);
    expect(s.input.style.height).toBe('92px'); // 4 lines, then it scrolls
    expect(s.input.style.overflowY).toBe('auto');
  });

  it('⏎ sends, never a newline; after it the box is one line again', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type(long);
    s.type('run ls');
    expect(fireEvent.keyDown(s.input, { key: 'Enter' })).toBe(false);
    await waitFor(() => expect(s.server.run).toHaveBeenCalled());
    expect(s.input).toHaveValue('');
    expect(s.input.style.height).toBe('32px');
  });

  it('a pasted multi-line text becomes one line (a command is one line)', () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('run\nls');
    expect(s.input).toHaveValue('run ls');
  });

  it('listening: the live words wrap and stay in view (scrolled to the newest); the waveform wraps with them', () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: long });
    expect(s.input.style.height).toBe('92px');
    expect(s.input.scrollTop).toBe(200);
    expect(screen.getByTestId('voice-caret').parentElement!.className).toContain('whitespace-pre-wrap');
  });

  it('the home screen\'s big box grows the same way', () => {
    const s = setup({ hero: true });
    s.type(long);
    expect(s.input.style.height).toBe('120px'); // 4 lines of the big box
  });
});

describe('CommandPalette: a spoken question gets a spoken answer', () => {
  let speech: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    speech = { speak: vi.fn(), cancel: vi.fn() };
    (window as unknown as { speechSynthesis?: unknown }).speechSynthesis = speech;
    (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });
  afterEach(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  });
  const said = () => speech.speak.mock.calls.map((c) => (c[0] as { text: string }).text);

  it('asked by voice: the recap shows and is read aloud; talking again stops it', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'partial', text: 'what is claude-1 doing' });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'what is claude-1 doing' });
    s.key('Enter');
    expect(await screen.findByText('claude-1 is fixing the login test.')).toBeInTheDocument();
    expect(said()).toEqual(['claude-1 is fixing the login test.']);
    speech.cancel.mockClear();
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    expect(speech.cancel).toHaveBeenCalled();
  });

  it('said in two goes, then ⏎: still spoken, so read aloud', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'what is' });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'claude-1 doing' });
    s.key('Enter');
    await waitFor(() => expect(speech.speak).toHaveBeenCalled());
  });

  it('said, then edited by typing: it is typed now, not read aloud', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'what is claude-1 doin' });
    s.type('what is claude-1 doing');
    s.key('Enter');
    expect(await screen.findByText('claude-1 is fixing the login test.')).toBeInTheDocument();
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it('typed: shown, not read aloud', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('what is claude-1 doing');
    s.key('Enter');
    expect(await screen.findByText('claude-1 is fixing the login test.')).toBeInTheDocument();
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it('a long answer is read only up to about 300 characters, cut at a word', async () => {
    const long = `${'word '.repeat(100)}end`;
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    s.server.recap.mockResolvedValue({ text: long });
    fireEvent.keyDown(s.input, { key: ' ', code: 'Space', altKey: true });
    fireEvent.keyUp(window, { key: ' ', code: 'Space', altKey: true });
    v.emit({ type: 'final', text: 'what is claude-1 doing' });
    s.key('Enter');
    await waitFor(() => expect(speech.speak).toHaveBeenCalled());
    const text = said()[0]!;
    expect(text.length).toBeLessThanOrEqual(301);
    expect(text.endsWith('word…')).toBe(true);
  });
});

describe('CommandPalette: the box holds the keyboard while you use it (the shell hands it back from a preview)', () => {
  let windowFocused = true;
  beforeEach(() => {
    windowFocused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => windowFocused);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  /** The page loses the keyboard to a preview, then the shell hands it back. */
  const handBack = async () => {
    windowFocused = false;
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    windowFocused = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
  };

  it('focus alone is not holding: the keyboard back leaves the box alone', async () => {
    const s = setup();
    act(() => s.input.focus());
    await handBack();
    expect(document.activeElement).not.toBe(s.input);
  });

  it('typing holds it; Esc lets go', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('open');
    s.key('Escape');
    await handBack();
    expect(document.activeElement).not.toBe(s.input);
  });

  it('a click away lets go; so does Tab', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('open');
    fireEvent.pointerDown(s.shellPane);
    await handBack();
    expect(document.activeElement).not.toBe(s.input);
    act(() => s.input.focus());
    s.type('open it');
    s.key('Tab');
    await handBack();
    expect(document.activeElement).not.toBe(s.input);
  });

  it('talking (hold ⌥Space, even from a terminal) holds it', async () => {
    const v = fakeVoice();
    const s = setup({ voice: v.bridge });
    fireEvent.keyDown(s.shellPane, { key: ' ', code: 'Space', altKey: true });
    expect(v.bridge.start).toHaveBeenCalled();
    await handBack();
    expect(document.activeElement).toBe(s.input);
  });

  it('the keyboard comes back to the window (the shell took it off a preview): it lands in the box', async () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('open');
    // The preview grabbed the keyboard: this page lost it, so nothing reclaims yet.
    windowFocused = false;
    act(() => { s.input.blur(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.activeElement).not.toBe(s.input);
    // The shell hands it back.
    windowFocused = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(document.activeElement).toBe(s.input);
  });

  it('not holding: the window getting the keyboard back leaves it where it is', () => {
    const s = setup();
    act(() => s.shellPane.focus());
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(document.activeElement).toBe(s.shellPane);
  });
});

describe('popover footer: the keys, under a list', () => {
  it('a list (Recent, matches) shows ↑↓ select · ↵ run · @ mention · esc close, keys as kbd', () => {
    rememberCommand('default', 'split down');
    const s = setup();
    act(() => s.input.focus());
    const foot = within(screen.getByTestId('command-bar-popover')).getByTestId('command-bar-footer');
    expect(foot).toHaveTextContent('↑↓ select · ↵ run · @ mention · esc close');
    expect(Array.from(foot.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['↑↓', '↵', '@', 'esc']);
    s.type('FD');
    expect(screen.getByTestId('command-bar-footer')).toBeInTheDocument();
  });

  it('the hero box has it too', () => {
    const s = setup({ hero: true });
    act(() => s.input.focus());
    s.type('FD');
    expect(screen.getByTestId('command-bar-popover')).toHaveAttribute('data-placement', 'below');
    expect(screen.getByTestId('command-bar-footer')).toBeInTheDocument();
  });

  it('no list, no footer: the quiet "⏎ to run" line or a model card alone', () => {
    const s = setup();
    act(() => s.input.focus());
    s.type('shell right');
    expect(screen.getByTestId('jarvis-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('command-bar-footer')).not.toBeInTheDocument();
  });
});
