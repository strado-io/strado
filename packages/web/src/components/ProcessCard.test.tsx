import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const logs = vi.fn().mockResolvedValue({ lines: ['[12:00] boot', '[12:01] ready'] });
const start = vi.fn().mockResolvedValue({ status: 'running', pid: 1, startedAt: null, port: 5173, detectedUrl: null, exitCode: null });
const stop = vi.fn().mockResolvedValue(undefined);
vi.mock('../api', () => ({ api: { worktrees: { logs: (...a: unknown[]) => logs(...a), start: (...a: unknown[]) => start(...a), stop: (...a: unknown[]) => stop(...a) } } }));

import { ProcessCard } from './ProcessCard';
const proc = (over = {}) => ({ status: 'stopped', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null, ...over });

describe('ProcessCard', () => {
  beforeEach(() => { logs.mockClear(); start.mockClear(); stop.mockClear(); });

  it('shows recent log lines fetched on mount', async () => {
    render(<ProcessCard wsId="w1" path="/w/FD-1" process={proc({ status: 'running', port: 5173 }) as never} />);
    // getByText matches on an element's direct text-node children only; the two log
    // lines are joined into a single text node inside <pre>, so an exact string match
    // never hits. Use a substring matcher instead (still resolves to just the <pre>).
    await waitFor(() => expect(screen.getByText((content) => content.includes('[12:01] ready'))).toBeInTheDocument());
    expect(logs).toHaveBeenCalledWith('w1', '/w/FD-1', expect.any(Number));
  });

  it('Start calls the api when stopped', async () => {
    render(<ProcessCard wsId="w1" path="/w/FD-1" process={proc() as never} />);
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('w1', '/w/FD-1'));
  });

  it('Stop calls the api when running', async () => {
    render(<ProcessCard wsId="w1" path="/w/FD-1" process={proc({ status: 'running' }) as never} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith('w1', '/w/FD-1'));
  });
});
