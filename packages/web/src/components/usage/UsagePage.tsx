import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useUsage, type UsageRange } from '../../hooks/usage';
import type { MachineSample } from '../../types';
import { AccountCard, AGENT_NAME } from './AccountCard';
import { ModelTable, WorktreeTable } from './BreakdownTables';
import { MachineResources } from './MachineResources';
import { StatStrip } from './StatStrip';
import { UsageChart } from './UsageChart';
import type { ChartMetric } from './chartGeometry';
import { money, percent, shortDate, tokens } from './format';

type Tab = 'tokens' | 'machine';

const RANGES: UsageRange[] = [7, 30, 90];

function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 rounded-md bg-zinc-900 p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded px-2 py-0.5 text-[11px] ${
            option.value === value ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >{option.label}</button>
      ))}
    </div>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">{children}</span>
);

/**
 * Usage across every agent on this machine: quota per account, then priced
 * token history from the agents' own session logs.
 *
 * Costs are estimates at full API rate — subscription plans do not bill per
 * token — so every figure here is labelled rather than presented as an invoice.
 */
export function UsagePage({ wsId, sidebarCollapsed, onExpandSidebar, runningServers }: {
  wsId: string;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  runningServers?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('tokens');
  const [days, setDays] = useState<UsageRange>(30);
  const [metric, setMetric] = useState<ChartMetric>('cost');
  const [hideEmails, setHideEmails] = useState(false);
  const [machine, setMachine] = useState<MachineSample | null>(null);
  const { summary, accounts, loading, refreshing, error, refresh } = useUsage(wsId, days);

  useEffect(() => {
    if (tab !== 'machine') return;
    let alive = true;
    api.usage?.machine(wsId).then((sample) => { if (alive) setMachine(sample); }).catch(() => {
      if (alive) setMachine(null);
    });
    return () => { alive = false; };
  }, [tab, wsId, refreshing]);

  const totals = summary?.totals;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-900 bg-zinc-950 px-3 py-2">
        {sidebarCollapsed && (
          <button
            aria-label="Open sidebar"
            title="Open sidebar (⌘B)"
            onClick={() => onExpandSidebar?.()}
            className="-ml-1 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >»</button>
        )}
        <Segmented
          label="Usage view"
          value={tab}
          onChange={setTab}
          options={[{ value: 'tokens', label: 'Token usage' }, { value: 'machine', label: 'Machine resources' }]}
        />
        <div className="ml-auto flex items-center gap-2">
          {runningServers}
          <button
            type="button"
            onClick={() => setHideEmails((value) => !value)}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          >{hideEmails ? 'Show emails' : 'Hide emails'}</button>
          <button
            type="button"
            aria-label="Refresh usage"
            title="Refresh usage"
            onClick={refresh}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
          >
            {refreshing ? (
              <span role="status" aria-label="Refreshing usage" className="braille-spinner text-[12px] leading-none" />
            ) : '↻'}
          </button>
        </div>
      </div>

      {tab === 'machine' ? (
        <div className="px-3 py-3">
          <MachineResources sample={machine} />
        </div>
      ) : (
        <div className="flex flex-col gap-5 px-3 py-3">
          {error && (
            <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-[11px] text-red-300">
              {error}
            </p>
          )}

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <SectionLabel>Accounts</SectionLabel>
              <span className="text-[11px] text-zinc-600">Vendor-reported quota · refreshes every 5 min</span>
            </div>
            {accounts.length === 0 ? (
              <p className="text-[11px] text-zinc-600">
                {loading ? 'Reading agent credentials…' : 'No agent signed in on this machine.'}
              </p>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {accounts.map((account) => (
                  <div key={`${account.agent}:${account.accountLabel}`} className="flex flex-col gap-1">
                    <span className="text-[11px] text-zinc-500">{AGENT_NAME[account.agent]}</span>
                    <AccountCard account={account} hideEmails={hideEmails} />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SectionLabel>Token usage</SectionLabel>
              {summary && (
                <span className="text-[11px] text-zinc-600">
                  {shortDate(summary.range.from)} – {shortDate(summary.range.to)} · from local session logs
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Segmented
                  label="Chart metric"
                  value={metric}
                  onChange={setMetric}
                  options={[{ value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }]}
                />
                <Segmented
                  label="Date range"
                  value={days}
                  onChange={setDays}
                  options={RANGES.map((range) => ({ value: range, label: `${range}d` }))}
                />
              </div>
            </div>

            {loading && !summary ? (
              <p className="py-8 text-sm text-zinc-500">Reading session logs…</p>
            ) : !summary || summary.totals.tokens === 0 ? (
              <p className="py-8 text-sm text-zinc-500">
                No agent turns in this window. Run Claude Code or Codex in a worktree and usage lands here.
              </p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
                <div>
                  <div className="font-mono text-2xl tabular-nums text-zinc-100">
                    {money(summary.totals.cost)}<span className="text-zinc-500">*</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-600">* if billed at full API rate</p>
                  <p className="text-[11px] text-emerald-500">Cost to you: covered by your plans</p>
                  <ul className="mt-3 flex flex-col gap-1">
                    {(['claude', 'codex'] as const).map((agent) => (
                      <li key={agent} className="flex items-center gap-2 text-[11px]">
                        <span
                          aria-hidden
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${agent === 'claude' ? 'bg-orange-500' : 'bg-sky-400'}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-zinc-400">{AGENT_NAME[agent]}</span>
                        <span className="font-mono tabular-nums text-zinc-300">
                          {metric === 'cost' ? money(summary.byAgent[agent].cost) : tokens(summary.byAgent[agent].tokens)}
                        </span>
                        <span className="w-9 text-right font-mono tabular-nums text-zinc-600">
                          {percent(summary.totals.cost > 0
                            ? (summary.byAgent[agent].cost / summary.totals.cost) * 100
                            : 0)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <UsageChart series={summary.series} metric={metric} />
              </div>
            )}

            {totals && totals.tokens > 0 && <StatStrip totals={totals} />}
          </section>

          {summary && summary.models.length > 0 && (
            <section className="grid gap-5 lg:grid-cols-2">
              <div className="min-w-0">
                <ModelTable rows={summary.models} />
              </div>
              <div className="min-w-0">
                <WorktreeTable rows={summary.worktrees} />
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
