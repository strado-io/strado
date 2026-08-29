import { useEffect, useState } from 'react';
import type { AgentMode } from '../api';
import { ClaudeIcon, CodexIcon, OpencodeIcon } from './hub/icons';

const LABEL: Record<AgentMode, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const ICON = { claude: ClaudeIcon, codex: CodexIcon, opencode: OpencodeIcon };

export function HandoffDialog({
  source,
  opencodeInstalled,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  source: { mode: AgentMode; sessionId: string };
  opencodeInstalled: boolean | null;
  busy: boolean;
  error: string | null;
  onSubmit: (target: AgentMode, notes: string) => void;
  onCancel: () => void;
}) {
  const choices = ['claude', 'codex', 'opencode'] as AgentMode[];
  // Prefer another provider for usage-limit recovery, while still allowing a
  // fresh same-provider session when the old conversation hit a context limit.
  const first = choices.find((mode) => mode !== source.mode && (mode !== 'opencode' || opencodeInstalled !== false)) ?? source.mode;
  const [target, setTarget] = useState<AgentMode>(first);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { if (!busy) onCancel(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="handoff-title" className="text-base font-semibold text-zinc-100">Continue with another agent</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          Strado will transfer clean {LABEL[source.mode]} conversation messages when available, your handoff note, and the current Git state into a fresh agent conversation.
        </p>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-medium text-zinc-300">Continue with</legend>
          <div className="grid grid-cols-2 gap-2">
            {choices.map((mode) => {
              const ModeIcon = ICON[mode];
              const disabled = mode === 'opencode' && opencodeInstalled === false;
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={disabled || busy}
                  aria-pressed={target === mode}
                  onClick={() => setTarget(mode)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                    target === mode
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-100'
                      : disabled
                        ? 'cursor-not-allowed border-zinc-900 text-zinc-700'
                        : 'border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900'
                  }`}
                >
                  <ModeIcon className="text-zinc-500" />
                  <span>{LABEL[mode]}{mode === source.mode ? ' (new session)' : ''}</span>
                  {disabled && <span className="ml-auto text-[10px]">not installed</span>}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="mt-4 block text-xs font-medium text-zinc-300" htmlFor="handoff-notes">
          Anything the next agent must know? <span className="font-normal text-zinc-600">Optional</span>
        </label>
        <textarea
          id="handoff-notes"
          autoFocus
          value={notes}
          disabled={busy}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Current blocker, expected behavior, or the next step…"
          className="mt-2 h-28 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        <p className="mt-2 text-[11px] leading-4 text-zinc-600">
          Terminal screen output is not copied. Agent A stays available as history; the new agent becomes active and verifies existing changes before continuing.
        </p>
        {error && <div role="alert" className="mt-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (target === 'opencode' && opencodeInstalled === false)}
            onClick={() => onSubmit(target, notes)}
            className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? 'Preparing handoff…' : `Continue with ${LABEL[target]}`}
          </button>
        </div>
      </div>
    </div>
  );
}
