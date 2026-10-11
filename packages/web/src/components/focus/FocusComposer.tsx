// New focus: a centred dialog that seeds the Focus at creation. From ticket
// (pick one of your open tickets: the name follows, the ticket is linked,
// worktrees with that ticket are pre-checked), From worktrees (the picker),
// or Blank. All tabs share the name and the checked set; Create & switch
// makes the Focus and activates it. A seed worktree (the hub gate's pending
// open) arrives pre-checked and names a blank Focus.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FocusTicket, RemoteWorktree, TicketIssueDto, TicketProviderId } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import { useTickets } from '../../hooks/tickets';
import { useRendererOverlay } from '../../contexts/RendererOverlay';
import { worktreeLabel } from '../sidebar/labels';
import { localPinId, remotePinId } from '../sidebar/pinIds';
import { FocusIcon } from '../sidebar/FocusSwitcher';
import { WorktreePicker } from './WorktreePicker';
import { loadMyTickets } from './myTickets';

type Tab = 'ticket' | 'worktrees' | 'blank';

export function FocusComposer({ repos, worktrees, remoteWorktrees, seedPinId, onCreate, onClose }: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  /** A worktree to start from: pre-checked, and the name when nothing else gives one. */
  seedPinId?: string | null;
  onCreate: (name: string, members: string[], ticket?: FocusTicket) => void;
  onClose: () => void;
}) {
  useRendererOverlay(true);
  const { configured } = useTickets();
  const seed = useMemo(() => {
    if (!seedPinId) return null;
    const local = worktrees.find((w) => localPinId(w) === seedPinId);
    if (local) return { pinId: seedPinId, label: worktreeLabel(local), ticket: local.meta?.ticketId?.trim() || null, provider: local.meta?.ticketProvider as TicketProviderId | undefined };
    const remote = remoteWorktrees.find((w) => remotePinId(w) === seedPinId);
    if (remote) return { pinId: seedPinId, label: remote.branch ?? remote.name, ticket: null, provider: undefined };
    return null;
  }, [seedPinId, worktrees, remoteWorktrees]);
  const [tab, setTab] = useState<Tab>(seed ? 'worktrees' : configured.length > 0 ? 'ticket' : 'blank');
  const [name, setName] = useState(seed?.label ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(seed ? [seed.pinId] : []));
  const [ticket, setTicket] = useState<FocusTicket | null>(seed?.ticket ? { provider: seed.provider ?? 'jira', key: seed.ticket } : null);
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<TicketIssueDto[] | null>(null);
  const [issuesFailed, setIssuesFailed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  useEffect(() => {
    if (tab !== 'ticket' || issues) return;
    let alive = true;
    loadMyTickets(configured).then((list) => { if (alive) setIssues(list); }).catch(() => { if (alive) { setIssues([]); setIssuesFailed(true); } });
    return () => { alive = false; };
  }, [tab, issues, configured]);

  const toggle = (pinId: string, on: boolean) => setSelected((prev) => { const next = new Set(prev); on ? next.add(pinId) : next.delete(pinId); return next; });
  // Worktrees carrying a ticket join when it is picked.
  const withTicket = (key: string) => worktrees.filter((w) => w.meta?.ticketId?.trim().toLowerCase() === key.toLowerCase()).map(localPinId);
  const pickTicket = (t: FocusTicket, summary?: string) => {
    setTicket(t);
    if (!nameTouched) setName(summary ? `${t.key} · ${summary}` : t.key);
    setSelected((prev) => new Set([...prev, ...withTicket(t.key)]));
  };

  const q = query.trim().toLowerCase();
  const visibleIssues = (issues ?? []).filter((i) => !q || i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q));
  const typedKey = /^[a-z]+-\d+$/i.test(query.trim()) && !(issues ?? []).some((i) => i.key.toLowerCase() === q) ? query.trim().toUpperCase() : null;
  const canCreate = name.trim().length > 0;
  const submit = () => { if (canCreate) { onCreate(name.trim(), [...selected], ticket ?? undefined); onClose(); } };

  const tabButton = (id: Tab, label: string) => (
    <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={`rounded-md px-2.5 py-1 text-xs ${tab === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>{label}</button>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-label="New focus" onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-sky-400"><FocusIcon size={16} /></span>
          <h2 className="text-sm font-medium text-zinc-100">New focus</h2>
          <div role="tablist" aria-label="Start from" className="ml-auto flex gap-0.5 rounded-md bg-zinc-900 p-0.5">
            {configured.length > 0 && tabButton('ticket', 'From ticket')}
            {tabButton('worktrees', 'From worktrees')}
            {tabButton('blank', 'Blank')}
          </div>
        </div>

        {tab === 'ticket' && (
          <div className="flex min-h-0 flex-col gap-2">
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tickets"
              placeholder="Search your open tickets, or type a key…"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none" />
            <div role="listbox" aria-label="Tickets" className="flex max-h-48 min-h-0 flex-col overflow-y-auto">
              {issues === null && <p className="px-2 py-2 text-xs text-zinc-600">Loading your open tickets…</p>}
              {issues !== null && issuesFailed && <p className="px-2 py-2 text-xs text-amber-500/80">Could not load tickets; type a key instead.</p>}
              {issues !== null && !issuesFailed && visibleIssues.length === 0 && !typedKey && (
                <p className="px-2 py-2 text-xs text-zinc-600">{issues.length === 0 ? 'No open tickets found. Type a key to use one anyway.' : 'No match.'}</p>
              )}
              {visibleIssues.map((i) => {
                const on = ticket?.key === i.key && ticket.provider === i.provider;
                const n = withTicket(i.key).length;
                return (
                  <button key={`${i.provider}:${i.key}`} type="button" role="option" aria-selected={on} onClick={() => pickTicket({ provider: i.provider, key: i.key }, i.summary)}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-900 ${on ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-300'}`}>
                    <span className="shrink-0 font-mono text-xs text-zinc-400">{i.key}</span>
                    <span className="min-w-0 flex-1 truncate">{i.summary}</span>
                    {n > 0 && <span className="shrink-0 text-[10px] text-zinc-600">{n} worktree{n === 1 ? '' : 's'}</span>}
                  </button>
                );
              })}
              {typedKey && (
                <button type="button" role="option" aria-selected={ticket?.key === typedKey} onClick={() => pickTicket({ provider: configured[0] ?? 'jira', key: typedKey })}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-900">
                  <span className="shrink-0 font-mono text-xs text-zinc-400">{typedKey}</span>
                  <span className="min-w-0 flex-1 truncate">Use this key</span>
                </button>
              )}
            </div>
            {ticket && (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span>Linked to <span className="font-mono text-zinc-300">{ticket.key}</span></span>
                <button type="button" onClick={() => setTicket(null)} className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300">unlink</button>
              </div>
            )}
          </div>
        )}
        {tab === 'worktrees' && (
          <WorktreePicker repos={repos} worktrees={worktrees} remoteWorktrees={remoteWorktrees} selected={selected} onToggle={toggle} autoFocus />
        )}

        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Name
          <input autoFocus={tab === 'blank'} value={name} aria-label="Focus name"
            onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder={tab === 'ticket' ? 'Pick a ticket, or name it yourself' : 'What is this focus about?'}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none" />
        </label>

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600">{selected.size === 0 ? 'No worktrees selected' : `${selected.size} worktree${selected.size === 1 ? '' : 's'} selected`}</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">Cancel</button>
          <button type="button" onClick={submit} disabled={!canCreate}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
            Create & switch
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
