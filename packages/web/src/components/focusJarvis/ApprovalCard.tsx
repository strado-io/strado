import type { ChatEntry } from '../../types';

type Approval = Extract<ChatEntry, { type: 'approval' }>;
const SETTLED: Record<Approval['state'], string> = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', superseded: 'Skipped' };

/** Something Jarvis wants to do that needs a yes first: exactly what will
 * happen, then Approve / No. Red when the action can't be undone. */
export function ApprovalCard({ entry, onApprove }: { entry: Approval; onApprove: (entryId: string, approve: boolean) => void }) {
  const danger = Boolean(entry.danger);
  const pending = entry.state === 'pending';
  return (
    <div data-testid="approval-card" data-danger={danger}
      className={`rounded-xl border px-3 py-2.5 ${danger ? 'border-red-500/40 bg-red-500/10' : 'glass pane-card'}`}>
      <div className="text-[13px] text-zinc-100">{entry.summary}</div>
      {entry.danger && <div className="mt-0.5 text-[12px] text-red-300">{entry.danger}</div>}
      {pending ? (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => onApprove(entry.id, true)}
            className={`rounded-md px-3 py-1 text-[12px] font-medium ${danger ? 'bg-red-500/80 text-white hover:bg-red-500' : 'bg-zinc-100 text-zinc-900 hover:bg-white'}`}>Approve</button>
          <button type="button" onClick={() => onApprove(entry.id, false)}
            className="rounded-md px-3 py-1 text-[12px] text-zinc-300 hover:bg-white/10">No</button>
        </div>
      ) : (
        <div className="mt-1 text-[12px] text-zinc-500">
          {SETTLED[entry.state]}{entry.result ? ` · ${entry.result}` : ''}
        </div>
      )}
    </div>
  );
}
