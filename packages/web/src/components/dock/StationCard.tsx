import { useEffect, useRef, useState } from 'react';
import type { StationDto } from '../../api';
import { lightOf, statusText } from '../../lib/dock/stations';

export type FeedItem = { id: string; from: string; to: string; body: string; at: number };

const short = (id: string) => (id === 'human' ? 'you' : id.split('@')[0]!);

/** A station's card, opened by clicking its light. Calling you: the question
 * and a reply line (⏎ answers, "Hang up" dismisses). Otherwise a talk line
 * (⏎ types it into the station's prompt); a shell gets none, since nothing
 * reads a shell's inbox. ⌘⏎ opens its tab; Esc closes.
 *
 * The call is pinned when the card opens (or when one arrives before you type),
 * so an answer never lands on a different call raised while you were typing. */
export function StationCard({ station, recent, onAnswer, onDismiss, onTalk, onOpenTab, onClose }: {
  station: StationDto;
  recent?: FeedItem[];
  onAnswer: (callId: string, text: string) => Promise<unknown>;
  onDismiss: (callId: string) => Promise<unknown>;
  onTalk: (text: string) => Promise<unknown>;
  onOpenTab: () => void;
  onClose: () => void;
}) {
  const name = station.alias ?? station.name;
  const shell = station.mode === 'shell';
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<string | null>(() => station.calls[0]?.id ?? null);
  const first = station.calls[0]?.id ?? null;
  useEffect(() => { if (!pinned && first && !text) setPinned(first); }, [pinned, first, text]);
  const call = pinned ? station.calls.find((c) => c.id === pinned) ?? null : null;
  const ended = !!pinned && !call;
  const permission = !pinned && !!station.needsYou;
  const line = !permission && !shell;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Opened by the user, so the line is ready for typing.
  useEffect(() => { inputRef.current?.focus(); }, [station.agentId]);

  const send = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError((err as Error).message || 'That did not go through');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); onOpenTab(); return; }
    if (e.target !== inputRef.current || ended) return;
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    void send(() => (call ? onAnswer(call.id, t) : onTalk(t)));
  };

  return (
    <div
      role="dialog"
      aria-label={name}
      onKeyDown={onKey}
      className="absolute bottom-full right-0 z-[60] mb-1 w-full overflow-hidden border border-zinc-800 bg-zinc-950 text-sm shadow-2xl sm:right-4 sm:w-96 sm:rounded-lg"
    >
      <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
        <span className="font-medium text-zinc-100">{name}</span>
        <span className="text-xs text-zinc-500">{station.worktreeName}</span>
        <span className={`ml-auto text-xs ${lightOf(station) === 'calling' ? 'text-amber-300' : 'text-zinc-500'}`}>{statusText(lightOf(station))}</span>
      </div>
      <div className="space-y-2 px-3 py-2">
        {call && (
          <div>
            <div className="text-zinc-100">{call.title}</div>
            {call.body && <div className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-400">{call.body}</div>}
          </div>
        )}
        {ended && <div className="text-xs text-zinc-400">That call ended</div>}
        {permission && <div className="text-xs text-amber-300">Waiting for permission — ⌘⏎ opens its tab to answer it.</div>}
        {line && (
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy || ended}
            aria-label={call ? `Answer ${name}` : `Talk to ${name}`}
            placeholder={call ? 'Your answer…  ⏎' : `Tell ${name}…  ⏎`}
            className="h-8 w-full rounded border border-zinc-800 bg-zinc-900 px-2 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
        )}
        {error && <div role="alert" className="text-xs text-red-400">{error}</div>}
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          {call && (
            <button type="button" disabled={busy} onClick={() => void send(() => onDismiss(call.id))} className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
              Hang up
            </button>
          )}
          <button type="button" onClick={onOpenTab} className="rounded px-1.5 py-0.5 hover:bg-zinc-800 hover:text-zinc-200">Open tab ⌘⏎</button>
          <span className="ml-auto">esc</span>
        </div>
      </div>
      {recent && recent.length > 0 && (
        <div className="border-t border-zinc-900 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Recent</div>
          <ul className="space-y-0.5 text-xs text-zinc-400">
            {recent.slice(0, 5).map((m) => (
              <li key={m.id} className="truncate"><span className="text-zinc-500">{short(m.from)} → {short(m.to)}:</span> {m.body}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
