// One runner's details, shown in place under its row in Settings → Runners:
// an Overview of what the laptop already knows about it, its Connections, its
// Sandboxes and its own Logs.
// The tab is the caller's (a deep link picks it). Both panels stay mounted
// once seen, so a connect in flight survives a tab switch.
import { useEffect, useState, type ReactNode } from 'react';
import { api, type RunnerRow } from '../../api';
import type { HostInfo } from '../../types';
import { SenderKeyLine } from '../settings/CommandBoxSection';
import { ConnectionsTab, ago } from './ConnectionsTab';
import { LogsTab } from './LogsTab';
import { SandboxesTab } from './SandboxesTab';

export type HostTab = 'overview' | 'connections' | 'sandboxes' | 'logs';
const TABS: { id: HostTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connections', label: 'Connections' },
  { id: 'sandboxes', label: 'Sandboxes' },
  { id: 'logs', label: 'Logs' },
];

export function HostDetails({ runner, tab, onTab, expanded = true }: {
  runner: RunnerRow;
  tab: HostTab;
  onTab: (tab: HostTab) => void;
  /** The row is open: Sandboxes and Logs poll only while on screen. */
  expanded?: boolean;
}) {
  // undefined while loading; null when it failed (the details still show the row's facts).
  const [info, setInfo] = useState<HostInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<HostTab>>(() => new Set([tab]));
  useEffect(() => { setSeen((s) => (s.has(tab) ? s : new Set([...s, tab]))); }, [tab]);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.runners.host(runner.runnerId))
      .then((h) => { if (live) setInfo(h); })
      .catch((err: Error) => { if (live) { setInfo(null); setError(err.message); } });
    return () => { live = false; };
  }, [runner.runnerId]);

  return (
    <div className="flex flex-col gap-3" data-testid={`host-details-${runner.runnerId}`}>
      <div role="tablist" aria-label={`${runner.name} details`} className="flex gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs ${tab === t.id ? 'border-zinc-200 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-amber-300">Couldn’t load host details: {error}</p>}
      <div hidden={tab !== 'overview'}>{seen.has('overview') && <Overview runner={runner} info={info} />}</div>
      <div hidden={tab !== 'connections'}>
        {seen.has('connections') && info !== undefined && (
          <ConnectionsTab runnerId={runner.runnerId} online={runner.online} pinnedRunnerFingerprint={info?.pinnedRunnerFingerprint ?? null} />
        )}
      </div>
      <div hidden={tab !== 'sandboxes'}>
        {seen.has('sandboxes') && <SandboxesTab runnerId={runner.runnerId} online={runner.online} visible={expanded && tab === 'sandboxes'} />}
      </div>
      <div hidden={tab !== 'logs'}>
        {seen.has('logs') && <LogsTab runnerId={runner.runnerId} online={runner.online} visible={expanded && tab === 'logs'} />}
      </div>
    </div>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex gap-3 py-1.5 text-xs">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-zinc-200" data-testid={testId}>{children}</dd>
    </div>
  );
}

function Overview({ runner, info }: { runner: RunnerRow; info: HostInfo | null | undefined }) {
  const seen = runner.lastOnlineAt ? ago(Date.parse(runner.lastOnlineAt)) : 'never';
  const ssh = info?.ssh;
  return (
    <dl className="flex flex-col divide-y divide-zinc-900" data-testid="host-overview">
      <Fact label="Status">{runner.online ? 'Online' : `Offline · last seen ${seen}`}</Fact>
      <Fact label="Version">{runner.runnerVersion ? `v${runner.runnerVersion}` : 'Unknown'}</Fact>
      <Fact label="Added">{new Date(runner.createdAt).toLocaleDateString()}</Fact>
      {info !== undefined && (
        <Fact label="Set up" testId="host-ssh">
          {ssh ? (
            <>
              <code className="font-mono">{ssh.target}{ssh.port ? `:${ssh.port}` : ''}</code>
              {ssh.lastInstallVersion && <span className="text-zinc-500"> · Installed v{ssh.lastInstallVersion} over ssh</span>}
            </>
          ) : 'Paired with a code'}
        </Fact>
      )}
      {info !== undefined && (
        <Fact label="Runner key" testId="host-runner-key">
          {info?.pinnedRunnerFingerprint
            ? <code className="font-mono">{info.pinnedRunnerFingerprint}</code>
            : <span className="text-zinc-500">Not trusted yet — the first Connect asks.</span>}
        </Fact>
      )}
      {info?.laptopFingerprint && (
        <Fact label="This laptop">
          <SenderKeyLine fingerprint={info.laptopFingerprint} />
          <p className="text-[10px] text-zinc-600">After the first Connect, the runner’s log shows ‘trusted laptop &lt;fingerprint&gt;’ — they should match.</p>
        </Fact>
      )}
    </dl>
  );
}
