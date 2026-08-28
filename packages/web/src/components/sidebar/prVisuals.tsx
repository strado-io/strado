import type { MergeRequest } from '../../types';

export const MR_STATE_COLOR: Record<MergeRequest['state'], string> = {
  open: '#3fb950',
  closed: '#f85149',
  merged: '#a371f7',
};

export const PIPELINE_DETAIL = {
  success: { glyph: '✓', label: 'Checks passed', cls: 'text-emerald-400' },
  failed: { glyph: '✗', label: 'Checks failed', cls: 'text-red-400' },
  running: { glyph: '●', label: 'Checks running', cls: 'animate-pulse text-amber-400' },
  pending: { glyph: '●', label: 'Checks pending', cls: 'text-zinc-500' },
  canceled: { glyph: '⊘', label: 'Checks canceled', cls: 'text-zinc-500' },
} as const;

/** GitLab calls it an MR and numbers it with "!"; GitHub a PR with "#". */
export function prKind(mr: MergeRequest): { kind: 'MR' | 'PR'; prefix: '!' | '#' } {
  return mr.provider === 'gitlab' ? { kind: 'MR', prefix: '!' } : { kind: 'PR', prefix: '#' };
}

export function PullRequestIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      data-component="Octicon"
      width="14" height="14" viewBox="0 0 16 16" version="1.1" aria-hidden
      data-pr-icon="open"
      className={`octicon octicon-git-pull-request color-fg-open ${className}`} fill="currentColor"
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

export function MergeIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" aria-hidden
      data-pr-icon="merged"
      className={className} fill="currentColor"
    >
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z" />
    </svg>
  );
}

export function ClosedPullRequestIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" aria-hidden
      data-pr-icon="closed"
      className={className} fill="currentColor"
    >
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

/** The state glyph for a merge request — open, merged or closed. */
export function PrStateIcon({ state, className = '' }: { state: MergeRequest['state']; className?: string }) {
  if (state === 'merged') return <MergeIcon className={className} />;
  if (state === 'closed') return <ClosedPullRequestIcon className={className} />;
  return <PullRequestIcon className={className} />;
}
