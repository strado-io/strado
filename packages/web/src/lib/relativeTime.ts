/** "3m ago" / "2d ago", falling back to a short date past a month. */
export function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'recently';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The card-sized form: "now", "5m", "5h", "3d", then the same short date as
 * relativeTime. Takes an ISO string or a millisecond timestamp (the worktree
 * LRU stores the latter); nothing, or garbage, gives an empty string.
 */
export function shortRelativeTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
