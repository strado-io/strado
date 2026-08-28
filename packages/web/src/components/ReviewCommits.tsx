import { useEffect, useRef, useState } from 'react';
import type { MergeRequestChange, ReviewCommit } from '../types';
import { relativeTime } from '../lib/relativeTime';
import { PrStateIcon } from './sidebar/prVisuals';
import { ChangedFiles } from './ChangedFiles';

type CommitDiff =
  | { kind: 'loading' }
  | { kind: 'needsAuth' }
  | { kind: 'error' }
  | { kind: 'list'; files: MergeRequestChange[] };

export type CommitsProbe =
  | { kind: 'loading' }
  | { kind: 'needsAuth' }
  | { kind: 'error' }
  | { kind: 'list'; commits: ReviewCommit[] };

/** The commits behind a review, newest last — the order the provider lists. */
export function ReviewCommits({ probe, providerName, onConnect, onOpenCommit, loadChanges }: {
  probe: CommitsProbe;
  providerName: string;
  onConnect: () => void;
  /** Opens the commit on the provider — the escape hatch, not the default. */
  onOpenCommit: (commit: ReviewCommit) => void;
  loadChanges: (sha: string) => Promise<CommitDiff>;
}) {
  const [open, setOpen] = useState<ReviewCommit | null>(null);
  const [diff, setDiff] = useState<CommitDiff>({ kind: 'loading' });
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  // The full sha, not the abbreviation on screen — it is what a git command
  // wants pasted into it.
  const copySha = (commit: ReviewCommit) => {
    void navigator.clipboard?.writeText(commit.sha).catch(() => {});
    setCopied(commit.sha);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1200);
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setDiff({ kind: 'loading' });
    loadChanges(open.sha)
      .then((result) => { if (alive) setDiff(result); })
      .catch(() => { if (alive) setDiff({ kind: 'error' }); });
    return () => { alive = false; };
    // loadChanges closes over the workspace and worktree, which change only
    // with the review itself — and that remounts this pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.sha]);

  if (open) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs">
          <button
            onClick={() => setOpen(null)}
            className="shrink-0 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >‹ Commits</button>
          <button
            onClick={() => onOpenCommit(open)}
            title={`Open ${open.shortSha} in ${providerName}`}
            className="shrink-0 font-mono text-sky-400 hover:underline"
          >{open.shortSha}</button>
          <span className="min-w-0 flex-1 truncate text-zinc-200" title={open.title}>{open.title}</span>
          {open.author && <span className="shrink-0 text-zinc-500">{open.author}</span>}
        </div>
        {diff.kind === 'loading' ? (
          <div role="status" aria-label="Loading commit diff" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
            <span className="animate-pulse text-zinc-400" aria-hidden>
              <PrStateIcon state="open" className="h-9 w-9" />
            </span>
            <span className="text-sm text-zinc-500">Loading commit diff…</span>
          </div>
        ) : diff.kind === 'needsAuth' ? (
          <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-zinc-400">
            Reconnect {providerName} to view this commit.
            <button
              onClick={onConnect}
              className="ml-2 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700"
            >Connect {providerName}</button>
          </div>
        ) : diff.kind === 'error' ? (
          <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-red-300">Couldn’t load this commit’s diff.</div>
        ) : (
          <ChangedFiles
            key={open.sha}
            files={diff.files}
            providerName={providerName}
            onOpenExternal={() => onOpenCommit(open)}
          />
        )}
      </div>
    );
  }

  if (probe.kind === 'loading') {
    return (
      <div role="status" aria-label="Loading commits" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <span className="animate-pulse text-zinc-400" aria-hidden>
          <PrStateIcon state="open" className="h-9 w-9" />
        </span>
        <span className="text-sm text-zinc-500">Loading commits…</span>
      </div>
    );
  }
  if (probe.kind === 'needsAuth') {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-zinc-400">
        Reconnect {providerName} to list these commits.
        <button
          onClick={onConnect}
          className="ml-2 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700"
        >Connect {providerName}</button>
      </div>
    );
  }
  if (probe.kind === 'error') {
    return <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-red-300">Couldn’t load the commits.</div>;
  }
  if (probe.commits.length === 0) {
    return <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-zinc-600">No commits on this review.</div>;
  }

  return (
    <ul className="min-h-0 flex-1 overflow-auto">
      {probe.commits.map((commit) => (
        <li key={commit.sha} className="flex items-center border-b border-zinc-900 last:border-b-0">
          {/* The row reads the commit here; the sha is a copy button, so the
              two things you want from a commit row are one click apart. */}
          <button
            type="button"
            onClick={() => setOpen(commit)}
            aria-label={`View commit ${commit.shortSha}`}
            className="min-w-0 flex-1 self-stretch px-4 py-2.5 text-left hover:bg-zinc-900/50"
          >
            <span className="block truncate text-sm text-zinc-200" title={commit.title}>{commit.title}</span>
            <span className="mt-0.5 block truncate text-xs text-zinc-500">
              {commit.author && <>{commit.author} · </>}{relativeTime(commit.createdAt)}
            </span>
          </button>
          <button
            type="button"
            onClick={() => copySha(commit)}
            aria-label={`Copy commit sha ${commit.shortSha}`}
            title="Copy the full commit sha"
            className="mr-3 shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >{copied === commit.sha ? 'Copied' : commit.shortSha}</button>
        </li>
      ))}
    </ul>
  );
}
