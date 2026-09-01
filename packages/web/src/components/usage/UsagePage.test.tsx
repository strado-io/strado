import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';
import type { MachineSample, UsageAccount, UsageSummary } from '../../types';

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  accounts: vi.fn(),
  machine: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { usage: { summary: mocks.summary, accounts: mocks.accounts, machine: mocks.machine } },
}));

const HOUR = 3_600_000;

const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  range: { from: '2026-08-03', to: '2026-09-01' },
  pricing: { source: 'litellm', fetchedAt: '2026-09-01T09:00:00.000Z' },
  totals: {
    cost: 3798, tokens: 4_200_000_000, cachedInput: 4_100_000_000, uncachedInput: 10_300_000,
    cacheWrite: 0, output: 15_200_000, cacheSavings: 20_701, cacheSavingsMultiple: 5.5,
  },
  byAgent: {
    claude: { cost: 3567, tokens: 3_900_000_000 },
    codex: { cost: 230, tokens: 300_000_000 },
  },
  series: [
    { date: '2026-08-30', claude: { cost: 120, tokens: 1_000_000 }, codex: { cost: 5, tokens: 40_000 } },
    { date: '2026-08-31', claude: { cost: 300, tokens: 2_000_000 }, codex: { cost: 9, tokens: 60_000 } },
  ],
  models: [
    { id: 'claude-opus-5', agent: 'claude', cost: 1409, tokens: 1_800_000_000, share: 37, priced: true },
    { id: 'gpt-5.6', agent: 'codex', cost: 229, tokens: 303_600_000, share: 6, priced: true },
  ],
  worktrees: [
    { label: 'strado', path: '/repo/strado', cost: 794, tokens: 975_200_000 },
    { label: 'docs_page', path: '/repo/docs', cost: 355, tokens: 459_000_000 },
  ],
  skipped: 0,
  bytesRead: 0,
  ...over,
});

const claudeAccount: UsageAccount = {
  agent: 'claude',
  accountLabel: 'dev@example.com',
  plan: 'TEAM',
  credentialSource: 'Keychain',
  windows: [
    // Half a minute of slack so the countdown does not tick down mid-render.
    { label: 'Session (5h)', usedPercent: 2, resetsAt: Date.now() + HOUR + 9 * 60_000 + 30_000 },
    { label: 'Weekly', usedPercent: 0, resetsAt: Date.now() + 6 * 24 * HOUR + 2 * HOUR + 30_000 },
  ],
  quotaStatus: 'official',
};

const machine: MachineSample = {
  cpuPercent: 28, cpuCount: 10, memUsedBytes: 12 * 1024 ** 3, memTotalBytes: 16 * 1024 ** 3,
  diskUsedBytes: 500 * 1024 ** 3, diskTotalBytes: 900 * 1024 ** 3, loadAvg: [2, 3, 4], uptimeSec: 4 * 86_400,
};

beforeEach(() => {
  mocks.summary.mockReset().mockResolvedValue(summary());
  mocks.accounts.mockReset().mockResolvedValue([claudeAccount]);
  mocks.machine.mockReset().mockResolvedValue(machine);
});

describe('UsagePage', () => {
  it('holds the page shape with skeletons while the logs are read', async () => {
    mocks.summary.mockImplementation(() => new Promise(() => {}));
    mocks.accounts.mockImplementation(() => new Promise(() => {}));

    render(<UsagePage wsId="ws-1" />);

    expect(await screen.findByRole('status', { name: 'Reading session logs' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Reading agent credentials' })).toBeInTheDocument();
    // The bare wait text is gone; the spinner carries the same words.
    expect(screen.getByText('Reading session logs…')).toBeInTheDocument();
  });

  it('drops the skeletons once the numbers land', async () => {
    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('$3,798')).toBeInTheDocument());
    expect(screen.queryByRole('status', { name: 'Reading session logs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Reading agent credentials' })).not.toBeInTheDocument();
  });

  it('shows meter skeletons until the machine sample returns', async () => {
    mocks.machine.mockImplementation(() => new Promise(() => {}));
    render(<UsagePage wsId="ws-1" />);
    await waitFor(() => expect(screen.getByText('$3,798')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Machine resources' }));

    expect(await screen.findByRole('status', { name: 'Reading machine resources' })).toBeInTheDocument();
    expect(screen.getByText('Sampling this machine…')).toBeInTheDocument();
  });

  it('shows the account card with quota and reset countdown', async () => {
    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('dev@example.com')).toBeInTheDocument());
    expect(screen.getByText('TEAM')).toBeInTheDocument();
    expect(screen.getByText('Keychain')).toBeInTheDocument();
    const sessionBar = screen.getByRole('meter', { name: 'Session (5h) used' });
    expect(sessionBar).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('↺ 1h 9m')).toBeInTheDocument();
    expect(screen.getByText('↺ 6d 2h')).toBeInTheDocument();
  });

  it('masks emails on request and restores them', async () => {
    render(<UsagePage wsId="ws-1" />);
    await waitFor(() => expect(screen.getByText('dev@example.com')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hide emails'));

    expect(screen.getByText('d•••@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Show emails'));
    expect(screen.getByText('dev@example.com')).toBeInTheDocument();
  });

  it('says quota is unavailable instead of showing a bar', async () => {
    mocks.accounts.mockResolvedValue([{ ...claudeAccount, quotaStatus: 'unavailable', windows: [] }]);

    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText(/Quota unavailable/)).toBeInTheDocument());
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('leads with the total cost, its caveat, and the per-agent split', async () => {
    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('$3,798')).toBeInTheDocument());
    expect(screen.getByText(/if billed at full API rate · LiteLLM rates · 1 Sep/))
      .toBeInTheDocument();
    expect(screen.getByText('$3,567')).toBeInTheDocument();
    expect(screen.getByText('$230')).toBeInTheDocument();
  });

  it('reports where the tokens went', async () => {
    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('Processed tokens')).toBeInTheDocument());
    expect(screen.getByText('4.2B')).toBeInTheDocument();
    expect(screen.getByText('4.1B · 100%')).toBeInTheDocument();
    expect(screen.getByText('$20,701 · 5.5x')).toBeInTheDocument();
  });

  it('renders the model and worktree breakdowns', async () => {
    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('claude-opus-5')).toBeInTheDocument());
    expect(screen.getByText('gpt-5.6')).toBeInTheDocument();
    expect(screen.getByText('strado')).toBeInTheDocument();
    expect(screen.getByText('docs_page')).toBeInTheDocument();
    expect(screen.getByText('$794')).toBeInTheDocument();
  });

  it('flags a model with no published price', async () => {
    mocks.summary.mockResolvedValue(summary({
      models: [{ id: 'mystery-1', agent: 'claude', cost: 0, tokens: 5_000, share: 0, priced: false }],
    }));

    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('unpriced')).toBeInTheDocument());
  });

  it('refetches when the range changes', async () => {
    render(<UsagePage wsId="ws-1" />);
    await waitFor(() => expect(mocks.summary).toHaveBeenCalledWith('ws-1', 30));

    fireEvent.click(screen.getByRole('button', { name: '7d' }));

    await waitFor(() => expect(mocks.summary).toHaveBeenLastCalledWith('ws-1', 7));
  });

  it('switches the chart to token counts', async () => {
    render(<UsagePage wsId="ws-1" />);
    await waitFor(() => expect(screen.getByText('$3,567')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Tokens' }));

    expect(screen.getByRole('img', { name: 'Daily tokens by agent' })).toBeInTheDocument();
    expect(screen.getByText('3.9B')).toBeInTheDocument();
  });

  it('invites the first agent run when the window is empty', async () => {
    mocks.summary.mockResolvedValue(summary({
      totals: {
        cost: 0, tokens: 0, cachedInput: 0, uncachedInput: 0, cacheWrite: 0,
        output: 0, cacheSavings: 0, cacheSavingsMultiple: 1,
      },
      models: [],
      worktrees: [],
    }));

    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText(/No agent turns in this window/)).toBeInTheDocument());
    expect(screen.queryByRole('img', { name: /Daily/ })).not.toBeInTheDocument();
  });

  it('shows machine resources on its own tab, sampled on demand', async () => {
    render(<UsagePage wsId="ws-1" />);
    await waitFor(() => expect(screen.getByText('$3,798')).toBeInTheDocument());
    expect(mocks.machine).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Machine resources' }));

    await waitFor(() => expect(screen.getByText('Memory')).toBeInTheDocument());
    expect(mocks.machine).toHaveBeenCalledWith('ws-1');
    expect(screen.getByText('12.0 GB of 16.0 GB')).toBeInTheDocument();
    expect(screen.getByText('10 cores · load 2.00 3.00 4.00')).toBeInTheDocument();
    expect(screen.getByText('Up 4d 0h · sampled when this tab opened')).toBeInTheDocument();
  });

  it('surfaces a failed load without hiding the page', async () => {
    mocks.summary.mockRejectedValue(new Error('cache unreadable'));

    render(<UsagePage wsId="ws-1" />);

    await waitFor(() => expect(screen.getByText('cache unreadable')).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Date range' })).toBeInTheDocument();
  });

  it('reads out a day on chart hover', async () => {
    render(<UsagePage wsId="ws-1" />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'Daily cost by agent' })).toBeInTheDocument());

    const chart = screen.getByRole('img', { name: 'Daily cost by agent' });
    const targets = chart.querySelectorAll('rect');
    fireEvent.mouseEnter(targets[targets.length - 1]!);

    const readout = screen.getByTestId('usage-chart-readout');
    expect(within(readout).getByText('31 Aug')).toBeInTheDocument();
    expect(within(readout).getByText('$300')).toBeInTheDocument();
    expect(within(readout).getByText('$9')).toBeInTheDocument();
  });
});
