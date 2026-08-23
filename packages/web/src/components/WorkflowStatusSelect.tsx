import type { WorkflowStatus } from '../types';

export const WORKFLOW_STATUSES: { value: WorkflowStatus; label: string }[] = [
  { value: 'todo', label: 'TODO' },
  { value: 'in_progress', label: 'IN PROGRESS' },
  { value: 'ready_for_qa', label: 'READY FOR QA' },
  { value: 'retest_failed', label: 'RETEST FAILED' },
  { value: 'verified', label: 'VERIFIED' },
  { value: 'done', label: 'DONE' },
];

// Terminal states (verified/done) go quiet — filled chips are reserved for
// statuses that still need someone.
const STYLE: Record<WorkflowStatus, string> = {
  todo: 'bg-zinc-800 text-zinc-300',
  in_progress: 'bg-blue-950/70 text-blue-300',
  ready_for_qa: 'bg-amber-950/60 text-amber-300',
  retest_failed: 'bg-red-950/70 text-red-300',
  verified: 'bg-transparent text-emerald-600/80 hover:bg-zinc-900',
  done: 'bg-transparent text-zinc-500 hover:bg-zinc-900',
};

const GHOST = 'bg-transparent text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300';

export function WorkflowStatusSelect({
  value,
  onChange,
}: {
  value: WorkflowStatus | null;
  onChange: (status: WorkflowStatus | null) => void;
}) {
  const cls = value ? STYLE[value] : GHOST;
  return (
    <select
      aria-label="Workflow status"
      title="Workflow status"
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '') return;
        onChange(v === '__none__' ? null : (v as WorkflowStatus));
      }}
      className={`h-6 w-full max-w-[120px] cursor-pointer rounded px-1.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      <option value="" disabled hidden>
        Status
      </option>
      {WORKFLOW_STATUSES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
      <option value="__none__">— None</option>
    </select>
  );
}
