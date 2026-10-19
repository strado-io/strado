// Natural-language Jarvis: ask the server's model route to turn free text into
// registry steps (or answer a question). The key and the model call stay on the
// server; this sends only the text, a short thread and a scrubbed context
// (model.ts buildModelContext). Every outcome resolves — errors are typed, an
// abort is just 'aborted' — so the box never has to catch.
import { jarvisFetch } from './hubToken';

export type ModelThreadTurn = { role: 'user' | 'assistant'; text: string };
export type ModelStep = { action: string; args: unknown };
export type ModelErrorReason = 'no_key' | 'bad_key' | 'timeout' | 'rate_limited' | 'model_unavailable' | 'local_only' | 'secret' | 'thread' | 'refused' | 'failed';
export type ModelResult =
  | { kind: 'plan'; steps: ModelStep[]; model: string; ms: number }
  /** `choices`: 2–4 complete follow-up requests, best first ("ask claude-1 how are you"). */
  | { kind: 'answer'; text: string; choices?: string[]; model: string; ms: number }
  | { kind: 'error'; reason: ModelErrorReason; message?: string }
  | { kind: 'aborted' };

const KNOWN: ReadonlySet<string> = new Set(['no_key', 'bad_key', 'timeout', 'rate_limited', 'model_unavailable', 'local_only', 'secret', 'thread']);
/** The server gives the model 12 s; past this the box stops waiting (and the abort cancels the call). */
export const MODEL_CLIENT_TIMEOUT_MS = 14_000;

export async function askModel(
  wsId: string,
  input: { text: string; context: unknown; thread: ModelThreadTurn[] },
  signal?: AbortSignal,
  opts: { timeoutMs?: number } = {},
): Promise<ModelResult> {
  // Shell lines are literal and may hold anything; they never leave the machine.
  if (input.text.trimStart().startsWith('$')) return { kind: 'error', reason: 'refused' };
  // One signal for both "the user moved on" (caller) and "too slow" (ours).
  // The request is raced against both, so the box never waits on a fetch
  // that ignores its abort.
  const ac = new AbortController();
  let timedOut = false;
  let stop: (err: Error) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  const cancel = (why: string) => { ac.abort(); stop(Object.assign(new Error(why), { name: 'AbortError' })); };
  const timer = setTimeout(() => { timedOut = true; cancel('timeout'); }, opts.timeoutMs ?? MODEL_CLIENT_TIMEOUT_MS);
  const onAbort = () => cancel('aborted');
  if (signal?.aborted) cancel('aborted');
  else signal?.addEventListener('abort', onAbort, { once: true });
  stopped.catch(() => undefined);
  let res: Response;
  let json: Record<string, unknown> | null;
  try {
    res = await Promise.race([
      jarvisFetch(`/api/w/${encodeURIComponent(wsId)}/jarvis/plan`, { method: 'POST', body: JSON.stringify(input), signal: ac.signal }),
      stopped,
    ]);
    json = (await Promise.race([res.json().catch(() => null), stopped])) as Record<string, unknown> | null;
  } catch (err) {
    if (timedOut) return { kind: 'error', reason: 'timeout' };
    if (ac.signal.aborted || (err as { name?: string })?.name === 'AbortError') return { kind: 'aborted' };
    return { kind: 'error', reason: 'failed', message: (err as Error)?.message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (timedOut) return { kind: 'error', reason: 'timeout' };
  if (ac.signal.aborted) return { kind: 'aborted' };
  if (res.ok && json && json.kind === 'answer') {
    const choices = Array.isArray(json.choices)
      ? json.choices.filter((c: unknown): c is string => typeof c === 'string' && c.trim() !== '' && c.length <= 300 && !/[\r\n]/.test(c)).map((c: string) => c.trim()).slice(0, 4)
      : [];
    return { ...(json as ModelResult & { kind: 'answer' }), ...(choices.length > 0 ? { choices } : { choices: undefined }) };
  }
  if (res.ok && json && json.kind === 'plan') return json as ModelResult;
  const err = json?.error as { message?: string; details?: { reason?: unknown } } | undefined;
  const reason = (err?.details?.reason ?? json?.reason) as string | undefined;
  return { kind: 'error', reason: reason && KNOWN.has(reason) ? (reason as ModelErrorReason) : 'failed', ...(err?.message ? { message: err.message } : {}) };
}
