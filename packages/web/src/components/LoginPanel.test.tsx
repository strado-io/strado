import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { LoginPanel } from './LoginPanel';

beforeEach(() => {
  // jsdom doesn't implement window.open; the component opens the system
  // browser as a side effect the sign-in flow doesn't need exercised here
  // (see DiffView.test.tsx for the same pattern).
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LoginPanel', () => {
  it('shows the code to confirm, and reports when signed in', async () => {
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'WXYZ-1234',
      verificationUrl: 'https://api.strado.io/login?user_code=WXYZ-1234',
      interval: 0, // no waiting in tests
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const poll = vi
      .spyOn(api.api.auth, 'poll')
      .mockResolvedValueOnce({ status: 'authorization_pending' })
      .mockResolvedValueOnce({ status: 'signed_in', email: 'a@b.com', name: 'Kamlesh' });
    const onSignedIn = vi.fn();

    render(<LoginPanel onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // The human must be able to compare this against the browser.
    await waitFor(() => expect(screen.getByText('WXYZ-1234')).toBeInTheDocument());
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('surfaces an expired attempt instead of polling forever', async () => {
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'AAAA-BBBB',
      verificationUrl: 'https://api.strado.io/login?user_code=AAAA-BBBB',
      interval: 0,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.spyOn(api.api.auth, 'poll').mockResolvedValue({ status: 'expired' });

    render(<LoginPanel onSignedIn={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText(/expired/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('surfaces an unrecognised poll status as an error rather than retrying forever', async () => {
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'EEEE-FFFF',
      verificationUrl: 'https://api.strado.io/login?user_code=EEEE-FFFF',
      interval: 0,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // Cast past the known-literal union: this simulates a server that has
    // shipped a terminal status this build doesn't know about yet.
    const poll = vi
      .spyOn(api.api.auth, 'poll')
      .mockResolvedValue({ status: 'some_future_status' } as Awaited<ReturnType<typeof api.api.auth.poll>>);
    const onSignedIn = vi.fn();

    render(<LoginPanel onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText(/unexpected sign-in status/i)).toBeInTheDocument());
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('treats an HTTP error from poll as terminal, not a network blip to retry', async () => {
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'GGGG-HHHH',
      verificationUrl: 'https://api.strado.io/login?user_code=GGGG-HHHH',
      interval: 0,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // request() throws ApiClientError precisely when fetch() succeeded and the
    // server answered with a non-2xx status (e.g. the local server's in-memory
    // pending map was wiped by a restart mid-poll, so userCode now 400s as
    // unknown_user_code). That is a "the server said no," not a network blip.
    const poll = vi
      .spyOn(api.api.auth, 'poll')
      .mockRejectedValue(new api.ApiClientError('UNKNOWN', 'Bad Request'));
    const onSignedIn = vi.fn();

    render(<LoginPanel onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText(/sign-in failed/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
    // Terminal: must not keep hammering a poll the server has already rejected.
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying through a genuine network blip (a rejection that is not an ApiClientError)', async () => {
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'IIII-JJJJ',
      verificationUrl: 'https://api.strado.io/login?user_code=IIII-JJJJ',
      interval: 0,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // fetch() itself failing (offline, DNS, connection refused) rejects with a
    // plain TypeError, never reaching request()'s res.ok check — this must
    // still be treated as transient.
    const poll = vi
      .spyOn(api.api.auth, 'poll')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ status: 'signed_in', email: 'a@b.com', name: 'Kamlesh' });
    const onSignedIn = vi.fn();

    render(<LoginPanel onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not sign in on a poll that was already in flight when the panel unmounted', async () => {
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'KKKK-LLLL',
      verificationUrl: 'https://api.strado.io/login?user_code=KKKK-LLLL',
      interval: 0,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // Held open so the unmount lands squarely in the middle of the request.
    let land!: (r: Awaited<ReturnType<typeof api.api.auth.poll>>) => void;
    const poll = vi
      .spyOn(api.api.auth, 'poll')
      .mockImplementation(() => new Promise((resolve) => (land = resolve)));
    const onSignedIn = vi.fn();

    const { unmount } = render(<LoginPanel onSignedIn={onSignedIn} />);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(poll).toHaveBeenCalled());

    unmount();
    await act(async () => {
      land({ status: 'signed_in', email: 'a@b.com', name: 'Kamlesh' });
    });

    // LicenseGate passes onSignedIn={() => window.location.reload()}, so a
    // straggler here does not merely warn — it reloads the app out from under
    // whatever the user moved on to.
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('stops polling after unmount, instead of leaking the loop in the background', async () => {
    vi.useFakeTimers();
    vi.spyOn(api.api.auth, 'start').mockResolvedValue({
      userCode: 'ZZZZ-0000',
      verificationUrl: 'https://api.strado.io/login?user_code=ZZZZ-0000',
      interval: 1, // 1s — deterministic under fake timers, unlike interval: 0
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const poll = vi.spyOn(api.api.auth, 'poll').mockResolvedValue({ status: 'authorization_pending' });

    const { unmount } = render(<LoginPanel onSignedIn={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
      await vi.advanceTimersByTimeAsync(0); // let start() resolve
    });

    // Let a few poll cycles happen while the panel is still mounted — this is
    // the same "Sign in with email" → Settings-nav-away scenario as a real
    // user switching tabs mid-attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(poll.mock.calls.length).toBeGreaterThan(0);

    unmount();

    // A poll already asleep in its interval when unmount happens may still
    // land once, but the loop must not keep going after that.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const settledAfterUnmount = poll.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000); // 20 more cycles' worth
    });
    expect(poll.mock.calls.length).toBe(settledAfterUnmount);
  });
});
