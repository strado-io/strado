// New focus: a centred dialog that seeds the Focus at creation. From ticket
// (pick one of your open tickets: the name follows, the ticket is linked,
// worktrees with that ticket are pre-checked), From worktrees (the picker),
// Blank, or New worktree (make one, NewWorktreeDialog's way, then the Focus
// with it; or, with a Focus active, add it there instead). All tabs share the
// name and the checked set; Create & switch makes the Focus and activates it.
// A seed worktree (the hub gate's pending open) arrives pre-checked and names
// a blank Focus.
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
import { mainBranchOf, useSourceBranches } from '../NewWorktreeDialog';
import { SearchSelect } from '../SearchSelect';
import { JobSteps } from '../JobSteps';
import { useJobSteps } from '../../hooks/jobSteps';
import { startWorktreeJob } from '../../lib/worktreeJob';
import { createdPinId } from '../sidebar/pinIds';

type Tab = 'ticket' | 'worktrees' | 'blank' | 'worktree';

/** A Focus name as a worktree name; the server makes the branch from it. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function FocusComposer({ workspaceId, repos, worktrees, remoteWorktrees, seedPinId, activeFocus, onCreate, onAddToFocus, onClose }: {
  /** Where a new worktree is made (the New worktree tab); without it the tab is not offered. */
  workspaceId?: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  /** A worktree to start from: pre-checked, and the name when nothing else gives one. */
  seedPinId?: string | null;
  /** The Focus active now: the New worktree tab can add to it instead. */
  activeFocus?: { id: string; name: string } | null;
  onCreate: (name: string, members: string[], ticket?: FocusTicket) => void;
  /** The New worktree tab's "Add to <active Focus>". */
  onAddToFocus?: (focusId: string, pinId: string) => void;
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
  const [ticketSummary, setTicketSummary] = useState<string | null>(null);

  // New worktree: the repo, its name (the branch follows), where it starts,
  // and whether it joins the active Focus or makes a new one.
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const repo = repos.find((r) => r.id === repoId);
  const [wtName, setWtName] = useState('');
  const [wtTouched, setWtTouched] = useState(false);
  const [base, setBase] = useState(mainBranchOf(worktrees, repos[0]) ?? 'main');
  // Asked of git only once the tab is open.
  const branches = useSourceBranches(tab === 'worktree' ? workspaceId : undefined, repo, worktrees, base);
  const [target, setTarget] = useState<'add' | 'new'>(activeFocus ? 'add' : 'new');
  const [jobId, setJobId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [wtError, setWtError] = useState<string | null>(null);
  const progress = useJobSteps(jobId);

  useEffect(() => {
    // A worktree on its way: closing would drop its Focus.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (!creating) onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, creating]);
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
    setTicketSummary(summary ?? null);
    if (!nameTouched) setName(summary ? `${t.key} · ${summary}` : t.key);
    setSelected((prev) => new Set([...prev, ...withTicket(t.key)]));
  };

  const q = query.trim().toLowerCase();
  const visibleIssues = (issues ?? []).filter((i) => !q || i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q));
  const typedKey = /^[a-z]+-\d+$/i.test(query.trim()) && !(issues ?? []).some((i) => i.key.toLowerCase() === q) ? query.trim().toUpperCase() : null;
  // The worktree's name follows the ticket, else the Focus name; the Focus
  // name follows the worktree's when it has none of its own.
  const wtShown = wtTouched ? wtName : ticket ? (ticketSummary || ticket.key) : slug(name);
  const focusName = name || (wtTouched ? wtName : '');
  const adding = tab === 'worktree' && target === 'add' && !!activeFocus;
  const canCreate = tab === 'worktree'
    ? !creating && !!repo && wtShown.trim().length > 0 && (adding || focusName.trim().length > 0)
    : name.trim().length > 0;
  // The job finished: the worktree joins the active Focus, or a new one made with it.
  useEffect(() => {
    if (!progress.done) return;
    const pinId = createdPinId(progress.result);
    if (pinId) {
      if (adding) onAddToFocus?.(activeFocus!.id, pinId);
      else onCreate(focusName.trim(), [pinId], ticket ?? undefined);
    }
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress.done]);
  useEffect(() => { if (progress.error) setCreating(false); }, [progress.error]);
  const submitWorktree = async () => {
    if (!workspaceId || !repo) return;
    setWtError(null);
    setCreating(true);
    try {
      const started = await startWorktreeJob(workspaceId, {
        repoId: repo.id, ticketId: ticket?.key ?? '', ticketProvider: ticket?.provider,
        title: wtShown.trim(), sourceBranch: base, sourceWorktree: repo.path,
      });
      if (started?.jobId) setJobId(started.jobId);
      else { setCreating(false); setWtError('Couldn’t start the worktree.'); }
    } catch (err) {
      setWtError(err instanceof Error ? err.message : 'Couldn’t create the worktree.');
      setCreating(false);
    }
  };
  const submit = () => {
    if (!canCreate) return;
    if (tab === 'worktree') { void submitWorktree(); return; }
    onCreate(name.trim(), [...selected], ticket ?? undefined);
    onClose();
  };

  const tabButton = (id: Tab, label: string) => (
    <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={`rounded-md px-2.5 py-1 text-xs ${tab === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>{label}</button>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={creating ? undefined : onClose}>
      <div role="dialog" aria-label={adding ? 'New worktree' : 'New focus'} onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-sky-400"><FocusIcon size={16} /></span>
          <h2 className="text-sm font-medium text-zinc-100">{adding ? 'New worktree' : 'New focus'}</h2>
          <div role="tablist" aria-label="Start from" className="ml-auto flex gap-0.5 rounded-md bg-zinc-900 p-0.5">
            {configured.length > 0 && tabButton('ticket', 'From ticket')}
            {tabButton('worktrees', 'From worktrees')}
            {tabButton('blank', 'Blank')}
            {workspaceId && repos.length > 0 && tabButton('worktree', 'New worktree')}
          </div>
        </div>

        {tab === 'ticket' && (
          <div className="flex min-h-0 flex-col gap-2">
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tickets"
              placeholder="Search tickets or type a key…"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none" />
            <div role="listbox" aria-label="Tickets" className="flex max-h-48 min-h-0 flex-col overflow-y-auto">
              {issues === null && <p className="px-2 py-2 text-xs text-zinc-600">Loading…</p>}
              {issues !== null && issuesFailed && <p className="px-2 py-2 text-xs text-amber-500/80">Could not load tickets.</p>}
              {issues !== null && !issuesFailed && visibleIssues.length === 0 && !typedKey && (
                <p className="px-2 py-2 text-xs text-zinc-600">{issues.length === 0 ? 'No open tickets.' : 'No match.'}</p>
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

        {tab === 'worktree' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <label className="flex min-w-0 items-center gap-1.5">
                <span>Project</span>
                <select aria-label="Project" value={repoId} disabled={creating}
                  onChange={(e) => { setRepoId(e.target.value); setBase(mainBranchOf(worktrees, repos.find((r) => r.id === e.target.value)) ?? 'main'); }}
                  className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200 focus:outline-none">
                  {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <span className="ml-auto shrink-0">from</span>
              <SearchSelect value={base} options={branches} onSelect={setBase} ariaLabel="Source branch" placeholder="Search branches…" align="right" />
            </div>
            <input autoFocus value={wtShown} aria-label="Worktree name" disabled={creating}
              onChange={(e) => { setWtName(e.target.value); setWtTouched(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              placeholder="Branch / worktree name"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 font-mono text-sm text-zinc-200 placeholder:font-sans placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none" />
            {activeFocus && (
              <div role="radiogroup" aria-label="Put it in" className="flex flex-col gap-1 text-xs text-zinc-400">
                <label className="flex items-center gap-2"><input type="radio" name="wt-target" checked={target === 'add'} disabled={creating} onChange={() => setTarget('add')} />Add to {activeFocus.name}</label>
                <label className="flex items-center gap-2"><input type="radio" name="wt-target" checked={target === 'new'} disabled={creating} onChange={() => setTarget('new')} />New focus with it</label>
              </div>
            )}
            {jobId && <JobSteps progress={progress} />}
            {wtError && <p className="rounded-md bg-red-950/60 px-2.5 py-1.5 text-xs text-red-200">{wtError}</p>}
          </div>
        )}

        {!adding && <label className="flex flex-col gap-1 text-xs text-zinc-500">
          <input autoFocus={tab === 'blank'} value={tab === 'worktree' ? focusName : name} aria-label="Focus name"
            onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder="Name"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none" />
        </label>}

        <div className="flex items-center gap-2">
          {tab !== 'worktree' && selected.size > 0 && <span className="text-xs text-zinc-600">{selected.size} worktree{selected.size === 1 ? '' : 's'} selected</span>}
          <span className="flex-1" />
          <button type="button" onClick={onClose} disabled={creating} className="rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200">Cancel</button>
          <button type="button" onClick={submit} disabled={!canCreate}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40">
            {tab !== 'worktree' ? 'Create & switch' : creating ? 'Creating…' : adding ? 'Create' : 'Create & switch'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
