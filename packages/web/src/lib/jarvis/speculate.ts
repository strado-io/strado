// Speculative ask, for voice: while the user is still holding to talk and the
// partial transcript pauses, start the model request on that text; on release,
// reuse it when the final text says the same thing, else drop it and ask fresh.
// This only holds the model's answer. It never turns it into a plan or runs
// anything: the box does that after take(), as for a typed ask.
import { buildModelContext, sendable, type Turn } from './model';
import type { ModelResult } from './modelClient';
import type { ParseContext } from './types';

export type Ask = (text: string, thread: Turn[], ctx: ParseContext, signal: AbortSignal) => Promise<ModelResult>;

/** Words that mean the same ask: case, spacing and trailing punctuation don't count. */
export const normaliseAsk = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.?!,;:]+$/, '');

/** What the model would be told besides the text; a change means a new ask. */
const fingerprint = (ctx: ParseContext, thread: Turn[]): string => JSON.stringify([buildModelContext(ctx), thread]);

type Pending = { key: string; ac: AbortController; result: Promise<ModelResult> };

export function createSpeculator(ask: Ask) {
  let pending: Pending | null = null;
  const keyOf = (text: string, ctx: ParseContext, thread: Turn[]) => `${normaliseAsk(text)}\n${fingerprint(ctx, thread)}`;
  const start = (text: string, ctx: ParseContext, thread: Turn[], key: string): Pending => {
    const ac = new AbortController();
    return { key, ac, result: ask(text, thread, ctx, ac.signal) };
  };
  const drop = () => { pending?.ac.abort(); pending = null; };

  /** Ask now on a partial transcript (one at a time; the same words keep the one in flight). */
  const speculate = (text: string, ctx: ParseContext, thread: Turn[]): void => {
    if (!sendable(text).ok) return;
    const key = keyOf(text, ctx, thread);
    if (pending?.key === key && !pending.ac.signal.aborted) return;
    drop();
    pending = start(text, ctx, thread, key);
  };

  /** The answer for the final text: the speculation's when it matches, else a fresh ask. Used once. */
  const take = (text: string, ctx: ParseContext, thread: Turn[], signal?: AbortSignal): Promise<ModelResult> => {
    const key = keyOf(text, ctx, thread);
    const hit = pending && pending.key === key && !pending.ac.signal.aborted ? pending : null;
    if (!hit) drop();
    pending = null;
    const run = hit ?? start(text, ctx, thread, key);
    if (!signal) return run.result;
    if (signal.aborted) { run.ac.abort(); return Promise.resolve({ kind: 'aborted' }); }
    return new Promise<ModelResult>((resolve) => {
      const onAbort = () => { run.ac.abort(); resolve({ kind: 'aborted' }); };
      signal.addEventListener('abort', onAbort, { once: true });
      void run.result.then((r) => { signal.removeEventListener('abort', onAbort); resolve(r); });
    });
  };

  /** The user let go without asking (cancel, Esc): drop whatever is in flight. */
  const cancel = (): void => drop();

  return { speculate, take, cancel };
}
