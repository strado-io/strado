import { QuotaBar } from './QuotaBar';
import { measurementAge } from './format';
import type { UsageAccount } from '../../types';

const AGENT_NAME: Record<'claude' | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const AGENT_DOT: Record<'claude' | 'codex', string> = {
  claude: 'bg-sky-500',
  codex: 'bg-blue-400',
};

/** Masks the local part of an email: `k•••@fleetx.io`. */
function maskEmail(label: string): string {
  const at = label.indexOf('@');
  if (at <= 0) return label;
  return `${label[0]}•••${label.slice(at)}`;
}

/**
 * One signed-in agent account: who it is, which plan, and where its credential
 * lives, above a bar per rate-limit window.
 */
export function AccountCard({ account, hideEmails }: { account: UsageAccount; hideEmails: boolean }) {
  const age = measurementAge(account.measuredAt);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[account.agent]}`} />
        <span className="truncate text-xs text-zinc-200">
          {hideEmails ? maskEmail(account.accountLabel) : account.accountLabel}
        </span>
        {account.plan && (
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-[1px] text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            {account.plan}
          </span>
        )}
        {age && (
          <span
            className="ml-auto shrink-0 text-[10px] text-zinc-600"
            title="These limits were last reported by the agent at this time"
          >{age}</span>
        )}
        <span className={`${age ? '' : 'ml-auto '}shrink-0 font-mono text-[10px] text-zinc-600`}>
          {account.credentialSource}
        </span>
      </div>
      <div className="px-3 py-1.5">
        {account.quotaStatus === 'official' ? (
          account.windows.map((quotaWindow) => (
            <QuotaBar key={quotaWindow.label} window={quotaWindow} agent={account.agent} />
          ))
        ) : (
          <p className="py-1 text-[11px] text-zinc-600">
            Quota unavailable — {AGENT_NAME[account.agent]} did not report its limits. Cost below still counts every
            local session.
          </p>
        )}
      </div>
    </div>
  );
}

export { AGENT_NAME };
