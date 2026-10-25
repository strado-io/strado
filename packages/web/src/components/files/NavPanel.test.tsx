import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NavHit } from '../../types';
import { NavPanel, byFile, navTitle } from './NavPanel';

const h = (path: string, line: number, preview = `line ${line}`): NavHit => ({ path, line, col: 3, preview });

describe('navTitle', () => {
  it('exact answers read plainly; a search guess says why it is one', () => {
    expect(navTitle('definition', { source: 'lsp', server: 'typescript', hits: [] })).toBe('Definitions');
    expect(navTitle('references', { source: 'lsp', server: 'typescript', hits: [h('a', 1), h('b', 2)] })).toBe('References · 2');
    expect(navTitle('definition', { source: 'search', server: 'typescript', fallback: 'not-installed', hits: [] }))
      .toBe('Possible definitions (no TypeScript server — install in Settings)');
    expect(navTitle('definition', { source: 'search', server: 'typescript', fallback: 'starting', hits: [] }))
      .toBe('Starting TypeScript… showing search results meanwhile');
    expect(navTitle('references', { source: 'search', server: 'gopls', fallback: 'disabled', hits: [] }))
      .toBe('Possible references (Go server is off — turn it on in Settings)');
    expect(navTitle('definition', { source: 'search', fallback: 'no-server', hits: [] }))
      .toBe('Possible definitions (no language server for this file type)');
    expect(navTitle('definition', { source: 'search', server: 'pyright', fallback: 'timeout', hits: [] }))
      .toBe('Possible definitions (Python server didn’t answer in time)');
    expect(navTitle('definition', { source: 'search', server: 'pyright', fallback: 'failed', hits: [] }))
      .toBe('Possible definitions (Python server failed — showing search results)');
  });
  it('groups by file in first-seen order', () => {
    expect(byFile([h('b.ts', 1), h('a.ts', 2), h('b.ts', 9)]).map(([f, g]) => [f, g.length])).toEqual([['b.ts', 2], ['a.ts', 1]]);
  });
});

describe('NavPanel', () => {
  it('lists hits grouped by file with line numbers; a click picks; the list takes focus; ↑↓ move; Esc closes', () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<NavPanel title="References · 3" hits={[h('src/a.ts', 4, 'open(x)'), h('src/b.ts', 10), h('src/a.ts', 9)]} empty="none" onPick={onPick} onClose={onClose} />);
    const panel = screen.getByRole('region', { name: 'References · 3' });
    const a = within(panel).getByRole('region', { name: 'src/a.ts' });
    expect(a).toHaveTextContent('src/a.ts · 2');
    expect(within(a).getAllByRole('button').map((b) => b.textContent)).toEqual(['4open(x)', '9line 9']);
    const first = within(a).getAllByRole('button')[0]!;
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(a).getAllByRole('button')[1]);
    fireEvent.click(first);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/a.ts', line: 4 }));
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('pending and empty states', () => {
    const { rerender } = render(<NavPanel title="Finding references" hits={[]} pending empty="No references found." onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('nav-panel')).toHaveTextContent('Looking…');
    rerender(<NavPanel title="References · 0" hits={[]} empty="No references found." onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('nav-panel')).toHaveTextContent('No references found.');
  });
});
