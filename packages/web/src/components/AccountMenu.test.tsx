import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

const licenseGet = vi.hoisted(() => vi.fn());
const profileGet = vi.hoisted(() => vi.fn());
const orgGet = vi.hoisted(() => vi.fn());
const orgSwitch = vi.hoisted(() => vi.fn());
const signout = vi.hoisted(() => vi.fn());

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      license: { ...actual.api.license, get: licenseGet },
      profile: { ...actual.api.profile, get: profileGet },
      org: { ...actual.api.org, get: orgGet, switch: orgSwitch },
      auth: { ...actual.api.auth, signout },
    },
  };
});

import { AccountMenu } from './AccountMenu';

const orgView = {
  active: { id: 'org-1', name: 'Fleetx', kind: 'team', role: 'owner' },
  orgs: [
    { id: 'org-1', name: 'Fleetx', kind: 'team', role: 'owner' },
    { id: 'org-2', name: 'Personal', kind: 'personal', role: 'owner' },
  ],
  members: [],
  invitations: { outgoing: [], incoming: [] },
  entitlements: {
    plan: 'pro' as const,
    features: { runners: true, remote_worktrees: true, remote_ports: true, sandboxes: true, jira: true, linear: true },
  },
};

beforeEach(() => {
  licenseGet.mockReset().mockResolvedValue({
    required: true,
    apiUrl: 'https://api.strado.dev',
    license: { email: 'kamlesh@example.com', name: 'Kamlesh Bishnoi', token: 'secret', deviceId: 'device-1' },
  });
  profileGet.mockReset().mockResolvedValue({ fullName: 'Kamlesh Bishnoi', callMe: 'Kamlesh', telemetryOptOut: false });
  orgGet.mockReset().mockResolvedValue(orgView);
  orgSwitch.mockReset().mockResolvedValue({ ...orgView, active: orgView.orgs[1] });
  signout.mockReset().mockResolvedValue(undefined);
});

function renderMenu(overrides: Partial<ComponentProps<typeof AccountMenu>> = {}) {
  const props = {
    onOpenSettings: vi.fn(),
    onOpenFeedback: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
  render(<AccountMenu {...props} />);
  return props;
}

describe('AccountMenu', () => {
  it('combines the user and active organization in one sidebar control', async () => {
    renderMenu();
    const trigger = await screen.findByRole('button', { name: 'Account: Kamlesh' });
    expect(trigger).toHaveTextContent('KB');
    expect(trigger).toHaveTextContent('Kamlesh');
    expect(trigger).toHaveTextContent('Fleetx');
    expect(trigger).toHaveTextContent('pro');
  });

  it('opens Profile and Organization settings from the account menu', async () => {
    const onOpenSettings = vi.fn();
    renderMenu({ onOpenSettings });
    await userEvent.click(await screen.findByRole('button', { name: 'Account: Kamlesh' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Settings$/ }));
    expect(onOpenSettings).toHaveBeenCalledWith('profile');

    await userEvent.click(screen.getByRole('button', { name: 'Account: Kamlesh' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /organization settings/i }));
    expect(onOpenSettings).toHaveBeenCalledWith('organization');
  });

  it('opens feedback from the menu without restoring a standalone sidebar row', async () => {
    const onOpenFeedback = vi.fn();
    renderMenu({ onOpenFeedback });
    await userEvent.click(await screen.findByRole('button', { name: 'Account: Kamlesh' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /send feedback/i }));
    expect(onOpenFeedback).toHaveBeenCalled();
  });

  it('switches organizations and reloads after the switch completes', async () => {
    const reload = vi.fn();
    renderMenu({ reload });
    await userEvent.click(await screen.findByRole('button', { name: 'Account: Kamlesh' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Personal' }));
    await waitFor(() => expect(orgSwitch).toHaveBeenCalledWith('org-2'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('signs out from the account menu', async () => {
    const reload = vi.fn();
    renderMenu({ reload });
    await userEvent.click(await screen.findByRole('button', { name: 'Account: Kamlesh' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));
    await waitFor(() => expect(signout).toHaveBeenCalled());
    expect(reload).toHaveBeenCalled();
  });
});
