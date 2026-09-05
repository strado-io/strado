import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apiModule from '../../api';
import { GithubSection } from './GithubSection';

const installation = {
  installationId: 42,
  accountLogin: 'strado-io',
  accountType: 'Organization' as const,
  repositorySelection: 'selected' as const,
  suspended: false,
};

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.spyOn(apiModule.api.github, 'config').mockResolvedValue({ hosts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GithubSection', () => {
  it('shows verified GitHub App installations without exposing a token', async () => {
    vi.spyOn(apiModule.api.github, 'appStatus').mockResolvedValue({ installations: [installation] });
    render(<GithubSection />);

    expect(await screen.findByText('strado-io')).toBeInTheDocument();
    expect(screen.getByText(/selected repositories/i)).toBeInTheDocument();
    expect(screen.getByText(/enterprise server or manual pat fallback/i).closest('details')).not.toHaveAttribute('open');
  });

  it('opens the install URL and polls until GitHub is connected', async () => {
    const status = vi.spyOn(apiModule.api.github, 'appStatus')
      .mockResolvedValueOnce({ installations: [] })
      .mockResolvedValueOnce({ installations: [installation] });
    vi.spyOn(apiModule.api.github, 'appConnect').mockResolvedValue({
      state: 'a'.repeat(64),
      url: 'https://github.com/apps/strado-cloud/installations/new?state=x',
      expiresAt: '2026-09-01T00:00:00Z',
    });
    render(<GithubSection />);
    await screen.findByRole('button', { name: /^connect github$/i });

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^connect github$/i }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/apps/strado-cloud/installations/new?state=x',
      '_blank',
      'noopener,noreferrer',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByText('strado-io')).toBeInTheDocument();
  });

  it('keeps PAT configuration behind the enterprise fallback', async () => {
    vi.spyOn(apiModule.api.github, 'appStatus').mockResolvedValue({ installations: [] });
    render(<GithubSection />);
    const summary = await screen.findByText(/enterprise server or manual pat fallback/i);
    fireEvent.click(summary);
    expect(screen.getByPlaceholderText(/personal access token/i)).toBeInTheDocument();
  });
});
