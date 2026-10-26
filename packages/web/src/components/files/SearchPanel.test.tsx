import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchAnswer, SearchQuery } from '../../types';
import { SearchPanel, matchAt, snippet } from './SearchPanel';

const ANSWER: SearchAnswer = { engine: 'rg', truncated: false, hits: [
  { path: 'src/a.ts', line: 3, col: 5, preview: 'const open = 1' },
  { path: 'src/b.ts', line: 7, col: 1, preview: 'open()' },
] };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const settle = () => act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });

describe('SearchPanel', () => {
  const open = async (search: (q: SearchQuery, s: AbortSignal) => Promise<SearchAnswer> = vi.fn(async () => ANSWER), onPick = vi.fn()) => {
    render(<SearchPanel search={search} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'open' } });
    await settle();
    return { search, onPick };
  };

  it('debounces, sends the switches, and groups results by file; a click opens the hit with its query', async () => {
    const search = vi.fn(async (_q: SearchQuery, _s: AbortSignal) => ANSWER);
    const onPick = vi.fn();
    render(<SearchPanel search={search} onPick={onPick} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Search text'));
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'op' } });
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'open' } });
    fireEvent.click(screen.getByRole('button', { name: 'Match whole word' }));
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    const query = { q: 'open', word: true, case: true, regex: false };
    expect(search.mock.calls[0]![0]).toEqual(query);
    expect(screen.getByRole('search')).toHaveTextContent('2 results in 2 files');
    fireEvent.click(within(screen.getByRole('region', { name: 'src/b.ts' })).getByRole('option'));
    expect(onPick).toHaveBeenCalledWith(ANSWER.hits[1], false, query);
    fireEvent.click(within(screen.getByRole('region', { name: 'src/b.ts' })).getByRole('option'), { altKey: true });
    expect(onPick).toHaveBeenLastCalledWith(ANSWER.hits[1], true, query);
  });

  it('the switches are buttons in the box with tooltips, saying whether they are on', () => {
    render(<SearchPanel search={vi.fn(async () => ANSWER)} onPick={vi.fn()} onClose={vi.fn()} />);
    for (const name of ['Match case', 'Match whole word', 'Use regular expression']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('title', name);
      expect(b).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(b);
      expect(b).toHaveAttribute('aria-pressed', 'true');
      expect(b.className).toMatch(/bg-sky-500/);
      fireEvent.click(b);
      expect(b).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('a file header: its name, its folder dim, a count; it folds its rows', async () => {
    await open(vi.fn(async () => ({ ...ANSWER, hits: [...ANSWER.hits, { path: 'src/b.ts', line: 9, col: 2, preview: ' open(2)' }] })));
    const b = within(screen.getByRole('region', { name: 'src/b.ts' }));
    const header = b.getByRole('button', { name: /b\.ts/ });
    expect(header).toHaveTextContent('b.tssrc2');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(b.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(header);
    expect(b.queryAllByRole('option')).toHaveLength(0);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('↑/↓ move through the rows (folded ones skipped) and ⏎ opens the selected one', async () => {
    const { onPick } = await open();
    const options = () => screen.getAllByRole('option');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    const box = screen.getByLabelText('Search text');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // stays on the last
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(ANSWER.hits[1], false, expect.objectContaining({ q: 'open' }));
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter', altKey: true });
    expect(onPick).toHaveBeenLastCalledWith(ANSWER.hits[0], true, expect.objectContaining({ q: 'open' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'src/a.ts' })).getByRole('button', { name: /a\.ts/ }));
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(ANSWER.hits[1], false, expect.anything());
  });

  it('a row shows the match marked, in view however far along the line it is', async () => {
    const line = '    "resolved": "https://registry.npmjs.org/@vercel/analytics/-/analytics-1.3.1.tgz",';
    const col = line.indexOf('@vercel/analytics') + 1;
    render(<SearchPanel search={vi.fn(async () => ({ engine: 'rg' as const, truncated: false, hits: [{ path: 'package-lock.json', line: 490, col, preview: line }] }))} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: '@vercel/analytics' } });
    await settle();
    const row = screen.getByRole('option');
    expect(row.querySelector('mark')).toHaveTextContent('@vercel/analytics');
    expect(row).toHaveTextContent(/^490…y\.npmjs\.org\/@vercel\/analytics\/-\/analytics/);
  });

  it('a newer query cancels the older one', async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn((_q: SearchQuery, s: AbortSignal) => { signals.push(s); return new Promise<SearchAnswer>(() => {}); });
    render(<SearchPanel search={search} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'one' } });
    await settle();
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'two' } });
    expect(signals[0]!.aborted).toBe(true);
  });

  it('a bad pattern says so in fixed words; no matches says No results; Esc closes', async () => {
    const onClose = vi.fn();
    const search = vi.fn(async () => { throw Object.assign(new Error('regex parse error: ...'), { code: 'VALIDATION' }); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rerender } = render(<SearchPanel search={search} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: '(' } });
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(/^That search isn’t valid\.$/);
    rerender(<SearchPanel search={vi.fn(async () => ({ ...ANSWER, hits: [] }))} onPick={vi.fn()} onClose={onClose} />);
    await settle();
    expect(screen.getByRole('search')).toHaveTextContent('No results');
    fireEvent.keyDown(screen.getByRole('search'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('snippet / matchAt', () => {
  it('keeps about 12 characters before the match, with an ellipsis when cut; leading indent goes when not', () => {
    expect(snippet('const open = 1', matchAt('const open = 1', 7, { q: 'open' }))).toEqual({ cut: false, before: 'const ', match: 'open', after: ' = 1' });
    expect(snippet('        open()', matchAt('        open()', 9, { q: 'open' }))).toEqual({ cut: false, before: '', match: 'open', after: '()' });
    const long = `${'x'.repeat(80)}needle tail`;
    const s = snippet(long, matchAt(long, 81, { q: 'needle' }));
    expect(s).toEqual({ cut: true, before: 'x'.repeat(12), match: 'needle', after: ' tail' });
  });

  it('a regex match is as long as what it matched there, honouring case', () => {
    expect(matchAt('let fooBar = 1', 5, { q: 'foo[a-z]*', regex: true })).toEqual([4, 10]);
    expect(matchAt('let fooBar = 1', 5, { q: 'foo[a-z]*', regex: true, case: true })).toEqual([4, 7]);
    expect(matchAt('abc', 1, { q: '(', regex: true })).toEqual([0, 1]); // an invalid browser regex: the query's length
  });
});
