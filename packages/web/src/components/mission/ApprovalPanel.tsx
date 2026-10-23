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
const QUESTION_LINES = 8;
const VALUE_MAX = 160;

type Shown = { header: string; tool: string | null; body: string; prose: boolean; question: boolean };

/** What the card says: a question as its question and options, a tool's JSON
 * input as `key: value` lines, anything else as it came. Never raw JSON. */
export function describeApproval(cur: PendingApproval): Shown {
  const tool = cur.title.replace(/^use /, '') || null;
  const verb = `${cur.agentName} wants to ${VERB[cur.kind] ?? VERB.tool}`;
  let input: unknown = null;
  try { input = JSON.parse(cur.detail); } catch { /* plain text */ }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { header: verb, tool, body: clampLines(cur.detail, DETAIL_LINES), prose: false, question: false };
  }
  const o = input as Record<string, unknown>;
  if (tool === 'AskUserQuestion' && Array.isArray(o.questions)) {
    const qs = (o.questions as { question?: unknown; options?: { label?: unknown }[] }[]).map((q) => {
      const opts = Array.isArray(q.options) ? q.options.map((x, n) => `${n + 1}. ${String(x?.label ?? '')}`) : [];
      return [String(q.question ?? ''), ...opts].join('\n');
    });
    return { header: `${cur.agentName} has a question`, tool: null, body: clampLines(qs.join('\n\n'), QUESTION_LINES), prose: true, question: true };
  }
  const short = (v: unknown) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > VALUE_MAX ? `${t.slice(0, VALUE_MAX)}…` : t;
  };
  const lines = Object.entries(o).map(([k, v]) => `${k}: ${short(v)}`);
  return { header: verb, tool, body: clampLines(lines.join('\n'), DETAIL_LINES), prose: false, question: false };
}

const BTN = 'flex h-7 items-center rounded-md px-2.5 text-[12px] transition-colors disabled:opacity-50';

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
    return <div role="status" className="tab-bar mx-2 mb-1.5 rounded-[13px] px-3 py-2 text-[12px] text-zinc-400">answered in the tab ✓</div>;
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

  const shown = describeApproval(cur);
  return (
    <div
      role="group"
      aria-label={shown.header}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (open.length < 2) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      }}
      className="approval-card mx-2 mb-1.5 rounded-[13px] px-3 py-2.5 text-[12px] text-zinc-200"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_8px_rgb(251_191_36/0.7)]" />
        <span className="truncate text-[13px] font-medium text-zinc-100">{shown.header}</span>
        {shown.tool && <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">{shown.tool}</span>}
        {open.length > 1 && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-zinc-500">
            <button type="button" aria-label="Previous approval" onClick={() => step(-1)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/[0.06] hover:text-zinc-200">←</button>
            <span className="tabular-nums">{i + 1}/{open.length}</span>
            <button type="button" aria-label="Next approval" onClick={() => step(1)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/[0.06] hover:text-zinc-200">→</button>
          </span>
        )}
      </div>
      <pre
        data-testid="approval-detail"
        className={`mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-white/[0.06] bg-black/30 px-2.5 py-2 ${
          shown.prose ? 'font-sans text-[13px] leading-relaxed text-zinc-200' : 'font-mono text-[11.5px] leading-relaxed text-zinc-300'
        }`}
      >{shown.body}</pre>
      {error && <div role="alert" className="mt-1.5 text-red-300">{error}</div>}
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" disabled={busy} onClick={() => void decide('deny')} className={`${BTN} border border-white/10 text-zinc-300 hover:bg-white/[0.06]`}>Deny</button>
        <button type="button" disabled={busy} onClick={() => void decide('allow')} className={`${BTN} bg-amber-400 font-medium text-zinc-950 hover:bg-amber-300`}>Approve</button>
        <button type="button" onClick={() => onOpen(cur.agentId)} className={`${BTN} ml-auto text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100`}>
          {shown.question ? 'Answer in tab ↗' : 'Open tab ↗'}
        </button>
      </div>
    </div>
  );
}
