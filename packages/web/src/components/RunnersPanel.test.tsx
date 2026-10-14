import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { RunnersPanel, durationUntil } from './RunnersPanel';

describe('RunnersPanel pairing expiry text', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats future and past timestamps with durationUntil', () => {
    const now = Date.now();
    expect(durationUntil(new Date(now + 9 * 60_000).toISOString())).toBe('in 9 minutes');
    expect(durationUntil(new Date(now + 2 * 60 * 60_000).toISOString())).toBe('in 2 hours');
    expect(durationUntil(new Date(now - 60_000).toISOString())).toBe('expired');
  });

  it('renders future pairing expiry instead of "just now from now"', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: [] });
    const expiresAt = new Date(Date.now() + 9 * 60_000).toISOString();
    vi.spyOn(api.runners, 'pairCode').mockResolvedValue({
      code: 'PAIR-1234-5678',
      expiresAt,
      installCommand: 'curl -fsSL https://strado.io/install-runner.sh | sh',
      pairCommand: 'strado-runner pair --code PAIR-1234-5678',
    });

    render(<RunnersPanel />);
    await waitFor(() => expect(screen.getByText(/No runners yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add runner/i }));
    await waitFor(() => expect(screen.getByText(/in 9 minutes/i)).toBeInTheDocument());
    expect(screen.queryByText(/just now from now/i)).not.toBeInTheDocument();
  });
});
