// Jarvis parser: typed text → Plan. The step builders are exported for
// model.ts, which turns a model's suggestion into the same Steps. Pure (no I/O, no clock), so the palette
// can re-run it on every keystroke and the tests can pin it as a table. P0
// has no model: prefixes, a rule table, navigation names, and a fallback that
// hands anything else to an agent as the human's message.
import { withSafety } from './safety';
import type {
  ActionArgs, ActionId, AgentMode, Chip, ParseContext, ParseInput, Place, Plan, PlanSource, Risk, Split, Step, StepOf,
  TabInfo, TabMode, TabRef, Target, Where,
} from './types';
import { SETTINGS, type AppPage } from './types';

const PAGE_LABEL: Record<AppPage, string> = { home: 'home', worktrees: 'Worktrees', reviews: 'Code reviews', usage: 'Usage' };

const AGENT_MODES: AgentMode[] = ['claude', 'codex', 'opencode', 'pi'];
const OPEN_MODES: (AgentMode | 'shell')[] = ['shell', 'claude', 'codex', 'opencode', 'pi'];
export const isAgentMode = (m: TabMode): m is AgentMode => (AGENT_MODES as string[]).includes(m);

// ---------- step construction ----------

type Meta = { risk: Risk; where: Where; undoable: boolean };

export function mk<A extends ActionId>(action: A, args: ActionArgs[A], target: Target, meta: Meta, chips: Chip[], ctx: ParseContext): Step {
  return withSafety({ action, args, target, ...meta, needsConfirm: false, chips } as StepOf<A> as Step, ctx);
}

// ---------- tabs and names ----------

const sameRef = (a: TabRef, b: TabRef) => a.worktreePath === b.worktreePath && a.mode === b.mode && a.sessionId === b.sessionId;
const infoOf = (ctx: ParseContext, ref: TabRef): TabInfo | undefined => ctx.tabs.find((t) => sameRef(t, ref));
const refOnly = (t: TabRef): TabRef =>
  ({ worktreePath: t.worktreePath, mode: t.mode, sessionId: t.sessionId, ...(t.executionId ? { executionId: t.executionId } : {}) });
const tabTarget = (ref: TabRef): Target => ({ kind: 'tab', ref: refOnly(ref) });
/** Focus and "last acted on" come from the hub without an execution id; the
 * strip's entry for the same slot has it, so a deictic target pins it too. */
export const tabTargetIn = (ctx: ParseContext, ref: TabRef): Target => tabTarget(infoOf(ctx, ref) ?? ref);

/** How a tab reads in a row: alias, else the agent id's local part, else mode-N. */
function nameOf(ctx: ParseContext, ref: TabRef): string {
  const t = infoOf(ctx, ref);
  if (t?.alias) return t.alias;
  if (t?.agentId) return t.agentId.split('@')[0]!;
  return `${ref.mode}-${ref.sessionId}`;
}
function targetName(ctx: ParseContext, t: Target): string {
  if (t.kind === 'tab') return nameOf(ctx, t.ref);
  if (t.kind === 'step') return 'the new tab';
  return 'the focus';
}

export const focusedTarget = (ctx: ParseContext): Target => (ctx.focused ? tabTargetIn(ctx, ctx.focused) : { kind: 'none' });
export const here = (ctx: ParseContext): string | null => ctx.currentWorktree ?? ctx.focused?.worktreePath ?? null;
const inWorktree = (ctx: ParseContext, path: string | null) => ctx.tabs.filter((t) => t.worktreePath === path);

export type Resolved =
  | { kind: 'ok'; target: Target }
  | { kind: 'ambiguous'; options: TabRef[]; what: string }
  | { kind: 'none'; message: string };

const MODE_WORD: Record<string, TabMode> = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', shell: 'shell', terminal: 'shell', browser: 'browser' };

const AGENT_KIND: Record<string, TabMode | 'agent'> = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', agent: 'agent' };

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const namesCache = new WeakMap<ParseContext['worktrees'], Map<string, string>>();

/** Every worktree's unique context name: its plain name (ticket, branch or
 * directory) when no other worktree shares it, else "<repo>/<name>" for each
 * one that does (the parent directory when the repo is unknown). */
/** Context names arrive unique from the app (jarvisContext): the plain name,
 * or "<repo>/<name>" where several worktrees share it. Taken as given. */
export function worktreeNames(ctx: ParseContext): Map<string, string> {
  const hit = namesCache.get(ctx.worktrees);
  if (hit) return hit;
  const out = new Map(ctx.worktrees.map((w) => [w.path, w.name || baseName(w.path)] as const));
  namesCache.set(ctx.worktrees, out);
  return out;
}
export const worktreeLabel = (ctx: ParseContext, path: string): string => worktreeNames(ctx).get(path) ?? baseName(path);

export type WorktreeFound = { kind: 'ok'; path: string } | { kind: 'ambiguous'; paths: string[] } | { kind: 'none' };
/** A worktree by name: its unique context name; else its plain name, branch,
 * ticket or directory when only one worktree has it; else a repo name when
 * that repo has exactly one worktree. Several matches are never guessed. */
export function findWorktree(ctx: ParseContext, name: string): WorktreeFound {
  const n = name.trim().replace(/^#/, '').toLowerCase();
  if (!n) return { kind: 'none' };
  const names = worktreeNames(ctx);
  const exact = ctx.worktrees.find((w) => names.get(w.path)?.toLowerCase() === n);
  if (exact) return { kind: 'ok', path: exact.path };
  const pick = (list: ParseContext['worktrees']): WorktreeFound | null =>
    list.length === 1 ? { kind: 'ok', path: list[0]!.path } : list.length > 1 ? { kind: 'ambiguous', paths: list.map((w) => w.path) } : null;
  return pick(ctx.worktrees.filter((w) => [w.name, w.branch, w.ticketKey, baseName(w.path)].some((v) => v?.toLowerCase() === n)))
    ?? pick(ctx.worktrees.filter((w) => w.repoName?.toLowerCase() === n))
    ?? { kind: 'none' };
}

/** "wt/name": the context seen from that worktree (its focus and "it" only
 * if they are there), or null when `phrase` has no known worktree prefix. */
function scoped(phrase: string, ctx: ParseContext): { ctx: ParseContext; rest: string; path: string } | null {
  // The longest prefix that names one worktree: names may hold spaces and a
  // slash of their own ("Strado Website/main/claude-1").
  const p = phrase.trim();
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const rest = p.slice(i + 1).trim();
    const found = rest ? findWorktree(ctx, p.slice(0, i)) : null;
    if (found?.kind !== 'ok') continue;
    const path = found.path;
    const inside = (r: TabRef | null) => (r && r.worktreePath === path ? r : null);
    return { ctx: { ...ctx, currentWorktree: path, focused: inside(ctx.focused), lastActedOn: inside(ctx.lastActedOn) }, rest, path };
  }
  return null;
}

/** A bare kind ("claude", "the agent", "shell") picks among this worktree's
 * tabs only: the focused one if it is that kind, else the only one, else the
 * one last acted on, else a pick list. Another worktree needs "wt/name". */
function byKind<T extends TabRef>(pool: T[], ctx: ParseContext, what: string): { kind: 'ok'; hit: T } | { kind: 'ambiguous'; options: T[] } | { kind: 'none'; message: string } {
  const f = ctx.focused ? pool.find((t) => sameRef(t, ctx.focused!)) : undefined;
  if (f) return { kind: 'ok', hit: f };
  if (pool.length === 1) return { kind: 'ok', hit: pool[0]! };
  const l = ctx.lastActedOn ? pool.find((t) => sameRef(t, ctx.lastActedOn!)) : undefined;
  if (l) return { kind: 'ok', hit: l };
  if (pool.length > 1) return { kind: 'ambiguous', options: pool };
  return { kind: 'none', message: `No ${what} in this worktree` };
}
const kindMatch = (word: string): ((t: { mode: TabMode }) => boolean) | null => {
  const k = AGENT_KIND[word] ?? MODE_WORD[word];
  if (!k) return null;
  return k === 'agent' ? (t) => isAgentMode(t.mode) : (t) => t.mode === k;
};

export type AgentResolved = { kind: 'ok'; agentId: string } | { kind: 'ambiguous'; agentIds: string[]; what: string } | { kind: 'none'; message: string };

/** An agent named in a message: "this", an agent id or alias (anywhere), a
 * bare kind ("claude", "agent": see byKind), a local name ("claude-1": this
 * worktree only), or "wt/name" for another worktree. */
export function resolveAgent(name: string, ctx: ParseContext): AgentResolved {
  const raw = name.trim().replace(/^@/, '');
  const n = raw.toLowerCase().replace(/^the\s+/, '');
  const cur = here(ctx);
  const agents = ctx.peers.filter((p) => isAgentMode(p.mode));
  // A mention chip carries the exact id: no lookup, no worktree scoping.
  const chip = /^\{([^{}\s]+)\}$/.exec(raw);
  if (chip) {
    const id = chip[1]!;
    const peer = ctx.peers.find((p) => p.agentId === id);
    if (!peer) return { kind: 'none', message: `${id.split('@')[0]} is offline` };
    return isAgentMode(peer.mode) ? { kind: 'ok', agentId: id } : { kind: 'none', message: `${agentName(ctx, id)} is not an agent` };
  }
  if (n === 'this' || n === 'here') {
    const id = ctx.focused && isAgentMode(ctx.focused.mode) ? infoOf(ctx, ctx.focused)?.agentId : null;
    return id ? { kind: 'ok', agentId: id } : { kind: 'none', message: 'The focused tab is not an agent' };
  }
  const sc = scoped(raw, ctx);
  if (sc) {
    const r = resolveAgent(sc.rest, sc.ctx);
    const inWt = (id: string) => agents.some((p) => p.agentId === id && p.worktreePath === sc.path);
    if (r.kind === 'ok') return inWt(r.agentId) ? r : { kind: 'none', message: `No agent "${raw}"` };
    if (r.kind === 'ambiguous') return { ...r, agentIds: r.agentIds.filter(inWt) };
    return r;
  }
  const one = (ids: string[], what: string): AgentResolved | null =>
    ids.length === 1 ? { kind: 'ok', agentId: ids[0]! } : ids.length > 1 ? { kind: 'ambiguous', agentIds: ids, what } : null;
  const named = agents.filter((p) => p.agentId.toLowerCase() === n || p.alias?.toLowerCase() === n);
  const mine = named.filter((p) => p.worktreePath === cur);
  const byName = one((mine.length > 0 ? mine : named).map((p) => p.agentId), raw);
  if (byName) return byName;
  const match = AGENT_KIND[n] ? kindMatch(n) : null;
  if (match) {
    // Tabs carry the focus; peers cover an agent with no tab in this strip.
    const tabs = inWorktree(ctx, cur).filter((t) => match(t) && t.agentId);
    if (tabs.length > 0) {
      const r = byKind(tabs, ctx, n);
      return r.kind === 'ok' ? { kind: 'ok', agentId: r.hit.agentId! } : r.kind === 'ambiguous' ? { kind: 'ambiguous', agentIds: r.options.map((t) => t.agentId!), what: n } : r;
    }
    return one(agents.filter((p) => p.worktreePath === cur && match(p)).map((p) => p.agentId), n) ?? { kind: 'none', message: `No ${n} in this worktree` };
  }
  const here_ = agents.filter((p) => p.worktreePath === cur);
  const local = (id: string) => id.split('@')[0]!.toLowerCase();
  return one(here_.filter((p) => local(p.agentId) === n).map((p) => p.agentId), raw)
    ?? one(here_.filter((p) => local(p.agentId).startsWith(n) || !!p.alias?.toLowerCase().startsWith(n)).map((p) => p.agentId), raw)
    ?? { kind: 'none', message: `No agent "${raw}" in this worktree` };
}

/** A phrase naming a tab. `openedAt` = index of the latest step in this plan
 * that opens a tab, which is what "it" means mid-plan. */
export function resolveTarget(phrase: string, ctx: ParseContext, openedAt: number | null): Resolved {
  // A mention chip names the exact agent: its tab, or nothing.
  const chip = /^@?\{([^{}\s]+)\}$/.exec(phrase.trim());
  if (chip) {
    const t = ctx.tabs.find((x) => x.agentId === chip[1]);
    return t ? { kind: 'ok', target: tabTarget(t) } : { kind: 'none', message: `${chip[1]!.split('@')[0]} has no tab here` };
  }
  phrase = phrase.trim().replace(/^@(?=\S)/, '');
  const p = phrase.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+tab$/, '');
  if (p === 'it' || p === 'that') {
    if (openedAt !== null) return { kind: 'ok', target: { kind: 'step', index: openedAt } };
    if (ctx.lastActedOn && infoOf(ctx, ctx.lastActedOn)) return { kind: 'ok', target: tabTargetIn(ctx, ctx.lastActedOn) };
  }
  if (p === 'it' || p === 'that' || p === 'this' || p === 'here') {
    return ctx.focused ? { kind: 'ok', target: tabTargetIn(ctx, ctx.focused) } : { kind: 'none', message: 'Nothing is focused' };
  }
  const sc = scoped(phrase, ctx);
  if (sc) {
    const r = resolveTarget(sc.rest, sc.ctx, null);
    const inWt = (t: TabRef) => t.worktreePath === sc.path;
    if (r.kind === 'ok') return r.target.kind === 'tab' && inWt(r.target.ref) ? r : { kind: 'none', message: `No tab "${phrase.trim()}"` };
    if (r.kind === 'ambiguous') return { ...r, options: r.options.filter(inWt) };
    return r;
  }
  const cur = here(ctx);
  // Names other than an alias or a full agent id mean this worktree's tab.
  const pick = (list: TabInfo[], what: string, anywhere = false): Resolved => {
    const local = list.filter((t) => t.worktreePath === cur);
    const pool = local.length > 0 || !anywhere ? local : list;
    if (pool.length === 1) return { kind: 'ok', target: tabTarget(pool[0]!) };
    if (pool.length > 1) return { kind: 'ambiguous', options: pool.map(refOnly), what };
    return { kind: 'none', message: `No tab "${phrase.trim()}"` };
  };
  const numbered = /^(claude|codex|opencode|pi|shell|terminal|browser)[\s-]?(\d+)$/.exec(p);
  if (numbered) {
    const mode = MODE_WORD[numbered[1]!]!;
    return pick(ctx.tabs.filter((t) => t.mode === mode && t.sessionId === numbered[2]), phrase.trim());
  }
  const byId = ctx.tabs.filter((t) => t.agentId?.toLowerCase() === p);
  if (byId.length > 0) return pick(byId, phrase.trim(), true);
  const byAlias = ctx.tabs.filter((t) => t.alias?.toLowerCase() === p);
  if (byAlias.length > 0) return pick(byAlias, phrase.trim(), true);
  const kind = kindMatch(p);
  if (kind) {
    const r = byKind(inWorktree(ctx, cur).filter(kind), ctx, p);
    return r.kind === 'ok' ? { kind: 'ok', target: tabTarget(r.hit) } : r.kind === 'ambiguous' ? { kind: 'ambiguous', options: r.options.map(refOnly), what: p } : r;
  }
  const byLabel = ctx.tabs.filter((t) => t.label.toLowerCase() === p);
  if (byLabel.length > 0) return pick(byLabel, phrase.trim());
  return { kind: 'none', message: `No tab "${phrase.trim()}"` };
}

// ---------- chips and summaries ----------

const placeLabel = (ctx: ParseContext, p: Place): string =>
  p.split === 'tab' ? 'as a tab' : `${p.split === 'right' ? 'right of' : 'below'} ${targetName(ctx, p.anchor)}`;

export function placeChip(ctx: ParseContext, p: Place): Chip {
  const order: Split[] = [p.split, ...(['right', 'down', 'tab'] as Split[]).filter((s) => s !== p.split)];
  return {
    arg: 'place',
    label: placeLabel(ctx, p),
    candidates: order.map((split) => {
      const v: Place = { ...p, split, focus: split === 'tab' ? true : p.focus };
      return { label: placeLabel(ctx, v), value: v };
    }),
  };
}

export function targetChip(ctx: ParseContext, target: Target, label: (name: string) => string, filter: (t: TabInfo) => boolean = () => true): Chip {
  if (target.kind !== 'tab') return { arg: 'target', label: label(targetName(ctx, target)), candidates: [] };
  const others = inWorktree(ctx, target.ref.worktreePath).filter((t) => filter(t) && !sameRef(t, target.ref));
  return {
    arg: 'target',
    label: label(nameOf(ctx, target.ref)),
    candidates: [target, ...others.map(tabTarget)].map((t) => ({ label: label(targetName(ctx, t)), value: t })),
  };
}

function summarize(ctx: ParseContext, s: Step): string {
  const name = targetName(ctx, s.target);
  switch (s.action) {
    case 'tab.open': {
      const { mode, place, command, prompt } = s.args;
      return [`Open ${mode}${place ? ` ${placeLabel(ctx, place)}` : ''}`, command ? `run ${command}` : null, prompt ? `ask "${prompt}"` : null].filter(Boolean).join(', ');
    }
    case 'tab.close': return `Close ${name}`;
    case 'tab.focus': return `Focus ${name}`;
    case 'tab.interrupt': return `Interrupt ${name}`;
    case 'tab.rename': return s.args.name ? `Rename ${name} to "${s.args.name}"` : `Reset the name of ${name}`;
    case 'tab.place': return `Move ${name} ${placeLabel(ctx, s.args.place)}`;
    case 'shell.run': return `Run ${s.args.command} in ${name}`;
    case 'browser.open': return `Open ${s.args.url}${s.args.place && s.args.place.split !== 'tab' ? ` ${placeLabel(ctx, s.args.place)}` : ''}`;
    case 'agent.message': return `Ask ${agentName(ctx, s.args.agentId)}: ${s.args.text}`;
    case 'nav.worktree': return `Go to ${worktreeLabel(ctx, s.args.path)}`;
    case 'nav.focus': return `Go to Focus ${ctx.focuses.find((f) => f.id === s.args.focusId)?.name ?? s.args.focusId}`;
    case 'nav.workspace': return `Switch to workspace ${ctx.workspaces?.find((w) => w.id === s.args.wsId)?.name ?? s.args.wsId}`;
    case 'nav.repo': return `Go to repo ${ctx.repos?.find((r) => r.path === s.args.repoPath)?.name ?? s.args.repoPath}`;
    // It runs the worktree's configured dev command, not necessarily this one.
    case 'server.start': return 'Start dev server';
    case 'server.stop': return 'Stop dev server';
    case 'agent.wait': return `Wait for ${agentName(ctx, s.args.agentId)}`;
    case 'ui.state': return 'Show window state';
    case 'call.answer': return `Answer ${agentName(ctx, s.args.agentId)}: ${s.args.text}`;
    case 'call.dismiss': return `Dismiss ${agentName(ctx, s.args.agentId)}'s call`;
    case 'nav.line': return 'Open the Line';
    case 'nav.addRepo': return s.args.path ? `Add repo ${s.args.path}` : 'Add a repo';
    case 'nav.newWorktree': return s.args.repoPath ? `New worktree in ${ctx.repos?.find((r) => r.path === s.args.repoPath)?.name ?? s.args.repoPath}` : 'New worktree';
    case 'nav.page': return `Open ${PAGE_LABEL[s.args.page]}`;
    case 'settings.open': return `Open Settings → ${s.args.section}`;
    case 'agent.ask': return `Ask ${agentName(ctx, s.args.agentId)}: ${s.args.question}`;
    case 'agent.recap': return s.args.focus ? `Recap the agents in ${s.args.focus}` : s.args.agentIds === 'all' ? 'Recap all agents' : `Recap ${s.args.agentIds.map((id) => agentName(ctx, id)).join(', ')}`;
    case 'ui.sidebar': return `${s.args.show === null ? 'Toggle' : s.args.show ? 'Show' : 'Hide'} the sidebar`;
    case 'focus.edit': {
      const a = s.args;
      const focus = ctx.focuses.find((f) => f.id === a.focusId)?.name ?? a.focusId ?? '';
      const names = a.worktreePaths.map((p) => worktreeLabel(ctx, p)).join(', ');
      if (a.op === 'create') return `Create Focus ${a.name}${names ? ` (${names})` : ''}`;
      if (a.op === 'rename') return `Rename Focus ${focus} to ${a.name}`;
      if (a.op === 'delete') return `Delete Focus ${focus}`;
      return a.op === 'add' ? `Add ${names} to Focus ${focus}` : `Remove ${names} from Focus ${focus}`;
    }
    case 'settings.set': return `Set ${(Object.hasOwn(SETTINGS, s.args.setting) ? SETTINGS[s.args.setting]!.label : null) ?? s.args.setting} to ${s.args.value}`;
  }
}

/** A phrasing-independent identity for an interpretation (frecency): action
 * ids plus the args that make it a different command, steps joined by '|'. */
export function planKey(p: Plan): string {
  const tab = (t: Target) => (t.kind === 'tab' ? `${t.ref.mode}:${t.ref.sessionId}` : t.kind === 'step' ? `step${t.index}` : '');
  return p.steps.map((s): string => {
    switch (s.action) {
      case 'tab.open': return `tab.open:${s.args.mode}:${s.args.place?.split ?? ''}:${s.args.command ?? s.args.prompt ?? ''}`;
      case 'tab.place': return `tab.place:${tab(s.target)}:${s.args.place.split}`;
      case 'tab.focus': case 'tab.close': case 'tab.interrupt': return `${s.action}:${tab(s.target)}`;
      case 'tab.rename': return `tab.rename:${tab(s.target)}:${s.args.name}`;
      case 'shell.run': return `shell.run:${s.args.command}`;
      case 'browser.open': return `browser.open:${s.args.url}`;
      case 'agent.message': case 'agent.wait': return `${s.action}:${s.args.agentId}`;
      // Call ids are one-off; the caller is what repeats.
      case 'call.answer': case 'call.dismiss': return `${s.action}:${s.args.agentId}`;
      case 'nav.line': return 'nav.line';
      case 'nav.addRepo': return 'nav.addRepo';
      case 'nav.newWorktree': return `nav.newWorktree:${s.args.repoPath ?? ''}`;
      case 'nav.page': return `nav.page:${s.args.page}`;
      case 'settings.open': return `settings.open:${s.args.section}`;
      case 'settings.set': return `settings.set:${s.args.setting}:${s.args.value}`;
      case 'agent.ask': return `agent.ask:${s.args.agentId}`;
      case 'agent.recap': return `agent.recap:${s.args.agentIds === 'all' ? 'all' : s.args.agentIds.join(',')}`;
      case 'ui.sidebar': return `ui.sidebar:${s.args.show === null ? 'toggle' : s.args.show ? 'show' : 'hide'}`;
      case 'focus.edit': return `focus.edit:${s.args.op}:${s.args.focusId ?? s.args.name ?? ''}:${s.args.worktreePaths.join(',')}`;
      case 'nav.worktree': return `nav.worktree:${s.args.path}`;
      case 'nav.focus': return `nav.focus:${s.args.focusId}`;
      case 'nav.workspace': return `nav.workspace:${s.args.wsId}`;
      case 'nav.repo': return `nav.repo:${s.args.repoPath}`;
      case 'server.start': return `server.start:${s.args.script ?? s.args.command}`;
      case 'server.stop': case 'ui.state': return s.action;
    }
  }).join('|');
}

export function agentName(ctx: ParseContext, agentId: string): string {
  const peer = ctx.peers.find((p) => p.agentId === agentId);
  return peer?.alias ?? agentId.split('@')[0]!;
}

export function plan(ctx: ParseContext, steps: Step[], source: PlanSource, executable: boolean, alternatives?: Plan[]): Plan {
  return {
    steps, source, executable: executable && steps.length > 0,
    summary: steps.map((s) => `${summarize(ctx, s)}${s.note ? ` (${s.note})` : ''}`).join(', then '),
    ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
  };
}
export const explain = (summary: string, source: PlanSource, alternatives?: Plan[]): Plan =>
  ({ steps: [], source, summary, executable: false, ...(alternatives && alternatives.length > 0 ? { alternatives } : {}) });

// ---------- step builders ----------

export function openStep(ctx: ParseContext, mode: AgentMode | 'shell', worktreePath: string, place: Place | null, payload?: { command?: string; prompt?: string }): Step {
  const args: ActionArgs['tab.open'] = { mode, worktreePath, place, ...(payload?.command ? { command: payload.command } : {}), ...(payload?.prompt ? { prompt: payload.prompt } : {}) };
  const ran = args.command !== undefined;
  const chips: Chip[] = [
    { arg: 'mode', label: `Open ${mode}`, candidates: [mode, ...OPEN_MODES.filter((m) => m !== mode)].map((m) => ({ label: `Open ${m}`, value: m })) },
    ...(place ? [placeChip(ctx, place)] : []),
    ...(args.command ? [{ arg: 'command', label: `run ${args.command}`, candidates: [] }] : []),
    ...(args.prompt ? [{ arg: 'prompt', label: `"${args.prompt}"`, candidates: [] }] : []),
  ];
  return mk('tab.open', args, { kind: 'none' }, { risk: ran ? 'exec' : 'spawn', where: 'server', undoable: !ran }, chips, ctx);
}

export function runStep(ctx: ParseContext, command: string, target: Target): Step {
  return mk('shell.run', { command }, target, { risk: 'exec', where: 'server', undoable: false },
    [{ arg: 'command', label: `run ${command}`, candidates: [] }, targetChip(ctx, target, (n) => `in ${n}`, (t) => t.mode === 'shell')], ctx);
}

/** `$`/run semantics: in the focused shell, else a new shell right of the focus. */
export function shellCommand(ctx: ParseContext, command: string): Step | string {
  if (ctx.focused?.mode === 'shell') return runStep(ctx, command, tabTargetIn(ctx, ctx.focused));
  const wt = here(ctx);
  if (!wt) return 'No worktree is open';
  const place: Place = ctx.focused ? { split: 'right', anchor: tabTargetIn(ctx, ctx.focused), focus: false } : { split: 'tab', anchor: { kind: 'none' }, focus: true };
  return openStep(ctx, 'shell', wt, place, { command });
}

export function messageStep(ctx: ParseContext, agentId: string, text: string): Step {
  const others = ctx.peers.filter((p) => isAgentMode(p.mode) && p.agentId !== agentId);
  return mk('agent.message', { agentId, text }, { kind: 'none' }, { risk: 'exec', where: 'server', undoable: false }, [
    { arg: 'agentId', label: `Ask ${agentName(ctx, agentId)}`, candidates: [agentId, ...others.map((p) => p.agentId)].map((id) => ({ label: `Ask ${agentName(ctx, id)}`, value: id })) },
    { arg: 'text', label: text, candidates: [] },
  ], ctx);
}

const tabMeta = (ctx: ParseContext, target: Target, action: 'close' | 'focus' | 'interrupt'): Meta => {
  if (action === 'focus') return { risk: 'layout', where: 'hub', undoable: true };
  const browser = target.kind === 'tab' && target.ref.mode === 'browser';
  // Undo can reopen neither a closed Browser tab nor a killed session.
  if (action === 'close') return browser ? { risk: 'layout', where: 'hub', undoable: false } : { risk: 'destructive', where: 'server', undoable: false };
  return { risk: 'exec', where: 'server', undoable: false };
};

export function tabStep(ctx: ParseContext, action: 'close' | 'focus' | 'interrupt', target: Target): Step {
  const verb = action === 'close' ? 'Close' : action === 'focus' ? 'Focus' : 'Interrupt';
  const id = `tab.${action}` as const;
  return mk(id, {} as ActionArgs[typeof id], target, tabMeta(ctx, target, action), [targetChip(ctx, target, (n) => `${verb} ${n}`)], ctx);
}

/** Same rules as the server's normaliseUrl: a bare host is https, localhost is http, only http(s). */
export function normaliseUrl(raw: string): string | null {
  const s = raw.trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s);
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^localhost:\d/i.test(s) ? s : `${local ? 'http' : 'https'}://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}
const urlish = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s) || /^(localhost|127\.0\.0\.1|\[::1\])\b/i.test(s) || /^[^\s/]+\.[a-z]{2,}(\/|:|$)/i.test(s);

// ---------- calls and the shell line ----------

export const runScript = (ctx: ParseContext, script: string): string => `${ctx.packageManager ?? 'npm'} run ${script}`;

export type Call = NonNullable<ParseContext['calls']>[number];

/** Answer a call with `text`, or dismiss it (`text` null). */
export const callStep = (ctx: ParseContext, c: Call, text: string | null): Step => text === null
  ? mk('call.dismiss', { callId: c.id, agentId: c.agentId }, { kind: 'none' }, { risk: 'exec', where: 'server', undoable: false },
    [{ arg: 'callId', label: `Dismiss ${agentName(ctx, c.agentId)}'s call`, candidates: [] }], ctx)
  : mk('call.answer', { callId: c.id, agentId: c.agentId, text }, { kind: 'none' }, { risk: 'exec', where: 'server', undoable: false },
    [{ arg: 'callId', label: `Answer ${agentName(ctx, c.agentId)}`, candidates: [] }, { arg: 'text', label: text, candidates: [] }], ctx);

function shellPlan(ctx: ParseContext, rest: string, executable: boolean): Plan {
  const command = rest.trim();
  if (!command) return explain('Type a command after $', 'prefix');
  const step = shellCommand(ctx, command);
  return typeof step === 'string' ? explain(step, 'prefix') : plan(ctx, [step], 'prefix', executable);
}

/** The box's one local reading: `$ command`, typed literally into the focused
 * shell (pasted, it waits for a second ⏎). Everything else is natural
 * language and the model's job (model.ts planFromModel): an empty plan here,
 * which the box sends on. Never throws. */
export function parse(input: ParseInput, ctx: ParseContext): Plan {
  const text = input.text.trim();
  if (!text) return explain('', 'rule');
  // Multi-line input is pasted material: never a command line.
  if (!/[\r\n]/.test(text) && text.startsWith('$')) return shellPlan(ctx, text.slice(1), !input.pasted);
  return explain('', 'fallback');
}
