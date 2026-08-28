import { useEffect, useRef, useState } from 'react';
import type { Worktree, MergeRequest, MergeRequestChange } from '../types';
import { api } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { invalidateMrPath } from '../hooks/mrSummaries';
import { PrStateIcon } from './sidebar/prVisuals';
import { ChangedFiles, type LineJump } from './ChangedFiles';
import { ReviewConversation, type DiscussionProbe, type ReviewSubmission } from './ReviewConversation';
import { ReviewCommits, type CommitsProbe } from './ReviewCommits';

const STATE_TONE: Record<MergeRequest['state'], string> = {
  open: 'text-emerald-400', merged: 'text-purple-400', closed: 'text-zinc-500',
};
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
  const [discussion, setDiscussion] = useState<DiscussionProbe>({ kind: 'loading' });
  const [discussionSeq, setDiscussionSeq] = useState(0);
  const [commits, setCommits] = useState<CommitsProbe>({ kind: 'loading' });
  // The file a new line comment belongs to — ChangedFiles owns the selection.
  const [selectedFile, setSelectedFile] = useState<MergeRequestChange | null>(null);
  const [jumpTo, setJumpTo] = useState<LineJump | undefined>();
  const [tab, setTab] = useState<'conversation' | 'commits' | 'files'>('files');
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
        window.dispatchEvent(new Event('strado:code-reviews-changed'));
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
        if (r.kind === 'list') setProbe({ kind: 'list', files: r.files });
        else if (r.kind === 'needsAuth') setProbe({ kind: 'needsAuth' });
        else setProbe({ kind: 'list', files: [] });
      })
      .catch(() => { if (alive) setProbe({ kind: 'error' }); });
    return () => { alive = false; };
  }, [wsId, worktree.path, mr.number]);

  // Fetched alongside the diff rather than on tab switch, so the tab can
  // carry a comment count and the panel is ready when it is opened.
  useEffect(() => {
    let alive = true;
    setDiscussion({ kind: 'loading' });
    api.worktrees.mergeRequestDiscussion(wsId, worktree.path, mr.number)
      .then((r) => {
        if (!alive) return;
        if (r.kind === 'discussion') setDiscussion({ kind: 'ready', discussion: r.discussion });
        else if (r.kind === 'needsAuth') setDiscussion({ kind: 'needsAuth' });
        else setDiscussion({ kind: 'ready', discussion: { description: null, comments: [], anchor: null } });
      })
      .catch(() => { if (alive) setDiscussion({ kind: 'error' }); });
    return () => { alive = false; };
  }, [wsId, worktree.path, mr.number, discussionSeq]);

  // Throws on failure so the composer can surface the provider's own words.
  const submitReview = async (input: ReviewSubmission) => {
    const res = await api.worktrees.postMergeRequestReview(wsId, worktree.path, mr.number, input);
    if (res.kind === 'needsAuth') throw new Error(`Reconnect ${providerName} to post.`);
    if (res.kind === 'absent') throw new Error('This worktree no longer maps to a provider — refresh and retry.');
    if (!aliveRef.current) return;
    setDiscussionSeq((seq) => seq + 1);
    // An approval changes the count the review list renders.
    if (input.event !== 'comment') window.dispatchEvent(new Event('strado:code-reviews-changed'));
  };

  useEffect(() => {
    let alive = true;
    setCommits({ kind: 'loading' });
    api.worktrees.mergeRequestCommits(wsId, worktree.path, mr.number)
      .then((r) => {
        if (!alive) return;
        if (r.kind === 'list') setCommits({ kind: 'list', commits: r.commits });
        else if (r.kind === 'needsAuth') setCommits({ kind: 'needsAuth' });
        else setCommits({ kind: 'list', commits: [] });
      })
      .catch(() => { if (alive) setCommits({ kind: 'error' }); });
    return () => { alive = false; };
  }, [wsId, worktree.path, mr.number]);

  const openProvider = () => window.dispatchEvent(
    new CustomEvent('strado:open-settings', { detail: { section: provider } }),
  );
  const commentCount = discussion.kind === 'ready' ? discussion.discussion.comments.length : null;
  const commitCount = commits.kind === 'list' ? commits.commits.length : null;
  const fileCount = probe.kind === 'list' ? probe.files.length : null;

  const openExternal = () => {
    const bridge = window.strado;
    if (bridge?.preview) void bridge.preview('open-external', worktree.path, { url: mr.webUrl });
    else window.open(mr.webUrl, '_blank', 'noopener');
  };
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
        {/* Author and raised date are already on the row in the list beside
            this pane — repeating them only squeezed the title. */}
        {fmtDate(effective.mergedAt) && (
          <span
            title={effective.mergedAt ?? undefined}
            className="hidden shrink-0 text-xs text-zinc-500 md:block"
          >merged {fmtDate(effective.mergedAt)}</span>
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
                onClick={openProvider}
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
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1">
        {([
          { id: 'conversation' as const, label: 'Conversation', count: commentCount },
          { id: 'commits' as const, label: 'Commits', count: commitCount },
          { id: 'files' as const, label: 'Files changed', count: fileCount },
        ]).map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? 'true' : undefined}
            className={`rounded px-2 py-1 text-xs ${tab === entry.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            {entry.label}
            {entry.count !== null && <span className="ml-1.5 font-mono text-[10px] text-zinc-500">{entry.count}</span>}
          </button>
        ))}
      </div>
      {tab === 'conversation' ? (
        <ReviewConversation
          probe={discussion}
          provider={provider}
          providerName={providerName}
          canReview={effective.state === 'open'}
          onConnect={openProvider}
          onSubmit={submitReview}
          // Only offered for files the loaded diff actually has, so the chip
          // is never a dead click.
          jumpablePaths={probe.kind === 'list' ? probe.files.map((file) => file.path) : []}
          onJumpToLine={(comment) => {
            if (!comment.path || !comment.line) return;
            setJumpTo((current) => ({
              path: comment.path!,
              line: comment.line!,
              side: comment.side,
              seq: (current?.seq ?? 0) + 1,
            }));
            setTab('files');
          }}
        />
      ) : tab === 'commits' ? (
        <ReviewCommits
          probe={commits}
          providerName={providerName}
          onConnect={openProvider}
          loadChanges={async (sha) => {
            const r = await api.worktrees.commitChanges(wsId, worktree.path, sha);
            if (r.kind === 'list') return { kind: 'list' as const, files: r.files };
            if (r.kind === 'needsAuth') return { kind: 'needsAuth' as const };
            return { kind: 'list' as const, files: [] };
          }}
          onOpenCommit={(commit) => {
            if (!commit.webUrl) return;
            const bridge = window.strado;
            if (bridge?.preview) void bridge.preview('open-external', worktree.path, { url: commit.webUrl });
            else window.open(commit.webUrl, '_blank', 'noopener');
          }}
        />
      ) : probe.kind === 'loading' ? (
        <div role="status" aria-label="Loading code review" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
          <span className="animate-pulse text-zinc-400" aria-hidden>
            <PrStateIcon state="open" className="h-9 w-9" />
          </span>
          <span className="text-sm text-zinc-500">Loading code review…</span>
        </div>
      ) : probe.kind === 'needsAuth' ? (
        <div className="p-4 text-xs text-zinc-400">
          Reconnect {providerName} to view this diff.
          <button
            onClick={openProvider}
            className="ml-2 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700"
          >Connect {providerName}</button>
        </div>
      ) : probe.kind === 'error' ? (
        <div className="p-4 text-xs text-red-300">Couldn't load the diff.</div>
      ) : (
        <ChangedFiles
          files={probe.files}
          providerName={providerName}
          onOpenExternal={openExternal}
          comments={discussion.kind === 'ready' ? discussion.discussion.comments : []}
          // Only offered once the provider has told us what to pin against.
          onAddComment={discussion.kind === 'ready' && discussion.discussion.anchor && selectedFile
            ? async (target, body) => {
                const res = await api.worktrees.postMergeRequestLineComment(wsId, worktree.path, mr.number, {
                  body,
                  path: selectedFile.path,
                  oldPath: selectedFile.oldPath,
                  line: target.line,
                  side: target.side,
                });
                if (res.kind === 'needsAuth') throw new Error(`Reconnect ${providerName} to post.`);
                if (res.kind === 'absent') throw new Error('This worktree no longer maps to a provider — refresh and retry.');
                if (aliveRef.current) setDiscussionSeq((seq) => seq + 1);
              }
            : undefined}
          onSelectFile={setSelectedFile}
          jumpTo={jumpTo}
        />
      )}
    </div>
  );
}
