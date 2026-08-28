import { useEffect, useRef, useState } from 'react';
import type { Worktree, MergeRequest, MergeRequestChange } from '../types';
import { api } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { invalidateMrPath } from '../hooks/mrSummaries';
import { parseUnifiedDiff } from '../lib/diff';

const STATE_TONE: Record<MergeRequest['state'], string> = {
  open: 'text-emerald-400', merged: 'text-purple-400', closed: 'text-zinc-500',
};
const STATUS_TONE: Record<MergeRequestChange['status'], string> = {
  A: 'text-emerald-400', M: 'text-amber-400', D: 'text-red-400', R: 'text-sky-400',
};

function UnifiedDiff({ diff }: { diff: string }) {
  const parsed = parseUnifiedDiff(diff);
  if (parsed.binary) return <div className="p-3 text-xs text-zinc-500">Binary file — not shown.</div>;
  return (
    <div className="diff-surface diff-code-font text-xs">
      {parsed.hunks.map((h, hi) => (
        <div key={hi} className="diff-hunk mb-3 overflow-hidden rounded border">
          <div className="diff-hunk-header px-2 py-1 text-[11px]">{h.header}</div>
          {h.lines.map((l, li) => (
            <div
              key={li}
              className={`diff-line grid grid-cols-[3rem_3rem_1fr] whitespace-pre ${
                l.kind === 'add' ? 'diff-line-add'
                : l.kind === 'del' ? 'diff-line-del'
                : 'diff-line-context'
              }`}
            >
              <span className="diff-line-number px-2 text-right">{l.oldNo ?? ''}</span>
              <span className="diff-line-number px-2 text-right">{l.newNo ?? ''}</span>
              <span className="px-2">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

type Probe =
  | { kind: 'loading' }
  | { kind: 'needsAuth' }
  | { kind: 'error' }
  | { kind: 'list'; files: MergeRequestChange[] };

export function MrReview({ worktree, mr, onClose }: { worktree: Worktree; mr: MergeRequest; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' });
  const [sel, setSel] = useState<string | null>(null);
  const [merge, setMerge] = useState<'idle' | 'confirm' | 'pending' | 'done'>('idle');
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeNeedsAuth, setMergeNeedsAuth] = useState(false);
  const [mergedMr, setMergedMr] = useState<MergeRequest | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const provider = mr.provider ?? 'gitlab';
  const providerName = provider === 'github' ? 'GitHub' : 'GitLab';
  const effective = mergedMr ?? mr;

  useEffect(() => {
    // StrictMode dev double-invoke runs cleanup once on mount — re-arm
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const startConfirm = () => {
    setMerge('confirm');
    confirmTimer.current = setTimeout(() => setMerge('idle'), 5000);
  };

  const confirmMerge = async () => {
    if (confirmTimer.current) { clearTimeout(confirmTimer.current); confirmTimer.current = null; }
    setMerge('pending');
    setMergeError(null);
    setMergeNeedsAuth(false);
    try {
      const res = await api.worktrees.mergeMergeRequest(wsId, worktree.path, mr.number);
      if (res.kind === 'merged') {
        invalidateMrPath(worktree.path);
        if (!aliveRef.current) return;
        setMergedMr(res.mergeRequest);
        setMerge('done');
      } else if (res.kind === 'needsAuth') {
        if (!aliveRef.current) return;
        setMergeError(`Reconnect ${providerName} to merge.`);
        setMergeNeedsAuth(true);
        setMerge('idle');
      } else {
        if (!aliveRef.current) return;
        setMergeError('This worktree no longer maps to a provider — refresh and retry.');
        setMerge('idle');
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setMergeError(e instanceof Error ? e.message : String(e));
      setMerge('idle');
    }
  };

  useEffect(() => {
    let alive = true;
    setProbe({ kind: 'loading' });
    api.worktrees.mergeRequestChanges(wsId, worktree.path, mr.number)
      .then((r) => {
        if (!alive) return;
        if (r.kind === 'list') { setProbe({ kind: 'list', files: r.files }); setSel(r.files[0]?.path ?? null); }
        else if (r.kind === 'needsAuth') setProbe({ kind: 'needsAuth' });
        else setProbe({ kind: 'list', files: [] });
      })
      .catch(() => { if (alive) setProbe({ kind: 'error' }); });
    return () => { alive = false; };
  }, [wsId, worktree.path, mr.number]);

  const openExternal = () => {
    const bridge = window.strado;
    if (bridge?.preview) void bridge.preview('open-external', worktree.path, { url: mr.webUrl });
    else window.open(mr.webUrl, '_blank', 'noopener');
  };
  const selected = probe.kind === 'list' ? probe.files.find((f) => f.path === sel) : undefined;
  const effectiveTargetBranch = mergedMr?.targetBranch ?? mr.targetBranch;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-zinc-950">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
        <button
          onClick={openExternal}
          title={`Open in ${providerName}`}
          className="shrink-0 font-mono text-sky-400 hover:underline"
        >{provider === 'github' ? '#' : '!'}{mr.number}</button>
        <span className={`uppercase ${STATE_TONE[effective.state]}`}>{effective.state}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-200">{mr.title}</span>
        {(mr.author || fmtDate(mr.createdAt) || fmtDate(effective.mergedAt)) && (
          <span className="hidden shrink-0 text-xs text-zinc-500 md:block">
            {mr.author && <>by <span className="text-zinc-300">{mr.author}</span></>}
            {fmtDate(mr.createdAt) && <span title={mr.createdAt ?? undefined}> · raised {fmtDate(mr.createdAt)}</span>}
            {fmtDate(effective.mergedAt) && <span title={effective.mergedAt ?? undefined}> · merged {fmtDate(effective.mergedAt)}</span>}
          </span>
        )}
        {effectiveTargetBranch && (
          <span
            className="hidden shrink-0 items-center gap-1 font-mono text-xs text-zinc-500 sm:flex"
            title={`${mr.sourceBranch} → ${effectiveTargetBranch}`}
          >
            <span className="max-w-48 truncate">{mr.sourceBranch}</span>
            <span className="text-zinc-600">→</span>
            <span className="max-w-32 truncate text-zinc-400">{effectiveTargetBranch}</span>
          </span>
        )}
        {mergeError && (
          <span className="flex min-w-0 shrink-0 items-center gap-2">
            <span className="max-w-40 truncate text-xs text-red-400" title={mergeError}>{mergeError}</span>
            {mergeNeedsAuth && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('strado:open-settings', { detail: { section: provider } }))}
                className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700"
              >Connect {providerName}</button>
            )}
          </span>
        )}
        {effective.state === 'open' && (
          merge === 'pending' ? (
            <button disabled className="shrink-0 cursor-not-allowed rounded bg-emerald-700/60 px-2 py-0.5 text-xs text-white">Merging…</button>
          ) : merge === 'confirm' ? (
            <button onClick={() => void confirmMerge()} className="shrink-0 rounded bg-amber-700 px-2 py-0.5 text-xs text-white hover:bg-amber-600">Confirm merge?</button>
          ) : (
            <button onClick={startConfirm} className="shrink-0 rounded bg-emerald-700 px-2 py-0.5 text-xs text-white hover:bg-emerald-600">Merge</button>
          )
        )}
        <button onClick={onClose} aria-label="Close review" className="shrink-0 rounded px-1.5 text-zinc-500 hover:text-zinc-200">✕</button>
      </div>
      {probe.kind === 'loading' ? (
        <div className="p-4 text-xs text-zinc-600">Loading…</div>
      ) : probe.kind === 'needsAuth' ? (
        <div className="p-4 text-xs text-zinc-400">
          Reconnect {providerName} to view this diff.
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('strado:open-settings', { detail: { section: provider } }))}
            className="ml-2 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700"
          >Connect {providerName}</button>
        </div>
      ) : probe.kind === 'error' ? (
        <div className="p-4 text-xs text-red-300">Couldn't load the diff.</div>
      ) : probe.files.length === 0 ? (
        <div className="p-4 text-xs text-zinc-600">No file changes.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-auto border-r border-zinc-800 p-1">
            {probe.files.map((f) => (
              <button
                key={f.path}
                onClick={() => setSel(f.path)}
                title={f.path}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                  sel === f.path ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'
                }`}
              >
                <span className={`w-3 shrink-0 font-mono ${STATUS_TONE[f.status]}`}>{f.status}</span>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto p-3">
            {!selected ? (
              <div className="text-xs text-zinc-600">Select a file</div>
            ) : selected.truncated || !selected.diff ? (
              <div className="text-xs text-zinc-500">
                Diff too large or binary —{' '}
                <button onClick={openExternal} className="underline">open in {providerName}</button>.
              </div>
            ) : (
              <UnifiedDiff diff={selected.diff} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
