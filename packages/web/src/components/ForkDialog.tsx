import { useEffect, useMemo, useState } from 'react';
import type { AgentMode, ForkCreateInput, IntercomTaskDto, PeerDto } from '../api';
import { ClaudeIcon, CodexIcon, OpencodeIcon, PiIcon } from './hub/icons';

export const FORK_NOTES_MAX = 4096; // bytes, UTF-8 — same value as the server

export type ForkDialogProps = {
  source: { agentId: string; mode: AgentMode; worktreePath: string; alias: string | null };
  peers: PeerDto[]; // the workspace's peers; the dialog filters to live ones except the source
  tasks: IntercomTaskDto[]; // the dialog filters to status === 'open'
  busy: boolean;
  error: string | null;
  onSubmit: (input: ForkCreateInput) => void;
  onCancel: () => void;
};

const LABEL: Record<AgentMode, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
const ICON = { claude: ClaudeIcon, codex: CodexIcon, opencode: OpencodeIcon, pi: PiIcon };
const MODES: AgentMode[] = ['claude', 'codex', 'opencode', 'pi'];

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function ForkDialog({ source, peers, tasks, busy, error, onSubmit, onCancel }: ForkDialogProps) {
  const livePeers = useMemo(() => peers.filter((p) => p.live && p.agentId !== source.agentId), [peers, source.agentId]);
  const openTasks = useMemo(() => tasks.filter((t) => t.status === 'open'), [tasks]);

  const [peerMode, setPeerMode] = useState(livePeers.length > 0);
  const [selectedPeer, setSelectedPeer] = useState(livePeers[0]?.agentId ?? '');
  const [mode, setMode] = useState<AgentMode>(source.mode);
  const [notes, setNotes] = useState('');
  const [taskId, setTaskId] = useState('');

  const bytes = useMemo(() => new TextEncoder().encode(notes).length, [notes]);
  const overCap = bytes > FORK_NOTES_MAX;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  // The live peer list can change under the dialog (a peer dies, or a new one
  // joins) while it's open; keep the selection valid instead of letting it
  // point at a peer that is no longer selectable.
  useEffect(() => {
    if (!livePeers.some((p) => p.agentId === selectedPeer)) {
      setSelectedPeer(livePeers[0]?.agentId ?? '');
    }
  }, [livePeers, selectedPeer]);

  const submit = () => {
    onSubmit({
      source: source.agentId,
      notes,
      ...(taskId ? { taskId } : {}),
      ...(peerMode ? { to: selectedPeer } : { newTab: { mode } }),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { if (!busy) onCancel(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-title"
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="fork-title" className="text-base font-semibold text-zinc-100">Fork to…</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          Strado asks {source.alias ?? source.agentId} for a short summary (or uses its turn diary), then hands the summary, the last turns and the repo state to the target.
        </p>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-medium text-zinc-300">Target</legend>
          <div className="flex gap-4 text-sm text-zinc-300">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="fork-target"
                checked={peerMode}
                disabled={busy || livePeers.length === 0}
                onChange={() => setPeerMode(true)}
              />
              Live peer
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="fork-target"
                checked={!peerMode}
                disabled={busy}
                onChange={() => setPeerMode(false)}
              />
              New tab
            </label>
          </div>

          {livePeers.length === 0 && (
            <p className="mt-2 text-xs text-zinc-600">No other live agents in this workspace</p>
          )}

          {peerMode ? (
            <select
              aria-label="Peer"
              value={selectedPeer}
              disabled={busy}
              onChange={(event) => setSelectedPeer(event.target.value)}
              className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
            >
              {livePeers.map((p) => (
                <option key={p.agentId} value={p.agentId}>
                  {`${p.alias ?? p.agentId} (${p.mode} · ${basename(p.worktreePath)})`}
                </option>
              ))}
            </select>
          ) : (
            <div className="mt-2">
              <div className="grid grid-cols-4 gap-2">
                {MODES.map((m) => {
                  const ModeIcon = ICON[m];
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={busy}
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                      className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm transition ${
                        mode === m
                          ? 'border-sky-500/60 bg-sky-500/10 text-sky-100'
                          : 'border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900'
                      }`}
                    >
                      <ModeIcon className="text-zinc-500" />
                      <span>{LABEL[m]}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-zinc-600">Opens in {basename(source.worktreePath)}</p>
            </div>
          )}
        </fieldset>

        <label className="mt-4 block text-xs font-medium text-zinc-300" htmlFor="fork-notes">
          Notes for the target <span className="font-normal text-zinc-600">Optional</span>
        </label>
        <textarea
          id="fork-notes"
          aria-label="Notes for the target"
          autoFocus
          value={notes}
          disabled={busy}
          onChange={(event) => setNotes(event.target.value)}
          className="mt-2 h-24 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        <p className={`mt-1 text-[11px] ${overCap ? 'text-red-400' : 'text-zinc-600'}`}>{bytes} / {FORK_NOTES_MAX} bytes</p>

        <label className="mt-3 block text-xs font-medium text-zinc-300" htmlFor="fork-task">
          Task <span className="font-normal text-zinc-600">Optional</span>
        </label>
        <select
          id="fork-task"
          aria-label="Task"
          value={taskId}
          disabled={busy}
          onChange={(event) => setTaskId(event.target.value)}
          className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
        >
          <option value="">No task</option>
          {openTasks.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>

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
            disabled={busy || overCap || (peerMode && !selectedPeer)}
            onClick={submit}
            className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? 'Forking…' : 'Fork'}
          </button>
        </div>
      </div>
    </div>
  );
}
