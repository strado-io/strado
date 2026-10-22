import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentLine } from './AgentLine';
import type { CardAgent } from './AgentCard';

const agent = (over: Partial<CardAgent> = {}): CardAgent => ({
  agentId: 'codex-2@x', name: 'codex-2', mode: 'codex', worktree: 'Strado_Mcp', state: 'working', word: 'working', elapsed: '3m',
  detail: 'running npm test', calls: [], ...over,
});
const handlers = () => ({ onInterrupt: vi.fn(), onOpen: vi.fn(), onRecap: vi.fn(), onDismissCalls: vi.fn() });

describe('AgentLine: the selected agent, one muted line in the strip', () => {
  it('says what typing does, per state and kind', () => {
    const { rerender } = render(<AgentLine agent={agent()} note={null} {...handlers()} />);
    expect(screen.getByTestId('agent-line-hint')).toHaveTextContent('↵ queues, ⌘↵ sends now');
    rerender(<AgentLine agent={agent({ state: 'idle', word: 'idle' })} note={null} {...handlers()} />);
    expect(screen.getByTestId('agent-line-hint')).toHaveTextContent('type a message, ↵ sends it');
    rerender(<AgentLine agent={agent({ name: 'shell-1', mode: 'shell', state: 'working', word: 'working' })} note={null} {...handlers()} />);
    expect(screen.getByTestId('agent-line-hint')).toHaveTextContent('type a command, ↵ runs it');
  });

  it('one line: no region, no second line, no transcript (the activity is on the pill)', () => {
    render(<AgentLine agent={agent()} note={null} {...handlers()} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-line').textContent).not.toContain('running npm test');
    expect(screen.getByTestId('agent-line').className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('a note (sent / queued / recap / error) shows truncated, the full text in its title', () => {
    const long = `queued: ${'x'.repeat(300)}\nsecond line`;
    render(<AgentLine agent={agent()} note={long} {...handlers()} />);
    const note = screen.getByTestId('agent-line-note');
    expect(note).toHaveAttribute('title', long);
    expect(note.className).toMatch(/\btruncate\b/);
  });

  it('needs you because of a call: it reads as a question to answer; Dismiss clears it', () => {
    const h = handlers();
    render(<AgentLine agent={agent({ state: 'needs_you', word: 'needs you', calls: [{ id: 'e1', title: 'Which DB?' }] })} note={null} {...h} />);
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent('asks: Which DB? — type to reply');
    expect(screen.getByTestId('agent-line-hint')).toHaveTextContent('↵ sends your reply');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss call' }));
    expect(h.onDismissCalls).toHaveBeenCalledWith('codex-2@x', ['e1']);
  });

  it('a note outranks the call title', () => {
    render(<AgentLine agent={agent({ state: 'needs_you', word: 'needs you', calls: [{ id: 'e1', title: 'Which DB?' }] })} note="sent: postgres" {...handlers()} />);
    expect(screen.getByTestId('agent-line-note')).toHaveTextContent('sent: postgres');
  });

  it('text buttons: Open tab ⌘O, Stop ⌃C while working, Summarize', () => {
    const h = handlers();
    render(<AgentLine agent={agent()} note={null} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open tab ⌘O' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop ⌃C' }));
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(h.onOpen).toHaveBeenCalledWith('codex-2@x');
    expect(h.onInterrupt).toHaveBeenCalledWith('codex-2@x');
    expect(h.onRecap).toHaveBeenCalledWith('codex-2@x');
  });

  it('idle: no Stop; no calls: no Dismiss', () => {
    render(<AgentLine agent={agent({ state: 'idle', word: 'idle' })} note={null} {...handlers()} />);
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it('a shell: no Summarize; Stop only while running', () => {
    const sh = { agentId: 'shell-1@x', name: 'shell-1', mode: 'shell', detail: null };
    const { rerender } = render(<AgentLine agent={agent({ ...sh, state: 'idle', word: 'idle' })} note={null} {...handlers()} />);
    expect(screen.queryByRole('button', { name: 'Summarize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument();
    rerender(<AgentLine agent={agent({ ...sh, state: 'working', word: 'working' })} note={null} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Stop ⌃C' })).toBeInTheDocument();
  });
});
