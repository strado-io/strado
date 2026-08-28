import { memo, useEffect, useRef, useState } from 'react';
import type { MergeRequest, Worktree } from '../types';
import { useWorkspace } from '../hooks/useWorkspace';
import { useActivityBeacon } from '../hooks/useActivityBeacon';
import { api, ApiClientError } from '../api';
import { parseUnifiedDiff, hunkPatch, type ParsedDiff, type DiffHunk, type DiffLine } from '../lib/diff';
import { SearchSelect } from '../components/SearchSelect';
import { GitTreePanel } from '../components/GitTreePanel';
import { MrReviewModal } from '../components/MrReviewModal';
import { invalidateMrPath } from '../hooks/mrSummaries';
import { MinusIcon, PlusIcon } from '../components/hub/icons';

type Tab = 'changes' | 'branch';
type ChangeFile = Awaited<ReturnType<typeof api.worktrees.git.changes>>['files'][number];
type BranchFile = Awaited<ReturnType<typeof api.worktrees.git.branchChanges>>['files'][number];

// Bare colored monograms (VS Code style) — the letter is the signal, no box.
const STATUS_CHIP: Record<string, string> = {
  A: 'text-emerald-400',
  M: 'text-amber-400',
  D: 'text-red-400',
  R: 'text-blue-400',
  U: 'text-blue-400',
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function splitPath(p: string): { dir: string; base: string } {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? { dir: '', base: p } : { dir: p.slice(0, idx + 1), base: p.slice(idx + 1) };
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="animate-spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function RemoteMenu({
  label,
  menuTitle,
  icon,
  disabled,
  pending,
  searchable = false,
  loadItems,
  onPick,
}: {
  label: string;
  menuTitle: string;
  icon: React.ReactNode;
  disabled: boolean;
  pending: boolean;
  searchable?: boolean;
  loadItems: () => Promise<string[]>;
  onPick: (item: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = () => {
    setOpen((p) => !p);
    setQuery('');
    if (items === null) {
      loadItems().then(setItems).catch(() => setItems([]));
    }
  };

  const filtered = items?.filter((i) => i.toLowerCase().includes(query.toLowerCase())) ?? null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={toggle}
        disabled={disabled}
        title={label}
        aria-label={label}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? <Spinner /> : icon}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
          <div className="border-b border-zinc-800 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
            {menuTitle}
          </div>
          {searchable && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches…"
              aria-label={`${label} search`}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && filtered?.[0]) {
                  setOpen(false);
                  onPick(filtered[0]);
                }
              }}
              className="w-full border-b border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          )}
          <div className="max-h-64 overflow-auto py-1">
            {filtered === null && <div className="px-2 py-1.5 text-xs text-zinc-600">Loading…</div>}
            {filtered?.length === 0 && <div className="px-2 py-1.5 text-xs text-zinc-600">No matches</div>}
            {filtered?.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setOpen(false);
                  onPick(r);
                }}
                className="block w-full truncate px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Memoized: the lines array reference only changes when the diff is
// refetched, so staging one hunk doesn't re-render every other hunk's rows.
const DiffLinesView = memo(function DiffLinesView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff-surface diff-code-font">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`diff-line grid grid-cols-[3rem_3rem_1fr] whitespace-pre text-xs ${
            l.kind === 'add'
              ? 'diff-line-add'
              : l.kind === 'del'
                ? 'diff-line-del'
                : 'diff-line-context'
          }`}
        >
          <span className="diff-line-number px-2 text-right">{l.oldNo ?? ''}</span>
          <span className="diff-line-number px-2 text-right">{l.newNo ?? ''}</span>
          <span className="px-2">{l.text}</span>
        </div>
      ))}
    </div>
  );
});

// Hunks over this many lines start collapsed to keep worst-case DOM bounded.
const COLLAPSE_THRESHOLD = 400;
const COLLAPSED_PREVIEW = 200;

const HunkBlock = memo(
  function HunkBlock({
    diff,
    hunk,
    buttonLabel,
    showButton,
    disabled,
    onApply,
    discardLabel,
    onDiscard,
  }: {
    diff: ParsedDiff;
    hunk: DiffHunk;
    buttonLabel: string;
    showButton: boolean;
    disabled: boolean;
    onApply: (diff: ParsedDiff, hunk: DiffHunk) => void;
    discardLabel?: string;
    onDiscard?: (diff: ParsedDiff, hunk: DiffHunk) => void;
  }) {
    const [expanded, setExpanded] = useState(false);
    const oversized = hunk.lines.length > COLLAPSE_THRESHOLD;
    const visible = oversized && !expanded ? hunk.lines.slice(0, COLLAPSED_PREVIEW) : hunk.lines;
    return (
      // content-visibility lets the browser skip layout/paint for offscreen
      // hunks — the main cost of large diffs is DOM volume, not git.
      <div className="diff-hunk mb-3 overflow-hidden rounded border [contain-intrinsic-size:auto_240px] [content-visibility:auto]">
        <div className="diff-hunk-header diff-code-font flex items-center justify-between gap-2 px-2 py-1 text-[11px]">
          <span className="min-w-0 truncate font-mono">{hunk.header}</span>
          <span className="flex shrink-0 items-center gap-1">
            {showButton && discardLabel && onDiscard && (
              <button
                onClick={() => onDiscard(diff, hunk)}
                disabled={disabled}
                className="diff-hunk-action diff-hunk-action-danger rounded px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {discardLabel}
              </button>
            )}
            {showButton && (
              <button
                onClick={() => onApply(diff, hunk)}
                disabled={disabled}
                className="diff-hunk-action rounded px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {buttonLabel}
              </button>
            )}
          </span>
        </div>
        <DiffLinesView lines={visible} />
        {oversized && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="diff-expand block w-full border-t px-2 py-1 text-center text-[11px]"
          >
            Show all {hunk.lines.length} lines ({hunk.lines.length - COLLAPSED_PREVIEW} hidden)
          </button>
        )}
      </div>
    );
  },
  // onApply is deliberately excluded: its identity changes every parent
  // render, but it only closes over stable setters/refs, so a "stale"
  // handler is behaviorally identical. Everything that affects output is
  // compared.
  (prev, next) =>
    prev.diff === next.diff &&
    prev.hunk === next.hunk &&
    prev.buttonLabel === next.buttonLabel &&
    prev.discardLabel === next.discardLabel &&
    prev.showButton === next.showButton &&
    prev.disabled === next.disabled,
);

export function DiffView({ worktree, onClose }: { worktree: Worktree; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;

  // Reviewing a diff is work: heartbeat this worktree while the view is open.
  useActivityBeacon(worktree.path);

  const [tab, setTab] = useState<Tab>('changes');
  const [showTree, setShowTree] = useState(false);
  const [changesFiles, setChangesFiles] = useState<ChangeFile[]>([]);
  const [branchFiles, setBranchFiles] = useState<BranchFile[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  // Live checked-out branch. The row snapshot in `worktree.branch` can be
  // stale (the user may have switched branches in a terminal since the row
  // was fetched); the branches endpoint reports the truth.
  const [currentBranch, setCurrentBranch] = useState<string | null>(worktree.branch ?? null);
  // User-chosen comparison base; undefined = server-detected default.
  const [baseOverride, setBaseOverride] = useState<string | undefined>(undefined);
  const baseOverrideRef = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const [stagedDiff, setStagedDiff] = useState<ParsedDiff | null>(null);
  const [unstagedDiff, setUnstagedDiff] = useState<ParsedDiff | null>(null);
  const [branchDiff, setBranchDiff] = useState<ParsedDiff | null>(null);

  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRemoteOp, setPendingRemoteOp] = useState<'push' | 'pull' | null>(null);

  // In-app create-MR dialog: `createMr` set on target pick opens it (no
  // network yet); the submit handler owns the async create call.
  const [createMr, setCreateMr] = useState<{ target: string } | null>(null);
  const [mrTitle, setMrTitle] = useState('');
  const [mrDescription, setMrDescription] = useState('');
  const [mrDescOpen, setMrDescOpen] = useState(false);
  const [mrSubmitting, setMrSubmitting] = useState(false);
  const [mrError, setMrError] = useState<string | null>(null);
  const [mrNeedsAuth, setMrNeedsAuth] = useState<'gitlab' | 'github' | null>(null);
  const [createdMr, setCreatedMr] = useState<MergeRequest | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Guards against out-of-order diff responses: every diff load bumps the
  // sequence and captures it; only the latest load may commit its results to
  // state. Without this, a slow fetch for a previously-selected file would
  // overwrite the currently-selected file's hunks — and hunk patches are
  // built from that state, so a user could stage a hunk from the wrong file.
  const loadSeqRef = useRef(0);

  async function loadList(which: Tab): Promise<string[]> {
    try {
      if (which === 'changes') {
        const res = await api.worktrees.git.changes(wsId, worktree.path);
        setChangesFiles(res.files);
        return res.files.map((f) => f.path);
      } else {
        const res = await api.worktrees.git.branchChanges(wsId, worktree.path, baseOverrideRef.current);
        setBaseBranch(res.baseBranch);
        setBranchFiles(res.files);
        return res.files.map((f) => f.path);
      }
    } catch (e) {
      setError(errMessage(e));
      return [];
    }
  }

  async function loadDiffs(which: Tab, file: string | null) {
    const seq = ++loadSeqRef.current;
    if (!file) {
      setStagedDiff(null);
      setUnstagedDiff(null);
      setBranchDiff(null);
      return;
    }
    try {
      if (which === 'changes') {
        const [staged, unstaged] = await Promise.all([
          api.worktrees.git.diff(wsId, worktree.path, file, 'staged'),
          api.worktrees.git.diff(wsId, worktree.path, file, 'unstaged'),
        ]);
        if (seq !== loadSeqRef.current) return; // stale response for a superseded selection
        setStagedDiff(parseUnifiedDiff(staged.diff));
        setUnstagedDiff(parseUnifiedDiff(unstaged.diff));
      } else {
        const res = await api.worktrees.git.diff(wsId, worktree.path, file, 'branch', baseOverrideRef.current);
        if (seq !== loadSeqRef.current) return; // stale response for a superseded selection
        setBranchDiff(parseUnifiedDiff(res.diff));
      }
    } catch (e) {
      if (seq !== loadSeqRef.current) return; // stale failure — a newer load owns the UI
      setError(errMessage(e));
    }
  }

  async function refreshAll(which: Tab) {
    const paths = await loadList(which);
    const current = selectedRef.current;
    const next = current && paths.includes(current) ? current : (paths[0] ?? null);
    selectedRef.current = next;
    setSelected(next);
    await loadDiffs(which, next);
  }

  useEffect(() => {
    void refreshAll(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, wsId, worktree.path]);

  useEffect(() => {
    api.worktrees.git
      .branches(wsId, worktree.path)
      .then((r) => {
        setBranches(r.branches);
        setCurrentBranch(r.current ?? null);
      })
      .catch(() => setBranches([]));
  }, [wsId, worktree.path]);

  function selectBase(base: string) {
    const next = base || undefined;
    setBaseOverride(next);
    baseOverrideRef.current = next;
    void refreshAll('branch');
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (reviewOpen) {
        // MrReviewModal is stacked above this modal and has its own Esc
        // listener that will also fire and call its onClose — both
        // converge on setReviewOpen(false), so the double-fire is harmless.
        // Esc belongs to the top layer only; don't fall through to onClose.
        setReviewOpen(false);
        return;
      }
      if (createMr) {
        setCreateMr(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, createMr, reviewOpen]);

  // ↑/↓ walk the file list in its visual order (staged section before
  // unstaged; a partially staged file appears in both but is visited once).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (showTree) return;
      // Typing in the commit message / search inputs keeps native caret keys.
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
      const paths =
        tab === 'changes'
          ? [
              ...new Set(
                [
                  ...changesFiles.filter((f) => f.staged !== 'none'),
                  ...changesFiles.filter((f) => f.staged !== 'full'),
                ].map((f) => f.path),
              ),
            ]
          : branchFiles.map((f) => f.path);
      if (paths.length === 0) return;
      e.preventDefault();
      const idx = paths.indexOf(selectedRef.current ?? '');
      const next =
        e.key === 'ArrowDown'
          ? paths[Math.min(idx + 1, paths.length - 1)]!
          : paths[Math.max(idx - 1, 0)]!;
      if (next === selectedRef.current) return;
      selectFile(next);
      document
        .querySelector(`[data-file-row="${CSS.escape(next)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, changesFiles, branchFiles, showTree]);

  function selectFile(path: string) {
    selectedRef.current = path;
    setSelected(path);
    void loadDiffs(tab, path);
  }

  async function runFileOp(op: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await op();
      await refreshAll('changes');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const onStageFile = (f: ChangeFile) => runFileOp(() => api.worktrees.git.stage(wsId, worktree.path, f.path));
  const onUnstageFile = (f: ChangeFile) => runFileOp(() => api.worktrees.git.unstage(wsId, worktree.path, f.path));

  const onStageAll = () => runFileOp(() => api.worktrees.git.stageAll(wsId, worktree.path));
  const onUnstageAll = () => runFileOp(() => api.worktrees.git.unstageAll(wsId, worktree.path));

  function onDiscardAll() {
    const ok = window.confirm(
      'Discard ALL unstaged changes and delete untracked files? Staged changes are kept. This cannot be undone.',
    );
    if (!ok) return;
    void runFileOp(() => api.worktrees.git.discardAll(wsId, worktree.path));
  }

  function onDiscardFile(f: ChangeFile) {
    const what = f.untracked ? `Delete untracked ${f.path}?` : `Discard changes in ${f.path}?`;
    if (!window.confirm(`${what} This cannot be undone.`)) return;
    void runFileOp(() => api.worktrees.git.discard(wsId, worktree.path, f.path));
  }

  async function onApplyHunk(diff: ParsedDiff, hunk: DiffHunk, reverse: boolean) {
    setBusy(true);
    setError(null);
    try {
      const patch = hunkPatch(diff, hunk);
      await api.worktrees.git.applyHunk(wsId, worktree.path, patch, reverse);
      await refreshAll('changes');
    } catch (e) {
      setError(errMessage(e));
      if (e instanceof ApiClientError && e.code === 'VALIDATION') {
        await refreshAll('changes');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDiscardHunk(diff: ParsedDiff, hunk: DiffHunk) {
    if (!window.confirm('Discard this hunk from the working tree? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      const patch = hunkPatch(diff, hunk);
      await api.worktrees.git.discardHunk(wsId, worktree.path, patch);
      await refreshAll('changes');
    } catch (e) {
      setError(errMessage(e));
      if (e instanceof ApiClientError && e.code === 'VALIDATION') {
        await refreshAll('changes');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onPush(remote: string) {
    setBusy(true);
    setPendingRemoteOp('push');
    setError(null);
    setNotice(`Pushing to ${remote}…`);
    try {
      const res = await api.worktrees.git.push(wsId, worktree.path, remote);
      setNotice(`Pushed to ${remote}${res.output ? ` — ${res.output.split('\n')[0]}` : ''}`);
    } catch (e) {
      setNotice(null);
      setError(errMessage(e));
    } finally {
      setPendingRemoteOp(null);
      setBusy(false);
    }
  }

  async function onPull(remote: string) {
    setBusy(true);
    setPendingRemoteOp('pull');
    setError(null);
    setNotice(`Pulling from ${remote}…`);
    try {
      const res = await api.worktrees.git.pull(wsId, worktree.path, remote);
      setNotice(`Pulled from ${remote}${res.output ? ` — ${res.output.split('\n')[0]}` : ''}`);
      await refreshAll(tab);
    } catch (e) {
      setNotice(null);
      setError(errMessage(e));
    } finally {
      setPendingRemoteOp(null);
      setBusy(false);
    }
  }

  function onCreateMr(target: string) {
    const title =
      worktree.meta?.ticketId && worktree.meta?.title
        ? `${worktree.meta.ticketId}: ${worktree.meta.title}`
        : (currentBranch ?? '');
    setCreateMr({ target });
    setMrTitle(title);
    setMrDescription('');
    setMrDescOpen(false);
    setMrError(null);
    setMrNeedsAuth(null);
    setReviewOpen(false);
  }

  async function submitCreateMr() {
    if (!createMr) return;
    const { target } = createMr;
    setMrSubmitting(true);
    setMrError(null);
    setMrNeedsAuth(null);
    try {
      const res = await api.worktrees.createMergeRequest(wsId, worktree.path, {
        target,
        title: mrTitle,
        description: mrDescription || undefined,
      });
      if (res.kind === 'created') {
        setCreateMr(null);
        setError(null);
        setNotice(`Created ${res.mergeRequest.provider === 'github' ? '#' : '!'}${res.mergeRequest.number} → ${target}`);
        setCreatedMr(res.mergeRequest);
        invalidateMrPath(worktree.path);
        window.dispatchEvent(new Event('strado:code-reviews-changed'));
      } else if (res.kind === 'needsAuth') {
        setMrNeedsAuth(res.provider);
        setMrError(`Connect ${res.provider === 'github' ? 'GitHub' : 'GitLab'} first`);
      } else {
        // absent: no createMergeRequest support for this host — fall back
        // to the old open-in-browser flow verbatim.
        setCreateMr(null);
        setError(null);
        try {
          const { url } = await api.worktrees.git.mrUrl(wsId, worktree.path, target);
          window.open(url, '_blank', 'noopener');
        } catch (e) {
          setError(errMessage(e));
        }
      }
    } catch (e) {
      setMrError(errMessage(e));
    } finally {
      setMrSubmitting(false);
    }
  }

  async function onCommit() {
    setBusy(true);
    setError(null);
    try {
      await api.worktrees.git.commit(wsId, worktree.path, commitMsg);
      setCommitMsg('');
      await refreshAll('changes');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const stagedList = changesFiles.filter((f) => f.staged !== 'none');
  const unstagedList = changesFiles.filter((f) => f.staged !== 'full');
  const sectionBtn =
    'flex h-4 w-4 shrink-0 items-center justify-center rounded text-[12px] leading-none text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30';
  const selectedChangeFile = changesFiles.find((f) => f.path === selected) ?? null;
  const stagedCount = changesFiles.filter((f) => f.staged !== 'none').length;
  const label = worktree.meta?.ticketId ?? worktree.path.split('/').pop();
  const showHunkButtons = tab === 'changes' && !!selectedChangeFile && !selectedChangeFile.untracked;

  function renderChangeRow(f: ChangeFile, section: 'staged' | 'unstaged') {
    const { dir, base } = splitPath(f.path);
    const isSelected = selected === f.path;
    const iconBtn =
      'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[13px] leading-none opacity-0 transition group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30';
    return (
      <div
        key={`${section}:${f.path}`}
        data-file-row={f.path}
        onClick={() => selectFile(f.path)}
        className={`group flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs ${
          isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-900'
        }`}
      >
        <span
          className={`w-3 shrink-0 text-center font-mono text-[10px] font-bold ${STATUS_CHIP[f.status] ?? 'text-zinc-400'}`}
        >
          {f.status}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {f.renamedFrom && <span className="text-zinc-600">{f.renamedFrom} → </span>}
          <span className="text-zinc-500">{dir}</span>
          <span className="text-zinc-100">{base}</span>
        </span>
        {section === 'unstaged' ? (
          <>
            <button
              aria-label={`Discard ${f.path}`}
              title={f.untracked ? 'Delete file' : 'Discard changes'}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onDiscardFile(f);
              }}
              className={`${iconBtn} text-zinc-500 hover:bg-red-900/50 hover:text-red-300`}
            >
              ↺
            </button>
            <button
              aria-label={`Stage ${f.path}`}
              title="Stage file"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void onStageFile(f);
              }}
              className={`${iconBtn} text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100`}
            >
              <PlusIcon size={12} />
            </button>
          </>
        ) : (
          <button
            aria-label={`Unstage ${f.path}`}
            title="Unstage file"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void onUnstageFile(f);
            }}
            className={`${iconBtn} text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100`}
          >
            <MinusIcon size={12} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="diff-view relative flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {createMr && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setCreateMr(null)}
          >
            <div
              className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950 p-3 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 text-sm text-zinc-200">
                Create MR: {currentBranch} → {createMr.target}
              </div>
              <input
                autoFocus
                aria-label="MR title"
                value={mrTitle}
                onChange={(e) => setMrTitle(e.target.value)}
                placeholder="Title"
                className="mb-2 w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
              />
              {mrDescOpen ? (
                <textarea
                  autoFocus
                  aria-label="MR description"
                  rows={3}
                  value={mrDescription}
                  onChange={(e) => setMrDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className="mb-2 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
                />
              ) : (
                <button
                  onClick={() => setMrDescOpen(true)}
                  className="mb-2 text-[11px] text-zinc-500 hover:text-zinc-300"
                >
                  + Add description
                </button>
              )}
              {mrError && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded bg-red-950/60 px-2 py-1 text-xs text-red-200">
                  <span>{mrError}</span>
                  {mrNeedsAuth && (
                    <button
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('strado:open-settings', { detail: { section: mrNeedsAuth } }),
                        )
                      }
                      className="shrink-0 rounded bg-red-900/60 px-2 py-0.5 text-red-100 hover:bg-red-800/60"
                    >
                      Connect {mrNeedsAuth === 'github' ? 'GitHub' : 'GitLab'}
                    </button>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setCreateMr(null)}
                  className="rounded px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void submitCreateMr()}
                  disabled={mrSubmitting || !mrTitle.trim()}
                  className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {mrSubmitting ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm text-zinc-200">
          <div className="flex min-w-0 max-w-[45%] items-center gap-2">
            <span className="truncate font-mono text-zinc-100" title={label}>{label}</span>
            {currentBranch && currentBranch !== label && (
              <span className="hidden min-w-0 truncate text-xs text-zinc-600 lg:inline" title={currentBranch}>
                {currentBranch}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <button
              onClick={() => { setTab('changes'); setShowTree(false); }}
              className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition ${
                !showTree && tab === 'changes'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              Changes
            </button>
            <button
              onClick={() => { setTab('branch'); setShowTree(false); }}
              className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition ${
                !showTree && tab === 'branch'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              vs base
            </button>
            {tab === 'branch' && (
              <SearchSelect
                value={baseOverride ?? baseBranch}
                options={[
                  ...(baseBranch && !branches.includes(baseBranch) ? [baseBranch] : []),
                  ...branches.filter((b) => b !== currentBranch),
                ]}
                onSelect={selectBase}
                ariaLabel="Comparison base"
                placeholder="Search branches…"
              />
            )}
          </div>
          <button
            onClick={() => setShowTree((p) => !p)}
            title="Git tree"
            aria-label="Git tree"
            className={`inline-flex h-7 shrink-0 items-center rounded-md px-2.5 ${
              showTree ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="5" cy="6" r="3" />
              <path d="M5 9v6" />
              <circle cx="5" cy="18" r="3" />
              <path d="M12 3v18" />
              <circle cx="19" cy="6" r="3" />
              <path d="M16 15.7A9 9 0 0 0 19 9" />
            </svg>
          </button>
          <RemoteMenu
            label="Create MR"
            menuTitle={`Create MR from ${currentBranch ?? 'current branch'} into`}
            icon={
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="fill-current">
                <path
                  fillRule="evenodd"
                  d="M10,0 L10,2.60002 C12.2108812,3.04881281 13.8920863,4.95644867 13.9950026,7.27443311 L14,7.5 L14,11.2676 C14.5978,11.6134 15,12.2597 15,13 C15,14.1046 14.1046,15 13,15 C11.8954,15 11,14.1046 11,13 C11,12.3166462 11.342703,11.713387 11.8656124,11.3526403 L12,11.2676 L12,7.5 C12,6.259091 11.246593,5.19415145 10.1722389,4.73766702 L10,4.67071 L10,7 L6,3.5 L10,0 Z M3,1 C4.10457,1 5,1.89543 5,3 C5,3.68333538 4.65729704,4.28663574 4.13438762,4.6473967 L4,4.73244 L4,11.2676 C4.5978,11.6134 5,12.2597 5,13 C5,14.1046 4.10457,15 3,15 C1.89543,15 1,14.1046 1,13 C1,12.3166462 1.34270296,11.713387 1.86561238,11.3526403 L2,11.2676 L2,4.73244 C1.4022,4.38663 1,3.74028 1,3 C1,1.89543 1.89543,1 3,1 Z"
                />
              </svg>
            }
            disabled={busy}
            pending={false}
            searchable
            loadItems={() =>
              api.worktrees.git.branches(wsId, worktree.path).then((r) => {
                const cur = r.current ?? currentBranch;
                setCurrentBranch(r.current ?? null);
                const targets = r.branches
                  .filter((b) => b.startsWith('origin/'))
                  .map((b) => b.slice('origin/'.length));
                const unique = [...new Set(targets)];
                return unique.filter((b) => b !== cur);
              })
            }
            onPick={(target) => onCreateMr(target)}
          />
          <RemoteMenu
            label="Push"
            menuTitle="Push to"
            icon="↑"
            disabled={busy}
            pending={pendingRemoteOp === 'push'}
            loadItems={() => api.worktrees.git.remotes(wsId, worktree.path).then((r) => r.remotes)}
            onPick={(r) => void onPush(r)}
          />
          <RemoteMenu
            label="Pull"
            menuTitle={`Pull into ${currentBranch ?? 'current branch'} from`}
            icon="↓"
            disabled={busy}
            pending={pendingRemoteOp === 'pull'}
            searchable
            loadItems={() =>
              api.worktrees.git
                .branches(wsId, worktree.path)
                .then((r) => r.branches.filter((b) => b !== (r.current ?? currentBranch)))
            }
            onPick={(r) => void onPull(r)}
          />
          <button
            className="shrink-0 rounded-md px-2.5 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            onClick={() => void refreshAll(tab)}
            title="Refresh"
            aria-label="Refresh"
          >
            ↻
          </button>
          <button
            className="shrink-0 rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            onClick={onClose}
          >
            Close (Esc)
          </button>
        </div>

        {showTree ? (
          <GitTreePanel worktreePath={worktree.path} />
        ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r border-zinc-800">
            {tab === 'changes' ? (
              <>
                {changesFiles.length === 0 && <div className="p-3 text-xs text-zinc-600">No changes</div>}
                {stagedList.length > 0 && (
                  <div className="flex items-center justify-between px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    <span>Staged Changes ({stagedList.length})</span>
                    <button
                      aria-label="Unstage all"
                      title="Unstage all files"
                      disabled={busy}
                      onClick={() => void onUnstageAll()}
                      className={sectionBtn}
                    >
                      <MinusIcon size={11} />
                    </button>
                  </div>
                )}
                {stagedList.map((f) => renderChangeRow(f, 'staged'))}
                {unstagedList.length > 0 && (
                  <div className="flex items-center justify-between px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    <span>Changes ({unstagedList.length})</span>
                    <span className="flex items-center">
                      <button
                        aria-label="Discard all"
                        title="Discard all changes (deletes untracked files)"
                        disabled={busy}
                        onClick={onDiscardAll}
                        className={`${sectionBtn} hover:bg-red-900/50 hover:text-red-300`}
                      >
                        ⤺
                      </button>
                      <button
                        aria-label="Stage all"
                        title="Stage all files"
                        disabled={busy}
                        onClick={() => void onStageAll()}
                        className={sectionBtn}
                      >
                        <PlusIcon size={11} />
                      </button>
                    </span>
                  </div>
                )}
                {unstagedList.map((f) => renderChangeRow(f, 'unstaged'))}
              </>
            ) : (
              <>
                {branchFiles.length === 0 && <div className="p-3 text-xs text-zinc-600">No changes</div>}
                {branchFiles.map((f) => {
                  const { dir, base } = splitPath(f.path);
                  const isSelected = selected === f.path;
                  return (
                    <div
                      key={f.path}
                      data-file-row={f.path}
                      onClick={() => selectFile(f.path)}
                      className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs ${
                        isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                      }`}
                    >
                      <span
                        className={`w-3 shrink-0 text-center font-mono text-[10px] font-bold ${STATUS_CHIP[f.status] ?? 'text-zinc-400'}`}
                      >
                        {f.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {f.renamedFrom && <span className="text-zinc-600">{f.renamedFrom} → </span>}
                        <span className="text-zinc-500">{dir}</span>
                        <span className="text-zinc-100">{base}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-emerald-400">+{f.additions}</span>{' '}
                        <span className="text-red-300">-{f.deletions}</span>
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {error && (
              <div className="border-b border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>
            )}
            {notice && (
              <div className="flex items-center justify-between gap-2 border-b border-emerald-900 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
                <span>{notice}</span>
                {createdMr && (
                  <button
                    onClick={() => setReviewOpen(true)}
                    className="shrink-0 rounded bg-emerald-800/60 px-2 py-0.5 text-emerald-100 hover:bg-emerald-700/60"
                  >
                    Open review
                  </button>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {tab === 'changes' ? (
                <>
                  {stagedDiff && (stagedDiff.binary || stagedDiff.hunks.length > 0) && (
                    <div className="mb-4">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                        Staged
                      </div>
                      {stagedDiff.binary ? (
                        <div className="text-xs text-zinc-500">Binary file — no preview</div>
                      ) : (
                        stagedDiff.hunks.map((h, i) => (
                          <HunkBlock
                            key={i}
                            diff={stagedDiff}
                            hunk={h}
                            buttonLabel="Unstage hunk"
                            showButton={showHunkButtons}
                            disabled={busy}
                            onApply={(d, hk) => onApplyHunk(d, hk, true)}
                          />
                        ))
                      )}
                    </div>
                  )}
                  {unstagedDiff && (unstagedDiff.binary || unstagedDiff.hunks.length > 0) && (
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                        Unstaged
                      </div>
                      {unstagedDiff.binary ? (
                        <div className="text-xs text-zinc-500">Binary file — no preview</div>
                      ) : (
                        unstagedDiff.hunks.map((h, i) => (
                          <HunkBlock
                            key={i}
                            diff={unstagedDiff}
                            hunk={h}
                            buttonLabel="Stage hunk"
                            showButton={showHunkButtons}
                            disabled={busy}
                            onApply={(d, hk) => onApplyHunk(d, hk, false)}
                            discardLabel="Discard hunk"
                            onDiscard={(d, hk) => void onDiscardHunk(d, hk)}
                          />
                        ))
                      )}
                    </div>
                  )}
                  {selected &&
                    !stagedDiff?.binary &&
                    !unstagedDiff?.binary &&
                    !(stagedDiff?.hunks.length || unstagedDiff?.hunks.length) && (
                      <div className="text-xs text-zinc-600">No changes to show</div>
                    )}
                </>
              ) : (
                <>
                  {branchDiff?.binary && <div className="text-xs text-zinc-500">Binary file — no preview</div>}
                  {branchDiff && !branchDiff.binary && branchDiff.hunks.length === 0 && (
                    <div className="text-xs text-zinc-600">No changes to show</div>
                  )}
                  {branchDiff &&
                    !branchDiff.binary &&
                    branchDiff.hunks.map((h, i) => (
                      <HunkBlock
                        key={i}
                        diff={branchDiff}
                        hunk={h}
                        buttonLabel=""
                        showButton={false}
                        disabled={false}
                        onApply={() => undefined}
                      />
                    ))}
                </>
              )}
            </div>

            {tab === 'changes' && (
              <div className="flex items-end gap-2 border-t border-zinc-800 p-2">
                <textarea
                  rows={2}
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Commit message"
                  className="flex-1 resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600"
                />
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[11px] text-zinc-500">{stagedCount} files staged</span>
                  <button
                    onClick={() => void onCommit()}
                    disabled={busy || !commitMsg.trim() || stagedCount === 0}
                    className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Commit
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
      {createdMr && reviewOpen && (
        // Stop propagation so a click on MrReviewModal's own backdrop
        // doesn't also bubble to this modal's backdrop onClick={onClose}
        // (mirrors TerminalView's handling of the same stacked modal).
        <div onClick={(e) => e.stopPropagation()}>
          <MrReviewModal worktree={worktree} mr={createdMr} onClose={() => setReviewOpen(false)} />
        </div>
      )}
    </div>
  );
}
