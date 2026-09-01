import fsp from 'node:fs/promises';
import path from 'node:path';
import { isRecord, num, readLines, type ReadResult, type UsageEvent } from './claudeLogs.js';

/** The quota picture an agent's own logs report, as the CLI would show it. */
export type RateLimitSnapshot = {
  windows: { label: string; usedPercent: number; resetsAt: number | null }[];
  capturedAt: number;
};

export type CodexReadResult = ReadResult & {
  /** Newest snapshot in the bytes just read; null when the rollout has none. */
  rateLimits: RateLimitSnapshot | null;
  /** Session cwd from the rollout's meta line, for callers resuming later. */
  cwd: string;
  /** Model in force at the end of the read. */
  model: string;
};

/** Carried across reads of the same rollout so appended turns stay attributed. */
export type CodexSessionState = { cwd?: string; model?: string };

/**
 * Codex reports each limit as a window length in minutes. The two it actually
 * uses get the names its CLI shows; anything else is labelled by its length so
 * a new window never renders as a blank row.
 */
function windowLabel(minutes: number): string {
  if (minutes === 300) return 'Session (5h)';
  if (minutes === 10_080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function parseRateLimits(value: unknown, capturedAt: number): RateLimitSnapshot | null {
  if (!isRecord(value)) return null;
  const windows: RateLimitSnapshot['windows'] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const entry = value[key];
    if (!isRecord(entry)) continue;
    const minutes = num(entry.window_minutes);
    const resets = num(entry.resets_at);
    windows.push({
      label: windowLabel(minutes),
      usedPercent: num(entry.used_percent),
      // Codex writes reset times as epoch seconds; the UI works in millis.
      resetsAt: resets > 0 ? resets * 1000 : null,
    });
  }
  return windows.length ? { windows, capturedAt } : null;
}

function metaModel(payload: Record<string, unknown>): string | null {
  if (typeof payload.model === 'string') return payload.model;
  const instructions = isRecord(payload.base_instructions) ? payload.base_instructions : null;
  const provenance = instructions && isRecord(instructions.provenance) ? instructions.provenance : null;
  if (provenance && typeof provenance.model === 'string') return provenance.model;
  return null;
}

export async function codexRolloutFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  await visit(root);
  return found;
}

/**
 * Codex writes a cumulative `total_token_usage` plus the `last_token_usage` for
 * the turn that just finished. Summing the per-turn numbers is both simpler and
 * resume-safe: a cumulative total restarts at zero in a forked session, which
 * would make deltas go negative.
 */
export async function readCodexEvents(
  file: string,
  fromOffset: number,
  state: CodexSessionState = {},
): Promise<CodexReadResult> {
  const read = await readLines(file, fromOffset);
  let cwd = state.cwd ?? '';
  let model = state.model ?? 'unknown';
  if (!read) return { events: [], offset: fromOffset, skipped: 0, rateLimits: null, cwd, model };

  const events: UsageEvent[] = [];
  let rateLimits: RateLimitSnapshot | null = null;
  let skipped = 0;

  for (const raw of read.lines) {
    if (!raw.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(entry)) continue;
    const payload = isRecord(entry.payload) ? entry.payload : null;
    if (!payload) continue;
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const stamp = Number.isFinite(ts) ? ts : Date.now();

    if (entry.type === 'session_meta') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      const found = metaModel(payload);
      if (found) model = found;
      continue;
    }
    // A session can switch model mid-run; each turn is priced at the model in
    // force when it ran.
    if (entry.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && !cwd) cwd = payload.cwd;
      if (typeof payload.model === 'string') model = payload.model;
      continue;
    }
    if (payload.type !== 'token_count') continue;

    const snapshot = parseRateLimits(payload.rate_limits, stamp);
    if (snapshot) rateLimits = snapshot;

    const info = isRecord(payload.info) ? payload.info : null;
    const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
    if (!last) continue;

    const cacheRead = num(last.cached_input_tokens);
    const cacheWrite = num(last.cache_write_input_tokens);
    // `input_tokens` already includes the cached share; only the remainder was
    // billed at the uncached rate.
    const input = Math.max(0, num(last.input_tokens) - cacheRead);
    const output = num(last.output_tokens) + num(last.reasoning_output_tokens);
    if (input + cacheRead + cacheWrite + output === 0) continue;

    events.push({
      ts: stamp,
      agent: 'codex',
      model,
      cwd,
      tokens: { input, cacheWrite, cacheRead, output },
    });
  }

  return { events, offset: read.offset, skipped, rateLimits, cwd, model };
}
