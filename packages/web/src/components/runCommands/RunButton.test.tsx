import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunButton, type RunEntry } from './RunButton';

const e = (id: string, name: string, status: RunEntry['status'] = 'idle', over: Partial<RunEntry> = {}): RunEntry => ({ id, name, status, ...over });
const handlers = () => ({ onStart: vi.fn(), onStop: vi.fn(), onOpenTab: vi.fn(), onAdd: vi.fn() });

describe('RunButton (split): the default command, and a menu of every run command', () => {
  it('main part: "Run <default>" when idle; it starts the default', () => {
    const h = handlers();
    render(<RunButton entries={[e('dev', 'dev'), e('storybook', 'storybook')]} defaultId="dev" {...h} />);
    const main = screen.getByRole('button', { name: 'Run dev' });
    fireEvent.click(main);
    expect(h.onStart).toHaveBeenCalledWith('dev');
  });

  it('main part: Stop (with the port) while the default runs; Starting…/Stopping… as the server says', () => {
    const h = handlers();
    const { rerender } = render(<RunButton entries={[e('dev', 'dev', 'running', { port: 3000 })]} defaultId="dev" {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop dev' }));
    expect(h.onStop).toHaveBeenCalledWith('dev');
    expect(screen.getByRole('button', { name: 'Stop dev' })).toHaveTextContent('Stop :3000');
    rerender(<RunButton entries={[e('dev', 'dev', 'starting')]} defaultId="dev" {...h} />);
    expect(screen.getByRole('button', { name: 'Stop dev' })).toHaveTextContent('Starting…');
    rerender(<RunButton entries={[e('dev', 'dev', 'stopping')]} defaultId="dev" {...h} />);
    expect(screen.getByRole('button', { name: 'Stop dev' })).toBeDisabled();
  });

  it('crashed default: says so, and the click runs it again', () => {
    const h = handlers();
    render(<RunButton entries={[e('dev', 'dev', 'crashed')]} defaultId="dev" {...h} />);
    const main = screen.getByRole('button', { name: 'Run dev' });
    expect(main).toHaveTextContent('Crashed');
    fireEvent.click(main);
    expect(h.onStart).toHaveBeenCalledWith('dev');
  });

  it('▾ lists every command with its state; click runs an idle one, opens a running one\'s tab; ■ stops it', () => {
    const h = handlers();
    render(<RunButton entries={[e('dev', 'dev', 'running'), e('sb', 'storybook'), e('api', 'api', 'crashed')]} defaultId="dev" {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run commands' }));
    const menu = screen.getByRole('menu', { name: 'Run commands' });
    expect(within(menu).getByRole('menuitem', { name: /dev.*running/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /api.*crashed/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^storybook/ }));
    expect(h.onStart).toHaveBeenCalledWith('sb');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run commands' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^dev/ }));
    expect(h.onOpenTab).toHaveBeenCalledWith('dev');
    fireEvent.click(screen.getByRole('button', { name: 'Run commands' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Stop dev' }));
    expect(h.onStop).toHaveBeenCalledWith('dev');
  });

  it('the last item adds a run command', () => {
    const h = handlers();
    render(<RunButton entries={[e('dev', 'dev')]} defaultId="dev" {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run commands' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[items.length - 1]).toHaveTextContent('+ Add run command…');
    fireEvent.click(items[items.length - 1]!);
    expect(h.onAdd).toHaveBeenCalled();
  });

  it('Esc closes the menu', () => {
    render(<RunButton entries={[e('dev', 'dev')]} defaultId="dev" {...handlers()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run commands' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('no run commands: "Add run command" instead of Run', () => {
    const h = handlers();
    render(<RunButton entries={[]} defaultId={null} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add run command' }));
    expect(h.onAdd).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run commands' })).toBeNull();
  });

  it('a long default name is shortened on the button (full name in the title)', () => {
    render(<RunButton entries={[e('x', 'storybook-with-a-very-long-name')]} defaultId="x" {...handlers()} />);
    const main = screen.getByRole('button', { name: 'Run storybook-with-a-very-long-name' });
    expect(main.textContent!.length).toBeLessThan(22);
    expect(main).toHaveAttribute('title', expect.stringContaining('storybook-with-a-very-long-name'));
  });

  it('an unnamed default (no run commands known): plain "Run" / "Stop"; detail in the title; no menu when asked', () => {
    const h = handlers();
    const { rerender } = render(<RunButton entries={[e('', '')]} defaultId="" menu={false} {...h} />);
    expect(screen.getByLabelText('Run')).toHaveTextContent(/^Run$/);
    expect(screen.queryByRole('button', { name: 'Run commands' })).toBeNull();
    rerender(<RunButton entries={[e('', '', 'running')]} defaultId="" menu={false} detail="http://localhost:8080" {...h} />);
    expect(screen.getByLabelText('Stop').title).toContain('http://localhost:8080');
    expect(screen.getByLabelText('Stop').title).toContain('running');
  });
});
