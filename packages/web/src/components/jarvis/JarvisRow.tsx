import type { Plan } from '../../lib/jarvis/types';
import type { StepStatus } from '../../lib/jarvis/execute';
import { AnswerText } from './AnswerText';

export type JarvisRowState = {
  /** 'paste': pasted input, ⏎ again to run. 'confirm': a step needs a second ⏎. */
  arm: 'paste' | 'confirm' | null;
  status: Record<number, StepStatus>;
  /** `code`: the server's reason, when it gave one (no_key, local_only, …). */
  error: { index: number; reason: string; code?: string } | null;
  busy: boolean;
};

const STATUS_MARK: Record<StepStatus, string> = { running: '…', done: '✓', failed: '✕' };

/** One interpretation of what was typed: its steps as chips (numbered when
 * there are several), what running it will need, and how it went. */
/** Which model read the text: Jev (OpenRouter's fast decisions) answers as
 * `typesafe/…`; everything else is Haiku. */
export const modelName = (model?: string | null): 'Jev' | 'Haiku' => (model?.startsWith('typesafe/') ? 'Jev' : 'Haiku');
/** "via Jev · 0.6 s": who answered and how long it took (when the server said). */
export const viaText = (model?: string | null, ms?: number | null): string =>
  `via ${modelName(model)}${typeof ms === 'number' ? ` · ${(ms / 1000).toFixed(1)} s` : ''}`;

/** Failures the user fixes in Settings → Command box. */
const SETTINGS_CODES = new Set(['no_key', 'bad_key', 'local_only']);

export function JarvisRow({ plan, index, selected, state, onPick, onHover, onSettings, model, ms }: {
  plan: Plan;
  /** The model id that produced a model plan (`typesafe/jev-…` or a Claude id), and its time. */
  model?: string | null;
  ms?: number | null;
  index: number;
  selected: boolean;
  state: JarvisRowState | null;
  onPick: () => void;
  onHover: () => void;
  /** A failure fixed in Settings (no key, Local only): its button opens them. */
  onSettings?: () => void;
}) {
  const multi = plan.steps.length > 1;
  const notUndoable = plan.steps.some((s) => !s.undoable);
  const reasons = plan.steps.filter((s) => s.needsConfirm).map((s) => s.confirmReason).filter(Boolean);
  return (
    <div
      role="option"
      aria-selected={selected}
      data-testid={`jarvis-row-${index}`}
      data-idx-jarvis={index}
      onClick={onPick}
      onMouseEnter={onHover}
      className={`cursor-default rounded-md px-2.5 py-1.5 text-sm ${selected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'}`}
    >
      {plan.steps.map((s, si) => (
        <div key={si} className="flex min-w-0 flex-wrap items-center gap-1">
          {multi && <span className="w-4 shrink-0 text-[11px] text-zinc-500">{`${si + 1}.`}</span>}
          {s.chips.length === 0 && <span className="truncate">{plan.summary}</span>}
          {s.chips.map((c, ci) => (
            <span key={ci} data-testid={`jarvis-chip-${si}-${ci}`} className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-200">
              {c.label}
            </span>
          ))}
          {state?.status[si] && <span className="text-[11px] text-zinc-500">{STATUS_MARK[state.status[si]!]}</span>}
        </div>
      ))}
      {(notUndoable || selected || plan.source === 'model') && (
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
          {plan.source === 'model' && <span className="text-violet-300/80">{viaText(model, ms)}</span>}
          {notUndoable && <span className="text-amber-500/80">not undoable</span>}
          {selected && <span>⏎ run · ⌘⏎ run, keep open</span>}
        </div>
      )}
      {state?.arm === 'paste' && <div className="mt-1 text-[11px] text-amber-300">Pasted — check it, then ⏎ to run.</div>}
      {state?.arm === 'confirm' && (
        <div className="mt-1 text-[11px] text-amber-300">
          {plan.source === 'model'
            ? `${modelName(model)} wants to: ${plan.summary} (${reasons.join('; ') || 'this can’t be undone'}) — ⏎ to confirm, esc to cancel.`
            : `Confirm: ${reasons.join('; ') || 'this can’t be undone'} — ⏎ to run, esc to cancel.`}
        </div>
      )}
      {state?.error && (
        <div role="alert" className="mt-1 flex items-center gap-2 text-[11px] text-red-400">
          <span>{state.error.reason}</span>
          {onSettings && state.error.code && SETTINGS_CODES.has(state.error.code) && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onSettings(); }} className="rounded border border-zinc-700 px-1.5 text-zinc-200 hover:bg-zinc-800">Settings</button>
          )}
        </div>
      )}
    </div>
  );
}

export type ModelRowView =
  | { kind: 'confirm_paste' }
  /** ⏎ found nothing to run and the model is off (or the line is `$`/`@`). */
  | { kind: 'unknown'; message: string }
  /** Plain text with no model to read it (no key, or Local only). */
  | { kind: 'no_key' }
  | { kind: 'not_sendable'; why: string }
  | { kind: 'thinking' }
  | { kind: 'answer'; text: string }
  | { kind: 'error'; message: string; settings: boolean }
  | { kind: 'unusable'; message: string };

/** What ⏎ led to when it ran nothing yet: the model thinking or its reply,
 * or why nothing was sent. Its plans are ordinary rows (JarvisRow, "via Haiku"). */
export function JarvisModelRow({ view, selected, onPick, onHover, onSettings, model, ms }: { view: ModelRowView; selected: boolean; onPick: () => void; onHover: () => void; onSettings?: () => void; model?: string | null; ms?: number | null }) {
  const tone = view.kind === 'error' || view.kind === 'unusable' || view.kind === 'unknown' ? 'text-amber-300' : view.kind === 'answer' ? 'text-zinc-100' : 'text-zinc-300';
  return (
    <div
      role="option"
      aria-selected={selected}
      data-testid="jarvis-model-row"
      onClick={onPick}
      onMouseEnter={onHover}
      className={`cursor-default rounded-md px-2.5 py-1.5 text-sm ${selected ? 'bg-zinc-800' : ''}`}
    >
      <div className={`flex gap-2 ${view.kind === 'answer' ? 'items-start' : 'items-center'} ${tone}`}>
        <span aria-hidden className="text-violet-300">✦</span>
        {view.kind === 'confirm_paste' && <span>Send pasted text to Haiku? ⏎ to send</span>}
        {view.kind === 'unknown' && <span>{view.message}</span>}
        {view.kind === 'no_key' && (
          <span>
            Natural language needs the model —{' '}
            <button type="button" onClick={(e) => { e.stopPropagation(); onSettings?.(); }} className="text-violet-300 underline underline-offset-2 hover:text-violet-200">Settings</button>
          </span>
        )}
        {view.kind === 'not_sendable' && <span>{`Not sent to the model: ${view.why}`}</span>}
        {view.kind === 'thinking' && <span>Thinking…</span>}
        {view.kind === 'answer' && <AnswerText text={view.text} />}
        {(view.kind === 'error' || view.kind === 'unusable') && <span>{view.message}{view.kind === 'error' && view.settings ? ' → Settings' : ''}</span>}
      </div>
      {view.kind === 'thinking' && (
        <div role="progressbar" aria-label="Thinking" className="relative ml-5 mt-1 h-0.5 overflow-hidden rounded-full bg-zinc-800">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-violet-400/70" />
        </div>
      )}
      {view.kind !== 'unknown' && view.kind !== 'no_key' && (
        <div className="mt-0.5 flex gap-2 pl-5 text-[10px] text-zinc-500">
          {/* Jev and Haiku race on the server: no name until one has answered. */}
          {view.kind !== 'thinking' && <span className="text-violet-300/80">{viaText(model, ms)}</span>}
          {view.kind === 'thinking' && <span>esc to cancel</span>}
        </div>
      )}
    </div>
  );
}
