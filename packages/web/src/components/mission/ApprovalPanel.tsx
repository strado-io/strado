import { useEffect, useRef, useState } from 'react';
import { clampLines } from './tone';

export type ApprovalKind = 'command' | 'file-change' | 'file-read' | 'web' | 'tool';
export type PendingApproval = { id: string; agentId: string; agentName: string; kind: ApprovalKind; title: string; detail: string; createdAt: number };
/** 'gone': the agent's own tab answered first. */
export type ApprovalOutcome = 'ok' | 'gone';

const VERB: Record<ApprovalKind, string> = {
  command: 'run a command', 'file-change': 'change files', 'file-read': 'read a file', web: 'fetch from the web', tool: 'use a tool',
};
const GONE_MS = 1_200;
const DETAIL_LINES = 4;

/** An agent's permission request, mirrored above the box input. Only a
 * human click answers it; the tab's own dialog stays up, and whichever
 * answers first wins. */
export function ApprovalPanel({ approvals, onDecide, onOpen }: {
  approvals: PendingApproval[];
  onDecide: (id: string, decision: 'allow' | 'deny') => Promise<ApprovalOutcome>;
  onOpen: (agentId: string) => void;
}) {
  // Answered here: hidden at once, before the feed catches up.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const [gone, setGone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const open = approvals.filter((x) => !answered.has(x.id));
  const i = Math.min(index, Math.max(0, open.length - 1));
  const cur = open[i];
  if (gone) {
    return <div role="status" className="mx-2 mb-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">answered in the tab ✓</div>;
  }
  if (!cur) return null;

  const step = (d: number) => { setError(null); setIndex((i + d + open.length) % open.length); };
  const decide = async (decision: 'allow' | 'deny') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onDecide(cur.id, decision);
      setAnswered((s) => new Set(s).add(cur.id));
      if (r === 'gone') {
        setGone(cur.id);
        timer.current = setTimeout(() => setGone(null), GONE_MS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const header = `${cur.agentName} wants to ${VERB[cur.kind] ?? VERB.tool}`;
  return (
    <div
      role="group"
      aria-label={header}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (open.length < 2) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      }}
      className="mx-2 mb-1 rounded-md border border-amber-500/50 bg-zinc-900 px-3 py-2 text-xs text-zinc-200"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-amber-200">{header}</span>
        {cur.title && <span className="truncate text-zinc-500">{cur.title}</span>}
        {open.length > 1 && (
          <span className="ml-auto flex items-center gap-1 text-zinc-500">
            <button type="button" aria-label="Previous approval" onClick={() => step(-1)} className="rounded px-1 hover:bg-zinc-800">←</button>
            <span>{i + 1}/{open.length}</span>
            <button type="button" aria-label="Next approval" onClick={() => step(1)} className="rounded px-1 hover:bg-zinc-800">→</button>
          </span>
        )}
      </div>
      <pre data-testid="approval-detail" className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-300">{clampLines(cur.detail, DETAIL_LINES)}</pre>
      {error && <div role="alert" className="mt-1 text-red-300">{error}</div>}
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void decide('deny')} className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-50">Deny</button>
        <button type="button" disabled={busy} onClick={() => void decide('allow')} className="rounded bg-amber-500/90 px-2 py-0.5 font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50">Approve</button>
        <button type="button" onClick={() => onOpen(cur.agentId)} className="ml-auto text-zinc-400 hover:text-zinc-200">Open tab ↗</button>
      </div>
    </div>
  );
}
