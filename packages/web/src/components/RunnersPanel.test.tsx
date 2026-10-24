import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { api } from '../api';

// The dialog has its own tests; here it only hands back "Open host".
vi.mock('./SetUpOverSshDialog', () => ({
  SetUpOverSshDialog: ({ onOpenHost }: { onOpenHost?: (id: string) => void }) => (
    <button type="button" onClick={() => onOpenHost?.('r2')}>fake Open host</button>
  ),
}));
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

describe('RunnersPanel runner rows expand in place', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const row = (over: Partial<import('../api').RunnerRow> = {}) => ({
    runnerId: 'r1', name: 'runner-dev', online: true, lastOnlineAt: null, createdAt: '2026-10-01T00:00:00Z', runnerVersion: '0.1.30', ...over,
  });
  const two = [row(), row({ runnerId: 'r2', name: 'homebox' })];
  const info = { runnerId: 'r1', ssh: null, pinnedRunnerFingerprint: null, laptopFingerprint: '9f8e-7d6c-5b4a-3210' };
  const toggleOf = (name: string) => screen.getByRole('button', { name });
  const details = (id: string) => document.getElementById(`runner-details-${id}`);
  beforeEach(() => {
    vi.spyOn(api.runners, 'host').mockResolvedValue(info);
    vi.spyOn(api.runners.connections, 'list').mockResolvedValue({ connections: [], stale: false });
  });

  it('rows no longer sync logins or show the laptop key', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: [row()] });
    render(<RunnersPanel />);
    await screen.findByTestId('runner-r1');
    expect(screen.queryByRole('button', { name: 'Sync logins' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('sender-key-row')).not.toBeInTheDocument();
  });

  it('clicking a row expands its Overview · Connections below it, in the list; clicking again collapses', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: [row()] });
    render(<RunnersPanel />);
    const name = await screen.findByRole('button', { name: 'runner-dev' });
    expect(name).toHaveAttribute('aria-expanded', 'false');
    expect(details('r1')).toBeNull();
    fireEvent.click(screen.getByTestId('runner-row-r1'));
    expect(name).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('runner-chevron').className).toMatch(/\brotate-90\b/);
    expect(screen.getByTestId('runners-panel')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    const d = details('r1')!;
    expect(screen.getByTestId('runner-r1')).toContainElement(d);
    expect(d).toBeVisible();
    expect(within(d).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Connections', 'Sandboxes', 'Logs']);
    fireEvent.click(name);
    expect(name).toHaveAttribute('aria-expanded', 'false');
    expect(details('r1')).not.toBeVisible();
    expect(screen.getByTestId('runner-chevron').className).not.toMatch(/rotate-90/);
  });

  it('one runner open at a time: opening another closes the current one', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: two });
    render(<RunnersPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'runner-dev' }));
    fireEvent.click(toggleOf('homebox'));
    expect(toggleOf('homebox')).toHaveAttribute('aria-expanded', 'true');
    expect(toggleOf('runner-dev')).toHaveAttribute('aria-expanded', 'false');
    expect(details('r2')).toBeVisible();
    expect(details('r1')).not.toBeVisible();
  });

  it('Open, Link and Revoke never toggle the row', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: [row()] });
    vi.spyOn(api.runners, 'attach').mockResolvedValue({ code: 'c', expiresAt: '', url: 'https://x.example/' });
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<RunnersPanel />);
    const name = await screen.findByRole('button', { name: 'runner-dev' });
    for (const label of ['Open', 'Link', 'Revoke']) {
      fireEvent.click(within(screen.getByTestId('runner-row-r1')).getByRole('button', { name: label }));
      expect(name).toHaveAttribute('aria-expanded', 'false');
    }
    await waitFor(() => expect(api.runners.attach).toHaveBeenCalled());
  });

  it('a collapsed row keeps its Connections mounted, so a connect in flight carries on', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: [row()] });
    render(<RunnersPanel initialHost={{ runnerId: 'r1', tab: 'connections' }} />);
    const tab = await screen.findByTestId('connections-tab');
    fireEvent.click(toggleOf('runner-dev'));
    expect(screen.getByTestId('connections-tab')).toBe(tab);
    fireEvent.click(toggleOf('runner-dev'));
    expect(screen.getByTestId('connections-tab')).toBe(tab);
    expect(tab).toBeVisible();
  });

  it('a deep link expands that runner on its tab and scrolls it into view', async () => {
    const scrolled: Element[] = [];
    // jsdom has no scrollIntoView; give it one for this test only.
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    onTestFinished(() => { delete (Element.prototype as Partial<Element>).scrollIntoView; });
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: two });
    render(<RunnersPanel initialHost={{ runnerId: 'r2', tab: 'connections' }} />);
    await screen.findByTestId('runner-r2');
    expect(toggleOf('homebox')).toHaveAttribute('aria-expanded', 'true');
    expect(within(details('r2')!).getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(scrolled).toEqual([screen.getByTestId('runner-r2')]));
  });

  it('the SSH dialog\'s "Open host" closes it and expands that runner on Connections', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: two });
    render(<RunnersPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add over SSH' }));
    fireEvent.click(screen.getByRole('button', { name: 'fake Open host' }));
    expect(screen.queryByRole('button', { name: 'fake Open host' })).not.toBeInTheDocument();
    expect(toggleOf('homebox')).toHaveAttribute('aria-expanded', 'true');
    expect(within(details('r2')!).getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a runner that is gone leaves the list as it is', async () => {
    vi.spyOn(api.runners, 'list').mockResolvedValue({ runners: [row()] });
    render(<RunnersPanel initialHost={{ runnerId: 'gone' }} />);
    expect(await screen.findByTestId('runner-r1')).toBeInTheDocument();
    expect(toggleOf('runner-dev')).toHaveAttribute('aria-expanded', 'false');
  });
});
