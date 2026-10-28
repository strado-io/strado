// New focus: one box — say what you're working on, Enter. The first line names
// the Focus; the rest is the task. Everything else is optional, in place:
// - the agent menu: start Claude / Codex / … in the worktree with the task as
//   its first prompt (needs a worktree);
// - 🎫: link a ticket (fills the name, adds the worktrees already on it);
// - ⑂: add existing worktrees, shown as chips over the text;
// - beside the agent, the project and its worktree: a new one (its branch named
//   from the first line), an existing one, or the main checkout. No project:
//   a Focus with just what's chipped (or nothing).
// A seed worktree (the hub gate's pending open) arrives as a chip and names it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FocusTicket, RemoteWorktree, TicketIssueDto, TicketProviderId } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import { useTickets } from '../../hooks/tickets';
import { useRendererOverlay } from '../../contexts/RendererOverlay';
import { worktreeLabel } from '../sidebar/labels';
import { createdPinId, localPinId, remotePinId } from '../sidebar/pinIds';
import { WorktreePicker } from './WorktreePicker';
import { loadMyTickets } from './myTickets';
import { mainBranchOf } from '../NewWorktreeDialog';
import { JobSteps } from '../JobSteps';
import { useJobSteps } from '../../hooks/jobSteps';
import { startWorktreeJob } from '../../lib/worktreeJob';
import { ClaudeIcon, CodexIcon, OpencodeIcon, PiIcon } from '../hub/icons';

export type AgentMode = 'claude' | 'codex' | 'opencode' | 'pi';
const AGENTS: { mode: AgentMode; label: string; icon: ReactNode }[] = [
  { mode: 'claude', label: 'Claude', icon: <ClaudeIcon size={13} /> },
  { mode: 'codex', label: 'Codex', icon: <CodexIcon size={13} /> },
  { mode: 'opencode', label: 'OpenCode', icon: <OpencodeIcon size={13} /> },
  { mode: 'pi', label: 'Pi', icon: <PiIcon size={13} /> },
];

/** A Focus name as a worktree name; the server makes the branch from it. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Where the Focus's own worktree comes from, once a project is picked. */
type Place = { kind: 'new' } | { kind: 'main' } | { kind: 'existing'; pinId: string };

export function FocusComposer({ workspaceId, repos, worktrees, remoteWorktrees, seedPinId, onCreate, onStartAgent, onClose }: {
  /** Where a new worktree is made; without it, projects can't make one. */
  workspaceId?: string;
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  /** A worktree to start from: a chip, and the name when nothing else gives one. */
  seedPinId?: string | null;
  onCreate: (name: string, members: string[], ticket?: FocusTicket) => Promise<unknown> | void;
  /** After the Focus exists: start `mode` in that worktree with the task as its first prompt. */
  onStartAgent?: (worktreePath: string, mode: AgentMode, prompt: string) => void;
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

  const [text, setText] = useState(seed?.label ?? '');
  const [chips, setChips] = useState<Set<string>>(() => new Set(seed ? [seed.pinId] : []));
  const [ticket, setTicket] = useState<FocusTicket | null>(seed?.ticket ? { provider: seed.provider ?? 'jira', key: seed.ticket } : null);
  const [agent, setAgent] = useState<AgentMode | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [place, setPlace] = useState<Place>({ kind: 'new' });
  const [menu, setMenu] = useState<'agent' | 'ticket' | 'worktrees' | 'project' | 'place' | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useJobSteps(jobId);
  const box = useRef<HTMLTextAreaElement>(null);

  const repo = repos.find((r) => r.id === repoId) ?? null;
  const firstLine = text.split('\n')[0]!.trim();
  const task = text.trim();
  const name = firstLine || (ticket ? ticket.key : '');
  const repoWorktrees = repo ? worktrees.filter((w) => w.repoId === repo.id && w.path !== repo.path) : [];
  const mainCheckout = repo ? worktrees.find((w) => w.path === repo.path) ?? null : null;
  const placeLabel = !repo ? null
    : place.kind === 'new' ? 'New worktree'
    : place.kind === 'main' ? 'Main checkout'
    : worktreeLabel(worktrees.find((w) => localPinId(w) === place.pinId) ?? ({ path: place.pinId } as Worktree));
  // The worktree the agent would start in, before anything is made.
  const agentTarget = (): Worktree | null => {
    if (repo && place.kind === 'main') return mainCheckout;
    if (repo && place.kind === 'existing') return worktrees.find((w) => localPinId(w) === place.pinId) ?? null;
    const first = [...chips].map((id) => worktrees.find((w) => localPinId(w) === id)).find(Boolean);
    return first ?? null;
  };
  // An agent needs somewhere to run: a new worktree on the way, or one already there.
  const needsWorktree = !!agent && !(repo && place.kind === 'new') && !agentTarget();
  const canCreate = !creating && name.length > 0 && !needsWorktree;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (menu) setMenu(null);
      else if (!creating) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, creating, menu]);

  // Done: the Focus with everything chipped (and the new worktree), then the agent.
  const finish = async (made: { pinId: string; path: string } | null) => {
    const members = new Set(chips);
    if (repo && place.kind === 'main' && mainCheckout) members.add(localPinId(mainCheckout));
    if (repo && place.kind === 'existing') members.add(place.pinId);
    if (made) members.add(made.pinId);
    await onCreate(name, [...members], ticket ?? undefined);
    const target = made?.path ?? agentTarget()?.path;
    if (agent && target) onStartAgent?.(target, agent, task);
    onClose();
  };
  useEffect(() => {
    if (!progress.done) return;
    const pinId = createdPinId(progress.result);
    const path = pinId?.startsWith('local:') ? pinId.slice('local:'.length) : null;
    void finish(pinId && path ? { pinId, path } : null).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setCreating(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress.done]);
  useEffect(() => { if (progress.error) setCreating(false); }, [progress.error]);

  const submit = async () => {
    if (!canCreate) return;
    setError(null);
    setCreating(true);
    try {
      if (repo && place.kind === 'new' && workspaceId) {
        const started = await startWorktreeJob(workspaceId, {
          repoId: repo.id, ticketId: ticket?.key ?? '', ticketProvider: ticket?.provider,
          title: slug(firstLine) || ticket?.key || 'focus', sourceBranch: mainBranchOf(worktrees, repo) ?? 'main', sourceWorktree: repo.path,
        });
        if (started?.jobId) setJobId(started.jobId);
        else { setCreating(false); setError('Couldn’t start the worktree.'); }
        return;
      }
      await finish(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const toggleChip = (pinId: string, on: boolean) => setChips((prev) => { const next = new Set(prev); on ? next.add(pinId) : next.delete(pinId); return next; });
  const chipLabel = (pinId: string) => {
    const local = worktrees.find((w) => localPinId(w) === pinId);
    if (local) return worktreeLabel(local);
    const remote = remoteWorktrees.find((w) => remotePinId(w) === pinId);
    return remote ? (remote.branch ?? remote.name) : pinId;
  };
  const pickTicket = (t: FocusTicket, summary?: string) => {
    setTicket(t);
    if (!firstLine) setText(summary ? `${t.key}: ${summary}` : t.key);
    const onIt = worktrees.filter((w) => w.meta?.ticketId?.trim().toLowerCase() === t.key.toLowerCase()).map(localPinId);
    setChips((prev) => new Set([...prev, ...onIt]));
    setMenu(null);
    box.current?.focus();
  };
  const agentInfo = AGENTS.find((a) => a.mode === agent);
  const iconBtn = (on: boolean) => `flex h-8 w-8 items-center justify-center rounded-lg transition ${on ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'}`;
  const footChip = 'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200 disabled:opacity-50';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[18vh]" onMouseDown={creating ? undefined : onClose}>
      <div role="dialog" aria-label="New focus" onMouseDown={(e) => e.stopPropagation()} className="flex w-full max-w-2xl flex-col gap-2">
        <div className="relative flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          {(chips.size > 0 || ticket) && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {ticket && (
                <span className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                  <TicketIcon />{ticket.key}
                  <button type="button" aria-label={`Unlink ${ticket.key}`} onClick={() => setTicket(null)} className="ml-0.5 text-zinc-500 hover:text-zinc-200">×</button>
                </span>
              )}
              {[...chips].map((id) => (
                <span key={id} className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">
                  <BranchIcon />{chipLabel(id)}
                  <button type="button" aria-label={`Remove ${chipLabel(id)}`} onClick={() => toggleChip(id, false)} className="ml-0.5 text-zinc-500 hover:text-zinc-200">×</button>
                </span>
              ))}
            </div>
          )}
          <textarea ref={box} autoFocus rows={2} value={text} disabled={creating} aria-label="What are you working on?"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
            placeholder="What are you working on?"
            className="min-h-[64px] w-full resize-none bg-transparent px-4 pt-3 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500" />
          {needsWorktree && <p className="px-4 pb-1 text-[12px] text-amber-400/90">Pick a project or a worktree for {agentInfo?.label}</p>}
          <div className="flex items-center gap-1.5 px-3 pb-3">
            <span className="relative">
              <button type="button" onClick={() => setMenu(menu === 'agent' ? null : 'agent')} aria-label="Agent" aria-expanded={menu === 'agent'}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 text-[13px] text-zinc-300 hover:border-zinc-600">
                {agentInfo ? <>{agentInfo.icon}{agentInfo.label}</> : 'No agent'}
                <ChevronIcon />
              </button>
              {menu === 'agent' && (
                <Popover onClose={() => setMenu(null)} className="left-0 top-full mt-1 w-48">
                  <MenuItem on={!agent} onClick={() => { setAgent(null); setMenu(null); }}>No agent</MenuItem>
                  {AGENTS.map((a) => (
                    <MenuItem key={a.mode} on={agent === a.mode} onClick={() => { setAgent(a.mode); setMenu(null); }}>{a.icon}{a.label}</MenuItem>
                  ))}
                </Popover>
              )}
            </span>
            <span className="relative min-w-0">
              <button type="button" className={footChip} disabled={creating} onClick={() => setMenu(menu === 'project' ? null : 'project')} aria-label="Project" aria-expanded={menu === 'project'}>
                <BoxIcon />{repo ? repo.name : 'No project'}<UpDownIcon />
              </button>
              {menu === 'project' && (
                <Popover onClose={() => setMenu(null)} className="left-0 top-full mt-1 w-64">
                  <MenuItem on={!repo} onClick={() => { setRepoId(null); setMenu(null); }}>No project</MenuItem>
                  {repos.map((r) => (
                    <MenuItem key={r.id} on={repoId === r.id} onClick={() => { setRepoId(r.id); setPlace({ kind: 'new' }); setMenu(null); }}>{r.name}</MenuItem>
                  ))}
                </Popover>
              )}
            </span>
            {repo && (
              <span className="relative min-w-0">
                <button type="button" className={footChip} disabled={creating} onClick={() => setMenu(menu === 'place' ? null : 'place')} aria-label="Worktree" aria-expanded={menu === 'place'}>
                  <BranchIcon />{placeLabel}<UpDownIcon />
                </button>
                {menu === 'place' && repo && (
                  <Popover onClose={() => setMenu(null)} className="left-0 top-full mt-1 w-72">
                    <MenuItem on={place.kind === 'new'} onClick={() => { setPlace({ kind: 'new' }); setMenu(null); }}>
                      New worktree{firstLine && <span className="ml-auto truncate font-mono text-[11px] text-zinc-500">{slug(firstLine)}</span>}
                    </MenuItem>
                    {mainCheckout && <MenuItem on={place.kind === 'main'} onClick={() => { setPlace({ kind: 'main' }); setMenu(null); }}>Main checkout</MenuItem>}
                    {repoWorktrees.length > 0 && <div className="mx-2 my-1 h-px bg-zinc-800" />}
                    {repoWorktrees.map((w) => (
                      <MenuItem key={w.path} on={place.kind === 'existing' && place.pinId === localPinId(w)}
                        onClick={() => { setPlace({ kind: 'existing', pinId: localPinId(w) }); setMenu(null); }}>{worktreeLabel(w)}</MenuItem>
                    ))}
                  </Popover>
                )}
              </span>
            )}
            <span className="flex-1" />
            {configured.length > 0 && (
              <button type="button" onClick={() => setMenu(menu === 'ticket' ? null : 'ticket')} aria-label="Link a ticket" title="Link a ticket" className={iconBtn(!!ticket)}><TicketIcon size={15} /></button>
            )}
            <button type="button" onClick={() => setMenu(menu === 'worktrees' ? null : 'worktrees')} aria-label="Add worktrees" title="Add existing worktrees" className={iconBtn(chips.size > 0)}><BranchIcon size={15} /></button>
            <button type="button" onClick={() => void submit()} disabled={!canCreate} aria-label="Create focus" title="Create (Enter)"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-400">
              {creating ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-zinc-950" /> : <ArrowUpIcon />}
            </button>
          </div>

          {menu === 'ticket' && <TicketMenu configured={configured} selected={ticket} worktrees={worktrees} onPick={pickTicket} onClose={() => setMenu(null)} />}
          {menu === 'worktrees' && (
            <Popover onClose={() => setMenu(null)} className="right-12 top-full mt-1 w-96 p-2" scroll={false}>
              <WorktreePicker repos={repos} worktrees={worktrees} remoteWorktrees={remoteWorktrees} selected={chips} onToggle={toggleChip} autoFocus />
            </Popover>
          )}
        </div>

        {jobId && <div className="px-2"><JobSteps progress={progress} /></div>}
        {error && <p role="alert" className="mx-2 rounded-md bg-red-950/60 px-2.5 py-1.5 text-xs text-red-200">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}

/** `scroll`: false when the content scrolls itself (the worktree picker's list), so there's one scrollbar. */
function Popover({ children, className, onClose, scroll = true }: { children: ReactNode; className: string; onClose: () => void; scroll?: boolean }) {
  return (
    <>
      <div className="fixed inset-0 z-10" onMouseDown={onClose} />
      <div role="menu" className={`menu-solid absolute z-20 rounded-xl border p-1 ${scroll ? 'max-h-80 overflow-y-auto' : 'flex max-h-96 flex-col overflow-hidden'} ${className}`}>{children}</div>
    </>
  );
}

function MenuItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={onClick}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06] ${on ? 'text-zinc-100' : 'text-zinc-300'}`}>
      {children}
    </button>
  );
}

function TicketMenu({ configured, selected, worktrees, onPick, onClose }: {
  configured: TicketProviderId[];
  selected: FocusTicket | null;
  worktrees: Worktree[];
  onPick: (t: FocusTicket, summary?: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<TicketIssueDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadMyTickets(configured).then((list) => { if (alive) setIssues(list); }).catch(() => { if (alive) { setIssues([]); setFailed(true); } });
    return () => { alive = false; };
  }, [configured]);
  const q = query.trim().toLowerCase();
  const shown = (issues ?? []).filter((i) => !q || i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q));
  const typedKey = /^[a-z]+-\d+$/i.test(query.trim()) && !(issues ?? []).some((i) => i.key.toLowerCase() === q) ? query.trim().toUpperCase() : null;
  const onIt = (key: string) => worktrees.filter((w) => w.meta?.ticketId?.trim().toLowerCase() === key.toLowerCase()).length;
  return (
    <Popover onClose={onClose} className="right-12 top-full mt-1 w-96">
      <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tickets" placeholder="Search tickets or type a key…"
        className="mb-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600" />
      {issues === null && <p className="px-2 py-1.5 text-[11px] text-zinc-500">Loading…</p>}
      {issues !== null && failed && <p className="px-2 py-1.5 text-[11px] text-amber-500/80">Could not load tickets.</p>}
      {issues !== null && !failed && shown.length === 0 && !typedKey && <p className="px-2 py-1.5 text-[11px] text-zinc-500">{issues.length === 0 ? 'No open tickets.' : 'No match.'}</p>}
      {shown.map((i) => (
        <MenuItem key={`${i.provider}:${i.key}`} on={selected?.key === i.key} onClick={() => onPick({ provider: i.provider, key: i.key }, i.summary)}>
          <span className="shrink-0 font-mono text-[11px] text-zinc-400">{i.key}</span>
          <span className="min-w-0 flex-1 truncate">{i.summary}</span>
          {onIt(i.key) > 0 && <span className="shrink-0 text-[10px] text-zinc-600">{onIt(i.key)} worktree{onIt(i.key) === 1 ? '' : 's'}</span>}
        </MenuItem>
      ))}
      {typedKey && <MenuItem on={false} onClick={() => onPick({ provider: configured[0] ?? 'jira', key: typedKey })}><span className="font-mono text-[11px]">{typedKey}</span>Use this key</MenuItem>}
    </Popover>
  );
}

const svg = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
// A task, as Jira and Linear draw one: a checked square.
const TicketIcon = ({ size = 12 }: { size?: number }) => svg(size, <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="m8 12 3 3 5-6" /></>);
const BranchIcon = ({ size = 12 }: { size?: number }) => svg(size, <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M6 9v6M18 9a9 9 0 0 1-9 9" /></>);
const BoxIcon = () => svg(14, <><path d="M21 8 12 3 3 8v8l9 5 9-5Z" /><path d="m3 8 9 5 9-5M12 13v8" /></>);
const UpDownIcon = () => svg(12, <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />);
const ChevronIcon = () => svg(12, <path d="m6 9 6 6 6-6" />);
const ArrowUpIcon = () => svg(15, <path d="M12 19V5M5 12l7-7 7 7" />);
