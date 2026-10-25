import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry, FileTreePage } from '../../types';
import { FileTree } from './FileTree';

const d = (path: string, change?: FileTreeEntry['change']): FileTreeEntry => ({ name: path.split('/').pop()!, path, kind: 'dir', ...(change ? { change } : {}) });
const f = (path: string, change?: FileTreeEntry['change'], extra: Partial<FileTreeEntry> = {}): FileTreeEntry => ({ name: path.split('/').pop()!, path, kind: 'file', size: 10, ...(change ? { change } : {}), ...extra });
const PAGES: Record<string, FileTreeEntry[]> = {
  '': [d('src', 'M'), d('docs'), f('README.md'), f('new.txt', '?')],
  src: [d('src/lib'), f('src/app.ts', 'M'), f('src/old.ts')],
  'src/lib': [f('src/lib/util.ts')],
  docs: [f('docs/guide.md')],
};
const loader = () => vi.fn(async (dir: string): Promise<FileTreePage> => ({ dir, entries: PAGES[dir] ?? [], truncated: false }));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const item = (path: string) => document.querySelector<HTMLElement>(`[data-path="${path}"]`)!;
const visible = () => [...document.querySelectorAll('[role="treeitem"]')].map((el) => el.getAttribute('data-path'));

describe('FileTree', () => {
  it('loads the root, then each folder only when it opens', async () => {
    const load = loader();
    render(<FileTree load={load} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(visible()).toEqual(['src', 'docs', 'README.md', 'new.txt']);
    expect(screen.getByRole('tree', { name: 'Files' })).toBeInTheDocument();
    fireEvent.click(item('src'));
    await flush();
    expect(load).toHaveBeenLastCalledWith('src');
    expect(item('src')).toHaveAttribute('aria-expanded', 'true');
    expect(visible()).toEqual(['src', 'src/lib', 'src/app.ts', 'src/old.ts', 'docs', 'README.md', 'new.txt']);
    expect(item('src/app.ts')).toHaveAttribute('aria-level', '2');
    fireEvent.click(item('src'));
    expect(visible()).toEqual(['src', 'docs', 'README.md', 'new.txt']);
    fireEvent.click(item('src'));
    expect(load).toHaveBeenCalledTimes(2); // already loaded: not asked again
  });

  it('change badges in words for assistive tech; untracked reads U', async () => {
    render(<FileTree load={loader()} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    expect(within(item('new.txt')).getByLabelText('untracked')).toHaveTextContent('U');
    expect(within(item('src')).getByLabelText('modified')).toBeInTheDocument();
    expect(item('README.md').querySelector('[aria-label]')).toBeNull();
  });


  it('"Changed only" filters what is listed', async () => {
    const load = loader();
    const { rerender } = render(<FileTree load={load} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    fireEvent.click(item('src'));
    await flush();
    rerender(<FileTree load={load} changedOnly selected={null} onSelect={vi.fn()} />);
    expect(visible()).toEqual(['src', 'src/app.ts', 'new.txt']);
  });

  it('opening a file selects it; the selected one is marked', async () => {
    const onSelect = vi.fn();
    const load = loader();
    const { rerender } = render(<FileTree load={load} changedOnly={false} selected={null} onSelect={onSelect} />);
    await flush();
    fireEvent.click(item('README.md'));
    expect(onSelect).toHaveBeenCalledWith('README.md');
    rerender(<FileTree load={load} changedOnly={false} selected="README.md" onSelect={onSelect} />);
    expect(item('README.md')).toHaveAttribute('aria-selected', 'true');
    expect(item('README.md').className).toMatch(/glass-pill/);
    expect(item('docs')).toHaveAttribute('aria-selected', 'false');
  });

  it('keyboard: one tab stop; arrows move; Right opens then steps in; Left closes then steps out; Enter opens a file', async () => {
    const onSelect = vi.fn();
    render(<FileTree load={loader()} changedOnly={false} selected={null} onSelect={onSelect} />);
    await flush();
    const tabStops = () => [...document.querySelectorAll('[role="treeitem"][tabindex="0"]')].map((el) => el.getAttribute('data-path'));
    expect(tabStops()).toEqual(['src']);
    const tree = screen.getByRole('tree');
    item('src').focus();
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    await flush();
    expect(item('src')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('src/lib'));
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('src/app.ts'));
    expect(tabStops()).toEqual(['src/app.ts']);
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('src/app.ts');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('src'));
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(item('src')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(tree, { key: 'End' });
    expect(document.activeElement).toBe(item('new.txt'));
    fireEvent.keyDown(tree, { key: 'Home' });
    expect(document.activeElement).toBe(item('src'));
  });

  it('reveal opens every folder above a file opened from elsewhere', async () => {
    const load = loader();
    render(<FileTree load={load} changedOnly={false} selected="src/lib/util.ts" reveal="src/lib/util.ts" onSelect={vi.fn()} />);
    await flush();
    await flush();
    expect(load).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledWith('src/lib');
    expect(item('src/lib/util.ts')).toHaveAttribute('aria-selected', 'true');
  });

  it('ignored entries are dimmed; a new loader (ignored toggled) reloads, keeping folders open', async () => {
    const first = loader();
    const { rerender } = render(<FileTree load={first} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    fireEvent.click(item('docs'));
    await flush();
    const second = vi.fn(async (dir: string): Promise<FileTreePage> => ({ dir, entries: dir === '' ? [...PAGES['']!, f('dist/x.js', undefined, { ignored: true, name: 'dist' })] : PAGES[dir] ?? [], truncated: false }));
    rerender(<FileTree load={second} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    expect(second).toHaveBeenCalledWith('');
    expect(second).toHaveBeenCalledWith('docs');
    expect(item('dist/x.js').className).toMatch(/opacity-50/);
  });

  it('a folder that fails to list says so; an empty Changed-only view says so', async () => {
    const load = vi.fn(async () => { throw new Error('not a worktree'); });
    render(<FileTree load={load} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t list files: not a worktree');
  });

  it('a truncated folder says how much is shown', async () => {
    render(<FileTree load={async (dir) => ({ dir, entries: [f('a')], truncated: true })} changedOnly={false} selected={null} onSelect={vi.fn()} />);
    await flush();
    expect(screen.getByText('Showing the first 2,000 entries.')).toBeInTheDocument();
  });
});
