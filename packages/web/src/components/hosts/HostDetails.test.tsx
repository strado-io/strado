import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => vi.fn());
const mounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../api', () => ({ api: { runners: { host } } }));
vi.mock('./ConnectionsTab', async (orig) => ({
  ...(await orig<typeof import('./ConnectionsTab')>()),
  ConnectionsTab: (p: { runnerId: string; online: boolean; pinnedRunnerFingerprint: string | null }) => {
    useEffect(() => { mounts.n += 1; }, []);
    return <div data-testid="connections-tab" data-runner={p.runnerId} data-online={String(p.online)} data-pin={String(p.pinnedRunnerFingerprint)} />;
  },
}));

vi.mock('./SandboxesTab', () => ({
  SandboxesTab: (p: { runnerId: string; online: boolean; visible: boolean }) => <div data-testid="sandboxes-tab" data-visible={String(p.visible)} data-online={String(p.online)} />,
}));
vi.mock('./LogsTab', () => ({
  LogsTab: (p: { runnerId: string; online: boolean; visible: boolean }) => <div data-testid="logs-tab" data-visible={String(p.visible)} />,
}));
import { HostDetails, type HostTab } from './HostDetails';
import type { RunnerRow } from '../../api';

const runner = (over: Partial<RunnerRow> = {}): RunnerRow => ({
  runnerId: 'r1', name: 'homebox', online: true, lastOnlineAt: new Date(Date.now() - 5 * 60_000).toISOString(), createdAt: '2026-10-01T00:00:00Z', runnerVersion: '0.1.30', ...over,
});
const info = {
  runnerId: 'r1',
  ssh: { target: 'me@box', port: 2222, addedAt: Date.parse('2026-10-20T00:00:00Z'), lastInstallVersion: '0.1.30' },
  pinnedRunnerFingerprint: 'ab12-cd34-ef56-0789',
  laptopFingerprint: '9f8e-7d6c-5b4a-3210',
};

beforeEach(() => { host.mockReset().mockResolvedValue(info); mounts.n = 0; });

function Harness({ runner: r = runner(), initial = 'overview' as HostTab, expanded = true }: { runner?: RunnerRow; initial?: HostTab; expanded?: boolean }) {
  const [tab, setTab] = useState<HostTab>(initial);
  return <HostDetails runner={r} tab={tab} onTab={setTab} expanded={expanded} />;
}

describe('HostDetails', () => {
  it('Overview · Connections · Sandboxes · Logs; no breadcrumb or back button', async () => {
    render(<Harness />);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Connections', 'Sandboxes', 'Logs']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await screen.findByTestId('host-ssh');
  });

  it('Overview: online, version, where it was set up over ssh, and both keys', async () => {
    render(<Harness />);
    const o = screen.getByTestId('host-overview');
    expect(o).toHaveTextContent('Online');
    expect(o).toHaveTextContent('v0.1.30');
    expect(await screen.findByTestId('host-ssh')).toHaveTextContent('me@box:2222');
    expect(host).toHaveBeenCalledWith('r1');
    expect(o).toHaveTextContent('Installed v0.1.30 over ssh');
    expect(screen.getByTestId('host-runner-key')).toHaveTextContent('ab12-cd34-ef56-0789');
    expect(screen.getByTestId('sender-key')).toHaveTextContent('This laptop’s key: 9f8e-7d6c-5b4a-3210');
    expect(o).toHaveTextContent('the runner’s log shows ‘trusted laptop <fingerprint>’');
  });

  it('Overview of an offline, never-trusted runner added by pairing', async () => {
    host.mockResolvedValue({ ...info, ssh: null, pinnedRunnerFingerprint: null });
    render(<Harness runner={runner({ online: false, runnerVersion: null })} />);
    const o = screen.getByTestId('host-overview');
    expect(o).toHaveTextContent('Offline · last seen 5m ago');
    expect(await screen.findByTestId('host-runner-key')).toHaveTextContent('Not trusted yet — the first Connect asks.');
    expect(screen.getByTestId('host-ssh')).toHaveTextContent('Paired with a code');
  });

  it('host info failing still shows what the runner list knows', async () => {
    host.mockRejectedValue(new Error('boom'));
    render(<Harness />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load host details: boom');
    expect(screen.getByTestId('host-overview')).toHaveTextContent('v0.1.30');
  });

  it('Connections opens on request, gets the runner\'s state and pin, and stays mounted across tab switches', async () => {
    render(<Harness runner={runner({ online: false })} initial="connections" />);
    expect(screen.getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'true');
    const tab = await screen.findByTestId('connections-tab');
    expect(tab).toHaveAttribute('data-runner', 'r1');
    expect(tab).toHaveAttribute('data-online', 'false');
    expect(tab).toHaveAttribute('data-pin', 'ab12-cd34-ef56-0789');
    const before = mounts.n;
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.getByTestId('host-overview')).toBeVisible();
    expect(screen.getByTestId('connections-tab')).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(screen.getByTestId('connections-tab')).toBeVisible();
    // Never remounted: a connect in flight keeps its job.
    expect(mounts.n).toBe(before);
  });

  it('Sandboxes and Logs mount on first visit, stay mounted, and are "visible" only while selected and the row is open', async () => {
    const { rerender } = render(<Harness initial="sandboxes" />);
    expect(screen.getByTestId('sandboxes-tab')).toHaveAttribute('data-visible', 'true');
    expect(screen.queryByTestId('logs-tab')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(screen.getByTestId('logs-tab')).toHaveAttribute('data-visible', 'true');
    expect(screen.getByTestId('sandboxes-tab')).toHaveAttribute('data-visible', 'false');
    expect(screen.getByTestId('sandboxes-tab')).not.toBeVisible();
    rerender(<Harness initial="sandboxes" expanded={false} />);
    expect(screen.getByTestId('logs-tab')).toHaveAttribute('data-visible', 'false');
    await vi.waitFor(() => expect(host).toHaveBeenCalled());
  });
});
