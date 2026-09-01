import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { TokenCounts } from './pricing.js';

/** One priced turn from an agent's own log. */
export type UsageEvent = {
  ts: number;
  agent: 'claude' | 'codex';
  model: string;
  /** Working directory the turn ran in; '' when the log does not say. */
  cwd: string;
  tokens: TokenCounts;
};

export type ReadResult = {
  events: UsageEvent[];
  /** Byte offset a follow-up read should start from. */
  offset: number;
  skipped: number;
};

/**
 * Claude Code names a project directory after the session cwd with every
 * non-alphanumeric character replaced by a dash — the same encoding
 * `services/agentConversation.ts` relies on. It is lossy (dots, slashes and
 * underscores all collapse to '-'), so the reverse direction has to be a match
 * against known paths rather than a decode.
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

export function matchProjectDir(dirName: string, knownPaths: string[]): string | null {
  return knownPaths.find((candidate) => encodeProjectDir(candidate) === dirName) ?? null;
}

export async function claudeProjectDirs(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

export async function claudeTranscripts(projectDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(projectDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(projectDir, entry.name));
  } catch {
    return [];
  }
}

/** Reads `file` from `fromOffset`, returning whole lines only. */
export async function readLines(
  file: string,
  fromOffset: number,
): Promise<{ lines: string[]; offset: number } | null> {
  let size = 0;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return null;
  }
  if (size <= fromOffset) return { lines: [], offset: fromOffset };
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file, { start: fromOffset, end: size - 1 });
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  const text = Buffer.concat(chunks).toString('utf8');
  const lastBreak = text.lastIndexOf('\n');
  // A log being appended to right now ends mid-line; leave that tail for the
  // next read rather than counting a truncated turn as malformed.
  if (lastBreak === -1) return { lines: [], offset: fromOffset };
  const complete = text.slice(0, lastBreak);
  const consumed = Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8');
  return { lines: complete.split('\n'), offset: fromOffset + consumed };
}

export const num = (value: unknown): number =>
  (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resumed sessions and sidechains re-emit assistant messages that were already
 * billed once. `requestId|message.id` identifies the API call behind a turn, so
 * it is the key that keeps a resumed transcript from double-counting.
 */
function dedupKey(entry: Record<string, unknown>, message: Record<string, unknown>): string {
  const request = typeof entry.requestId === 'string' ? entry.requestId : '';
  const messageId = typeof message.id === 'string' ? message.id : '';
  if (request || messageId) return `${request}|${messageId}`;
  return `uuid:${typeof entry.uuid === 'string' ? entry.uuid : Math.random()}`;
}

export async function readClaudeEvents(file: string, fromOffset: number): Promise<ReadResult> {
  const read = await readLines(file, fromOffset);
  if (!read) return { events: [], offset: fromOffset, skipped: 0 };

  const events: UsageEvent[] = [];
  const seen = new Set<string>();
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
    const message = isRecord(entry.message) ? entry.message : null;
    const usage = message && isRecord(message.usage) ? message.usage : null;
    if (!message || !usage) continue;

    const key = dedupKey(entry, message);
    if (seen.has(key)) continue;
    seen.add(key);

    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    events.push({
      ts: Number.isFinite(ts) ? ts : Date.now(),
      agent: 'claude',
      model: typeof message.model === 'string' ? message.model : 'unknown',
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      tokens: {
        input: num(usage.input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        output: num(usage.output_tokens),
      },
    });
  }

  return { events, offset: read.offset, skipped };
}
