import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CodeReview, CodeReviewCounts, CodeReviewRepository, MergeRequest } from '../types';

export type CodeReviewsState = {
  reviews: CodeReview[];
  repositories: CodeReviewRepository[];
  counts: CodeReviewCounts;
  loading: boolean;
  refreshing: boolean;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Non-null when merging repositories: the deepest page that is exact. */
  pageLimit: number | null;
  error: string | null;
};

const EMPTY: CodeReviewsState = {
  reviews: [], repositories: [], counts: { open: 0, merged: 0, closed: 0 },
  loading: true, refreshing: false, page: 0, pageSize: 20, hasMore: false, pageLimit: null, error: null,
};

type Destination = { wsId: string; reviewState: MergeRequest['state']; search: string; repoId: string };
const currentDestination = (d: Destination) => `${d.wsId}:${d.reviewState}:${d.search}:${d.repoId}`;

/** Workspace-wide review inbox, shared by the sidebar count and full page. */
export function useCodeReviews(wsId: string, reviewState: MergeRequest['state'] = 'open', search = '', repoId = 'all') {
  const [state, setState] = useState<CodeReviewsState>(EMPTY);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const destinationRef = useRef({ wsId, reviewState, search, repoId });
  // The page the user asked for, set synchronously — `state.page` only lands
  // when the request resolves, so a refresh firing mid-`goToPage` would read
  // the old page from its closure and quietly drag them back to it.
  const pageRef = useRef(1);
  const requestSeq = useRef(0);

  const refresh = useCallback(() => setRefreshSeq((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    const workspaceChanged = destinationRef.current.wsId !== wsId;
    const reviewStateChanged = destinationRef.current.reviewState !== reviewState;
    const searchChanged = destinationRef.current.search !== search;
    const repoChanged = destinationRef.current.repoId !== repoId;
    const destinationChanged = workspaceChanged || reviewStateChanged || searchChanged || repoChanged;
    const requestedPage = destinationChanged ? 1 : pageRef.current || 1;
    pageRef.current = requestedPage;
    const requestId = ++requestSeq.current;
    destinationRef.current = { wsId, reviewState, search, repoId };
    setState((current) => workspaceChanged
      ? { ...EMPTY }
      : reviewStateChanged || searchChanged || repoChanged
        ? { ...current, reviews: [], loading: true, refreshing: false, page: 0, hasMore: false, error: null }
        : current.reviews.length
        ? { ...current, refreshing: true, error: null }
        : { ...EMPTY });

    let request: ReturnType<typeof api.reviews.list>;
    try {
      // Optional at runtime so older/incomplete test API mocks degrade to an
      // empty inbox instead of crashing unrelated dashboard tests.
      request = api.reviews?.list(wsId, reviewState, requestedPage, search, repoId) ?? Promise.resolve({
        reviews: [], repositories: [], counts: { open: 0, merged: 0, closed: 0 }, page: 1, pageSize: 20, hasMore: false, pageLimit: null,
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(({ reviews, repositories, counts, page, pageSize, hasMore, pageLimit }) => {
      if (alive && requestId === requestSeq.current) setState({
        reviews,
        repositories,
        counts: counts ?? {
          open: reviews.filter((review) => review.state === 'open').length,
          merged: reviews.filter((review) => review.state === 'merged').length,
          closed: reviews.filter((review) => review.state === 'closed').length,
        },
        loading: false,
        refreshing: false,
        page: page ?? 1,
        pageSize: pageSize ?? 20,
        hasMore: hasMore ?? false,
        pageLimit: pageLimit ?? null,
        error: null,
      });
    }).catch((error) => {
      if (alive && requestId === requestSeq.current) setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    });

    return () => { alive = false; };
  }, [wsId, reviewState, search, repoId, refreshSeq]);

  const goToPage = useCallback(async (nextPage: number) => {
    if (nextPage < 1 || state.loading || nextPage === state.page) return;
    pageRef.current = nextPage;
    const destination = `${wsId}:${reviewState}:${search}:${repoId}`;
    const requestId = ++requestSeq.current;
    setState((current) => ({ ...current, loading: true, refreshing: false, error: null }));
    try {
      const result = await api.reviews.list(wsId, reviewState, nextPage, search, repoId);
      if (requestId !== requestSeq.current || currentDestination(destinationRef.current) !== destination) return;
      setState({
        reviews: result.reviews,
        repositories: result.repositories,
        counts: result.counts,
        loading: false,
        refreshing: false,
        page: result.page,
        pageSize: result.pageSize ?? 20,
        hasMore: result.hasMore,
        pageLimit: result.pageLimit ?? null,
        error: null,
      });
    } catch (error) {
      if (requestId !== requestSeq.current || currentDestination(destinationRef.current) !== destination) return;
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [wsId, reviewState, search, repoId, state.loading, state.page]);

  useEffect(() => {
    // Every tick costs a list call per repo plus a checks call per open review,
    // and the services cache for 60s — polling at 60s meant the cache never hit
    // and a few repos could burn a GitHub hour-limit, which then surfaces as a
    // bogus "reconnect". Five minutes is fresh enough for a count badge; the
    // page has Refresh, and create/merge events refresh it immediately.
    const timer = setInterval(refresh, 5 * 60_000);
    const onConnected = () => refresh();
    window.addEventListener('strado:git-provider-connected', onConnected);
    window.addEventListener('strado:code-reviews-changed', onConnected);
    return () => {
      clearInterval(timer);
      window.removeEventListener('strado:git-provider-connected', onConnected);
      window.removeEventListener('strado:code-reviews-changed', onConnected);
    };
  }, [refresh]);

  return { ...state, refresh, goToPage };
}
