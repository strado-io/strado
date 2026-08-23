import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const profileGet = vi.hoisted(() => vi.fn().mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: false }));
const licenseGet = vi.hoisted(() => vi.fn().mockResolvedValue({ required: false, apiUrl: '', license: null }));
vi.mock('../../api', () => ({
  api: {
    profile: { get: profileGet, save: vi.fn() },
    modelCredential: { get: vi.fn().mockResolvedValue({ present: false, last4: null }) },
    license: { get: licenseGet },
    jira: { config: vi.fn().mockResolvedValue({ baseUrl: null, email: null, hasToken: false }) },
    tickets: { linearConfig: vi.fn().mockResolvedValue({ connected: false, workspaceName: null }) },
    gitlab: { config: vi.fn().mockResolvedValue({ hosts: [] }) },
    github: { config: vi.fn().mockResolvedValue({ hosts: [] }) },
  },
}));

import { SettingsModal } from './SettingsModal';

describe('SettingsModal', () => {
  it('opens on the section given by the prop', () => {
    render(<SettingsModal section="jira" onClose={() => {}} />);
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'jira');
  });

  it('defaults to the profile section', async () => {
    render(<SettingsModal onClose={() => {}} />);
    await waitFor(() => expect(profileGet).toHaveBeenCalled());
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
  });

  it('switches panes when a nav item is clicked', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'appearance');
  });

  it('opens the Linear section from the nav', () => {
    render(<SettingsModal onClose={() => {}} />);
    // Without entitlements the item carries a "Pro" badge in its accessible
    // name ("Linear Pro"), and clicking it must still open the pane (upsell).
    fireEvent.click(screen.getByRole('button', { name: /^Linear\b/ }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'linear');
  });

  it('opens the GitLab section from the nav', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'GitLab' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'gitlab');
  });

  it('opens the GitHub section from the nav', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'github');
  });

  it('closes on Escape and on the close button', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);
    await waitFor(() => expect(profileGet).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('Close settings'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
