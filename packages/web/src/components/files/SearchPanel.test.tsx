import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchAnswer, SearchQuery } from '../../types';
import { SearchPanel } from './SearchPanel';

const ANSWER: SearchAnswer = { engine: 'rg', truncated: false, hits: [
  { path: 'src/a.ts', line: 3, col: 5, preview: 'const open = 1' },
  { path: 'src/b.ts', line: 7, col: 1, preview: 'open()' },
] };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const settle = () => act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); });

describe('SearchPanel', () => {
  it('debounces, sends the switches, and groups results by file; a click opens the hit', async () => {
    const search = vi.fn(async (_q: SearchQuery, _s: AbortSignal) => ANSWER);
    const onPick = vi.fn();
    render(<SearchPanel search={search} onPick={onPick} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Search text'));
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'op' } });
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: 'open' } });
    fireEvent.click(screen.getByTitle('Whole word'));
    fireEvent.click(screen.getByTitle('Match case'));
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toEqual({ q: 'open', word: true, case: true, regex: false });
    expect(screen.getByTitle('Whole word')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('search')).toHaveTextContent('2 results');
    fireEvent.click(within(screen.getByRole('region', { name: 'src/b.ts' })).getByRole('button'));
    expect(onPick).toHaveBeenCalledWith(ANSWER.hits[1], false);
    fireEvent.click(within(screen.getByRole('region', { name: 'src/b.ts' })).getByRole('button'), { altKey: true });
    expect(onPick).toHaveBeenLastCalledWith(ANSWER.hits[1], true);
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

  it('a bad pattern says so in fixed words; no matches says so; Esc closes', async () => {
    const onClose = vi.fn();
    const search = vi.fn(async () => { throw Object.assign(new Error('regex parse error: ...'), { code: 'VALIDATION' }); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rerender } = render(<SearchPanel search={search} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTitle('Regular expression'));
    fireEvent.change(screen.getByLabelText('Search text'), { target: { value: '(' } });
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(/^That search isn’t valid\.$/);
    rerender(<SearchPanel search={vi.fn(async () => ({ ...ANSWER, hits: [] }))} onPick={vi.fn()} onClose={onClose} />);
    await settle();
    expect(screen.getByRole('search')).toHaveTextContent('No matches.');
    fireEvent.keyDown(screen.getByRole('search'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
