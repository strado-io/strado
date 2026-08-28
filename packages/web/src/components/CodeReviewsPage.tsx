import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CodeReview, CodeReviewCounts, CodeReviewRepository, MergeRequest, RepoConfig, Worktree } from '../types';
import { MR_STATE_COLOR, PIPELINE_DETAIL, PrStateIcon, prKind } from './sidebar/prVisuals';
import { MrReview } from './MrReview';
import { relativeTime } from '../lib/relativeTime';

type ReviewState = MergeRequest['state'];
type PaginationItem = number | 'ellipsis';

const reviewKey = (review: CodeReview) => `${review.provider}:${review.repoId}:${review.number}`;

export function paginationItems(current: number, total: number): PaginationItem[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const visible = new Set<number>([1, total, current - 1, current, current + 1]);
  if (current <= 4) [2, 3, 4, 5].forEach((page) => visible.add(page));
  if (current >= total - 3) [total - 4, total - 3, total - 2, total - 1].forEach((page) => visible.add(page));
  const pages = [...visible].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  pages.forEach((page, index) => {
    if (index > 0 && page - pages[index - 1]! > 1) items.push('ellipsis');
    items.push(page);
  });
  return items;
}

/** Use the matching branch worktree when it exists; repo roots cover orphan/fork PRs. */
export function reviewTarget(
  review: CodeReview,
  repos: RepoConfig[],
  worktrees: Worktree[],
): Worktree | null {
  const branchWorktree = worktrees.find((worktree) =>
    worktree.repoId === review.repoId && worktree.branch === review.sourceBranch,
  );
  if (branchWorktree) return branchWorktree;
  const repo = repos.find((candidate) => candidate.id === review.repoId);
  if (!repo) return null;
  return {
    path: repo.path,
    repoId: repo.id,
    branch: review.sourceBranch,
    head: '',
    prunable: false,
    tracked: false,
    meta: null,
    process: {
      status: 'idle', pid: null, startedAt: null, port: null,
      detectedUrl: null, exitCode: null,
    },
  };
}

function ReviewRow({ review, selected, onOpen }: {
  review: CodeReview;
  selected: boolean;
  onOpen: () => void;
}) {
  const pipeline = review.pipeline ? PIPELINE_DETAIL[review.pipeline] : null;
  const { kind, prefix } = prKind(review);
  // Two lines in a narrow column: the branch pair and the spelled-out status
  // live in the review header on the right, so the row keeps glyphs and ratios.
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${review.sourceBranch} → ${review.targetBranch || 'default'}`}
      aria-label={`Open ${kind} ${review.number}: ${review.title}`}
      aria-current={selected ? 'true' : undefined}
      className={`group grid w-full grid-cols-[1.25rem_minmax(0,1fr)] gap-2 border-b border-l-2 border-zinc-900 px-3 py-2 text-left last:border-b-0 ${
        selected ? 'border-l-sky-500 bg-zinc-900' : 'border-l-transparent hover:bg-zinc-900/70'
      }`}
    >
      <span style={{ color: MR_STATE_COLOR[review.state] }}>
        <PrStateIcon state={review.state} />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`truncate text-sm font-medium ${selected ? 'text-zinc-50' : 'text-zinc-200 group-hover:text-zinc-50'}`}>{review.title}</span>
          <span className="ml-auto shrink-0 font-mono text-xs text-zinc-600">{prefix}{review.number}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
          <span
            data-repo-chip={review.repoId}
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-zinc-800/80 bg-zinc-900/50 px-1.5 py-0.5 font-medium text-zinc-400"
          >
            <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-zinc-600">
              <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
            </svg>
            {review.repoName}
          </span>
          {review.author && <span className="min-w-0 flex-1 truncate">{review.author}</span>}
          {pipeline && (
            <span className={`shrink-0 ${pipeline.cls}`} title={pipeline.label}>
              <span aria-hidden>{pipeline.glyph}</span>
            </span>
          )}
          {review.approvals && (
            <span
              title={`${review.approvals.given}/${review.approvals.required} approved`}
              className={`shrink-0 ${review.approvals.given >= review.approvals.required ? 'text-emerald-400' : 'text-amber-400'}`}
            >
              {review.approvals.given}/{review.approvals.required}
            </span>
          )}
          <span className="ml-auto shrink-0 text-zinc-600">{relativeTime(review.updatedAt)}</span>
        </span>
      </span>
    </button>
  );
}

/** Match the centered launch state used by Claude, Codex, shells, and VS Code. */
function ReviewListLoading() {
  return (
    <div role="status" aria-label="Loading code reviews" className="flex h-full min-h-[20rem] flex-col items-center justify-center gap-4 py-16">
      <span className="animate-pulse text-zinc-400" aria-hidden>
        <PrStateIcon state="open" className="h-9 w-9" />
      </span>
      <span className="text-sm text-zinc-500">Loading code reviews…</span>
    </div>
  );
}

/** The right pane at rest — the split is always there, waiting for a pick. */
function ReviewPreviewPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="text-zinc-700" aria-hidden>
        <PrStateIcon state="open" className="h-8 w-8" />
      </span>
      <p className="text-sm text-zinc-600">Select a review to see it here.</p>
    </div>
  );
}

function EmptyReviewState({ state, filtered, onClear }: {
  state: ReviewState;
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex h-full min-h-[18rem] flex-col items-center justify-center px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900/50 text-zinc-600" aria-hidden>
        <PrStateIcon state={state} className="h-6 w-6" />
      </span>
      <h2 className="mt-4 text-sm font-medium text-zinc-300">
        {filtered ? 'No matching reviews' : `No ${state} reviews`}
      </h2>
      <p className="mt-1 max-w-sm text-xs text-zinc-600">
        {filtered ? 'Try a different search or repository.' : `There are no ${state} reviews in this workspace.`}
      </p>
      {filtered && (
        <button
          type="button"
          onClick={onClear}
          className="mt-4 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >Clear filters</button>
      )}
    </div>
  );
}

function openProviderSettings(provider: 'github' | 'gitlab') {
  window.dispatchEvent(new CustomEvent('strado:open-settings', { detail: { section: provider } }));
}

function ReviewConnectionState({ repositories, onRetry }: {
  repositories: CodeReviewRepository[];
  onRetry: () => void;
}) {
  const needsAuth = repositories.filter((repo) => repo.status === 'needsAuth' && repo.provider);
  const providers = [...new Set(needsAuth.flatMap((repo) => repo.provider ? [repo.provider] : []))];
  const oneRepo = repositories.length === 1 ? repositories[0] : null;
  const providerName = providers.length === 1 ? (providers[0] === 'github' ? 'GitHub' : 'GitLab') : null;
  const title = needsAuth.length > 0
    ? providerName ? `Connect ${providerName} to load reviews` : 'Connect providers to load reviews'
    : 'Couldn’t load reviews';
  const description = oneRepo
    ? needsAuth.length > 0
      ? `${oneRepo.repoName} needs a connection before its reviews can be shown.`
      : `${oneRepo.repoName} is temporarily unavailable. Try again in a moment.`
    : needsAuth.length > 0
      ? `${repositories.length} repositories need attention before all reviews can be shown.`
      : 'The repositories are temporarily unavailable. Try again in a moment.';

  return (
    <div className="flex h-full min-h-[18rem] flex-col items-center justify-center px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900/50 text-zinc-600" aria-hidden>
        <PrStateIcon state="open" className="h-6 w-6" />
      </span>
      <h2 className="mt-4 text-sm font-medium text-zinc-300">{title}</h2>
      <p className="mt-1 max-w-sm text-xs text-zinc-600">{description}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {providers.map((provider) => (
          <button
            key={provider}
            type="button"
            onClick={() => openProviderSettings(provider)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >Connect {provider === 'github' ? 'GitHub' : 'GitLab'}</button>
        ))}
        {needsAuth.length === 0 && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >Try again</button>
        )}
      </div>
    </div>
  );
}

export function CodeReviewsPage({
  reviews,
  repositories,
  counts,
  state,
  repoId,
  repos,
  worktrees,
  loading,
  refreshing,
  page,
  pageSize,
  hasMore,
  pageLimit,
  error,
  sidebarCollapsed,
  onExpandSidebar,
  runningServers,
  onRefresh,
  onStateChange,
  onRepoChange,
  onSearchChange,
  onPageChange,
}: {
  reviews: CodeReview[];
  repositories: CodeReviewRepository[];
  counts: CodeReviewCounts;
  state: ReviewState;
  repoId: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  loading: boolean;
  refreshing: boolean;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Non-null when merging repositories: the deepest page that stays exact. */
  pageLimit?: number | null;
  error: string | null;
  /** With the sidebar hidden the page owns the re-open control, so the shared
      toolbar row above it can disappear entirely instead of sitting empty. */
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  runningServers?: ReactNode;
  onRefresh: () => void;
  onStateChange: (state: ReviewState) => void;
  onRepoChange: (repoId: string) => void;
  onSearchChange: (search: string) => void;
  onPageChange: (page: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  // The picked review is held whole so the diff survives a background refresh
  // that replaces every row object.
  const [selected, setSelected] = useState<CodeReview | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);
  // A different state tab, repository, or query is a different list — the old
  // preview no longer belongs to anything on screen.
  useEffect(() => { setSelected(null); }, [state, repoId, committedQuery]);
  const activeCounts = repoId === 'all'
    ? counts
    : repositories.find((repository) => repository.repoId === repoId)?.counts ?? { open: 0, merged: 0, closed: 0 };
  const filtered = useMemo(() => {
    return reviews.filter((review) => review.state === state && (repoId === 'all' || review.repoId === repoId));
  }, [reviews, state, repoId]);

  const openReview = (review: CodeReview) => {
    // Repos outside this workspace have nothing to diff against locally.
    if (reviewTarget(review, repos, worktrees)) setSelected(review);
    else window.open(review.webUrl, '_blank', 'noopener');
  };
  const previewTarget = selected ? reviewTarget(selected, repos, worktrees) : null;
  const repoOptions = repositories.filter((repo) => repo.status !== 'unsupported');
  const problemRepos = repositories.filter((repo) =>
    (repoId === 'all' || repo.repoId === repoId)
    && (repo.status === 'needsAuth' || repo.status === 'error'),
  );
  const searchActive = committedQuery.length > 0;
  const knownTotal = activeCounts[state];
  // Merging repositories can only page as deep as the provider window allows;
  // offering 1,092 pages when 5 are reachable would just be a lie.
  const reachable = searchActive
    ? Math.max(1, page + (hasMore ? 1 : 0))
    : Math.max(1, Math.ceil(knownTotal / pageSize));
  const totalPages = pageLimit ? Math.min(reachable, pageLimit) : reachable;
  const providerWindowReached = !!pageLimit && (
    (!searchActive && knownTotal > pageLimit * pageSize)
    || (searchActive && page >= pageLimit && hasMore)
  );
  const aggregateWindow = repoId === 'all' && pageLimit === 5;
  const firstVisible = filtered.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastVisible = filtered.length === 0 ? 0 : Math.min(firstVisible + filtered.length - 1, knownTotal);
  const hasActiveFilters = searchActive || repoId !== 'all';
  const clearFilters = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setQuery('');
    setCommittedQuery('');
    onRepoChange('all');
    onSearchChange('');
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[24rem] min-w-0 shrink-0 flex-col border-r border-zinc-900 xl:w-[28rem]">
        <div className="shrink-0 border-b border-zinc-900 bg-zinc-950">
          <div className="flex flex-col gap-1.5 px-2.5 py-2">
            <div className="flex items-center gap-2">
              {sidebarCollapsed && (
                <button
                  aria-label="Open sidebar"
                  title="Open sidebar (⌘B)"
                  onClick={() => onExpandSidebar?.()}
                  className="-ml-1 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                >»</button>
              )}
              <div className="flex min-w-0 flex-1 rounded-md bg-zinc-900 p-0.5">
                {(['open', 'merged', 'closed'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onStateChange(value)}
                    className={`min-w-0 flex-1 truncate rounded px-2.5 py-1 text-xs capitalize ${state === value ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >{value} <span className="ml-1 font-mono text-[10px]">{activeCounts[value].toLocaleString()}</span></button>
                ))}
              </div>
              {runningServers}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="search"
                aria-label="Search code reviews"
                value={query}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuery(value);
                  if (searchTimer.current) clearTimeout(searchTimer.current);
                  searchTimer.current = setTimeout(() => {
                    const remoteQuery = value.trim();
                    setCommittedQuery(remoteQuery);
                    onSearchChange(remoteQuery);
                  }, 300);
                }}
                placeholder="Search reviews"
                className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-zinc-600"
              />
              <select
                aria-label="Filter by repository"
                value={repoId}
                onChange={(event) => onRepoChange(event.target.value)}
                className="w-28 shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-600"
              >
                <option value="all">All repositories</option>
                {repoOptions.map((repo) => <option key={repo.repoId} value={repo.repoId}>{repo.repoName}</option>)}
              </select>
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh"
                title={refreshing ? 'Refreshing…' : 'Refresh'}
                className="shrink-0 rounded-md border border-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-wait disabled:opacity-60"
              >
                <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className={refreshing ? 'animate-spin' : undefined}>
                  <path d="M8 2.5a5.5 5.5 0 1 0 5.24 3.83.75.75 0 0 1 1.43-.46A7 7 0 1 1 8 1a.75.75 0 0 1 0 1.5Z" />
                  <path d="M8.22 1.03a.75.75 0 0 1 1.06 0l1.72 1.72a.75.75 0 0 1 0 1.06L9.28 5.53a.75.75 0 1 1-1.06-1.06l1.19-1.19-1.19-1.19a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!loading && filtered.length > 0 && problemRepos.length > 0 && (
            <div className="mx-2.5 mt-3 flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
              <span>{problemRepos.length} repositor{problemRepos.length === 1 ? 'y is' : 'ies are'} unavailable</span>
              {problemRepos.find((repo) => repo.status === 'needsAuth' && repo.provider)?.provider && (
                <button
                  type="button"
                  onClick={() => openProviderSettings(problemRepos.find((repo) => repo.status === 'needsAuth' && repo.provider)!.provider!)}
                  className="shrink-0 text-zinc-400 hover:text-zinc-200"
                >Review connection</button>
              )}
            </div>
          )}

          {loading ? (
            <ReviewListLoading />
          ) : error && reviews.length === 0 ? (
            <div className="px-5 py-10 text-sm text-red-300">Couldn’t load code reviews. {error}</div>
          ) : filtered.length === 0 && problemRepos.length > 0 ? (
            <ReviewConnectionState repositories={problemRepos} onRetry={onRefresh} />
          ) : filtered.length === 0 ? (
            <EmptyReviewState state={state} filtered={hasActiveFilters} onClear={clearFilters} />
          ) : (
            <div className="pb-2">
              {filtered.map((review) => (
                <ReviewRow
                  key={reviewKey(review)}
                  review={review}
                  selected={!!selected && reviewKey(selected) === reviewKey(review)}
                  onOpen={() => openReview(review)}
                />
              ))}
            </div>
          )}
        </div>

        {!loading && providerWindowReached && (
          <div className="shrink-0 border-t border-zinc-900 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
            {aggregateWindow
              ? <>The combined view shows the newest {(pageLimit! * pageSize).toLocaleString()} reviews. Select a repository to browse its complete history.</>
              : <>GitHub exposes only the newest {(pageLimit! * pageSize).toLocaleString()} results for this view. Narrow the search or open GitHub to reach older reviews.</>}
          </div>
        )}
        {!loading && (reviews.length > 0 || hasMore || page > 1) && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-900 px-2.5 py-2 text-xs text-zinc-600">
            <span className="truncate">
              {searchActive
                ? `${filtered.length.toLocaleString()} matching review${filtered.length === 1 ? '' : 's'} on page ${page.toLocaleString()}`
                : `Showing ${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()} of ${knownTotal.toLocaleString()}`}
            </span>
            {(totalPages > 1 || page > 1) && (
              <nav
                aria-label="Code review pages"
                className="flex shrink-0 items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-xs"
              >
                <button
                  type="button"
                  onClick={() => onPageChange(page - 1)}
                  disabled={page <= 1}
                  className="border-r border-zinc-800 px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                >‹</button>
                {paginationItems(page, totalPages).map((item, index) => item === 'ellipsis' ? (
                  <span key={`ellipsis-${index}`} aria-hidden className="border-r border-zinc-800 px-2.5 py-1.5 text-zinc-600">…</span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    aria-label={`Page ${item}`}
                    aria-current={item === page ? 'page' : undefined}
                    onClick={() => onPageChange(item)}
                    className={`border-r border-zinc-800 px-2 py-1.5 ${item === page ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}
                  >{item.toLocaleString()}</button>
                ))}
                <button
                  type="button"
                  onClick={() => onPageChange(page + 1)}
                  disabled={!hasMore || (!searchActive && page >= totalPages)}
                  className="px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                >›</button>
              </nav>
            )}
          </div>
        )}
      </div>

      {/* MrReview is `absolute inset-0`, so this pane is its positioning parent. */}
      <div className="relative min-w-0 flex-1 bg-zinc-950">
        {selected && previewTarget ? (
          <MrReview
            key={reviewKey(selected)}
            worktree={previewTarget}
            mr={selected}
            onClose={() => setSelected(null)}
          />
        ) : (
          <ReviewPreviewPlaceholder />
        )}
      </div>
    </div>
  );
}
