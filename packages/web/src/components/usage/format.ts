/** Number formatting shared by the usage page's cards, chart and tables. */

/** `$3,798` above a dollar, `$0.42` below it, `$0` at zero. */
export function money(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value < 1000) return `$${value.toFixed(2).replace(/\.00$/, '')}`;
  return `$${Math.round(value).toLocaleString()}`;
}

/** Compact token counts: 4.2B, 15.2M, 27.8K, 940. */
export function tokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** Whole percent, with a floor of 1% so a used-but-tiny share is visible. */
export function percent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  if (value < 1) return '<1%';
  return `${Math.round(value)}%`;
}

/** `1h 9m`, `6d 2h`, `12m` — how long until a quota window resets. */
export function untilReset(resetsAt: number | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
}

/** `3 Aug` — axis and range labels, from an ISO date. */
export function shortDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return `${parsed.getUTCDate()} ${parsed.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

/** `4.1 GB`, `971 GB` — machine resources. */
export function bytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—';
  const units: [number, string][] = [[1024 ** 4, 'TB'], [1024 ** 3, 'GB'], [1024 ** 2, 'MB'], [1024, 'KB']];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${suffix}`;
    }
  }
  return `${Math.round(value)} B`;
}

/**
 * Where the rates came from, for the line under the cost figure. Catalog rates
 * carry their fetch date so a stale table is visible rather than implied.
 */
export function pricingNote(pricing: { source: 'litellm' | 'builtin'; fetchedAt: string | null }): string {
  if (pricing.source === 'builtin') return 'built-in rate table';
  const fetched = pricing.fetchedAt ? new Date(pricing.fetchedAt) : null;
  if (!fetched || Number.isNaN(fetched.getTime())) return 'LiteLLM rates';
  return `LiteLLM rates · ${shortDate(fetched.toISOString().slice(0, 10))}`;
}

/**
 * How old a quota measurement is, once it is old enough to matter. Codex writes
 * its limits only while a session runs, so a card can be hours behind; saying
 * so beats presenting a stale percentage as current.
 */
export function measurementAge(measuredAt: number | null, now = Date.now()): string | null {
  if (!measuredAt) return null;
  const minutes = Math.floor((now - measuredAt) / 60_000);
  if (minutes < 10) return null;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${minutes}m ago`;
}
