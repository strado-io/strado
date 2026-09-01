import { money, percent, tokens } from './format';
import type { UsageModelRow, UsageWorktreeRow } from '../../types';

const AGENT_DOT: Record<'claude' | 'codex', string> = {
  claude: 'bg-orange-500',
  codex: 'bg-sky-400',
};

const HEAD = 'text-[11px] font-normal text-zinc-600';
const CELL = 'py-1.5 font-mono text-[11px] tabular-nums text-zinc-300';

/** Cost per model, ranked, with the agent it belongs to. */
export function ModelTable({ rows }: { rows: UsageModelRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-zinc-900 text-left">
          <th className={HEAD}>Model</th>
          <th className={`${HEAD} text-right`}>Cost</th>
          <th className={`${HEAD} text-right`}>Share</th>
          <th className={`${HEAD} text-right`}>Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-zinc-900/60 last:border-0">
            <td className="py-1.5 pr-2 text-[11px] text-zinc-300">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_DOT[row.agent]}`} />
                <span className="truncate">{row.id}</span>
                {!row.priced && (
                  <span
                    title="No published price for this model, so its cost is not counted"
                    className="shrink-0 text-[10px] text-zinc-600"
                  >
                    unpriced
                  </span>
                )}
              </span>
            </td>
            <td className={`${CELL} text-right`}>{money(row.cost)}</td>
            <td className={`${CELL} text-right text-zinc-500`}>{percent(row.share)}</td>
            <td className={`${CELL} text-right text-zinc-500`}>{tokens(row.tokens)}</td>
          </tr>
        ))}
        {rows.length > 1 && (
          <tr>
            <td className="py-1.5 text-[11px] text-zinc-500">Total</td>
            <td className={`${CELL} text-right text-zinc-200`}>{money(total)}</td>
            <td className={`${CELL} text-right text-zinc-500`}>100%</td>
            <td className={`${CELL} text-right text-zinc-500`}>
              {tokens(rows.reduce((sum, row) => sum + row.tokens, 0))}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Cost per worktree, with an inline bar so the top consumers stand out. */
export function WorktreeTable({ rows }: { rows: UsageWorktreeRow[] }) {
  const peak = rows.reduce((highest, row) => Math.max(highest, row.cost), 0);
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-zinc-900 text-left">
          <th className={HEAD}>Worktree</th>
          <th className={`${HEAD} text-right`}>Tokens</th>
          <th className={`${HEAD} text-right`}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path ?? row.label} className="border-b border-zinc-900/60 last:border-0">
            <td className="min-w-0 py-1.5 pr-2">
              <div className="truncate text-[11px] text-zinc-300" title={row.path ?? undefined}>{row.label}</div>
              <div
                aria-hidden
                className="mt-1 h-[2px] rounded-full bg-zinc-700"
                style={{ width: `${peak > 0 ? Math.max(2, (row.cost / peak) * 100) : 2}%` }}
              />
            </td>
            <td className={`${CELL} text-right text-zinc-500`}>{tokens(row.tokens)}</td>
            <td className={`${CELL} text-right`}>{money(row.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
