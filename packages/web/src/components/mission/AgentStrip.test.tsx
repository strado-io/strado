import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentStrip, type StripAgent } from './AgentStrip';

const ag = (name: string, over: Partial<StripAgent> = {}): StripAgent => ({ agentId: `${name}@x`, name, state: 'idle', word: 'idle', activity: null, ...over });
const base = { onSelect: vi.fn(), onOpen: vi.fn() };

describe('AgentStrip', () => {
  it('labelled pills: name · state word · activity, in the given order, and the scope label', () => {
    render(<AgentStrip {...base} agents={[
      ag('claude-1', { state: 'needs_you', word: 'needs you', activity: 'Bash: rm -rf dist' }),
      ag('codex-2', { state: 'working', word: 'working', activity: 'running npm test · 3m' }),
      ag('pi-1'),
    ]} />);
    const pills = screen.getAllByRole('button', { name: /^(claude-1|codex-2|pi-1) · / });
    expect(pills.map((p) => p.getAttribute('aria-label'))).toEqual([
      'claude-1 · needs you · Bash: rm -rf dist', 'codex-2 · working · running npm test · 3m', 'pi-1 · idle',
    ]);
    expect(pills[0]).toHaveAttribute('data-state', 'needs_you');
    // The state is a dot on the pill; the word stays in its name and title, so it is never colour alone.
    expect(pills[0]).not.toHaveTextContent('needs you');
    expect(pills[2]).toHaveAttribute('title', 'pi-1 · idle');
    // Live work stays after the name.
    expect(pills[1]).toHaveTextContent('running npm test · 3m');
  });

  it('each pill starts with its harness icon; no status dot; the state is the pill\'s tint and in its name', () => {
    render(<AgentStrip {...base} agents={[
      ag('a', { state: 'idle' }), ag('b', { state: 'needs_you', word: 'needs you' }),
    ]} />);
    const pill = (n: string) => screen.getByRole('button', { name: new RegExp(`^${n} · `) });
    expect(screen.queryByTestId('status-dot')).toBeNull();
    const tile = pill('a').firstElementChild!;
    expect(tile).toHaveAttribute('data-testid', 'agent-mark');
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile.querySelector('svg')).not.toBeNull();
    expect(pill('b')).toHaveAccessibleName(/needs you/);
    expect(pill('b').className).toMatch(/amber/);
    expect(pill('a').className).not.toMatch(/amber/);
  });

  it('working and needs-you pills breathe (a CSS glow, still under reduced motion); idle ones do not', () => {
    render(<AgentStrip {...base} agents={[
      ag('a', { state: 'idle' }), ag('b', { state: 'working', word: 'working' }), ag('c', { state: 'needs_you', word: 'needs you' }),
    ]} />);
    const pill = (n: string) => screen.getByRole('button', { name: new RegExp(`^${n} · `) });
    expect(pill('b').className).toMatch(/\bpill-breathe-working\b/);
    expect(pill('c').className).toMatch(/\bpill-breathe-needs\b/);
    expect(pill('a').className).not.toMatch(/pill-breathe/);
  });

  it('agents from 2+ projects: a muted label once before each project\'s pills; one project: no labels', () => {
    const { rerender } = render(<AgentStrip {...base} agents={[
      ag('claude-1', { project: 'Strado' }), ag('codex-1', { project: 'Strado' }), ag('pi-1', { project: 'Strado Website' }),
    ]} />);
    const strip = screen.getByTestId('agent-strip');
    const order = Array.from(strip.querySelectorAll('[data-testid="project-label"], button')).map((el) => el.getAttribute('data-testid') === 'project-label' ? `#${el.textContent}` : el.getAttribute('aria-label')!.split(' · ')[0]);
    expect(order).toEqual(['#Strado', 'claude-1', 'codex-1', '#Strado Website', 'pi-1']);
    // The project is in each pill's name too (the label is visual only).
    expect(screen.getByRole('button', { name: 'pi-1 · Strado Website · idle' })).toBeInTheDocument();
    rerender(<AgentStrip {...base} agents={[ag('claude-1'), ag('codex-1')]} />);
    expect(screen.queryByTestId('project-label')).not.toBeInTheDocument();
  });

  it('just the pills: no count and no scope toggle', () => {
    render(<AgentStrip {...base} agents={[ag('pi-1')]} />);
    expect(screen.queryByText(/\d+ agents?|no agents/)).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('first 5, then "+N" opens the rest as a list', () => {
    const onSelect = vi.fn();
    const agents = Array.from({ length: 8 }, (_, i) => ag(`a-${i}`));
    render(<AgentStrip {...base} onSelect={onSelect} agents={agents} />);
    expect(screen.getAllByRole('button', { name: /^a-\d · / })).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '+3 more agents' }));
    const list = screen.getByRole('list', { name: 'More agents' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(within(list).getByRole('button', { name: /^a-6 · / }));
    expect(onSelect).toHaveBeenCalledWith('a-6@x');
    expect(screen.queryByRole('list', { name: 'More agents' })).not.toBeInTheDocument();
  });

  it('an agent outside the Focus says so plainly, with the place as the sidebar names it', () => {
    render(<AgentStrip {...base} agents={[ag('claude-2', { state: 'needs_you', word: 'needs you', activity: 'done: x', outside: 'Fleetx Napp' })]} />);
    expect(screen.getByRole('button', { name: 'claude-2 · needs you · outside this Focus · Fleetx Napp' })).toBeInTheDocument();
  });

  it('outside pills sit in their own "Outside this Focus" group after the Focus\'s, and are never hidden behind +N', () => {
    const inside = Array.from({ length: 6 }, (_, i) => ag(`a-${i}`));
    const out = ag('claude-2', { state: 'needs_you', word: 'needs you', outside: 'Fleetx Napp' });
    render(<AgentStrip {...base} agents={[out, ...inside]} />);
    const group = screen.getByRole('group', { name: 'Outside this Focus' });
    expect(within(group).getByRole('button', { name: /^claude-2 · / })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /^a-\d/ })).not.toBeInTheDocument();
    const pills = screen.getAllByRole('button', { name: /^(a-\d|claude-2) · / });
    expect(pills[pills.length - 1]).toHaveAccessibleName(/^claude-2/);
    expect(screen.getAllByRole('button', { name: /^a-\d · / })).toHaveLength(5);
    expect(screen.getByRole('button', { name: '+1 more agents' })).toBeInTheDocument();
  });

  it('click selects the agent in the box; ⌘-click opens its tab', () => {
    const onSelect = vi.fn(); const onOpen = vi.fn();
    render(<AgentStrip {...base} onSelect={onSelect} onOpen={onOpen} agents={[ag('pi-1')]} />);
    const pill = screen.getByRole('button', { name: 'pi-1 · idle' });
    fireEvent.click(pill);
    expect(onSelect).toHaveBeenCalledWith('pi-1@x');
    fireEvent.click(pill, { metaKey: true });
    expect(onOpen).toHaveBeenCalledWith('pi-1@x');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('the selected agent is marked pressed', () => {
    render(<AgentStrip {...base} selectedId="pi-1@x" agents={[ag('pi-1'), ag('codex-2')]} />);
    expect(screen.getByRole('button', { name: 'pi-1 · idle' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'codex-2 · idle' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('no hint text; the selected agent\'s line sits on the right, in the same row', () => {
    const { rerender } = render(<AgentStrip {...base} agents={[ag('pi-1')]} />);
    expect(screen.queryByText(/Click an agent/)).not.toBeInTheDocument();
    rerender(<AgentStrip {...base} selectedId="pi-1@x" selectedLine={<span>LINE</span>} agents={[ag('pi-1')]} />);
    const slot = screen.getByTestId('agent-strip-selected');
    expect(slot).toHaveTextContent('LINE');
    expect(slot.parentElement).toBe(screen.getByTestId('agent-strip'));
    expect(slot.className).toMatch(/\bml-auto\b/);
    expect(slot.className).toMatch(/\bmin-w-0\b/);
  });

  it('nothing selected: no line, even if one is passed', () => {
    render(<AgentStrip {...base} selectedLine={<span>LINE</span>} agents={[ag('pi-1')]} />);
    expect(screen.queryByTestId('agent-strip-selected')).not.toBeInTheDocument();
  });
});
