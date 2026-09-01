import { useEffect, useRef, useState } from 'react';
import { useQuotaAccounts } from '../../hooks/usage';
import type { UsageAccount, UsageQuotaWindow } from '../../types';
import { AccountCard, AGENT_NAME } from './AccountCard';
import { percent, untilReset } from './format';

/** The window closest to its limit across every account that reports one. */
export function tightestWindow(accounts: UsageAccount[]): { account: UsageAccount; window: UsageQuotaWindow } | null {
  let tightest: { account: UsageAccount; window: UsageQuotaWindow } | null = null;
  for (const account of accounts) {
    if (account.quotaStatus !== 'official') continue;
    for (const window of account.windows) {
      if (!tightest || window.usedPercent > tightest.window.usedPercent) tightest = { account, window };
    }
  }
  return tightest;
}

/** Quiet until a limit is worth noticing, then amber, then red. */
export function ringTone(used: number): string {
  if (used >= 90) return 'text-red-400';
  if (used >= 70) return 'text-amber-400';
  return 'text-zinc-400';
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A dial in the worktree toolbar: how close the nearest agent limit is, without
 * leaving the tab. Clicking it opens the same quota cards the Usage page shows.
 */
export function QuotaCircle({ wsId, onOpenUsage }: { wsId: string; onOpenUsage?: () => void }) {
  const accounts = useQuotaAccounts(wsId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // No agent signed in, or none reporting a limit: the toolbar stays as it was.
  const tightest = tightestWindow(accounts);
  if (!tightest) return null;

  const used = Math.max(0, Math.min(100, tightest.window.usedPercent));
  const reset = untilReset(tightest.window.resetsAt);
  // 'now' reads as a moment, not a duration: "resets now", never "resets in now".
  const resetPhrase = reset ? (reset === 'now' ? ', resets now' : `, resets in ${reset}`) : '';
  const label = `${AGENT_NAME[tightest.account.agent]} ${tightest.window.label.toLowerCase()} `
    + `${percent(used)} used${resetPhrase}`;

  return (
    <div ref={ref} className="relative shrink-0 self-start">
      <button
        type="button"
        aria-label={`Agent usage — ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-[26px] w-[26px] items-center justify-center rounded-md border transition ${
          open ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={ringTone(used)}>
          <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-800" />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            // Drawn from twelve o'clock, clockwise, like a dial.
            strokeDashoffset={CIRCUMFERENCE * (1 - used / 100)}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Agent usage"
          className="absolute right-0 top-full z-40 mt-1 w-[360px] rounded-lg border border-zinc-800 bg-zinc-950 p-2 shadow-2xl"
        >
          <div className="mb-1.5 flex items-baseline justify-between px-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Agent usage</span>
            <span className="text-[10px] text-zinc-600">vendor-reported</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {accounts.map((account) => (
              <div key={`${account.agent}:${account.accountLabel}`}>
                <span className="px-1 text-[10px] text-zinc-500">{AGENT_NAME[account.agent]}</span>
                <AccountCard account={account} hideEmails={false} />
              </div>
            ))}
          </div>
          {onOpenUsage && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenUsage();
              }}
              className="mt-1.5 w-full rounded-md px-2 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            >Open usage →</button>
          )}
        </div>
      )}
    </div>
  );
}
