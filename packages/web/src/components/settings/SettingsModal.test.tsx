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
    workspaces: { list: vi.fn().mockResolvedValue({ activeWorkspaceId: 'default', workspaces: [] }) },
  },
}));

import { SettingsModal } from './SettingsModal';
import { WorkspaceContext } from '../../contexts/WorkspaceContext';
import type { Workspace } from '../../types';

const workspace: Workspace = {
  id: 'default', name: 'Default', color: '#333333', icon: 'D',
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
};

describe('SettingsModal', () => {
  it('opens on the section given by the prop', () => {
    render(<SettingsModal section="jira" onClose={() => {}} />);
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'integrations');
    expect(screen.getByTestId('integration-pane')).toHaveAttribute('data-integration', 'jira');
  });

  it('defaults to the profile section', async () => {
    render(<SettingsModal onClose={() => {}} />);
    await waitFor(() => expect(profileGet).toHaveBeenCalled());
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
  });

  it('shows an icon for every settings navigation item', () => {
    render(<SettingsModal onClose={() => {}} onOpenFeedback={() => {}} />);
    for (const id of ['profile', 'organization', 'appearance', 'workspaces', 'runners', 'integrations', 'privacy', 'feedback']) {
      expect(screen.getByTestId(`settings-icon-${id}`)).toBeInTheDocument();
    }
  });

  it('switches panes when a nav item is clicked', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'appearance');
  });

  it('groups connections under a single Integrations navigation item', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'integrations');
    expect(screen.queryByRole('button', { name: /^Jira$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Jira\b/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Linear\b/ })).toBeInTheDocument();
  });

  it('switches between providers inside Integrations', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
    expect(screen.getByTestId('integration-pane')).toHaveAttribute('data-integration', 'github');
    fireEvent.click(screen.getByRole('tab', { name: 'GitLab' }));
    expect(screen.getByTestId('integration-pane')).toHaveAttribute('data-integration', 'gitlab');
  });

  it('keeps workspace management inside Settings', async () => {
    render(
      <WorkspaceContext.Provider value={{ workspace, allWorkspaces: [workspace], refresh: vi.fn(), switchTo: vi.fn() }}>
        <SettingsModal onClose={() => {}} />
      </WorkspaceContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'workspaces');
    expect(await screen.findByRole('heading', { name: 'Workspaces' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
  });

  it('opens runners in its own infrastructure section', () => {
    render(<SettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Runners\b/ }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'runners');
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
