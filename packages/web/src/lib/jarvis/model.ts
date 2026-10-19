// Jarvis natural language (P1): what the window sends to the model, and how
// the model's answer becomes an ordinary Plan. The model only ever sees and
// says NAMES (tabs, worktrees, agents); paths, session slots and execution ids
// stay here, and a name the window can't resolve is refused, never guessed.
// Everything after planFromModel is P0 unchanged: chips, safety, preview, ⏎.
// Spec: docs/specs/2026-10-17-jarvis-natural-language-design.md (private repo).
import { looksSecret } from './history';
import {
  agentName, callStep, explain, findWorktree, worktreeLabel, focusedTarget, here, isAgentMode, messageStep, mk, openStep, placeChip, plan, resolveAgent, resolveTarget, runScript, runStep,
  shellCommand, tabStep, targetChip, normaliseUrl, type Resolved,
} from './parse';
import { withSafety } from './safety';
import type { AgentMode, ParseContext, Place, Plan, Split, Step, TabInfo, TabMode, TabRef, Target } from './types';
import { APP_PAGES, FOCUS_OPS, SETTINGS, SETTINGS_SECTIONS, type AppPage, type FocusOp, type SettingsSectionId } from './types';

export const MODEL_CAPS = { tabs: 60, worktrees: 50, focuses: 30, scripts: 50, agents: 30, calls: 20, repos: 50, workspaces: 30, thread: 6, text: 2000, name: 64, title: 200 } as const;
const COMMAND_MAX = 4096;
const TEXT_MAX = 8 * 1024;

/** What the server forwards to the model. Names only: no paths, no ids. */
export type ModelContext = {
  worktree: { name: string } | null;
  focused: string | null;
  tabs: { name: string; mode: TabMode; label?: string; busy: boolean; worktree: string }[];
  /** Unique names ("<repo>/<name>" where plain names collide), most recent first. */
  worktrees: { name: string; branch?: string; repo?: string }[];
  /** Each Focus with its member worktrees (context names, ≤ 30). */
  focuses: { name: string; worktrees: string[] }[];
  /** The Focus open in this window: "this focus". */
  focus: { name: string } | null;
  scripts: string[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  agents: { name: string; mode: TabMode; lifecycle: 'working' | 'idle' }[];
  /** Open calls to the human, by the calling agent's name (only when there are any). */
  calls?: { from: string; title: string }[];
  /** Repo names, for "new worktree in <repo>". */
  repos: { name: string }[];
  /** The workspace this window is in, and every workspace (≤ 30). */
  workspace: { name: string } | null;
  workspaces: { name: string }[];
};

/** One step as the server returns it: a registry action id and the model's args. */
export type ModelStep = { action: string; args: unknown };

/** POST /api/w/:ws/jarvis/plan. A plan is only ever previewed (planFromModel → chips); an answer is shown as plain text. */
export type ModelPlanResponse =
  | { kind: 'plan'; steps: ModelStep[]; model: string; ms: number }
  | { kind: 'answer'; text: string; model: string; ms: number };

// ---------- scrubbing ----------

// C0/C1 controls, zero-width and bidi overrides: text that could hide or
// reorder what the model (or a human reviewing the prompt) reads.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** A context string fit to send, or null (empty, or looks like a credential). */
function scrub(s: string | null | undefined, max: number = MODEL_CAPS.name): string | null {
  if (!s) return null;
  const clean = s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return clean && !looksSecret(clean) ? clean : null;
}

export type Sendable = { ok: true } | { ok: false; reason: 'empty' | 'shell' | 'multiline' | 'secret' | 'too_long' };

/** May this typed text go to the model? `$` lines, multi-line text (pasted
 * logs, stack traces, terminal output) and secret-looking text never do. */
export function sendable(text: string): Sendable {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.startsWith('$')) return { ok: false, reason: 'shell' };
  if (/[\r\n]/.test(t)) return { ok: false, reason: 'multiline' };
  if (looksSecret(t)) return { ok: false, reason: 'secret' };
  if (t.length > MODEL_CAPS.text) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

// ---------- names ----------

const worktreeName = (ctx: ParseContext, path: string): string =>
  scrub(worktreeLabel(ctx, path)) ?? scrub(path.split('/').filter(Boolean).pop()) ?? 'worktree';

/** Every tab's unique model-facing name: plain in the current worktree,
 * `<worktree>/<name>` elsewhere. Deterministic, so the same context always
 * yields the same names on the way out and on the way back. */
function nameIndex(ctx: ParseContext): { name: string; info: TabInfo }[] {
  const cur = here(ctx);
  const ordered = [...ctx.tabs.filter((t) => t.worktreePath === cur), ...ctx.tabs.filter((t) => t.worktreePath !== cur)];
  const taken = new Set<string>();
  const out: { name: string; info: TabInfo }[] = [];
  for (const info of ordered) {
    const slot = `${info.mode}-${info.sessionId}`;
    const base = scrub(info.alias) ?? scrub(info.agentId?.split('@')[0]) ?? slot;
    const qualify = (n: string) => (info.worktreePath === cur ? n : `${worktreeName(ctx, info.worktreePath)}/${n}`);
    let name = qualify(base).slice(0, MODEL_CAPS.name);
    if (taken.has(name.toLowerCase())) name = qualify(slot);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${qualify(slot)}~${n}`;
    taken.add(name.toLowerCase());
    out.push({ name, info });
  }
  return out;
}

/** The text sent to the model: each mention chip `@{agentId}` becomes that
 * agent's model-facing name (the one buildModelContext lists), so the
 * model's answer maps back to the exact agent. Unknown ids keep their local name. */
export function modelText(text: string, ctx: ParseContext): string {
  const index = nameIndex(ctx);
  const cur = here(ctx);
  return text.replace(/@\{([^{}\s]+)\}/g, (_m, id: string) => {
    const hit = index.find((e) => e.info.agentId === id);
    if (hit) return `@${hit.name}`;
    const peer = ctx.peers.find((p) => p.agentId === id);
    const local = id.split('@')[0]!;
    return `@${peer && peer.worktreePath !== cur ? `${worktreeName(ctx, peer.worktreePath)}/${local}` : local}`;
  }).replace(WT_CHIP, (_m, enc: string) => {
    const path = decodeChip(enc);
    return `#${ctx.worktrees.some((w) => w.path === path) ? worktreeName(ctx, path) : path.split('/').pop() || path}`;
  });
}

/** A worktree chip: `#{encodeURIComponent(path)}` (paths may hold spaces). */
const WT_CHIP = /#\{([^{}\s]+)\}/g;
const decodeChip = (enc: string): string => { try { return decodeURIComponent(enc); } catch { return enc; } };

// ---------- context ----------

export function buildModelContext(ctx: ParseContext): ModelContext {
  const index = nameIndex(ctx);
  const cur = here(ctx);
  const nameOfTab = (t: TabInfo | undefined) => (t ? index.find((e) => e.info === t)?.name ?? null : null);
  const focusedInfo = ctx.focused
    ? ctx.tabs.find((t) => t.worktreePath === ctx.focused!.worktreePath && t.mode === ctx.focused!.mode && t.sessionId === ctx.focused!.sessionId)
    : undefined;
  const agents: ModelContext['agents'] = [];
  for (const p of ctx.peers) {
    if (!isAgentMode(p.mode)) continue;
    const t = ctx.tabs.find((x) => x.agentId === p.agentId);
    const name = nameOfTab(t) ?? (() => {
      const base = scrub(p.alias) ?? scrub(p.agentId.split('@')[0]);
      return base ? (p.worktreePath === cur ? base : `${worktreeName(ctx, p.worktreePath)}/${base}`) : null;
    })();
    if (name) agents.push({ name, mode: p.mode, lifecycle: t?.busy ? 'working' : 'idle' });
  }
  const calls = (ctx.calls ?? []).slice(0, MODEL_CAPS.calls).flatMap((c) => {
    const p = ctx.peers.find((x) => x.agentId === c.agentId);
    const t = ctx.tabs.find((x) => x.agentId === c.agentId);
    const base = scrub(p?.alias) ?? scrub(c.agentId.split('@')[0]);
    const from = nameOfTab(t) ?? (base ? (!p || p.worktreePath === cur ? base : `${worktreeName(ctx, p.worktreePath)}/${base}`) : null);
    const title = scrub(c.title, MODEL_CAPS.title);
    return from && title ? [{ from, title }] : [];
  });
  return {
    worktree: cur ? { name: worktreeName(ctx, cur) } : null,
    focused: nameOfTab(focusedInfo),
    tabs: index.slice(0, MODEL_CAPS.tabs).map(({ name, info }) => {
      // A Browser tab's label is the page's own title: third-party text that
      // can carry private content or instructions. Its name is enough.
      const label = info.mode === 'browser' ? null : scrub(info.label);
      return { name, mode: info.mode, ...(label ? { label } : {}), busy: info.busy, worktree: worktreeName(ctx, info.worktreePath) };
    }),
    // Most recent first: on home the model offers these as the choices.
    worktrees: [...ctx.worktrees].sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1)).slice(0, MODEL_CAPS.worktrees).flatMap((w) => {
      const name = scrub(worktreeLabel(ctx, w.path));
      if (!name) return [];
      const branch = scrub(w.branch);
      const repo = scrub(w.repoName);
      return [{ name, ...(branch ? { branch } : {}), ...(repo ? { repo } : {}) }];
    }),
    focuses: ctx.focuses.flatMap((f) => {
      const name = scrub(f.name);
      if (!name) return [];
      const worktrees = (f.worktreePaths ?? []).filter((p) => ctx.worktrees.some((w) => w.path === p))
        .flatMap((p) => { const n = scrub(worktreeName(ctx, p)); return n ? [n] : []; }).slice(0, FOCUS_MEMBERS_MAX);
      return [{ name, worktrees }];
    }).slice(0, MODEL_CAPS.focuses),
    focus: (() => { const n = scrub(ctx.currentFocus?.name); return n ? { name: n } : null; })(),
    scripts: Object.keys(ctx.packageScripts).flatMap((s) => { const n = scrub(s); return n ? [n] : []; }).slice(0, MODEL_CAPS.scripts),
    packageManager: ctx.packageManager ?? 'npm',
    agents: agents.slice(0, MODEL_CAPS.agents),
    ...(calls.length > 0 ? { calls } : {}),
    repos: (ctx.repos ?? []).flatMap((r) => { const name = scrub(r.name); return name ? [{ name }] : []; }).slice(0, MODEL_CAPS.repos),
    workspace: (() => { const n = scrub(ctx.currentWorkspace?.name); return n ? { name: n } : null; })(),
    workspaces: (ctx.workspaces ?? []).flatMap((w) => { const name = scrub(w.name); return name ? [{ name }] : []; }).slice(0, MODEL_CAPS.workspaces),
  };
}

// ---------- thread memory ----------

export type Turn = { role: 'user' | 'assistant'; text: string };

const keepable = (text: string): string | null => {
  const t = text.trim();
  return t && !t.startsWith('$') && !looksSecret(t) ? t.slice(0, MODEL_CAPS.text) : null;
};

/** The box session's short conversation (follow-ups like "no, below it"), in
 * memory only. Kept as answered pairs, so turns() always starts with the user,
 * alternates, and ends with the assistant: the new text is the next user turn.
 * A re-ask replaces an unanswered question; an answer to a dropped question
 * (or a dropped answer) drops the pair; `$` and secret-looking text never stay. */
export function createThread() {
  const BLOCKED = Symbol('blocked');
  let pending: string | typeof BLOCKED | null = null;
  let pairs: [string, string][] = [];
  return {
    push(role: Turn['role'], text: string): void {
      const t = keepable(text);
      if (role === 'user') { pending = t ?? BLOCKED; return; }
      if (typeof pending === 'string' && t) pairs = [...pairs, [pending, t] as [string, string]].slice(-(MODEL_CAPS.thread / 2));
      pending = null;
    },
    turns: (): Turn[] => pairs.flatMap(([u, a]): Turn[] => [{ role: 'user', text: u }, { role: 'assistant', text: a }]),
    /** Swap the last answer for what actually happened (the run's outcome,
     * with real tab names), so "this"/"it" in a follow-up mean those tabs. */
    amend(text: string): void {
      const t = keepable(text);
      if (t && pending === null && pairs.length > 0) pairs = [...pairs.slice(0, -1), [pairs[pairs.length - 1]![0], t]];
    },
    clear(): void { pending = null; pairs = []; },
  };
}

// ---------- the model's steps → a Plan ----------

/** `said`: nothing to do, and the reason is the answer ("Already in X"). */
type Out = { kind: 'ok'; step: Step } | { kind: 'ambiguous'; options: Step[]; what: string } | { kind: 'error'; message: string } | { kind: 'said'; text: string };
class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : refuse('arguments must be an object'));
function str(a: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number; line?: boolean } = {}): string | undefined {
  const v = a[key];
  if (v === undefined || v === null || v === '') return opts.required ? refuse(`${key} is required`) : undefined;
  if (typeof v !== 'string') return refuse(`${key} must be text`);
  const t = v.trim();
  if (!t) return opts.required ? refuse(`${key} is required`) : undefined;
  if (opts.max && t.length > opts.max) refuse(`${key} is too long`);
  if (opts.line && /[\r\n]/.test(t)) refuse(`${key} must be a single line`);
  // Typed into a terminal or an agent's prompt: ctrl-c, escape sequences, a
  // CR (Enter) or a line separator would act, not read. Tab and \n stay.
  if (CONTROL.test(t)) refuse(`${key} has control characters`);
  return t;
}
/** Same cap as the strip's double-click rename. */
const TAB_NAME_MAX = 40;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const SPLITS: Split[] = ['right', 'down', 'tab'];
/** The server takes the user's words for a recap up to this long. */
const RECAP_QUESTION_MAX = 2000;
/** Per Focus in the model context, and agents a Focus-wide recap covers. */
const FOCUS_MEMBERS_MAX = 30;
const RECAP_AGENTS_MAX = 20;
const OPEN_MODES: (AgentMode | 'shell')[] = ['shell', 'claude', 'codex', 'opencode', 'pi'];

const squash = (s: string): string => s.trim().replace(/\s+/g, ' ');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string): boolean => new RegExp(`(^|\\s)${escapeRe(word)}(?=\\s|$|[.,!?;:])`).test(text);

/** The user typed `command` themselves: word for word, or as the name of a
 * package script it runs ("run dev" → `npm run dev`). */
export function typedLiterally(command: string, text: string | undefined, ctx: ParseContext): boolean {
  if (!text) return false;
  const c = squash(command);
  const t = squash(text);
  if (c && hasWord(t, c)) return true;
  const m = /^(\S+) run (\S+)$/.exec(c);
  return !!m && m[1] === (ctx.packageManager ?? 'npm') && m[2]! in ctx.packageScripts && hasWord(t, m[2]!);
}

export function planFromModel(steps: ModelStep[], ctx: ParseContext, opts: { text?: string; thread?: Turn[] } = {}): Plan {
  if (!Array.isArray(steps) || steps.length === 0) return explain('The model suggested nothing to do', 'model');
  const index = nameIndex(ctx);
  // The user's own words: this text and their earlier turns. Never the
  // assistant's turns: those hold commands the model wrote.
  const userTexts = [opts.text, ...(opts.thread ?? []).filter((t) => t.role === 'user').map((t) => t.text)];
  /** A model-written command the user did not type needs their confirm. */
  const suggested = (step: Step, _ctx: ParseContext): Step => {
    const command = step.action === 'shell.run' || step.action === 'tab.open' ? step.args.command : undefined;
    return command && userTexts.some((t) => typedLiterally(command, t, ctx)) ? step : { ...step, suggested: true };
  };
  const mark = (s: Step): Step => withSafety({ ...s, fromModel: true }, ctx);

  // One request is one place: a step naming a worktree sets it for the steps
  // after it that name none (on home, where nothing is shown, too).
  let planWt: string | null = null;
  // A worktree chip the user picked sets the place outright.
  const chipWt = [...(opts.text ?? '').matchAll(WT_CHIP)].map((m) => decodeChip(m[1]!))[0];
  if (chipWt !== undefined) {
    if (!ctx.worktrees.some((w) => w.path === chipWt)) return explain('That worktree is gone', 'model');
    planWt = chipWt;
  }
  /** A worktree by name (parse.ts findWorktree); several matches are refused with the choices. */
  const worktreeByName = (name: string): string | undefined => {
    const f = findWorktree(ctx, name);
    if (f.kind === 'ambiguous') refuse(`Which ${name.trim()}: ${f.paths.map((p) => worktreeName(ctx, p)).join(', ')}?`);
    return f.kind === 'ok' ? f.path : undefined;
  };
  const worktree = (name: string | undefined): string => {
    if (name === undefined) return planWt ?? here(ctx) ?? refuse('no worktree is open — name one');
    planWt = worktreeByName(name) ?? refuse(`No worktree "${name}"`);
    return planWt;
  };

  /** A tab ref: an exact model-facing name, "this" (the focus), "#N" (the tab
   * step N of this plan opens, 1-based), or loosely what the P0 parser accepts. */
  const tabName = (name: string, at: number, opened: (AgentMode | 'shell' | null)[]): Resolved => {
    const step = /^#(\d+)$/.exec(name);
    if (step) {
      const i = Number(step[1]) - 1;
      return i >= 0 && i < at && opened[i] ? { kind: 'ok', target: { kind: 'step', index: i } } : { kind: 'none', message: `"${name}" is not a tab an earlier step opens` };
    }
    const hit = index.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (hit) return { kind: 'ok', target: { kind: 'tab', ref: refOf(hit.info) } };
    return resolveTarget(name, ctx, null);
  };

  /** Flat split/anchor args. split null = right; anchor null = the focus, or
   * (opening into another worktree) that worktree's active pane. */
  const place = (args: Record<string, unknown>, at: number, opened: (AgentMode | 'shell' | null)[], wt: string | null): Place | Resolved => {
    const split = (args.split ?? 'right') as Split;
    if (!SPLITS.includes(split)) refuse(`split must be one of ${SPLITS.join(', ')}`);
    const anchorName = str(args, 'anchor', { max: 200 });
    let anchor: Target = wt !== null && wt !== here(ctx) ? { kind: 'none' } : focusedTarget(ctx);
    if (anchorName) {
      const r = tabName(anchorName, at, opened);
      if (r.kind !== 'ok') return r;
      anchor = r.target;
    }
    return { split, anchor, focus: split === 'tab' };
  };

  const withTab = (r: Resolved, build: (t: Target) => Step): Out => {
    if (r.kind === 'ok') return { kind: 'ok', step: build(r.target) };
    if (r.kind === 'ambiguous') return { kind: 'ambiguous', options: r.options.map((o) => build({ kind: 'tab', ref: refOf(o) })), what: r.what };
    return { kind: 'error', message: r.message };
  };
  const isPlace = (v: Place | Resolved): v is Place => 'split' in v;
  const placeOr = (v: Place | Resolved): Place => (isPlace(v) ? v : v.kind === 'none' ? refuse(v.message) : refuse(`Which ${v.kind === 'ambiguous' ? v.what : 'tab'}? Name the anchor exactly`));

  /** A Focus by its name (any case), or "this focus" / "the focus" for the one open here. */
  const focusNamed = (name: string): ParseContext['focuses'][number] => {
    if (/^(this|the|current|this current)( focus)?$/i.test(name.trim())) {
      const cur = ctx.currentFocus ?? refuse('No Focus is open here');
      return ctx.focuses.find((f) => f.id === cur.id) ?? { ...cur, worktreePaths: [] };
    }
    const hits = ctx.focuses.filter((f) => f.name.toLowerCase() === name.trim().toLowerCase());
    if (hits.length === 0) refuse(`No Focus "${name}"`);
    if (hits.length > 1) refuse(`Two Focuses are called "${name}"; rename one first`);
    return hits[0]!;
  };

  /** An agent named by the model: an exact model-facing name first, then the
   * box's own rules (a bare kind is the focused one, other worktrees only as "wt/name"). */
  const toAgent = (name: string, build: (agentId: string) => Step): Out => {
    const bare = name.replace(/^@/, '').toLowerCase();
    const exact = index.find((e) => e.name.toLowerCase() === bare)?.info.agentId;
    if (exact && ctx.peers.some((p) => p.agentId === exact && isAgentMode(p.mode))) return { kind: 'ok', step: build(exact) };
    const r = resolveAgent(name, ctx);
    if (r.kind === 'ok') return { kind: 'ok', step: build(r.agentId) };
    if (r.kind === 'ambiguous' && r.agentIds.length > 0) return { kind: 'ambiguous', options: r.agentIds.map(build), what: name };
    return refuse(r.kind === 'none' ? r.message : `No agent "${name}"`);
  };

  const convert = (ms: ModelStep, at: number, opened: (AgentMode | 'shell' | null)[]): Out => {
    const action = typeof ms?.action === 'string' ? ms.action : refuse('a step has no action');
    const a = obj(ms.args ?? {});
    switch (action) {
      case 'tab.open': {
        const mode = a.mode as AgentMode | 'shell';
        if (!OPEN_MODES.includes(mode)) refuse(`mode must be one of ${OPEN_MODES.join(', ')}`);
        const command = str(a, 'command', { max: COMMAND_MAX, line: true });
        const prompt = str(a, 'prompt', { max: TEXT_MAX });
        if (command && mode !== 'shell') refuse('a command needs a shell; give an agent a prompt');
        if (prompt && mode === 'shell') refuse('a prompt needs an agent; give a shell a command');
        const wt = worktree(str(a, 'worktree', { max: 200 }));
        const step = openStep(ctx, mode, wt, placeOr(place(a, at, opened, wt)), command ? { command } : prompt ? { prompt } : undefined);
        return { kind: 'ok', step: command ? suggested(step, ctx) : step };
      }
      case 'shell.run': {
        const command = str(a, 'command', { required: true, max: COMMAND_MAX, line: true })!;
        const name = str(a, 'tab', { max: 200 });
        if (!name) {
          // Elsewhere than the shown worktree (or on home): a new shell there.
          if (planWt !== null && planWt !== here(ctx)) {
            return { kind: 'ok', step: suggested(openStep(ctx, 'shell', planWt, { split: 'tab', anchor: { kind: 'none' }, focus: true }, { command }), ctx) };
          }
          const s = shellCommand(ctx, command);
          return typeof s === 'string' ? { kind: 'error', message: s } : { kind: 'ok', step: suggested(s, ctx) };
        }
        const r = tabName(name, at, opened);
        const shellOnly = (t: Target) => (t.kind === 'tab' ? t.ref.mode === 'shell' : t.kind === 'step' ? opened[t.index] === 'shell' : false);
        if (r.kind === 'ok' && !shellOnly(r.target)) refuse(`${name} is not a shell`);
        if (r.kind === 'ambiguous') r.options = r.options.filter((o) => o.mode === 'shell');
        return withTab(r, (t) => suggested(runStep(ctx, command, t), ctx));
      }
      case 'tab.close': case 'tab.focus': case 'tab.interrupt': {
        const name = str(a, 'tab', { required: true, max: 200 })!;
        const verb = action.slice(4) as 'close' | 'focus' | 'interrupt';
        return withTab(tabName(name, at, opened), (t) => tabStep(ctx, verb, t));
      }
      case 'tab.rename': {
        const name = str(a, 'tab', { required: true, max: 200 })!;
        const label = (str(a, 'name', { max: 2000, line: true }) ?? '').slice(0, TAB_NAME_MAX).trim();
        if (looksSecret(label)) refuse('That name looks like a secret');
        return withTab(tabName(name, at, opened), (t) => {
          const mode = t.kind === 'tab' ? t.ref.mode : t.kind === 'step' ? opened[t.index] : null;
          if (mode === 'browser') refuse('Only terminal and agent tabs can be renamed');
          return mk('tab.rename', { name: label }, t, { risk: 'layout', where: 'hub', undoable: true }, [targetChip(ctx, t, (n) => `Rename ${n}`)], ctx);
        });
      }
      case 'tab.place': {
        const name = str(a, 'tab', { required: true, max: 200 })!;
        const p = placeOr(place(a, at, opened, null));
        return withTab(tabName(name, at, opened), (t) => {
          if (t.kind === 'tab' && p.anchor.kind === 'tab') {
            if (t.ref.worktreePath === p.anchor.ref.worktreePath && t.ref.mode === p.anchor.ref.mode && t.ref.sessionId === p.anchor.ref.sessionId) refuse('A tab cannot be placed beside itself');
            if (t.ref.worktreePath !== p.anchor.ref.worktreePath) refuse('Tabs can only be placed beside a tab of the same worktree');
          }
          return mk('tab.place', { place: p }, t, { risk: 'layout', where: 'hub', undoable: true }, [targetChip(ctx, t, (n) => `Move ${n}`), placeChip(ctx, p)], ctx);
        });
      }
      case 'browser.open': {
        const raw = str(a, 'url', { required: true, max: 4096, line: true })!;
        const url = normaliseUrl(raw) ?? refuse('Only http(s) URLs can be opened');
        const wt = worktree(str(a, 'worktree', { max: 200 }));
        const pl = placeOr(place(a, at, opened, wt));
        return { kind: 'ok', step: mk('browser.open', { url, worktreePath: wt, place: pl }, { kind: 'none' },
          { risk: 'layout', where: 'hub', undoable: true }, [{ arg: 'url', label: url, candidates: [] }, placeChip(ctx, pl)], ctx) };
      }
      case 'agent.message': {
        const name = str(a, 'to', { required: true, max: 200 })!;
        const text = str(a, 'text', { required: true, max: TEXT_MAX })!;
        return toAgent(name, (id) => messageStep(ctx, id, text));
      }
      case 'agent.ask': {
        const name = str(a, 'to', { required: true, max: 200 })!;
        const question = str(a, 'question', { required: true, max: TEXT_MAX })!;
        return toAgent(name, (agentId) => mk('agent.ask', { agentId, question }, { kind: 'none' }, { risk: 'exec', where: 'server', undoable: false },
          [{ arg: 'agentId', label: `Ask ${agentName(ctx, agentId)}`, candidates: [] }, { arg: 'question', label: question, candidates: [] }], ctx));
      }
      case 'agent.recap': {
        const name = str(a, 'agent', { required: true, max: 200 })!;
        const question = opts.text?.trim().slice(0, RECAP_QUESTION_MAX) || null;
        const recap = (agentIds: string[] | 'all', focus?: string) => mk('agent.recap', { agentIds, question, ...(focus ? { focus } : {}) }, { kind: 'none' }, { risk: 'read', where: 'server', undoable: false },
          [{ arg: 'agentIds', label: focus ? `Recap the agents in ${focus}` : agentIds === 'all' ? 'Recap all agents' : `Recap ${agentIds.map((id) => agentName(ctx, id)).join(', ')}`, candidates: [] }], ctx);
        if (/^(all|everyone|every agent|all agents)$/i.test(name)) {
          const focusName = str(a, 'focus', { max: 200 });
          if (!focusName) return { kind: 'ok', step: recap('all') };
          // Every agent working in that Focus's worktrees (none is an answer too).
          const f = focusNamed(focusName);
          const paths = new Set(f.worktreePaths ?? []);
          const ids = ctx.peers.filter((p) => isAgentMode(p.mode) && paths.has(p.worktreePath)).map((p) => p.agentId).slice(0, RECAP_AGENTS_MAX);
          return { kind: 'ok', step: recap(ids, f.name) };
        }
        return toAgent(name, (id) => recap([id]));
      }
      case 'nav.worktree': {
        const path = worktree(str(a, 'name', { required: true, max: 200 }));
        return { kind: 'ok', step: mk('nav.worktree', { path }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: true }, [{ arg: 'path', label: `Go to ${worktreeName(ctx, path)}`, candidates: [] }], ctx) };
      }
      case 'nav.focus': {
        const name = str(a, 'name', { required: true, max: 200 })!;
        const f = ctx.focuses.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? refuse(`No Focus "${name}"`);
        return { kind: 'ok', step: mk('nav.focus', { focusId: f.id }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: true }, [{ arg: 'focusId', label: `Focus ${f.name}`, candidates: [] }], ctx) };
      }
      case 'nav.workspace': {
        const name = str(a, 'name', { required: true, max: 200 })!;
        const all = ctx.workspaces ?? [];
        const lower = name.toLowerCase();
        const pick = (list: typeof all) => (list.length === 1 ? list[0]! : list.length > 1 ? refuse(`Which workspace: ${list.map((x) => x.name).join(', ')}?`) : null);
        const w = all.find((x) => x.name === name) ?? pick(all.filter((x) => x.name.toLowerCase() === lower)) ?? pick(all.filter((x) => x.name.toLowerCase().startsWith(lower)))
          ?? refuse(`No workspace "${name}"${all.length > 0 ? ` (workspaces: ${all.map((x) => x.name).join(', ')})` : ''}`);
        if (w.id === ctx.currentWorkspace?.id) return { kind: 'said', text: `Already in ${w.name}` };
        return { kind: 'ok', step: mk('nav.workspace', { wsId: w.id }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: true }, [{ arg: 'wsId', label: `Workspace ${w.name}`, candidates: [] }], ctx) };
      }
      case 'nav.repo': {
        const name = str(a, 'name', { required: true, max: 200 })!;
        const r = (ctx.repos ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? refuse(`No repo "${name}"`);
        return { kind: 'ok', step: mk('nav.repo', { repoPath: r.path }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: true }, [{ arg: 'repoPath', label: `Repo ${r.name}`, candidates: [] }], ctx) };
      }
      case 'server.start': {
        const wt = worktree(str(a, 'worktree', { max: 200 }));
        const script = wt === here(ctx) ? ['dev', 'start', 'serve'].find((k) => k in ctx.packageScripts) ?? null : null;
        const command = script ? runScript(ctx, script) : 'the configured dev command';
        return { kind: 'ok', step: mk('server.start', { worktreePath: wt, script, command }, { kind: 'none' }, { risk: 'spawn', where: 'server', undoable: false },
          [{ arg: 'command', label: 'Start dev server', candidates: [] }], ctx) };
      }
      case 'server.stop': {
        const wt = worktree(str(a, 'worktree', { max: 200 }));
        return { kind: 'ok', step: mk('server.stop', { worktreePath: wt }, { kind: 'none' }, { risk: 'exec', where: 'server', undoable: false }, [{ arg: 'worktreePath', label: 'Stop dev server', candidates: [] }], ctx) };
      }
      case 'call.answer': case 'call.dismiss': {
        // Always confirmed (safety.ts): the model words it, the user says yes.
        const caller = str(a, 'caller', { required: true, max: 200 })!;
        const text = action === 'call.answer' ? str(a, 'text', { required: true, max: TEXT_MAX })! : null;
        const bare = caller.replace(/^@/, '').toLowerCase();
        const open = ctx.calls ?? [];
        const exact = index.find((e) => e.name.toLowerCase() === bare)?.info.agentId;
        let ids = exact ? [exact] : [];
        if (ids.length === 0) { const r = resolveAgent(caller, ctx); ids = r.kind === 'ok' ? [r.agentId] : r.kind === 'ambiguous' ? r.agentIds : []; }
        // A caller in another worktree by its plain name: calls are explicit.
        if (!ids.some((id) => open.some((c) => c.agentId === id))) {
          ids = open.filter((c) => c.agentId.split('@')[0]!.toLowerCase() === bare || ctx.peers.find((p) => p.agentId === c.agentId)?.alias?.toLowerCase() === bare).map((c) => c.agentId);
        }
        const calls = open.filter((c) => ids.includes(c.agentId));
        if (calls.length === 0) return refuse(`${caller} is not calling you`);
        if (calls.length === 1) return { kind: 'ok', step: callStep(ctx, calls[0]!, text) };
        return { kind: 'ambiguous', options: calls.map((c) => callStep(ctx, c, text)), what: `${caller}'s call` };
      }
      case 'nav.addRepo': {
        const path = str(a, 'path', { max: 4096, line: true }) ?? null;
        return { kind: 'ok', step: mk('nav.addRepo', { path }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: false }, [{ arg: 'path', label: path ? `Add repo ${path}` : 'Add a repo', candidates: [] }], ctx) };
      }
      case 'nav.newWorktree': {
        const name = str(a, 'repo', { max: 200 });
        let repoPath: string | null = null;
        if (name) {
          const n = name.toLowerCase();
          const r = (ctx.repos ?? []).find((x) => x.name.toLowerCase() === n) ?? (ctx.repos ?? []).find((x) => (x.path.split('/').pop() ?? '').toLowerCase() === n);
          repoPath = r?.path ?? refuse(`No repo "${name}"`);
        }
        return { kind: 'ok', step: mk('nav.newWorktree', { repoPath }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: false }, [{ arg: 'repoPath', label: 'New worktree', candidates: [] }], ctx) };
      }
      case 'nav.line':
        return { kind: 'ok', step: mk('nav.line', {}, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: true }, [{ arg: 'target', label: 'Open the Line', candidates: [] }], ctx) };
      case 'nav.page': {
        const page = str(a, 'page', { required: true, max: 20 })!;
        if (!(APP_PAGES as readonly string[]).includes(page)) refuse(`No page "${page}"`);
        return { kind: 'ok', step: mk('nav.page', { page: page as AppPage }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: false }, [{ arg: 'page', label: `Open ${page}`, candidates: [] }], ctx) };
      }
      case 'settings.open': {
        const section = str(a, 'section', { required: true, max: 30 })!;
        if (!(SETTINGS_SECTIONS as readonly string[]).includes(section)) refuse(`No Settings section "${section}"`);
        return { kind: 'ok', step: mk('settings.open', { section: section as SettingsSectionId }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: false }, [{ arg: 'section', label: `Settings → ${section}`, candidates: [] }], ctx) };
      }
      case 'ui.sidebar': {
        const v = a.show ?? null;
        if (v !== null && typeof v !== 'boolean') refuse('show must be true, false or null');
        const show = v as boolean | null;
        return { kind: 'ok', step: mk('ui.sidebar', { show }, { kind: 'none' }, { risk: 'read', where: 'hub', undoable: false },
          [{ arg: 'show', label: `${show === null ? 'Toggle' : show ? 'Show' : 'Hide'} the sidebar`, candidates: [] }], ctx) };
      }
      case 'focus.edit': {
        const op = str(a, 'op', { required: true, max: 10 })!;
        if (!(FOCUS_OPS as readonly string[]).includes(op)) refuse(`A Focus can be ${FOCUS_OPS.join(', ')}d`);
        const byName = (n: string) => ctx.focuses.filter((f) => f.name.toLowerCase() === n.toLowerCase());
        const focusName = str(a, 'focus', { max: 200 });
        let focusId: string | null = null;
        if (op !== 'create') {
          if (!focusName) refuse('Which Focus?');
          focusId = focusNamed(focusName!).id;
        }
        const name = op === 'create' || op === 'rename' ? str(a, 'name', { max: 60, line: true }) ?? refuse(`The Focus needs a ${op === 'rename' ? 'new ' : ''}name`) : null;
        if (name && byName(name).some((f) => f.id !== focusId)) refuse(`A Focus called "${name}" already exists`);
        const raw = a.worktrees ?? null;
        if (raw !== null && !Array.isArray(raw)) refuse('worktrees must be a list');
        const list = (raw ?? []) as unknown[];
        if (list.length > MODEL_CAPS.worktrees) refuse('Too many worktrees');
        const worktreePaths: string[] = [];
        for (const w of list) {
          if (typeof w !== 'string' || !w.trim()) refuse('A worktree must be named');
          const path = worktreeByName(w as string) ?? refuse(`No worktree "${w as string}"`);
          if (!worktreePaths.includes(path)) worktreePaths.push(path);
        }
        if ((op === 'add' || op === 'remove') && worktreePaths.length === 0) refuse(`Name the worktrees to ${op}`);
        return { kind: 'ok', step: mk('focus.edit', { op: op as FocusOp, focusId, name, worktreePaths }, { kind: 'none' }, { risk: 'layout', where: 'hub', undoable: false },
          [{ arg: 'op', label: `${op[0]!.toUpperCase()}${op.slice(1)} Focus`, candidates: [] }], ctx) };
      }
      case 'settings.set': {
        const setting = str(a, 'setting', { required: true, max: 40 })!;
        // Own keys only: "constructor" or "__proto__" must not pass as a setting.
        const def = Object.hasOwn(SETTINGS, setting) ? SETTINGS[setting]! : refuse(`No setting "${setting}"`);
        let value = str(a, 'value', { required: true, max: def.max ?? 40, line: true })!.trim();
        if (def.values) {
          const v = value.toLowerCase().replace(/\s+/g, '-');
          value = ({ true: 'on', yes: 'on', enabled: 'on', false: 'off', no: 'off', disabled: 'off' } as Record<string, string>)[v] ?? v;
          if (!def.values.includes(value)) refuse(`${def.label} can be ${def.values.join(', ')}`);
        } else if (!value) refuse(`${def.label} needs a value`);
        return { kind: 'ok', step: mk('settings.set', { setting, value }, { kind: 'none' }, { risk: 'layout', where: 'hub', undoable: false }, [{ arg: 'value', label: `${def.label}: ${value}`, candidates: [] }], ctx) };
      }
      case 'agent.wait': case 'ui.state':
        return refuse(`${action} is not available from the command box`);
      default:
        return refuse(`Unknown action "${action}"`);
    }
  };

  const out: Step[] = [];
  const opened: (AgentMode | 'shell' | null)[] = [];
  for (const [i, ms] of steps.entries()) {
    let r: Out;
    try { r = convert(ms, i, opened); } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      r = { kind: 'error', message: err.message };
    }
    if (r.kind === 'ambiguous' && steps.length === 1) {
      return explain(`Which ${r.what}?`, 'model', r.options.map((o) => plan(ctx, [mark(o)], 'model', true)));
    }
    if (r.kind === 'said') {
      if (steps.length === 1) return explain(r.text, 'model');
      continue;
    }
    if (r.kind !== 'ok') {
      const why = r.kind === 'ambiguous' ? `which ${r.what}?` : r.message;
      return explain(steps.length > 1 ? `Can't use step ${i + 1} of the model's plan: ${why}` : `Can't use the model's plan: ${why}`, 'model');
    }
    out.push(mark(r.step));
    opened.push(r.step.action === 'tab.open' ? r.step.args.mode : null);
  }
  return plan(ctx, out, 'model', true);
}

// ---------- what a run did, for the thread ----------

export type RunOutcome = { done: number; failed?: { index: number; reason: string }; opened: (TabRef | null)[] };

/** What a model plan actually did, with real tab names ("Ran: opened shell-3
 * below reviewer; ran git status in shell-3"). Stored as the assistant turn so
 * a follow-up's "this"/"it"/"that shell" resolve to the tabs just opened.
 * `ctx` is read after the run. */
export function describeRun(plan: Plan, run: RunOutcome, ctx: ParseContext): string {
  const index = nameIndex(ctx);
  const cur = here(ctx);
  const same = (a: TabRef, b: TabRef) => a.worktreePath === b.worktreePath && a.mode === b.mode && a.sessionId === b.sessionId;
  const nameOf = (r: TabRef | null): string => {
    if (!r) return 'a tab';
    const hit = index.find((e) => same(e.info, r));
    if (hit) return hit.name;
    const slot = `${r.mode}-${r.sessionId}`;
    return r.worktreePath === cur ? slot : `${worktreeName(ctx, r.worktreePath)}/${slot}`;
  };
  const tabOf = (t: Target): TabRef | null => (t.kind === 'tab' ? t.ref : t.kind === 'step' ? run.opened[t.index] ?? null : null);
  const where = (p: Place | null): string => {
    if (!p) return '';
    const anchor = tabOf(p.anchor);
    if (p.split === 'tab') return anchor ? ` as a tab beside ${nameOf(anchor)}` : ' as a tab';
    const side = p.split === 'down' ? 'below' : 'right of';
    return anchor ? ` ${side} ${nameOf(anchor)}` : '';
  };
  const agentOf = (agentId: string): string =>
    index.find((e) => e.info.agentId === agentId)?.name ?? agentId.split('@')[0]!;
  /** [past tense, base form] of one step. */
  const phrase = (s: Step, i: number): [string, string] => {
    const target = nameOf(tabOf(s.target));
    switch (s.action) {
      case 'tab.open': {
        const what = `${nameOf(run.opened[i] ?? null)}${where(s.args.place)}`;
        const extra = s.args.command ? `, running ${s.args.command}` : s.args.prompt ? ' with a prompt' : '';
        return [`opened ${what}${extra}`, `open ${s.args.mode === 'shell' ? 'a shell' : s.args.mode}${where(s.args.place)}`];
      }
      case 'shell.run': return [`ran ${s.args.command} in ${target}`, `run ${s.args.command} in ${target}`];
      case 'tab.focus': return [`focused ${target}`, `focus ${target}`];
      case 'tab.close': return [`closed ${target}`, `close ${target}`];
      case 'tab.interrupt': return [`interrupted ${target}`, `interrupt ${target}`];
      case 'tab.rename': return s.args.name ? [`renamed ${target} to "${s.args.name}"`, `rename ${target} to "${s.args.name}"`] : [`reset the name of ${target}`, `reset the name of ${target}`];
      case 'tab.place': return [`moved ${target}${where(s.args.place)}`, `move ${target}${where(s.args.place)}`];
      case 'browser.open': return [`opened ${s.args.url}${where(s.args.place)}`, `open ${s.args.url}`];
      case 'agent.message': return [`messaged ${agentOf(s.args.agentId)}`, `message ${agentOf(s.args.agentId)}`];
      case 'nav.worktree': return [`went to ${worktreeName(ctx, s.args.path)}`, `go to ${worktreeName(ctx, s.args.path)}`];
      case 'server.start': return ['started the dev server', 'start the dev server'];
      case 'server.stop': return ['stopped the dev server', 'stop the dev server'];
      default: { const label = s.chips[0]?.label ?? s.action; return [label, label]; }
    }
  };
  const parts = plan.steps.slice(0, run.done).map((s, i) => phrase(s, i)[0]);
  if (!run.failed) return `Ran: ${parts.join('; ')}`;
  const f = run.failed;
  const failedStep = plan.steps[f.index];
  if (failedStep) parts.push(`failed to ${phrase(failedStep, f.index)[1]} (${f.reason})`);
  if (f.index + 1 < plan.steps.length) parts.push('did not run the rest');
  return `Partly ran: ${parts.join('; ')}`;
}

/** A TabInfo as a bare ref, keeping the execution id that pins it. */
const refOf = (t: TabRef) => ({ worktreePath: t.worktreePath, mode: t.mode, sessionId: t.sessionId, ...(t.executionId ? { executionId: t.executionId } : {}) });
