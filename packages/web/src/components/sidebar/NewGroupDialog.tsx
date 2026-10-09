// New focus group: a name — your own, or a ticket's — and, optionally, the
// worktrees (any repo) to start it with. Laid out like the New worktree
// dialog. More can be added later from a worktree's ⋯ → Add to group….
// In-app because the desktop shell (Electron) has no window.prompt.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type TicketIssueDto } from '../../api';
import { useTickets } from '../../hooks/tickets';
import { TicketSourceBadge } from '../TicketSourceBadge';

export type GroupCandidate = { pinId: string; label: string; repoName: string };

const MAX_NAME = 80; // the server's limit

export function NewGroupDialog({ candidates, initialMembers = [], onCreate, onCancel }: {
  /** Worktrees that can start in the group. */
  candidates: GroupCandidate[];
  /** Ticked from the start — the worktree whose menu opened the dialog. */
  initialMembers?: string[];
  onCreate: (name: string, members: string[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(initialMembers);
  const [filter, setFilter] = useState('');
  const [ticketOpen, setTicketOpen] = useState(false);

  useEffect(() => {
    // The ticket popover takes the first Escape, the dialog the next.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ticketOpen) setTicketOpen(false);
      else onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, ticketOpen]);

  const trimmed = name.trim();
  const submit = () => { if (trimmed) onCreate(trimmed, picked); };
  const q = filter.trim().toLowerCase();
  const shown = q
    ? candidates.filter((c) => c.label.toLowerCase().includes(q) || c.repoName.toLowerCase().includes(q))
    : candidates;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="New group"
        className="flex w-full max-w-xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-14 items-center gap-2.5 border-b border-zinc-800 px-5 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-zinc-500" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
              <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
            </svg>
          </span>
          <span className="text-sm font-medium text-zinc-200">New group</span>
        </div>

        <div className="px-5 pb-3 pt-5">
          <input
            autoFocus
            aria-label="Group name"
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Name this group, or pick a ticket below"
            className="w-full bg-transparent text-lg text-zinc-100 outline-none placeholder:text-zinc-600"
          />

          {candidates.length > 0 && (
            <div className="mt-4 rounded-lg border border-zinc-800">
              <input
                aria-label="Filter worktrees"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Add worktrees (optional)${picked.length ? ` · ${picked.length} selected` : ''}`}
                className="w-full border-b border-zinc-800 bg-transparent px-3 py-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
              />
              <div className="max-h-48 overflow-y-auto p-1">
                {shown.map((c) => (
                  <label key={c.pinId}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900">
                    <input type="checkbox" aria-label={`${c.repoName} ${c.label}`} checked={picked.includes(c.pinId)}
                      onChange={() => toggle(c.pinId)} className="h-3.5 w-3.5 shrink-0 accent-sky-500" />
                    <span className="min-w-0 flex-1 truncate font-mono">{c.label}</span>
                    <span className="max-w-[10rem] shrink-0 truncate text-[11px] text-zinc-600">{c.repoName}</span>
                  </label>
                ))}
                {shown.length === 0 && <div className="px-2 py-1.5 text-xs text-zinc-600">No matching worktrees.</div>}
              </div>
            </div>
          )}

          <div className="mt-4 flex items-end justify-between gap-3">
            <TicketButton open={ticketOpen} setOpen={setTicketOpen}
              onPick={(issue) => setName(`${issue.key} ${issue.summary}`.slice(0, MAX_NAME).trim())} />
            <div className="flex shrink-0 gap-2">
              <button onClick={onCancel} className="h-8 rounded-md px-3 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">
                Cancel
              </button>
              <button onClick={submit} disabled={!trimmed}
                className="h-8 rounded-md bg-sky-700 px-3 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
                Create group
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "Add ticket": your open tickets from every connected tracker, loaded on first open. */
function TicketButton({ open, setOpen, onPick }: {
  open: boolean;
  setOpen: (v: boolean) => void;
  onPick: (issue: TicketIssueDto) => void;
}) {
  const { configured } = useTickets();
  const [issues, setIssues] = useState<TicketIssueDto[] | null>(null);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // On demand, like the New worktree dialog: opening this dialog never calls
  // Jira/Linear. One tracker failing still shows the others' tickets.
  useEffect(() => {
    if (!open || issues || configured.length === 0) return;
    let live = true;
    Promise.all(configured.map((p) => api.tickets.myIssues(p).catch(() => [])))
      .then((lists) => { if (live) setIssues(lists.flat()); });
    return () => { live = false; };
  }, [open, issues, configured]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, setOpen]);

  const q = query.trim().toLowerCase();
  const shown = (issues ?? []).filter((i) => !q || i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q));

  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex h-8 items-center gap-2 rounded-md px-2.5 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300">
        <svg className="shrink-0" width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 4.5v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2Z" />
          <path d="M5.5 6h5M5.5 9h3" />
        </svg>
        Add ticket
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-96 max-w-[calc(100vw-3rem)] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl">
          <div className="border-b border-zinc-800 p-2.5">
            <input autoFocus aria-label="Find a ticket" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a ticket…"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500" />
          </div>
          <div className="max-h-52 overflow-y-auto p-1" role="listbox" aria-label="My open tickets">
            {configured.length === 0 ? (
              <div className="px-3 py-3 text-xs text-zinc-500">No ticket provider is connected. Type a name instead.</div>
            ) : !issues ? (
              <div className="px-3 py-3 text-xs text-zinc-500">Loading your open tickets…</div>
            ) : shown.length === 0 ? (
              <div className="px-3 py-3 text-xs text-zinc-500">{issues.length ? 'No matching tickets.' : 'No open tickets found.'}</div>
            ) : shown.map((issue) => (
              <button type="button" role="option" aria-selected={false} key={`${issue.provider}:${issue.key}`}
                onClick={() => { onPick(issue); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-zinc-900">
                <TicketSourceBadge provider={issue.provider} />
                <span className="shrink-0 font-mono text-sky-300">{issue.key}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-300">{issue.summary}</span>
                <span className="shrink-0 text-[10px] uppercase text-zinc-600">{issue.status}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
