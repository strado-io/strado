import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { GithubSection } from './GithubSection';
import { GitlabSection } from './GitlabSection';
import { JiraSection } from './JiraSection';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integration connection status', () => {
  it('shows a connected GitHub account', async () => {
    vi.spyOn(api.github, 'config').mockResolvedValue({ hosts: ['github.com/strado-io'] });
    const testConfig = vi.spyOn(api.github, 'testConfig').mockResolvedValue({ ok: true, accounts: 1 });
    render(<GithubSection />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('github.com/strado-io')).toBeInTheDocument();
    expect(screen.queryByText(/^GitHub$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Personal access token')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add account' }));
    expect(screen.getByLabelText('Personal access token')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(testConfig).toHaveBeenCalled());
    expect(await screen.findByText('Connection is working.')).toBeInTheDocument();
  });

  it('shows GitLab as not connected when no host is configured', async () => {
    vi.spyOn(api.gitlab, 'config').mockResolvedValue({ hosts: [] });
    render(<GitlabSection />);

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByLabelText('Personal access token')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitLab' }));
    expect(screen.getByLabelText('Personal access token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitLab' })).toBeDisabled();
  });

  it('shows the configured Jira account', async () => {
    vi.spyOn(api.jira, 'config').mockResolvedValue({
      baseUrl: 'https://strado.atlassian.net',
      email: 'dev@strado.io',
      hasToken: true,
    });
    vi.spyOn(api.jira, 'testConfig').mockResolvedValue({ ok: true, accountName: 'Dev' });
    render(<JiraSection />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('dev@strado.io')).toBeInTheDocument();
    expect(screen.getByText('https://strado.atlassian.net')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection is working.')).toBeInTheDocument();
  });
});
