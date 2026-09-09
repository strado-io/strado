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

import { SettingsPage } from './SettingsPage';
import { WorkspaceContext } from '../../contexts/WorkspaceContext';
import type { Workspace } from '../../types';

const workspace: Workspace = {
  id: 'default', name: 'Default', color: '#333333', icon: 'D',
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
};

describe('SettingsPage', () => {
  it('opens on the section given by the prop', () => {
    render(<SettingsPage section="jira" onClose={() => {}} />);
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'integrations');
    expect(screen.getByTestId('integration-pane')).toHaveAttribute('data-integration', 'jira');
  });

  it('filters navigation by feature keywords without changing the current section', () => {
    render(<SettingsPage onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'mcp' } });
    expect(screen.getByRole('button', { name: 'Coding agents' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Appearance' })).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'no-such-setting' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching settings.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
  });

  it('defaults to the profile section', async () => {
    render(<SettingsPage onClose={() => {}} />);
    await waitFor(() => expect(profileGet).toHaveBeenCalled());
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'profile');
  });

  it('shows an icon for every settings navigation item', () => {
    render(<SettingsPage onClose={() => {}} onOpenFeedback={() => {}} />);
    for (const id of ['profile', 'organization', 'appearance', 'workspaces', 'runners', 'integrations', 'privacy', 'feedback']) {
      expect(screen.getByTestId(`settings-icon-${id}`)).toBeInTheDocument();
    }
  });

  it('switches panes when a nav item is clicked', () => {
    render(<SettingsPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'appearance');
  });

  it('groups connections under a single Integrations navigation item', () => {
    render(<SettingsPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'integrations');
    expect(screen.queryByRole('button', { name: /^Jira$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Jira\b/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Linear\b/ })).toBeInTheDocument();
  });

  it('switches between providers inside Integrations', () => {
    render(<SettingsPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }));
    expect(screen.getByTestId('integration-pane')).toHaveAttribute('data-integration', 'github');
    fireEvent.click(screen.getByRole('tab', { name: 'GitLab' }));
    expect(screen.getByTestId('integration-pane')).toHaveAttribute('data-integration', 'gitlab');
  });

  it('keeps workspace management inside Settings', async () => {
    render(
      <WorkspaceContext.Provider value={{ workspace, allWorkspaces: [workspace], refresh: vi.fn(), switchTo: vi.fn() }}>
        <SettingsPage onClose={() => {}} />
      </WorkspaceContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'workspaces');
    expect(await screen.findByRole('heading', { name: 'Workspaces' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
  });

  it('opens runners in its own infrastructure section', () => {
    render(<SettingsPage onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Runners\b/ }));
    expect(screen.getByTestId('settings-pane')).toHaveAttribute('data-section', 'runners');
  });

  it('returns to the app on Escape and on the back button', async () => {
    const onClose = vi.fn();
    render(<SettingsPage onClose={onClose} />);
    await waitFor(() => expect(profileGet).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
