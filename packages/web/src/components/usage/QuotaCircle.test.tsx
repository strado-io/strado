import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaCircle, ringTone, tightestWindow } from './QuotaCircle';
import { resetQuotaCache } from '../../hooks/usage';
import type { UsageAccount } from '../../types';

const mocks = vi.hoisted(() => ({ accounts: vi.fn() }));

vi.mock('../../api', () => ({ api: { usage: { accounts: mocks.accounts } } }));

const HOUR = 3_600_000;

const claude = (over: Partial<UsageAccount> = {}): UsageAccount => ({
  agent: 'claude',
  measuredAt: Date.now(),
  accountLabel: 'dev@example.com',
  plan: 'TEAM',
  credentialSource: 'Keychain',
  windows: [
    { label: 'Session (5h)', usedPercent: 5, resetsAt: Date.now() + 2 * HOUR + 30_000 },
    { label: 'Weekly', usedPercent: 2, resetsAt: null },
  ],
  quotaStatus: 'official',
  ...over,
});

const codex = (usedPercent: number): UsageAccount => ({
  agent: 'codex',
  measuredAt: Date.now(),
  accountLabel: 'dev@strado.io',
  plan: 'PLUS',
  credentialSource: '~/.codex',
  windows: [{ label: 'Session (5h)', usedPercent, resetsAt: null }],
  quotaStatus: 'official',
});

beforeEach(() => {
  resetQuotaCache();
  mocks.accounts.mockReset().mockResolvedValue([claude(), codex(44)]);
});

describe('tightestWindow', () => {
  it('picks the window closest to its limit across accounts', () => {
    const found = tightestWindow([claude(), codex(44)]);

    expect(found?.account.agent).toBe('codex');
    expect(found?.window.usedPercent).toBe(44);
  });

  it('ignores accounts whose quota is unavailable', () => {
    const found = tightestWindow([
      { ...claude(), quotaStatus: 'unavailable', windows: [] },
      codex(10),
    ]);

    expect(found?.account.agent).toBe('codex');
  });

  it('finds nothing when no account reports a window', () => {
    expect(tightestWindow([])).toBeNull();
    expect(tightestWindow([{ ...claude(), windows: [] }])).toBeNull();
  });
});

describe('ringTone', () => {
  it('stays quiet until a limit is worth noticing', () => {
    expect(ringTone(10)).toContain('zinc');
    expect(ringTone(75)).toContain('amber');
    expect(ringTone(95)).toContain('red');
  });
});

describe('QuotaCircle', () => {
  it('names the tightest limit on the control itself', async () => {
    render(<QuotaCircle wsId="ws-1" />);

    const dial = await screen.findByRole('button', { name: /Agent usage/ });
    expect(dial).toHaveAccessibleName('Agent usage — Codex session (5h) 44% used');
  });

  it('includes the reset countdown when the vendor gives one', async () => {
    mocks.accounts.mockResolvedValue([claude({
      windows: [{ label: 'Session (5h)', usedPercent: 80, resetsAt: Date.now() + HOUR + 30_000 }],
    })]);

    render(<QuotaCircle wsId="ws-1" />);

    expect(await screen.findByRole('button', { name: /resets in 1h 0m/ })).toBeInTheDocument();
  });

  it('reads a passed reset as a moment, not a duration', async () => {
    mocks.accounts.mockResolvedValue([codex(50)]);
    resetQuotaCache();
    mocks.accounts.mockResolvedValue([{
      ...codex(50),
      windows: [{ label: 'Session (5h)', usedPercent: 50, resetsAt: Date.now() - 1_000 }],
    }]);

    render(<QuotaCircle wsId="ws-1" />);

    expect(await screen.findByRole('button', { name: /resets now/ })).toBeInTheDocument();
  });

  it('shows every account when opened, then closes on Escape', async () => {
    render(<QuotaCircle wsId="ws-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent usage/ }));

    const dialog = screen.getByRole('dialog', { name: 'Agent usage' });
    expect(within(dialog).getByText('dev@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('dev@strado.io')).toBeInTheDocument();
    expect(within(dialog).getByRole('meter', { name: 'Weekly used' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hands off to the usage page and closes', async () => {
    const onOpenUsage = vi.fn();
    render(<QuotaCircle wsId="ws-1" onOpenUsage={onOpenUsage} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent usage/ }));

    fireEvent.click(screen.getByText('Open usage →'));

    expect(onOpenUsage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing when no agent reports a limit', async () => {
    mocks.accounts.mockResolvedValue([]);

    const { container } = render(<QuotaCircle wsId="ws-1" />);

    await waitFor(() => expect(mocks.accounts).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the api has no usage namespace at all', async () => {
    const { container } = render(<QuotaCircle wsId="ws-1" />);

    await waitFor(() => expect(mocks.accounts).toHaveBeenCalled());
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('shares one request between several mounted dials', async () => {
    render(<><QuotaCircle wsId="ws-1" /><QuotaCircle wsId="ws-1" /><QuotaCircle wsId="ws-1" /></>);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Agent usage/ })).toHaveLength(3));
    expect(mocks.accounts).toHaveBeenCalledTimes(1);
  });
});
