import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api';
import { publishTickets, readTickets } from '../../hooks/tickets';
import { LinearSection } from './LinearSection';

beforeEach(() => {
  // jsdom doesn't implement window.open; the OAuth tab is a side effect the
  // flow doesn't need exercised here (see LoginPanel.test.tsx for the same
  // pattern) — it's asserted on separately below via the spy.
  vi.spyOn(window, 'open').mockImplementation(() => null);
  publishTickets({ configured: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LinearSection', () => {
  it('shows Connect Linear when not connected', async () => {
    vi.spyOn(api.api.tickets, 'linearConfig').mockResolvedValue({ connected: false, workspaceName: null });
    render(<LinearSection />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /connect linear/i })).toBeInTheDocument();
  });

  it('connects: opens the OAuth tab, polls status, then shows the workspace and a Disconnect button', async () => {
    vi.spyOn(api.api.tickets, 'linearConfig').mockResolvedValue({ connected: false, workspaceName: null });
    const start = vi.spyOn(api.api.tickets, 'linearConnectStart').mockResolvedValue({
      url: 'https://linear.app/oauth/authorize?x=1',
      state: 'abc123',
    });
    const status = vi
      .spyOn(api.api.tickets, 'linearConnectStatus')
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValueOnce({ connected: true, workspaceName: 'Acme' });
    vi.spyOn(api.api.tickets, 'providers').mockResolvedValue([
      { provider: 'linear', configured: true, label: 'Linear' },
    ]);

    render(<LinearSection />);
    await screen.findByRole('button', { name: /connect linear/i });

    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole('button', { name: /connect linear/i }).click();
      await vi.advanceTimersByTimeAsync(0); // let connect()'s await resolve
    });

    expect(start).toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith('https://linear.app/oauth/authorize?x=1', '_blank', 'noopener,noreferrer');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // first poll: still pending
    });
    expect(status).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // second poll: connected
    });

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    // the tickets store must reflect the newly-configured provider without
    // waiting for Dashboard's own next refresh
    expect(readTickets().configured).toEqual(['linear']);
  });

  it('disconnects and returns to the connect state', async () => {
    vi.spyOn(api.api.tickets, 'linearConfig').mockResolvedValue({ connected: true, workspaceName: 'Acme' });
    const disconnect = vi.spyOn(api.api.tickets, 'linearDisconnect').mockResolvedValue({ ok: true });
    vi.spyOn(api.api.tickets, 'providers').mockResolvedValue([
      { provider: 'linear', configured: false, label: 'Linear' },
    ]);

    render(<LinearSection />);

    await screen.findByText('Acme');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: /disconnect/i }).click();
      // flush disconnect()'s await plus its unawaited providers() refresh
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(disconnect).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /connect linear/i })).toBeInTheDocument();
    expect(readTickets().configured).toEqual([]);
  });

  it('tests an existing connection', async () => {
    vi.spyOn(api.api.tickets, 'linearConfig').mockResolvedValue({ connected: true, workspaceName: 'Acme' });
    const testConnection = vi.spyOn(api.api.tickets, 'linearTest').mockResolvedValue({ ok: true, workspaceName: 'Acme' });
    render(<LinearSection />);

    await screen.findByText('Acme');
    await act(async () => {
      screen.getByRole('button', { name: 'Test connection' }).click();
    });

    expect(testConnection).toHaveBeenCalled();
    expect(await screen.findByText('Connection is working.')).toBeInTheDocument();
  });
});
