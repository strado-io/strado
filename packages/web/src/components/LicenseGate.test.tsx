import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LicenseGate } from './LicenseGate';
import { api } from '../api';

// Mocked once at module scope; each test sets the resolved values it needs on
// these same mock functions rather than re-mocking the module.
vi.mock('../api', () => ({
  api: {
    license: { get: vi.fn(), verify: vi.fn() },
    profile: { get: vi.fn(async () => ({ telemetryOptOut: true })) },
    auth: { start: vi.fn(), poll: vi.fn(), signout: vi.fn() },
  },
}));

const activeLicense = { code: 'STRADO-AAAA-BBBB', token: 'f'.repeat(64), name: 'Friend', deviceId: 'd'.repeat(12) };

describe('LicenseGate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders children directly when the gate is not required (dev)', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: false,
      apiUrl: 'x',
      telemetry: false,
      license: null,
      status: 'none',
    });
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
  });

  it('renders children when a license is fresh, and verifies through the local server', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'ok',
    });
    vi.mocked(api.license.verify).mockResolvedValue({ ok: true });
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
    // The heartbeat now goes through the local server (Task 7's endpoint), not
    // straight to the cloud, so the local server can stamp lastVerifiedAt.
    await waitFor(() => expect(api.license.verify).toHaveBeenCalled());
  });

  it('offers sign-in and no invite-code box', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.strado.io',
      telemetry: false,
      license: null,
      status: 'none',
    });
    render(
      <LicenseGate>
        <div>the app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());
    expect(screen.queryByPlaceholderText(/STRADO-/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/the app/)).not.toBeInTheDocument();
  });

  it('a revoked verify locks the app', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'ok',
    });
    vi.mocked(api.license.verify).mockResolvedValue({ ok: false, reason: 'revoked' });
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    // The renderer opens the app immediately on a stored license and only
    // locks once the background verify call resolves as revoked, so we assert
    // on the settled state rather than an in-between render.
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());
    expect(screen.queryByText('app')).not.toBeInTheDocument();
  });

  it('an unreachable verify does not lock the app — offline is not revoked', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'ok',
    });
    vi.mocked(api.license.verify).mockRejectedValue(new Error('network error'));
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
    await waitFor(() => expect(api.license.verify).toHaveBeenCalled());
    // still open after the rejected verify call settles
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('a resolved "unreachable" verify (the actual shape the local server returns when the cloud is unreachable) does not lock the app either', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'ok',
    });
    vi.mocked(api.license.verify).mockResolvedValue({ ok: false, reason: 'unreachable' });
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
    await waitFor(() => expect(api.license.verify).toHaveBeenCalled());
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  // The grace window (Task 6) has run out: the local server's own
  // licenseState() already says 'stale', which is what GET /api/license now
  // reports. Without a distinct screen for this, the app would render as if
  // everything were fine while every API call silently 401s underneath it.
  it('a stale license shows a reconnect screen, never the app, with a way forward', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'stale',
    });
    // Still genuinely offline: the background verify that fires on mount also
    // fails, so this does not silently self-heal into looking fine.
    vi.mocked(api.license.verify).mockRejectedValue(new Error('network error'));
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(api.license.verify).toHaveBeenCalled());
    expect(screen.queryByText('app')).not.toBeInTheDocument();
    // Distinct from the plain signed-out screen: it must say the license
    // itself is the problem, not "you aren't signed in".
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // ...and still offers a way out that doesn't depend on connectivity.
    expect(screen.getByRole('button', { name: /sign in with email/i })).toBeInTheDocument();
  });

  it('a stale license that reaches the cloud in the background opens the app on its own', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'stale',
    });
    vi.mocked(api.license.verify).mockResolvedValue({ ok: true });
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
  });

  it('clicking Retry on the reconnect screen re-verifies and opens the app once it succeeds', async () => {
    vi.mocked(api.license.get).mockResolvedValue({
      required: true,
      apiUrl: 'https://api.test',
      telemetry: true,
      license: activeLicense,
      status: 'stale',
    });
    vi.mocked(api.license.verify).mockRejectedValueOnce(new Error('network error'));
    render(
      <LicenseGate>
        <div>app</div>
      </LicenseGate>,
    );
    const retryButton = await screen.findByRole('button', { name: /retry/i });
    vi.mocked(api.license.verify).mockResolvedValueOnce({ ok: true });
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.getByText('app')).toBeInTheDocument());
  });
});
