import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogLine } from '../../types';

const logs = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: { runners: { logs } } }));

import { LogsTab, formatLine } from './LogsTab';

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
const L = (i: number, level: LogLine['level'] = 'info', text = `line ${i}`): LogLine => ({ ts: T0 + i * 1000, level, text });
const PAGE = { source: 'journal' as const, nextSince: T0 + 3000, lines: [L(1), L(2, 'warn', 'disk 91% full'), L(3, 'error', 'relay dropped')] };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const shown = () => screen.getByTestId('log-lines').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  logs.mockReset().mockResolvedValue(PAGE);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('LogsTab', () => {
  it('formats a line as time, level, text', () => {
    expect(formatLine(L(2, 'warn', 'x'))).toBe('2026-10-24 10:00:02 WARN  x');
  });

  it('shows the last 300 lines, newest at the bottom, coloured by level', async () => {
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    expect(logs).toHaveBeenCalledWith('r1', { lines: 300 });
    expect(screen.getByRole('checkbox', { name: 'Follow' })).toBeEnabled();
    expect(screen.queryByTestId('follow-hint')).not.toBeInTheDocument();
    const rows = screen.getByTestId('log-lines').querySelectorAll('[data-level]');
    expect([...rows].map((r) => r.textContent)).toEqual([formatLine(PAGE.lines[0]!), formatLine(PAGE.lines[1]!), formatLine(PAGE.lines[2]!)]);
    expect(rows[1]!.className).toMatch(/amber/);
    expect(rows[2]!.className).toMatch(/red/);
    expect(screen.getByTestId('log-lines').className).toMatch(/font-mono/);
  });

  it('the filter goes to the runner, debounced', async () => {
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    fireEvent.change(screen.getByLabelText('Filter log lines'), { target: { value: 're' } });
    fireEvent.change(screen.getByLabelText('Filter log lines'), { target: { value: 'relay' } });
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(logs).toHaveBeenCalledTimes(1);
    logs.mockResolvedValueOnce({ ...PAGE, lines: [L(3, 'error', 'relay dropped')] });
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(logs).toHaveBeenCalledTimes(2);
    expect(logs).toHaveBeenLastCalledWith('r1', { lines: 300, grep: 'relay' });
    expect(shown()).toContain('relay dropped');
    expect(shown()).not.toContain('line 1');
  });

  it('Follow polls for lines after the last one every 2s and appends them; stops when hidden', async () => {
    const { rerender } = render(<LogsTab runnerId="r1" online visible />);
    await flush();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Follow' }));
    logs.mockResolvedValueOnce({ source: 'journal', nextSince: T0 + 4000, lines: [L(4, 'info', 'new one')] });
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(logs).toHaveBeenLastCalledWith('r1', { since: T0 + 3000 });
    expect(shown()).toMatch(/relay dropped.*new one/s);
    logs.mockResolvedValueOnce({ source: 'journal', nextSince: T0 + 4000, lines: [] });
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(logs).toHaveBeenLastCalledWith('r1', { since: T0 + 4000 });
    const calls = logs.mock.calls.length;
    rerender(<LogsTab runnerId="r1" online visible={false} />);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(logs).toHaveBeenCalledTimes(calls);
  });

  it('without Follow it never polls', async () => {
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('reopening keeps what was read instead of starting over', async () => {
    const { rerender } = render(<LogsTab runnerId="r1" online visible />);
    await flush();
    rerender(<LogsTab runnerId="r1" online visible={false} />);
    rerender(<LogsTab runnerId="r1" online visible />);
    await flush();
    expect(logs).toHaveBeenCalledTimes(1);
    expect(shown()).toContain('relay dropped');
  });

  it('"Copy visible lines" copies what is shown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible lines' }));
    expect(writeText).toHaveBeenCalledWith(PAGE.lines.map(formatLine).join('\n'));
  });

  it('the file log (no cursor) can\'t be followed and says why', async () => {
    logs.mockResolvedValue({ source: 'file', nextSince: null, lines: [L(1)] });
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    expect(screen.getByRole('checkbox', { name: 'Follow' })).toBeDisabled();
    expect(screen.getByTestId('follow-hint')).toHaveTextContent('Live follow needs the systemd service');
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('a runner with no log says so', async () => {
    logs.mockResolvedValue({ source: 'none', nextSince: null, lines: [] });
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    expect(screen.getByTestId('logs-tab')).toHaveTextContent('This runner has no log yet.');
  });

  it('runner offline: a banner, nothing read, Follow disabled', async () => {
    render(<LogsTab runnerId="r1" online={false} visible />);
    await flush();
    expect(screen.getByTestId('logs-offline')).toHaveTextContent('Runner offline');
    expect(logs).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Follow' })).toBeDisabled();
  });

  it('a failed read is said', async () => {
    logs.mockRejectedValue(new Error('runner unreachable'));
    render(<LogsTab runnerId="r1" online visible />);
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t read the log: runner unreachable');
  });
});
