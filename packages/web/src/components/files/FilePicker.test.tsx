import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilePicker } from './FilePicker';

const FILES = ['src/app.ts', 'src/lib/util.ts', 'README.md', 'packages/web/src/pages/TerminalView.tsx'];

async function open(load: () => Promise<{ files: string[]; truncated: boolean }> = vi.fn(async () => ({ files: FILES, truncated: false }))) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<FilePicker load={load} onPick={onPick} onClose={onClose} />);
  await act(async () => {});
  return { onPick, onClose, load, input: screen.getByRole('combobox', { name: 'Go to file' }) };
}

describe('FilePicker', () => {
  it('lists the files, filters as you type, Enter opens the top match', async () => {
    const { input, onPick } = await open();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.change(input, { target: { value: 'termview' } });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('TerminalView.tsx');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('packages/web/src/pages/TerminalView.tsx', undefined);
  });

  it('arrows move the selection; a click picks', async () => {
    const { input, onPick } = await open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getAllByRole('option')[2]!);
    expect(onPick).toHaveBeenCalledWith('README.md', undefined);
  });

  it('"name:42" opens at line 42', async () => {
    const { input, onPick } = await open();
    fireEvent.change(input, { target: { value: 'util:42' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('src/lib/util.ts', 42);
  });

  it('Escape closes; no match says so', async () => {
    const { input, onClose } = await open();
    fireEvent.change(input, { target: { value: 'zzzz' } });
    expect(screen.getByText('No matching files')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a failed load shows a fixed message; a truncated list says it is partial', async () => {
    await open(vi.fn(async () => { throw new Error('boom <secret>'); }));
    expect(screen.getByText("Couldn't list this worktree's files")).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it('a truncated list is flagged', async () => {
    await open(vi.fn(async () => ({ files: FILES, truncated: true })));
    expect(screen.getByText(/Showing the first/)).toBeInTheDocument();
  });
});
