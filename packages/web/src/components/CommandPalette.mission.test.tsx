import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, releaseKeyboard, type CommandBarHandle, type JarvisPaletteProps } from './CommandPalette';
import type { ParseContext, Plan } from '../lib/jarvis/types';
import type { RepoConfig, Workspace, Worktree } from '../types';

afterEach(() => releaseKeyboard());
beforeEach(() => localStorage.clear());

const P = '/wt/FD-1';
const empty: Plan = { steps: [], source: 'fallback', summary: '', executable: false };
function setup(over: { popoverLift?: number } = {}) {
  const parse = vi.fn(() => empty);
  const agentKey = vi.fn(() => true);
  const onAgentChip = vi.fn();
  const onPopover = vi.fn();
  const ctx = (): ParseContext => ({ tabs: [], focused: null, lastActedOn: null, currentWorktree: P, worktrees: [], focuses: [], packageScripts: {}, peers: [] });
  const jarvis: JarvisPaletteProps = {
    wsId: 'w1', parse, context: ctx, onRan: vi.fn(), onActed: vi.fn(),
    ports: () => ({ hub: null, server: { spawn: vi.fn(), run: vi.fn(), interrupt: vi.fn(), close: vi.fn(), message: vi.fn(), startServer: vi.fn(), stopServer: vi.fn(), answerCall: vi.fn(), dismissCall: vi.fn() }, nav: { worktree: vi.fn(), focus: vi.fn(), workspace: vi.fn(), repo: vi.fn(), addRepo: vi.fn(), newWorktree: vi.fn() } }),
  };
  const barRef: { current: CommandBarHandle | null } = { current: null };
  render(<CommandPalette barRef={barRef} repos={[] as RepoConfig[]} worktrees={[] as Worktree[]} workspaces={[{ id: 'w1', name: 'Personal' }] as Workspace[]} activeWorkspaceId="w1"
    onOpenWorktree={vi.fn()} onGoRepo={vi.fn()} onSwitchWorkspace={vi.fn()} onClose={vi.fn()} jarvis={jarvis} agentKey={agentKey} onAgentChip={onAgentChip} onPopover={onPopover} popoverLift={over.popoverLift} />);
  const input = screen.getByLabelText('Global search') as HTMLTextAreaElement;
  act(() => { input.focus(); });
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const key = (k: string, mods: Record<string, boolean> = {}) => fireEvent.keyDown(input, { key: k, ...mods });
  return { input, type, key, parse, agentKey, onAgentChip, onPopover, barRef };
}
const c2 = { agentId: 'claude-2@x', label: 'claude-2' };

describe('CommandPalette: Enter goes to an agent only when the box says so (a leading @agent chip)', () => {
  it('no chip: a typed command runs as a command, even with agent keys wired', () => {
    const b = setup();
    b.type('Open up Claude');
    b.key('Enter');
    expect(b.agentKey).not.toHaveBeenCalled();
    expect(b.parse).toHaveBeenCalled();
  });

  it('selecting an agent puts its chip at the start of the box; Enter sends the rest to it, and the chip stays', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent(c2); });
    expect(b.input.value).toBe('@claude-2 ');
    expect(screen.getByTestId('chip-claude-2@x')).toBeInTheDocument();
    expect(b.onAgentChip).toHaveBeenLastCalledWith('claude-2@x');
    b.type('@claude-2 Open up Claude');
    const parsed = b.parse.mock.calls.length;
    b.key('Enter');
    expect(b.agentKey).toHaveBeenCalledWith('send', 'Open up Claude');
    // Enter did not run it as a command (the box only re-previews what it now holds, the chip).
    expect((b.parse.mock.calls as unknown as [{ text: string }][]).slice(parsed).some(([c]) => c.text.includes('Open up Claude'))).toBe(false);
    expect(b.input.value).toBe('@claude-2 ');
  });

  it('⌘↵ with the chip steers', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent(c2); });
    b.type('@claude-2 use pnpm');
    b.key('Enter', { metaKey: true });
    expect(b.agentKey).toHaveBeenCalledWith('steer', 'use pnpm');
  });

  it('the chip and nothing else: Enter does nothing (no empty message)', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent(c2); });
    b.key('Enter');
    expect(b.agentKey).not.toHaveBeenCalled();
  });

  it('Backspace removes the chip: the box is a normal command box again', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent(c2); });
    b.input.setSelectionRange(9, 9);
    b.key('Backspace');
    expect(b.input.value).toBe(' ');
    expect(b.onAgentChip).toHaveBeenLastCalledWith(null);
    b.type('Open up Claude');
    b.key('Enter');
    expect(b.agentKey).not.toHaveBeenCalled();
    expect(b.parse).toHaveBeenCalled();
  });

  it('Esc removes the chip (deselects), keeping what was typed', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent(c2); });
    b.type('@claude-2 half a thought');
    b.key('Escape');
    expect(b.input.value).toBe('half a thought');
    expect(b.onAgentChip).toHaveBeenLastCalledWith(null);
  });

  it('selectAgent(null) removes it; the same words typed by hand (no chip) are a command', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent(c2); });
    act(() => { b.barRef.current!.selectAgent(null); });
    expect(b.input.value).toBe('');
    b.type('@claude-2 hi');
    b.key('Enter');
    expect(b.agentKey).not.toHaveBeenCalled();
  });

  it('with a leading agent chip the command popover never opens (the card is the UI)', () => {
    const b = setup();
    act(() => { b.barRef.current!.selectAgent({ agentId: 'shell-1@x', label: 'shell-1' }); });
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
    b.type('@shell-1 ls -la');
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
    expect(b.onPopover).toHaveBeenLastCalledWith(false);
  });

  it('without a chip the popover opens as usual, and the host hears about it (the mission stack yields)', () => {
    const b = setup();
    b.type('open');
    expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument();
    expect(b.onPopover).toHaveBeenLastCalledWith(true);
    b.key('Escape');
    expect(b.onPopover).toHaveBeenLastCalledWith(false);
  });

  it('in the bar the popover opens above the whole mission stack (lifted by its height), not over the strip', () => {
    const b = setup({ popoverLift: 72 });
    b.type('open');
    const pop = screen.getByTestId('command-bar-popover');
    expect(pop.style.marginBottom).toBe('76px');
  });

  it('clicking a pill while the popover is open: the chip goes in and the popover closes', () => {
    const b = setup();
    b.type('open');
    expect(screen.getByTestId('command-bar-popover')).toBeInTheDocument();
    act(() => { b.barRef.current!.selectAgent({ agentId: 'claude-2@x', label: 'claude-2' }); });
    expect(b.input.value).toBe('@claude-2 open');
    expect(screen.queryByTestId('command-bar-popover')).not.toBeInTheDocument();
  });
});
