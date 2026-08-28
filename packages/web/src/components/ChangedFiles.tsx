import { useEffect, useRef, useState } from 'react';
import type { MergeRequestChange, ReviewComment } from '../types';
import { parseUnifiedDiff } from '../lib/diff';
import { CommentCard } from './ReviewConversation';

export type LineTarget = { line: number; side: 'new' | 'old' };
/** A jump requested from elsewhere; `seq` re-fires it for a repeated click. */
export type LineJump = { path: string; line: number; side: 'new' | 'old'; seq: number };

const STATUS_TONE: Record<MergeRequestChange['status'], string> = {
  A: 'text-emerald-400', M: 'text-amber-400', D: 'text-red-400', R: 'text-sky-400',
};

/** Where a comment hangs: the new-file line, or the old one for a deletion. */
function lineTarget(line: { oldNo?: number | null; newNo?: number | null }): LineTarget | null {
  if (line.newNo) return { line: line.newNo, side: 'new' };
  if (line.oldNo) return { line: line.oldNo, side: 'old' };
  return null;
}
const targetKey = (target: LineTarget) => `${target.side}:${target.line}`;
// A hunk can hold the same number on both sides — say which one is meant.
const targetLabel = (target: LineTarget) =>
  target.side === 'old' ? `removed line ${target.line}` : `line ${target.line}`;

function LineComposer({ target, onSubmit, onCancel }: {
  target: LineTarget;
  onSubmit: (target: LineTarget, body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(target, text);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky left-0 w-[40rem] max-w-[80vw] whitespace-normal p-2">
      <textarea
        autoFocus
        aria-label={`Comment on ${targetLabel(target)}`}
        placeholder={`Comment on ${targetLabel(target)}`}
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send();
        }}
        className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-sans text-xs text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-zinc-500"
      />
      {error && <p className="mt-1 font-sans text-[11px] text-red-400">{error}</p>}
      <div className="mt-1 flex justify-end gap-2 font-sans text-[11px]">
        <button onClick={onCancel} className="rounded px-2 py-1 text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >{busy ? 'Posting…' : 'Comment'}</button>
      </div>
    </div>
  );
}

function UnifiedDiff({ diff, comments, onAddComment, jumpTo }: {
  diff: string;
  comments: ReviewComment[];
  onAddComment?: (target: LineTarget, body: string) => Promise<void>;
  jumpTo?: LineJump;
}) {
  const [composeAt, setComposeAt] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!jumpTo) return;
    const row = rootRef.current?.querySelector(`[data-line-key="${jumpTo.side}:${jumpTo.line}"]`);
    if (!(row instanceof HTMLElement)) return;
    row.scrollIntoView({ block: 'center' });
    // Restarting the animation needs the class off for a frame.
    row.classList.remove('diff-line-flash');
    requestAnimationFrame(() => row.classList.add('diff-line-flash'));
  }, [jumpTo?.seq, jumpTo?.line, jumpTo?.side]);

  const parsed = parseUnifiedDiff(diff);
  if (parsed.binary) return <div className="p-3 text-xs text-zinc-500">Binary file — not shown.</div>;

  const byLine = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    if (!comment.line) continue;
    const key = `${comment.side}:${comment.line}`;
    byLine.set(key, [...(byLine.get(key) ?? []), comment]);
  }

  return (
    // w-max lets the widest line set the width so the pane scrolls sideways
    // instead of clipping it, and min-w-full keeps row tints full-bleed.
    <div ref={rootRef} className="diff-surface diff-code-font w-max min-w-full text-xs">
      {parsed.hunks.map((h, hi) => (
        <div key={hi} className="diff-hunk mb-3 overflow-hidden rounded border">
          <div className="diff-hunk-header px-2 py-1 text-[11px]">{h.header}</div>
          {h.lines.map((l, li) => {
            const target = lineTarget(l);
            const key = target ? targetKey(target) : null;
            const pinned = key ? byLine.get(key) ?? [] : [];
            return (
              <div key={li}>
                <div
                  data-line-key={key ?? undefined}
                  className={`diff-line group grid grid-cols-[3rem_3rem_1fr] whitespace-pre ${
                    l.kind === 'add' ? 'diff-line-add'
                    : l.kind === 'del' ? 'diff-line-del'
                    : 'diff-line-context'
                  }`}
                >
                  <span className="diff-line-number px-2 text-right">{l.oldNo ?? ''}</span>
                  <span className="diff-line-number relative px-2 text-right">
                    {onAddComment && target && (
                      <button
                        onClick={() => setComposeAt(key)}
                        aria-label={`Comment on ${targetLabel(target)}`}
                        title={`Comment on ${targetLabel(target)}`}
                        className="absolute left-0 top-0 hidden h-full w-4 items-center justify-center rounded-sm bg-sky-700 text-[10px] leading-none text-white group-hover:flex"
                      >+</button>
                    )}
                    {l.newNo ?? ''}
                  </span>
                  <span className="px-2">{l.text}</span>
                </div>
                {pinned.length > 0 && (
                  <ul className="sticky left-0 w-[40rem] max-w-[80vw] whitespace-normal font-sans">
                    {pinned.map((comment) => <CommentCard key={comment.id} comment={comment} />)}
                  </ul>
                )}
                {key && composeAt === key && target && onAddComment && (
                  <LineComposer target={target} onSubmit={onAddComment} onCancel={() => setComposeAt(null)} />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<MergeRequestChange['status'], string> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed',
};

/** Counted from the patch — GitLab gives no per-file totals of its own. */
function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

/** The path the list column has to truncate, in full, over its diff. */
function FileHeader({ file }: { file: MergeRequestChange }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const { added, removed } = diffCounts(file.diff ?? '');

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-zinc-800 px-3 py-2">
      <span className={`mt-0.5 shrink-0 font-mono text-xs ${STATUS_TONE[file.status]}`} title={STATUS_LABEL[file.status]}>
        {file.status}
      </span>
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-200">
        {file.oldPath && file.oldPath !== file.path && (
          <span className="text-zinc-500">{file.oldPath} → </span>
        )}
        {file.path}
      </span>
      {(added > 0 || removed > 0) && (
        <span className="shrink-0 font-mono text-xs">
          <span className="text-emerald-400">+{added}</span> <span className="text-red-400">−{removed}</span>
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(file.path).catch(() => {});
          setCopied(true);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(false), 1200);
        }}
        aria-label="Copy file path"
        title="Copy the full file path"
        className="shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      >{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/**
 * A file list beside the selected file's diff — the reading surface shared by
 * the review's whole diff and any single commit inside it.
 */
export function ChangedFiles({ files, providerName, onOpenExternal, comments = [], onAddComment, onSelectFile, jumpTo }: {
  files: MergeRequestChange[];
  providerName: string;
  onOpenExternal: () => void;
  /** Existing review comments across the whole review; pinned by path here. */
  comments?: ReviewComment[];
  onAddComment?: (target: LineTarget, body: string) => Promise<void>;
  /** Lets the owner post a line comment against the file on screen — the whole
      change, because a rename needs its old path too. */
  onSelectFile?: (file: MergeRequestChange) => void;
  /** Opens a file and scrolls to a line — a jump from the conversation. */
  jumpTo?: LineJump;
}) {
  const [sel, setSel] = useState<string | null>(files[0]?.path ?? null);
  const selected = files.find((file) => file.path === sel) ?? files[0];
  useEffect(() => {
    if (selected) onSelectFile?.(selected);
  }, [selected?.path]);
  useEffect(() => {
    if (jumpTo) setSel(jumpTo.path);
  }, [jumpTo?.seq, jumpTo?.path]);
  const commentCounts = new Map<string, number>();
  for (const comment of comments) {
    if (comment.path) commentCounts.set(comment.path, (commentCounts.get(comment.path) ?? 0) + 1);
  }
  if (files.length === 0) return <div className="p-4 text-xs text-zinc-600">No file changes.</div>;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-64 shrink-0 overflow-auto border-r border-zinc-800 p-1">
        {files.map((file) => (
          <button
            key={file.path}
            onClick={() => setSel(file.path)}
            title={file.path}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
              selected?.path === file.path ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'
            }`}
          >
            <span className={`w-3 shrink-0 font-mono ${STATUS_TONE[file.status]}`}>{file.status}</span>
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            {commentCounts.get(file.path) && (
              <span
                title={`${commentCounts.get(file.path)} comment${commentCounts.get(file.path) === 1 ? '' : 's'}`}
                className="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400"
              >{commentCounts.get(file.path)}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected && <FileHeader file={selected} />}
        <div className="min-h-0 flex-1 overflow-auto p-3">
        {!selected ? (
          <div className="text-xs text-zinc-600">Select a file</div>
        ) : selected.truncated || !selected.diff ? (
          <div className="text-xs text-zinc-500">
            Diff too large or binary —{' '}
            <button onClick={onOpenExternal} className="underline">open in {providerName}</button>.
          </div>
        ) : (
          <UnifiedDiff
            key={selected.path}
            diff={selected.diff}
            comments={comments.filter((comment) => comment.path === selected.path)}
            onAddComment={onAddComment}
            jumpTo={jumpTo?.path === selected.path ? jumpTo : undefined}
          />
        )}
        </div>
      </div>
    </div>
  );
}
