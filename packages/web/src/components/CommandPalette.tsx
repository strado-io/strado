import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRendererOverlay } from '../contexts/RendererOverlay';
import type { StationDto } from '../api';
import { chipEndingAt, chipKey, chipLabel, chipSegments, insertChip, mentionAt, pruneChips, sigilOf, toRankStation, toWire, type Chip } from '../lib/mention/chips';
import { rankWorktrees, type RankedWorktree } from '../lib/mention/worktreeRank';
import { useVoice, type VoiceBridge } from '../hooks/voice';
import { expectAnswer, onAgentAnswer, type AgentAnswer } from '../hooks/agentAnswers';
import { createSpeculator } from '../lib/jarvis/speculate';
import { contextualNames } from '../lib/voice/contextual';
import { shortRelativeTime } from '../lib/relativeTime';
import { rankStations, type Station } from '../lib/mention/rank';
import { statusText } from '../lib/dock/stations';
import { api, type Focus, type RemoteWorktree } from '../api';
import type { RepoConfig, Workspace, Worktree } from '../types';
import { ShellIcon, ClaudeIcon, CodexIcon, VsCodeIcon, GlobeIcon, BookIcon } from './hub/icons';
import { hasSession } from '../hooks/sessions';
import { readVscodeTabs } from '../hooks/vscodeTabs';
import { readBrowserTabs } from '../hooks/browserTabs';
import { readKbTabs } from '../hooks/kbTabs';
import { readWorktreeLru, compareByActivityThenRecency, type RankableWorktree } from '../lib/worktreeLru';
import { byLastActive } from './sidebar/FocusSwitcher';
import { JarvisModelRow, JarvisRow, type JarvisRowState, type ModelRowView } from './jarvis/JarvisRow';
import { createThread, describeRun, modelText, sendable, type ModelStep, type Turn } from '../lib/jarvis/model';
import type { ModelErrorReason, ModelResult } from '../lib/jarvis/modelClient';
import type { ParseContext, ParseInput, Plan, TabRef } from '../lib/jarvis/types';
import { runPlan, type JarvisPorts, type UndoOp } from '../lib/jarvis/execute';
import { bindPlan, verifyPlan } from '../lib/jarvis/safety';
import { planKey } from '../lib/jarvis/parse';
import { clearHistory, frecencyScore, logFallthrough, readHistoryEntries, recordUse, rememberCommand, type HistoryEntry } from '../lib/jarvis/history';
import { plainAnswer } from './jarvis/AnswerText';

/** The ⌘K box as a command line (Jarvis). Nothing is suggested while typing;
 * ⏎ runs an exact rule hit at once, else asks Haiku and runs its plan. Rows
 * appear only when there is something to answer: a confirm, a pick list, an
 * error, the model's reply. */
export type JarvisPaletteProps = {
  wsId: string;
  parse: (input: ParseInput, ctx: ParseContext) => Plan;
  /** Read fresh on every keystroke and again right before running. */
  context: () => ParseContext;
  ports: () => Omit<JarvisPorts, 'verify' | 'onStep'>;
  /** A plan ran (or failed after doing something): the board shows the undo toast. */
  onRan: (r: { ok: boolean; summary: string; undo: UndoOp[]; undoable: boolean; notice?: boolean; action?: { label: string; run: () => void } }) => void;
  /** The tab the last command acted on — "it" for the next one. */
  onActed: (ref: TabRef | null) => void;
  /** Whether a shell has a process running (async, so checked at ⏎ for close/interrupt). */
  isBusy?: (ref: TabRef) => Promise<boolean>;
  /** Natural language (Claude Haiku via the server). Absent = rules only. */
  model?: {
    status: 'ready' | 'no_key' | 'local_only';
    /** `ctx` is the snapshot the request describes; the reply is resolved against the same one. */
    ask: (text: string, thread: Turn[], ctx: ParseContext, signal: AbortSignal) => Promise<ModelResult>;
    /** `text` is what the user asked, `thread` the earlier turns: a command
     * typed literally in either isn't "suggested". */
    toPlan: (steps: ModelStep[], ctx: ParseContext, opts?: { text: string; thread?: Turn[] }) => Plan;
    onOpenSettings: () => void;
  };
};

const MODEL_ERROR: Record<ModelErrorReason, { message: string; settings: boolean }> = {
  no_key: { message: 'Natural language needs an Anthropic API key', settings: true },
  bad_key: { message: 'Your Anthropic key was rejected', settings: true },
  local_only: { message: 'Local only is on — the model is off', settings: true },
  timeout: { message: 'Haiku took too long — try again', settings: false },
  rate_limited: { message: 'Too many requests, wait a moment', settings: false },
  secret: { message: 'Looks like a secret — not sent', settings: false },
  thread: { message: 'The conversation got out of sync — try again', settings: false },
  model_unavailable: { message: 'Haiku is unavailable right now', settings: false },
  refused: { message: 'That text is never sent to the model', settings: false },
  failed: { message: 'Couldn’t reach the model', settings: false },
};
const NOT_SENDABLE: Record<string, string> = { shell: 'shell lines stay local', secret: 'it looks like it contains a secret', too_long: 'it is too long', multiline: 'multi-line text is not sent to the model', empty: 'nothing to send' };
const DISCLOSED_KEY = 'strado:jarvis-model-disclosed';
// A conversation left this long is over: the next ask starts a new thread.
const THREAD_IDLE_MS = 120_000;

/** What ⌘K (and the sidebar's search button) holds to put the cursor in the
 * bar; `browse` (the Dock's worktree chip) also lists every worktree. */
export type CommandBarHandle = { focus: () => void; browse: () => void };
// ⏎ is ignored this long after a model plan arrives (a stray ⏎ meant for the ask).
const PLAN_ENTER_GUARD_MS = 500;
/** How much of an answer is read aloud (a spoken question gets a spoken answer). */
const SPEAK_MAX = 300;
/** A long request grows the box (upward in the Dock) up to this many lines, then scrolls inside. */
const BOX_LINES = 4;
/** Line height and vertical padding (px) of the bar's and the home box's text; the classes below match. */
const BAR_BOX = { line: 20, pad: 12, text: 'py-1.5 text-[13px] leading-5' };
const HERO_BOX = { line: 24, pad: 24, text: 'py-3 text-base leading-6' };
/** Read an answer aloud, cut at a word near SPEAK_MAX; any earlier one stops. */
function speak(text: string) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  text = plainAnswer(text);
  const cut = text.length <= SPEAK_MAX ? text : `${text.slice(0, SPEAK_MAX).replace(/\s+\S*$/, '')}…`;
  synth.cancel();
  synth.speak(new SpeechSynthesisUtterance(cut));
}
/** What was in the box, then what was said after it (one space between). */
const withSaid = (before: string, said: string) => (!said.trim() ? before : before.trim() ? `${before.replace(/\s+$/, '')} ${said}` : said);
const hush = () => { try { window.speechSynthesis?.cancel(); } catch { /* no speech here */ } };
/** What was typed (or said) for each question still waiting: its answer shows under it.
 * Module-level, so it survives the box being replaced (home → Dock). */
const askedText = new Map<string, string>();
/** The lines under each asked text, one per question (or the recap): an answer replaces its own. */
const answerLines = new Map<string, { id: string; line: string }[]>();
/** Quiet this long in the partials while still holding: ask early (speculate). */
const SPECULATE_PAUSE_MS = 400;
/** Space held this long in the box turns into push-to-talk; a tap is far shorter. */
const SPACE_HOLD_MS = 350;
/** The bar holds the keyboard: once you are typing or talking to Strado,
 * nothing the app does (a tab opening, a worktree or Focus switch remounting
 * the screen, a terminal grabbing focus) takes it away. Only you do: a click
 * elsewhere, Esc, Tab, an app shortcut, or asking to focus a tab. Module-level
 * so a bar that replaces another (home → Dock) keeps holding it. Starts
 * when you type or talk in the box, not when it merely has focus. */
let keepKeyboard = false;
/** Every change goes through here: the desktop shell holds the keyboard for
 * this page meanwhile (a Browser preview's page can't take it without a click). */
function setKeepKeyboard(on: boolean) {
  if (keepKeyboard === on) return;
  keepKeyboard = on;
  window.strado?.holdKeyboard?.(on);
}
/** Let go of the keyboard (tests start each case from a clean slate). */
export function releaseKeyboard() { setKeepKeyboard(false); }
/** Where focus may be pulled back from: nowhere, a pane, or a non-typing
 * element. Never from a dialog or another text field the app opened for you. */
function reclaimable(el: Element | null): boolean {
  if (!el || el === document.body) return true;
  if (el.closest('[role="dialog"], [aria-modal="true"]')) return false;
  if (el.closest('[data-pane-key]')) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return false;
  return !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
}
/** A dialog has the keyboard (focus is in one, or a modal is up): push-to-talk
 * must not start behind it, and Space stays the dialog's. */
function dialogHasKeyboard(target: Element | null): boolean {
  return !!target?.closest('[role="dialog"], [aria-modal="true"]') || !!document.querySelector('[aria-modal="true"]');
}
// Editing keys that stay in the box; any other ⌘/⌃ combo is an app shortcut.
const BOX_COMBOS = new Set(['a', 'c', 'v', 'x', 'z', 'k', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Meta', 'Control', 'Shift', 'Alt']);
// Push-to-talk needs two macOS permissions; each links to its own pane.
const VOICE_PERMISSION: Record<string, { what: string; href: string }> = {
  mic_denied: { what: 'microphone', href: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' },
  speech_denied: { what: 'speech recognition', href: 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition' },
};

type ModelState = { text: string; phase: 'thinking' | 'plans' | 'answer' | 'error' | 'unusable'; model?: string; ms?: number; plans?: Plan[]; ctx?: ParseContext; answer?: string; choices?: string[]; error?: { message: string; settings: boolean }; unusable?: string };

// A short reply to an answer with choices picks one locally ("yes" = the first).
const CHOICE_WORDS: Record<string, number> = { yes: 0, y: 0, yeah: 0, yep: 0, ok: 0, okay: 0, sure: 0, first: 0, '1': 0, second: 1, '2': 1, third: 2, '3': 2, fourth: 3, '4': 3 };
const choiceIndex = (text: string): number | undefined => CHOICE_WORDS[text.trim().toLowerCase().replace(/[.!? ]+$/, '')];

// A typed first character that means "this is a command, not a search".
const COMMAND_PREFIX = /^[$@>]/;
const VERIFY_TEXT: Record<string, string> = {
  target_gone: 'That tab is gone.',
  target_busy: 'That tab is busy now — check it and press ⏎ again.',
  target_replaced: 'That tab was closed and replaced — check it and press ⏎ again.',
};
const IDLE_ROW: JarvisRowState = { arm: null, status: {}, error: null, busy: false };

type Item =
  | { type: 'model' }
  // A follow-up the model offered with its answer; picking it asks it.
  | { type: 'choice'; text: string; n: number }
  // Typed text before ⏎: the single quiet "⏎ to run" line.
  | { type: 'submit' }
  | { type: 'nav'; r: Result }
  | { type: 'jarvis'; plan: Plan; index: number }
  | { type: 'history'; text: string; pasted: boolean };

type Result =
  | { kind: 'worktree'; id: string; label: string; detail: string; worktree: Worktree; wsId?: string; remote?: undefined }
  // A runner worktree in this workspace (opened through the remote hub).
  | { kind: 'worktree'; id: string; label: string; detail: string; remote: RemoteWorktree; worktree?: undefined; wsId?: undefined }
  | { kind: 'repo'; id: string; label: string; detail: string; repoId: string }
  | { kind: 'focus'; id: string; label: string; detail: string; focusId: string }
  | { kind: 'workspace'; id: string; label: string; detail: string; wsId: string };

const GROUP_LABEL: Record<Result['kind'], string> = {
  worktree: 'Worktrees',
  repo: 'Repos',
  focus: 'Focuses',
  workspace: 'Workspaces',
};

const NO_REMOTE: RemoteWorktree[] = [];
const NO_FOCUSES: Focus[] = [];

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// The command bar, docked at the bottom of the board: one always-visible box
// over everything navigable — worktrees (opens the hub, into the active
// Focus), repos (starts a worktree), workspaces — and, with Jarvis, commands.
// It only takes keys once focused (click or ⌘K); what it has to say opens as a
// popover above it, and finishing hands focus back to the pane that had it.
export function CommandPalette({
  repos,
  worktrees,
  workspaces,
  activeWorkspaceId,
  onOpenWorktree,
  onGoRepo,
  onSwitchWorkspace,
  onClose,
  remoteWorktrees = NO_REMOTE,
  onOpenRemoteWorktree,
  focusName,
  focusMemberIds,
  focuses = NO_FOCUSES,
  activeFocusId = null,
  onSwitchFocus,
  jarvis,
  barRef,
  onOpen,
  embedded = false,
  hero = false,
  stations,
  voice = null,
  dialogOpen = false,
}: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  // wsId set when the worktree lives in another workspace (switch first)
  onOpenWorktree: (w: Worktree, wsId?: string) => void;
  onGoRepo: (repoId: string) => void;
  onSwitchWorkspace: (wsId: string) => void;
  onClose: () => void;
  // This workspace's runner worktrees: ⌘K and the Worktrees page are how one
  // outside the active Focus gets opened.
  remoteWorktrees?: RemoteWorktree[];
  onOpenRemoteWorktree?: (w: RemoteWorktree) => void;
  /** The active Focus: its members get a small tag, so you can tell what opening will add. */
  focusName?: string;
  focusMemberIds?: Set<string>;
  /** Every Focus in this workspace; the inactive ones are rows that switch to it. */
  focuses?: Focus[];
  activeFocusId?: string | null;
  onSwitchFocus?: (id: string) => void;
  jarvis?: JarvisPaletteProps;
  barRef?: { current: CommandBarHandle | null };
  /** The bar took focus (telemetry, refreshing what the host reads on open). */
  onOpen?: () => void;
  /** Inside the Dock row: no border or gutters of its own, it fills the middle. */
  embedded?: boolean;
  /** The intercom stations, for the `@` picker. */
  stations?: StationDto[];
  /** The home screen's big box: focused on arrival, results drop below it, and
   * nothing pops up until there is something to show (the Recent list stays visible). */
  hero?: boolean;
  /** The desktop shell's on-device speech (push-to-talk); absent elsewhere, and then there is no mic. */
  voice?: VoiceBridge | null;
  /** A dialog the app has open (Add repo, New worktree, …): push-to-talk keys belong to it. */
  dialogOpen?: boolean;
}) {
  // Focused = open: the popover shows and keys are ours. Blurred, the bar is inert.
  const [open, setOpen] = useState(false);
  // Opened from the worktree chip: the empty box lists every worktree, not just the Focuses.
  const [browse, setBrowse] = useState(false);
  // `@` mentions picked from the picker: shown as @label, submitted as @{agentId}.
  const [chips, setChips] = useState<Chip[]>([]);
  const [caret, setCaret] = useState(0);
  // The mention (by its @ position) whose picker Esc closed; typing elsewhere reopens.
  const [pickerOff, setPickerOff] = useState<number | null>(null);
  const [pickSel, setPickSel] = useState(0);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const voiceCaretRef = useRef<HTMLDivElement>(null);
  const barElRef = useRef<HTMLDivElement>(null);
  // Where focus was before the bar took it, and which tab the hub had focused
  // then ("this"); finishing returns there (or to a tab the run focused).
  const lastOutsideRef = useRef<HTMLElement | null>(null);
  const focusedBeforeRef = useRef<TabRef | null>(null);
  useEffect(() => {
    const note = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el !== document.body && !barElRef.current?.contains(el)) lastOutsideRef.current = el;
    };
    document.addEventListener('focusin', note, true);
    return () => document.removeEventListener('focusin', note, true);
  }, []);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  // Pasted input never runs on the first ⏎ (it opens the preview).
  const [pasted, setPasted] = useState(false);
  const pasteRef = useRef(false);
  // ↑ in the empty box walks back through this workspace's commands.
  const [history, setHistory] = useState<HistoryEntry[]>(() => (jarvis ? readHistoryEntries(jarvis.wsId) : []));
  const [recall, setRecall] = useState<number | null>(null);
  // The busy-shell check at ⏎ replaces a row's plan until the text changes.
  const [edits, setEdits] = useState<Record<number, Plan>>({});
  // The text whose local readings are on screen (shown only by ⏎: a confirm,
  // a pasted command, a pick list).
  const [shownText, setShownText] = useState<string | null>(null);
  // What ⏎ said without asking the model (no key, not sendable, unknown, paste check).
  const [outcome, setOutcome] = useState<{ text: string; view: ModelRowView } | null>(null);
  // Keyed by row identity (`m<i>` model plan, `r<i>` local reading), never by
  // list position: the model's plans arrive above the local rows, and a confirm
  // armed for one reading must never apply to another. A model result or a
  // query change clears it outright.
  const [rowState, setRowState] = useState<{ key: string; state: JarvisRowState } | null>(null);
  // Bumped to re-parse against fresh context (a stale preview).
  const [reparse, setReparse] = useState(0);
  // Natural language: one thread per open box ("no, below it" follows up).
  const threadRef = useRef(createThread());
  // One speculator for the box's life; it asks through whatever model is wired now.
  const jarvisLiveRef = useRef(jarvis);
  jarvisLiveRef.current = jarvis;
  const [speculator] = useState(() => createSpeculator((text, thread, ctx, signal) => {
    const ask = jarvisLiveRef.current?.model?.ask;
    return ask ? ask(text, thread, ctx, signal) : Promise.resolve({ kind: 'error', reason: 'failed' } as const);
  }));
  const askRef = useRef<AbortController | null>(null);
  // The text the in-flight ask is for: a choice sets the box to it, which is not "the user moved on".
  const askTextRef = useRef<string | null>(null);
  // The last answer's choices, while that answer is the latest model turn.
  const lastChoicesRef = useRef<string[] | null>(null);
  const [modelState, setModelState] = useState<ModelState | null>(null);
  // A ⏎ landing just as a plan arrives was meant for the ask, not the plan.
  const planArrivedRef = useRef<{ at: number; text: string } | null>(null);
  // The text whose single model plan should run as soon as it is a row.
  const autoRunRef = useRef<string | null>(null);
  const lastTurnAtRef = useRef(0);
  // Where the conversation happened: tab names are relative to it.
  const threadScopeRef = useRef<string | null>(null);
  const [disclosed, setDisclosed] = useState(() => { try { return localStorage.getItem(DISCLOSED_KEY) === '1'; } catch { return true; } });
  useEffect(() => () => askRef.current?.abort(), []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const repoName = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos]);
  // Client-only embed tabs (VS Code / Browser / Knowledge Base) live in
  // localStorage, not on the Worktree — read once per palette open so rows
  // can badge them too.
  const vscodeTabs = useMemo(() => readVscodeTabs(), [open]);
  const browserTabs = useMemo(() => readBrowserTabs(), [open]);
  const kbTabs = useMemo(() => readKbTabs(), [open]);

  // Worktrees from the OTHER workspaces, loaded once per palette open so
  // any worktree is reachable without switching workspace first.
  const [remote, setRemote] = useState<{ ws: Workspace; items: Worktree[] }[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all(
      workspaces
        .filter((ws) => ws.id !== activeWorkspaceId)
        .map(async (ws) => ({ ws, items: await api.worktrees.list(ws.id).catch(() => [] as Worktree[]) })),
    ).then((loaded) => {
      if (alive) setRemote(loaded);
    });
    return () => {
      alive = false;
    };
  }, [workspaces, activeWorkspaceId, open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const lru = readWorktreeLru();
    const out: Result[] = [];

    // An empty query is the Focus switcher: every Focus, most recently used
    // first, the current one marked. Typing searches everything, Focuses
    // still leading so the 15-row cap never buries them under worktrees.
    for (const f of [...focuses].sort(byLastActive)) {
      if (q && !matches(q, f.name)) continue;
      const n = `${f.members.length} worktree${f.members.length === 1 ? '' : 's'}`;
      const current = f.id === activeFocusId;
      out.push({ kind: 'focus', id: f.id, label: f.name, detail: current ? `current · ${n}` : n, focusId: f.id });
    }
    if (!q && out.length > 0 && !browse) return out;

    // Collect every matching worktree (local + remote) into one list, then rank
    // by activity + recency so the ones the user is working in float to the top.
    const isActive = (w: Worktree) => hasSession(w) || w.process?.status === 'running';
    const wts: (RankableWorktree & { result: Extract<Result, { kind: 'worktree' }> })[] = [];
    let index = 0;
    for (const w of worktrees) {
      const ticket = w.meta?.ticketId ?? '';
      const title = w.meta?.title ?? '';
      const repo = (w.repoId && repoName.get(w.repoId)) || '';
      if (q && !matches(q, ticket, title, w.branch, repo)) continue;
      wts.push({
        path: w.path,
        active: isActive(w),
        index: index++,
        result: {
          kind: 'worktree',
          id: w.path,
          label: ticket || w.branch || w.path.split('/').pop() || w.path,
          detail: [title, repo].filter(Boolean).join(' · '),
          worktree: w,
        },
      });
    }
    for (const w of remoteWorktrees) {
      const id = `remote:${w.runnerId}:${w.path}`;
      const repo = (w.localRepoId && repoName.get(w.localRepoId)) || w.remoteRepoName || '';
      if (q && !matches(q, w.branch, w.name, repo, w.runnerName)) continue;
      wts.push({
        path: w.path,
        active: false,
        index: index++,
        result: {
          kind: 'worktree',
          id,
          label: w.branch ?? w.name,
          detail: [repo, w.runnerName].filter(Boolean).join(' · '),
          remote: w,
        },
      });
    }
    for (const { ws, items } of remote) {
      for (const w of items) {
        const ticket = w.meta?.ticketId ?? '';
        const title = w.meta?.title ?? '';
        if (q && !matches(q, ticket, title, w.branch, ws.name)) continue;
        wts.push({
          path: w.path,
          active: isActive(w),
          index: index++,
          result: {
            kind: 'worktree',
            id: `${ws.id}:${w.path}`,
            label: ticket || w.branch || w.path.split('/').pop() || w.path,
            detail: [title, `${ws.name} · switch & open`].filter(Boolean).join(' · '),
            worktree: w,
            wsId: ws.id,
          },
        });
      }
    }
    wts.sort((a, b) => compareByActivityThenRecency(a, b, lru));
    for (const { result } of wts) out.push(result);

    for (const r of repos) {
      if (q && !matches(q, r.name, r.path)) continue;
      out.push({ kind: 'repo', id: r.id, label: r.name, detail: r.path, repoId: r.id });
    }
    for (const ws of workspaces) {
      if (ws.id === activeWorkspaceId) continue;
      if (q && !matches(q, ws.name)) continue;
      out.push({ kind: 'workspace', id: ws.id, label: ws.name, detail: 'switch workspace', wsId: ws.id });
    }
    return out.slice(0, 15);
  }, [query, worktrees, remote, remoteWorktrees, repos, focuses, activeFocusId, workspaces, activeWorkspaceId, repoName, browse]);

  const parsed = useMemo(() => {
    const text = query.trim();
    if (!jarvis || !text) return { rows: [] as Plan[], ctx: null as ParseContext | null };
    const ctx = jarvis.context();
    const plan = jarvis.parse({ text: toWire(query, chips), pasted }, ctx);
    // "Ask the focused agent" is not offered: unknown text goes to Haiku.
    const rows = [...(plan.steps.length > 0 ? [plan] : []), ...(plan.alternatives ?? [])].filter((p) => p.steps.length > 0 && p.source !== 'fallback');
    // Readings the user keeps choosing float up; ties keep the parser's order.
    const score = (p: Plan) => frecencyScore(jarvis.wsId, planKey(p));
    const ranked = rows.map((p, i) => ({ p, i, f: score(p) })).sort((a, b) => b.f - a.f || a.i - b.i).map((x) => x.p);
    return { rows: ranked, ctx };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, chips, pasted, reparse, jarvis?.wsId]);

  // The model's plans for exactly this text lead the rows (they answer what
  // was asked); a pasted ask still needs the second ⏎.
  const modelPlans = useMemo(
    () => (modelState?.phase === 'plans' && modelState.text === query ? (modelState.plans ?? []).map((p) => (pasted ? { ...p, executable: false } : p)) : []),
    [modelState, query, pasted],
  );
  const rows = useMemo(() => [...modelPlans, ...parsed.rows], [modelPlans, parsed]);
  const ctxFor = (index: number): ParseContext | null => (index < modelPlans.length ? modelState?.ctx ?? null : parsed.ctx);

  // What the model (or ⏎) said about exactly this text.
  const modelView = useMemo<ModelRowView | null>(() => {
    if (modelState && modelState.text === query) {
      if (modelState.phase === 'thinking') return { kind: 'thinking' };
      if (modelState.phase === 'answer') return { kind: 'answer', text: modelState.answer ?? '' };
      if (modelState.phase === 'error') return { kind: 'error', ...modelState.error! };
      if (modelState.phase === 'unusable') return { kind: 'unusable', message: modelState.unusable ?? '' };
      return null; // plans: they are the rows
    }
    return outcome && outcome.text === query ? outcome.view : null;
  }, [query, modelState, outcome]);

  const items = useMemo<Item[]>(() => {
    const nav: Item[] = results.map((r) => ({ type: 'nav', r }));
    const text = query.trim();
    if (!text) return [...nav, ...history.slice(0, 5).map((h): Item => ({ type: 'history', text: h.text, pasted: h.pasted }))];
    if (!jarvis) return nav;
    // Only what ⏎ brought up: the model's plans, local readings it revealed,
    // or a reply. Before that, one quiet "⏎ to run" line.
    const shown = rows
      .map((plan, index): Item => ({ type: 'jarvis', plan: edits[index] ?? plan, index }))
      .filter((it) => it.type === 'jarvis' && (it.index < modelPlans.length || shownText === query));
    const choices = modelState?.text === query && modelState.phase === 'answer' ? modelState.choices ?? [] : [];
    const acts: Item[] = [...shown, ...(modelView ? [{ type: 'model' } as Item] : []), ...choices.map((c, n): Item => ({ type: 'choice', text: c, n }))];
    if (acts.length === 0) acts.push({ type: 'submit' });
    if (COMMAND_PREFIX.test(text)) return acts;
    // A name-like query ("FD-1", "payments") keeps navigation first.
    const q = text.toLowerCase();
    const navFirst = acts[0]!.type === 'submit' && results.some((r) => r.label.toLowerCase().startsWith(q));
    return navFirst ? [...nav, ...acts] : [...acts, ...nav];
  }, [results, rows, modelPlans, modelView, edits, history, query, shownText, jarvis]);

  useEffect(() => {
    setSel(0);
    setEdits({});
    setRowState(null);
    setShownText(null);
    // What ⏎ said about exactly this text stays (an agent's answer brought back with its question).
    setOutcome((o) => (o && o.text === query ? o : null));
    // New text: whatever the model was doing is for the old one.
    if (askTextRef.current !== query) {
      askRef.current?.abort();
      askRef.current = null;
    }
    setModelState((m) => (m && m.text === query ? m : null));
  }, [query]);

  const askModel = async (choice?: string) => {
    const m = jarvis?.model;
    if (!m) return;
    const text = choice ?? query;
    askTextRef.current = text;
    // `asked` carries each chip as @{agentId} (exact); the model gets names it knows.
    const asked = (choice ?? toWire(query, chips)).trim().replace(/^>\s*/, '');
    const shown = text.trim().replace(/^>\s*/, '');
    const scope = `${jarvis!.wsId}\n${jarvis!.context().currentWorktree ?? ''}`;
    // Idle too long, or another worktree/workspace: "shell-1" would now mean a different tab.
    if (Date.now() - lastTurnAtRef.current > THREAD_IDLE_MS || scope !== threadScopeRef.current) threadRef.current.clear();
    threadScopeRef.current = scope;
    askRef.current?.abort();
    const ac = new AbortController();
    askRef.current = ac;
    if (!disclosed) { try { localStorage.setItem(DISCLOSED_KEY, '1'); } catch { /* shown again next time */ } setDisclosed(true); }
    if (!pasted) logFallthrough(shown);
    setModelState({ text, phase: 'thinking' });
    // The model names tabs from this snapshot; its answer must be read against
    // the same one (verifyPlan still checks the live layout at ⏎).
    const ctx = jarvis!.context();
    const forModel = modelText(asked, ctx);
    // A voice ask may already be in flight from a pause while held: take() reuses
    // it when the words match, else asks fresh (as m.ask would).
    let res = await speculator.take(forModel, ctx, threadRef.current.turns(), ac.signal);
    // The server rejected our thread's shape: start the conversation over, once.
    if (res.kind === 'error' && res.reason === 'thread' && !ac.signal.aborted && askRef.current === ac) {
      threadRef.current.clear();
      res = await m.ask(forModel, [], ctx, ac.signal);
    }
    if (ac.signal.aborted || res.kind === 'aborted' || askRef.current !== ac) return;
    askRef.current = null;
    askTextRef.current = null;
    // Whatever was armed belongs to the rows before this result.
    setRowState(null);
    lastTurnAtRef.current = Date.now();
    if (res.kind === 'error') { setModelState({ text, phase: 'error', error: MODEL_ERROR[res.reason] ?? MODEL_ERROR.failed }); return; }
    threadRef.current.push('user', forModel);
    if (res.kind === 'answer') {
      threadRef.current.push('assistant', res.text);
      lastChoicesRef.current = res.choices?.length ? res.choices : null;
      setModelState({ text, phase: 'answer', model: res.model, ms: res.ms, answer: res.text, ...(res.choices?.length ? { choices: res.choices } : {}) });
      return;
    }
    lastChoicesRef.current = null;
    // turns() holds answered pairs only: this ask isn't in it yet.
    const plan = m.toPlan(res.steps, ctx, { text: asked, thread: threadRef.current.turns() });
    const plans = (plan.steps.length > 0 ? [plan] : plan.alternatives ?? []).filter((p) => p.steps.length > 0);
    threadRef.current.push('assistant', plan.summary);
    if (plans.length === 0) { setModelState({ text, phase: 'unusable', unusable: plan.summary }); return; }
    planArrivedRef.current = { at: Date.now(), text };
    // One reading, not pasted: run it straight away (runRow still stops for
    // a confirm, a busy shell or a moved layout). A pick list waits.
    autoRunRef.current = plans.length === 1 && !pasted ? text : null;
    setModelState({ text, phase: 'plans', model: res.model, ms: res.ms, plans, ctx });
    setEdits({});
    setSel(0);
  };
  // Holding the keyboard (see keepKeyboard): a new bar takes it on mount; a
  // press anywhere outside the bar is you leaving.
  useEffect(() => {
    // Taken by itself (home → Dock, a remount): quiet, so no empty popover covers a Browser preview.
    if (keepKeyboard && !voiceRef.current.dialogOpen && reclaimable(document.activeElement)) { setQuiet(true); inputRef.current?.focus(); }
    // The shell learns where things stand (a reload, a new window).
    window.strado?.holdKeyboard?.(keepKeyboard);
    const press = (e: PointerEvent) => { if (!barElRef.current?.contains(e.target as Node)) setKeepKeyboard(false); };
    // The keyboard comes back to this page (the shell took it off a preview):
    // into the box, if it is holding it.
    const back = () => {
      if (keepKeyboard && !voiceRef.current.dialogOpen && document.activeElement !== inputRef.current && reclaimable(document.activeElement)) { setQuiet(true); inputRef.current?.focus(); }
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('focus', back);
    return () => { window.removeEventListener('pointerdown', press, true); window.removeEventListener('focus', back); };
  }, []);
  useEffect(() => {
    if (!barRef) return;
    barRef.current = {
      focus: () => { setQuiet(false); inputRef.current?.focus(); },
      browse: () => { setQuiet(false); setBrowse(true); inputRef.current?.focus(); },
    };
    return () => { barRef.current = null; };
  }, [barRef]);

  /** Done with this command: forget it, and give focus back — to the tab the
   * run focused, else to whatever had it before the bar. The conversation
   * survives a run ("no, below it" right after); Esc ends it. */
  const dismiss = (endConversation = false) => {
    setQuiet(false);
    setKeepKeyboard(false);
    askRef.current?.abort();
    askRef.current = null;
    if (endConversation) { threadRef.current.clear(); lastChoicesRef.current = null; }
    setModelState(null);
    setQuery('');
    setChips([]);
    setPasted(false);
    setRecall(null);
    const before = focusedBeforeRef.current;
    const now = jarvis?.context().focused ?? null;
    const moved = now && !(before && before.worktreePath === now.worktreePath && before.mode === now.mode && before.sessionId === now.sessionId);
    const back = lastOutsideRef.current;
    // Only hand focus back if the bar still has it: a run that finishes after
    // the user clicked elsewhere must not pull them out of where they are.
    const hadFocus = document.activeElement === inputRef.current;
    inputRef.current?.blur();
    setOpen(false);
    setBrowse(false);
    const target = (): HTMLElement | null => {
      if (moved) {
        const pane = document.querySelector<HTMLElement>(`[data-pane-key="${now.mode}:${now.sessionId}"]`);
        if (pane) return pane.querySelector<HTMLElement>('textarea, input, iframe') ?? pane;
      }
      return back?.isConnected ? back : null;
    };
    // After the run's own renders (a newly focused tab mounts its pane).
    if (hadFocus) setTimeout(() => target()?.focus(), 0);
    onClose();
  };
  const [quiet, setQuiet] = useState(false);
  /** Done with this command, but you are still talking: clear the box and
   * keep the keyboard (unless you already went elsewhere). */
  const settle = () => {
    setQuiet(true);
    askRef.current = null;
    setModelState(null);
    setQuery('');
    setChips([]);
    setPasted(false);
    setRecall(null);
    setBrowse(false);
  };
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  // An answer with choices: the first choice is the selected row ("⏎" takes it).
  useEffect(() => {
    if (modelState?.phase !== 'answer' || !modelState.choices?.length || modelState.text !== query) return;
    const i = items.findIndex((it) => it.type === 'choice');
    if (i >= 0) setSel(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelState]);

  const rowKey = (index: number) => (index < modelPlans.length ? `m${index}` : `r${index - modelPlans.length}`);
  const patchRow = (key: string, patch: Partial<JarvisRowState>) =>
    setRowState((prev) => ({ key, state: { ...(prev?.key === key ? prev.state : IDLE_ROW), ...patch } }));
  const stateOf = (key: string): JarvisRowState | null => (rowState?.key === key ? rowState.state : null);

  const runRow = async (index: number, keepOpen: boolean) => {
    const bindCtx = ctxFor(index);
    if (!jarvis || !bindCtx) return;
    const plan = edits[index] ?? rows[index];
    if (!plan || plan.steps.length === 0) return;
    const key = rowKey(index);
    const current = stateOf(key) ?? IDLE_ROW;
    if (current.busy) return;
    if (!plan.executable && current.arm !== 'paste' && current.arm !== 'confirm') { patchRow(key, { arm: 'paste', error: null }); return; }
    if (current.arm !== 'confirm') {
      // A shell's running process isn't in the parse context (it takes a
      // request), so close/interrupt on a shell is checked here, once, and the
      // reason goes on exactly the steps whose shell is busy.
      let checked = plan;
      if (jarvis.isBusy) {
        const isShellStop = (st: Plan['steps'][number]) =>
          (st.action === 'tab.close' || st.action === 'tab.interrupt') && st.target.kind === 'tab' && st.target.ref.mode === 'shell';
        patchRow(key, { busy: true });
        const busy = await Promise.all(plan.steps.map((st) => (isShellStop(st) && st.target.kind === 'tab' ? jarvis.isBusy!(st.target.ref).catch(() => false) : Promise.resolve(false))));
        patchRow(key, { busy: false });
        if (busy.some(Boolean)) {
          // The same words as the model path (safety.ts), with the action's own verb.
          const tabs = jarvis.context().tabs;
          const why = (st: Plan['steps'][number]) => {
            const r = st.target.kind === 'tab' ? st.target.ref : null;
            const name = (r && tabs.find((t) => t.worktreePath === r.worktreePath && t.mode === r.mode && t.sessionId === r.sessionId)?.label) || 'That shell';
            return `${name} is running something — ${st.action === 'tab.interrupt' ? 'interrupt' : 'close'} it anyway?`;
          };
          checked = { ...plan, steps: plan.steps.map((st, i) => {
            if (!busy[i]) return st;
            const reason = why(st);
            if (st.confirmReason?.includes(reason)) return { ...st, needsConfirm: true };
            return { ...st, needsConfirm: true, confirmReason: st.confirmReason ? `${st.confirmReason}; ${reason}` : reason };
          }) };
          setEdits((prev) => ({ ...prev, [index]: checked }));
        }
      }
      if (checked.steps.some((st) => st.needsConfirm)) { patchRow(key, { arm: 'confirm', error: null }); return; }
    }
    // The preview bound its targets to the layout it showed; anything moved since → re-preview.
    const verdict = verifyPlan(bindPlan(plan, bindCtx), jarvis.context());
    if (!verdict.ok) {
      const at = 'step' in verdict ? verdict.step : 0;
      patchRow(key, { arm: null, error: { index: at, reason: VERIFY_TEXT[verdict.reason] ?? verdict.reason } });
      setReparse((n) => n + 1);
      return;
    }
    const text = query;
    rememberCommand(jarvis.wsId, text, { pasted });
    setHistory(readHistoryEntries(jarvis.wsId));
    patchRow(key, { arm: null, error: null, busy: true, status: {} });
    const result = await runPlan(plan, {
      ...jarvis.ports(),
      onStep: (i, status) => setRowState((prev) => (prev?.key === key ? { key, state: { ...prev.state, status: { ...prev.state.status, [i]: status } } } : prev)),
    });
    jarvis.onActed(result.lastActedOn);
    const undoable = plan.steps.every((st) => st.undoable);
    // The model's turn becomes what actually happened (real tab names, or
    // where it stopped), so the next ask reads "this"/"it" right. Local rule
    // runs aren't in the thread.
    const recordOutcome = () => {
      if (plan.source === 'model') threadRef.current.amend(describeRun(plan, { done: result.done, failed: result.failed, opened: result.opened }, jarvis.context()));
    };
    if (!result.ok) {
      recordOutcome();
      patchRow(key, { busy: false, error: result.failed ?? null });
      if (result.undo.length > 0) jarvis.onRan({ ok: false, summary: plan.summary, undo: result.undo, undoable });
      return;
    }
    recordUse(jarvis.wsId, planKey(plan));
    // A tab you just opened is where you are now: it becomes the focused tab,
    // so the next "this" (and the model's `focused`) names it.
    if (result.lastActedOn && plan.steps.some((st) => st.action === 'tab.open' || st.action === 'browser.open')) {
      jarvis.ports().hub?.focus(result.lastActedOn);
    }
    // Asks and recaps answer in the box: the question stays, its answer (or
    // "asked …") shows under it, and a spoken question is answered aloud.
    if (result.recap || result.asks.length > 0) {
      recordOutcome();
      const spoken = spokenRef.current === text;
      const lines: { id: string; line: string }[] = [];
      if (result.recap) { lines.push({ id: 'recap', line: result.recap }); if (spoken) speak(result.recap); }
      for (const a of result.asks) {
        const name = agentName(a.to.agentId, a.to.alias);
        askedText.set(a.id, text);
        expectAnswer(jarvis.wsId, { id: a.id, agentId: a.to.agentId, name, spoken });
        lines.push({ id: a.id, line: a.delivered === 'sent' ? `Asked ${name}, the answer will show here` : `${name} is busy, it’ll answer after this turn` });
      }
      answerLines.set(text, lines);
      jarvis.onRan({ ok: true, summary: plan.summary, undo: result.undo, undoable });
      askRef.current = null;
      setModelState(null);
      setOutcome({ text, view: { kind: 'answer', text: lines.map((l) => l.line).join('\n\n') } });
      patchRow(key, { busy: false });
      return;
    }
    // A lone message says how it landed; sent to an agent at rest, its tab
    // comes up (when it is in this strip) so you see it answer.
    let summary = plan.summary;
    const sent = plan.steps.length === 1 ? result.messages[0] : undefined;
    if (sent) {
      const name = sent.to.alias ?? sent.to.agentId.split('@')[0]!;
      summary = sent.delivered === 'sent' ? `Sent to ${name} via intercom` : `${name} is busy — it’ll read it after this turn`;
      const here = jarvis.context();
      const tab = sent.delivered === 'sent' ? here.tabs.find((t) => t.agentId === sent.to.agentId && t.worktreePath === here.currentWorktree) : undefined;
      if (tab) jarvis.ports().hub?.focus({ worktreePath: tab.worktreePath, mode: tab.mode, sessionId: tab.sessionId });
    }
    recordOutcome();
    // After the focus change: the undo toast snapshots the layout on mount.
    jarvis.onRan({ ok: true, summary, undo: result.undo, undoable, ...(sent?.delivered === 'queued' ? { notice: true } : {}) });
    // Keep talking: the keyboard stays in the box after a run — a tab that
    // opened or came up does not take it — until you ask to go to a tab
    // ("focus the shell"); Esc or a click elsewhere also hands it back.
    if (keepOpen || !plan.steps.some((st) => st.action === 'tab.focus')) {
      settle();
      if (keepOpen) inputRef.current?.focus();
    } else {
      dismiss();
    }
  };

  useEffect(() => {
    if (autoRunRef.current === null || modelPlans.length === 0) return;
    const text = autoRunRef.current;
    autoRunRef.current = null;
    // The user moved on (clicked into a pane) while Haiku thought: never act
    // or move focus behind their back; the plan waits as a row for ⏎.
    if (document.activeElement !== inputRef.current) return;
    if (text === query && modelPlans.length === 1) void runRow(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPlans]);

  /** ⏎ on typed text: a `$` line runs now; anything else goes to the model. */
  const submit = (keepOpen: boolean) => {
    const text = query.trim();
    const m = jarvis?.model;
    if (!jarvis || !text) return;
    if (modelState?.text === query && (modelState.phase === 'thinking' || modelState.phase === 'answer')) return;
    // Choices go stale with the thread (idle, or another worktree/workspace): "yes" is then just text.
    const scope = `${jarvis.wsId}\n${jarvis.context().currentWorktree ?? ''}`;
    if (Date.now() - lastTurnAtRef.current > THREAD_IDLE_MS || scope !== threadScopeRef.current) lastChoicesRef.current = null;
    // "yes" / "2" right after an answer with choices: that choice, without asking what "yes" means.
    const n = lastChoicesRef.current ? choiceIndex(text) : undefined;
    const picked = n !== undefined ? lastChoicesRef.current![n] : undefined;
    if (picked) return askChoice(picked);
    if (modelView?.kind === 'no_key' || (modelView?.kind === 'error' && modelView.settings)) { dismiss(); m?.onOpenSettings(); return; }
    const modelOn = !!m && m.status !== 'local_only';
    if (parsed.rows.length === 1) {
      const p = parsed.rows[0]!;
      const clean = p.executable && !p.steps.some((st) => st.needsConfirm);
      // `$`/`@` lines and pasted text never leave the box; without the model
      // the rules' own confirm is the only path.
      if (clean || pasted || COMMAND_PREFIX.test(text) || !modelOn) {
        setShownText(query);
        void runRow(modelPlans.length, keepOpen);
        return;
      }
    } else if (parsed.rows.length > 1) {
      setShownText(query); // an ambiguous target: pick one, never a guess
      return;
    }
    const say = (view: ModelRowView) => setOutcome({ text: query, view });
    if (COMMAND_PREFIX.test(text) && !text.startsWith('>')) return say({ kind: 'unknown', message: 'Not a command I know' });
    // Plain text is the model's to read; without one, only `$` lines and navigation work.
    if (!m) return say({ kind: 'unknown', message: 'Natural language needs the model' });
    if (m.status === 'local_only' || m.status === 'no_key') return say({ kind: 'no_key' });
    const ok = sendable(text.replace(/^>\s*/, ''));
    if (!ok.ok) return say({ kind: 'not_sendable', why: NOT_SENDABLE[ok.reason] ?? ok.reason });
    if (pasted && modelView?.kind !== 'confirm_paste') return say({ kind: 'confirm_paste' });
    void askModel();
  };

  // ---------- talk to Strado (push-to-talk) ----------
  // What was in the box before listening (Esc puts it back), and the final
  // transcript waiting to be submitted once it is the box's text.
  const beforeVoiceRef = useRef('');
  /** The last thing said (not typed): a request that is exactly it gets its answer read aloud. */
  const spokenRef = useRef<string | null>(null);
  const agentName = (agentId: string, alias?: string | null): string => {
    if (alias) return alias;
    const here = jarvis?.context();
    return here?.peers.find((p) => p.agentId === agentId)?.alias ?? here?.tabs.find((t) => t.agentId === agentId)?.alias ?? agentId.split('@')[0]!;
  };
  // An agent answered a question asked here. Open on that question (or empty):
  // the answer shows under it. Otherwise a toast says it, and Show brings it up.
  const answerRef = useRef<(a: AgentAnswer) => void>(() => {});
  answerRef.current = (a) => {
    const line = `${a.name}: ${a.text}`;
    const asked = askedText.get(a.questionId) ?? '';
    askedText.delete(a.questionId);
    if (a.spoken) speak(a.text);
    // Its own line under the question becomes the answer; the others stay as they are.
    const lines = (answerLines.get(asked) ?? []).map((l) => (l.id === a.questionId ? { ...l, line } : l));
    if (!lines.some((l) => l.id === a.questionId)) lines.push({ id: a.questionId, line });
    answerLines.set(asked, lines);
    const show = () => {
      setQuery(asked); setCaret(asked.length); setChips([]); setPasted(false);
      askRef.current = null; setModelState(null); setQuiet(false);
      setOutcome({ text: asked, view: { kind: 'answer', text: (answerLines.get(asked) ?? lines).map((l) => l.line).join('\n\n') } });
      inputRef.current?.focus();
    };
    if (document.activeElement === inputRef.current && (query === asked || query.trim() === '')) show();
    else jarvis?.onRan({ ok: true, notice: true, summary: line, undo: [], undoable: false, action: { label: 'Show', run: show } });
  };
  useEffect(() => onAgentAnswer((a) => answerRef.current(a)), []);
  // Ask early on a pause while still talking (≥ 400 ms of the same partial);
  // the final reuses that answer when the words match (lib/jarvis/speculate).
  const speculateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopSpeculating = () => {
    if (speculateTimerRef.current) { clearTimeout(speculateTimerRef.current); speculateTimerRef.current = null; }
  };
  const dropSpeculation = () => { stopSpeculating(); speculator.cancel(); };
  useEffect(() => () => dropSpeculation(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const v = useVoice({
    bridge: voice,
    contextual: () => (jarvis ? contextualNames(jarvis.context()) : []),
    // What is said goes after what was already in the box, so a request can be
    // said in several goes. It is never sent by itself: ⏎ sends it.
    onPartial: (t) => {
      const full = withSaid(beforeVoiceRef.current, t);
      setPasted(false); setChips([]); setQuery(full); setCaret(full.length);
      stopSpeculating();
      if (!jarvis || jarvis.model?.status !== 'ready' || !t.trim()) return;
      speculateTimerRef.current = setTimeout(() => {
        speculateTimerRef.current = null;
        if (voiceRef.current.v.phase !== 'listening') return;
        const ctx = jarvis.context();
        speculator.speculate(modelText(full, ctx), ctx, threadRef.current.turns());
      }, SPECULATE_PAUSE_MS);
    },
    onFinal: (t) => {
      stopSpeculating();
      const full = withSaid(beforeVoiceRef.current, t);
      spokenRef.current = full; // ⏎ on exactly this is a spoken request (answered aloud)
      setPasted(false); setChips([]); setQuery(full); setCaret(full.length);
      inputRef.current?.focus();
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(full.length, full.length));
      // Ask ahead so ⏎ is quick (the answer is used only if the words still match).
      if (jarvis && jarvis.model?.status === 'ready' && full.trim()) {
        const ctx = jarvis.context();
        speculator.speculate(modelText(full, ctx), ctx, threadRef.current.turns());
      }
    },
    onCancel: () => { dropSpeculation(); setQuery(beforeVoiceRef.current); setCaret(beforeVoiceRef.current.length); },
    onEmpty: () => dropSpeculation(),
    onError: () => dropSpeculation(),
  });
  const listening = v.phase === 'listening' || v.phase === 'finishing';
  /** `before`: what the box should hold instead (hold-Space takes its typed space back out). */
  const beginVoice = (before?: string) => {
    hush(); // talking again: stop reading the last answer
    beforeVoiceRef.current = before ?? query;
    if (before !== undefined) { setQuery(before); setCaret(before.length); }
    inputRef.current?.focus();
    setKeepKeyboard(true);
    v.start();
  };
  // Before paint, so the box never flashes at the wrong height.
  useLayoutEffect(() => {
    // Grow with the text (wrapped words), up to BOX_LINES; past that it scrolls
    // inside, and while listening the newest words stay in view.
    const el = inputRef.current;
    if (!el) return;
    const box = hero ? HERO_BOX : BAR_BOX;
    const max = box.line * BOX_LINES + box.pad;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, box.line + box.pad), max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    if (listening) el.scrollTop = el.scrollHeight;
    if (mirrorRef.current) mirrorRef.current.scrollTop = el.scrollTop;
    if (voiceCaretRef.current) voiceCaretRef.current.scrollTop = el.scrollTop;
  }, [query, listening, hero]);
  // Hold ⌥Space anywhere in the window — caught on the way down, so a
  // terminal never sees it; auto-repeat is ignored. Release stops.
  const voiceRef = useRef({ v, beginVoice, dialogOpen });
  voiceRef.current = { v, beginVoice, dialogOpen };
  const heldByKeyRef = useRef(false);
  // A plain Space outside the box is never ours: a terminal (Claude Code's own
  // hold-Space dictation) or a page gets it untouched, repeats included.
  useEffect(() => {
    if (!v.available) return;
    const down = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target !== inputRef.current && (voiceRef.current.dialogOpen || dialogHasKeyboard(target))) return;
      if (e.code !== 'Space' || !e.altKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || heldByKeyRef.current) return;
      heldByKeyRef.current = true;
      voiceRef.current.beginVoice();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceHoldRef.current) { endSpaceHold(); return; }
      if (!heldByKeyRef.current || (e.code !== 'Space' && e.key !== 'Alt')) return;
      heldByKeyRef.current = false;
      voiceRef.current.v.stop();
    };
    // Switching apps mid-hold: the key-up goes elsewhere, so stop here.
    const blur = () => {
      endSpaceHold();
      if (heldByKeyRef.current) { heldByKeyRef.current = false; voiceRef.current.v.stop(); }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur);
      endSpaceHold();
    };
  }, [v.available]); // eslint-disable-line react-hooks/exhaustive-deps
  // Hold Space in the box (as in Claude Code): a tap types its space as
  // usual; held past SPACE_HOLD_MS it turns into push-to-talk, that space
  // comes back out, and release stops. Repeats while held never type.
  const spaceHoldRef = useRef<{ timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const endSpaceHold = () => {
    const h = spaceHoldRef.current;
    if (!h) return;
    spaceHoldRef.current = null;
    if (h.timer) clearTimeout(h.timer);
    else voiceRef.current.v.stop();
  };
  /** onKeyDown's Space; true when it handled the key. */
  const spaceHoldKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key !== ' ' || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) {
      // Another key before the hold turns: they're typing (fast "a b" rolls).
      if (spaceHoldRef.current?.timer) endSpaceHold();
      return false;
    }
    if (spaceHoldRef.current) { e.preventDefault(); return true; }
    if (!v.available || listening || e.repeat) return false;
    const before = query;
    const h: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
    h.timer = setTimeout(() => {
      h.timer = null;
      if (spaceHoldRef.current === h) voiceRef.current.beginVoice(before);
    }, SPACE_HOLD_MS);
    spaceHoldRef.current = h;
    return false; // the tap types its space
  };

  /** Ask a choice as the next turn, shown in the box as if typed. */
  const askChoice = (choice: string) => {
    setPasted(false);
    setQuery(choice);
    void askModel(choice);
  };

  const activate = (item: Item, keepOpen = false) => {
    if (item.type === 'choice') return askChoice(item.text);
    if (item.type === 'model' || item.type === 'submit') submit(keepOpen);
    else if (item.type === 'nav') pick(item.r);
    else if (item.type === 'history') { setQuery(item.text); setPasted(item.pasted); }
    else void runRow(item.index, keepOpen);
  };

  const pick = (r: Result) => {
    if (document.activeElement === inputRef.current) { settle(); onClose(); } else dismiss();
    if (r.kind === 'worktree') {
      if (r.remote) onOpenRemoteWorktree?.(r.remote);
      else onOpenWorktree(r.worktree, r.wsId);
    }
    else if (r.kind === 'repo') onGoRepo(r.repoId);
    else if (r.kind === 'focus') { if (r.focusId !== activeFocusId) onSwitchFocus?.(r.focusId); }
    else onSwitchWorkspace(r.wsId);
  };

  const selected = items[sel];

  // ---------- the @ (stations) and # (worktrees) pickers ----------
  const typed = open && jarvis ? mentionAt(query, caret) : null;
  const mention = typed && (typed.sigil === '#' || stations) ? typed : null;
  const picker = useMemo((): { kind: 'stations'; rows: Station[]; dividerBefore: number | null } | { kind: 'worktrees'; rows: RankedWorktree[] } | null => {
    if (!mention || pickerOff === mention.start || !jarvis) return null;
    if (mention.sigil === '#') {
      const lru = readWorktreeLru();
      return { kind: 'worktrees', rows: rankWorktrees(worktrees.map((w) => ({
        path: w.path,
        name: w.meta?.ticketId || w.branch || w.path.split('/').pop() || w.path,
        branch: w.branch ?? null,
        ticket: w.meta?.ticketId ?? null,
        repo: repos.find((r) => r.id === w.repoId)?.name ?? '',
        lastUsedAt: lru[w.path] ?? 0,
      })), mention.query) };
    }
    if (!stations) return null;
    const here = jarvis.context();
    return { kind: 'stations', ...rankStations(stations.map((s) => toRankStation(s, here.currentWorktree, here.focused)), mention.query) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.start, mention?.query, mention?.sigil, pickerOff, stations, worktrees, repos]);
  useEffect(() => { setPickSel(0); }, [mention?.start, mention?.query]);
  const addChip = (label: string, chip: Chip) => {
    if (!mention) return;
    const next = insertChip(query, mention, label);
    setQuery(next.text);
    setChips((c) => [...pruneChips(next.text, c), chip]);
    setCaret(next.caret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.caret, next.caret));
  };
  const pickStation = (row: Station) => { const label = chipLabel(row); addChip(label, { label, agentId: row.agentId }); };
  const pickWorktree = (row: RankedWorktree) => addChip(row.label, { label: row.label, worktreePath: row.option.path });
  const pickRow = (i: number) => {
    if (picker?.kind === 'stations' && picker.rows[i]) pickStation(picker.rows[i]!);
    else if (picker?.kind === 'worktrees' && picker.rows[i]) pickWorktree(picker.rows[i]!);
  };
  /** Keys the open picker owns; true when handled. */
  const pickerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!picker || !mention) return false;
    const rows: unknown[] = picker.rows;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length > 0) setPickSel((i) => (e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)));
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && rows[pickSel]) {
      e.preventDefault();
      pickRow(pickSel);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setPickerOff(mention.start);
      return true;
    }
    return false;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⏎ that accepts an IME candidate is the input method's, not ours.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Esc while talking: cancel, and put back what was typed before.
    if (e.key === 'Escape' && listening) { e.preventDefault(); e.stopPropagation(); spaceHoldRef.current = null; v.cancel(); return; }
    if (spaceHoldKey(e)) return;
    // Tab, or an app shortcut (⌘1, ⌘], …): you are leaving the box.
    if (e.key === 'Tab' || ((e.metaKey || e.ctrlKey) && !BOX_COMBOS.has(e.key))) setKeepKeyboard(false);
    if (pickerKey(e)) return;
    // Backspace right after a chip removes it whole.
    const at = e.currentTarget.selectionStart ?? query.length;
    if (e.key === 'Backspace' && at === (e.currentTarget.selectionEnd ?? at)) {
      const hit = chipEndingAt(query, at, chips);
      if (hit) {
        e.preventDefault();
        const next = query.slice(0, hit.start) + query.slice(at);
        setQuery(next);
        setChips((c) => pruneChips(next, c.filter((x) => x !== hit.chip)));
        setCaret(hit.start);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      // First esc cancels a model call in flight, or backs out of a pending
      // confirm; the next closes.
      if (modelState?.phase === 'thinking') { askRef.current?.abort(); askRef.current = null; setModelState(null); return; }
      if (rowState?.state.arm) { patchRow(rowState.key, { arm: null }); return; }
      dismiss(true);
    } else if (e.key === 'ArrowUp' && jarvis && sel === 0 && (query === '' || recall !== null) && history.length > 0) {
      e.preventDefault();
      const next = recall === null ? 0 : Math.min(recall + 1, history.length - 1);
      setRecall(next);
      setQuery(history[next]!.text);
      setPasted(history[next]!.pasted);
    } else if (e.key === 'ArrowDown' && recall !== null && sel === 0) {
      e.preventDefault();
      const next = recall - 1;
      setRecall(next < 0 ? null : next);
      setQuery(next < 0 ? '' : history[next]!.text);
      setPasted(next < 0 ? false : history[next]!.pasted);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const arrived = planArrivedRef.current;
      if (selected?.type === 'jarvis' && arrived && arrived.text === query && Date.now() - arrived.at < PLAN_ENTER_GUARD_MS) return;
      if (selected) activate(selected, e.metaKey || e.ctrlKey);
    }
  };

  let lastKind: string | null = null;

  // Quiet (after a run, or a focus the box took back by itself): no empty-state
  // panel. It would cover — and so hide — a native Browser preview.
  const popover = open && ((!hero && !quiet) || query.trim() !== '' || browse || modelState !== null);
  useRendererOverlay(popover);
  // On home the box is the page: it starts focused.
  useEffect(() => { if (hero) inputRef.current?.focus(); }, [hero]);

  return (
    <div ref={barElRef} data-testid="command-bar" className={hero ? 'relative w-full' : embedded ? 'relative min-w-0 flex-1' : 'relative w-full shrink-0 border-t border-zinc-900 bg-zinc-950 px-4'}>
      {popover && (
        <div
          data-testid="command-bar-popover"
          data-placement={hero ? 'below' : 'above'}
          // Keep focus in the bar: a click on a row must not blur it first.
          onMouseDown={(e) => e.preventDefault()}
          className={hero
            ? 'absolute left-0 right-0 top-full z-[60] mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl'
            : `absolute bottom-full left-0 right-0 z-[60] mb-1 overflow-hidden border border-zinc-800 bg-zinc-950 shadow-2xl sm:right-auto sm:w-[36rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-lg ${embedded ? 'sm:left-0' : 'sm:left-4'}`}
        >
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {picker?.kind === 'worktrees' && (
            <div role="listbox" aria-label="Worktrees">
              {picker.rows.length === 0 && <div className="px-3 py-3 text-center text-xs text-zinc-600">No worktree matches “{mention?.query}”</div>}
              {picker.rows.map((row, i) => (
                <div
                  key={row.option.path}
                  role="option"
                  aria-selected={i === pickSel}
                  data-path={row.option.path}
                  onClick={() => pickWorktree(row)}
                  onMouseEnter={() => setPickSel(i)}
                  className={`flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${i === pickSel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'}`}
                >
                  <span aria-hidden className="text-zinc-600">⎇</span>
                  <span>{row.option.name}</span>
                  {row.option.repo && <span className="text-xs text-zinc-500">· {row.option.repo}</span>}
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-zinc-600">{shortRelativeTime(row.option.lastUsedAt || null)}</span>
                </div>
              ))}
            </div>
          )}
          {picker?.kind === 'stations' && (
            <div role="listbox" aria-label="Stations">
              {picker.rows.length === 0 && <div className="px-3 py-3 text-center text-xs text-zinc-600">No station matches “{mention?.query}”</div>}
              {picker.rows.map((row, i) => (
                <div key={row.agentId}>
                  {picker.dividerBefore === i && <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">other worktrees</div>}
                  <div
                    role="option"
                    aria-selected={i === pickSel}
                    data-agent={row.agentId}
                    onClick={() => pickStation(row)}
                    onMouseEnter={() => setPickSel(i)}
                    className={`flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${i === pickSel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${row.status === 'calling' ? 'animate-pulse bg-amber-400' : row.status === 'working' ? 'bg-emerald-400' : row.status === 'offline' ? 'bg-zinc-700' : 'border border-zinc-500'}`} />
                    <span>{row.alias ?? row.name}</span>
                    <span className={`text-xs ${row.status === 'calling' ? 'text-amber-300' : 'text-zinc-500'}`}>{statusText(row.status)}</span>
                    <span className="ml-auto text-xs text-zinc-600">{row.worktreeName}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!picker && items.length === 0 && <div className="px-3 py-6 text-center text-xs text-zinc-600">No matches</div>}
          {!picker && items.map((item, i) => {
            if (item.type === 'submit') {
              lastKind = 'submit';
              return (
                <div key="submit" data-idx={i} data-testid="jarvis-submit" role="option" aria-selected={i === sel}
                  onClick={() => { setSel(i); activate(item); }} onMouseEnter={() => setSel(i)}
                  className={`cursor-default rounded-md px-2.5 py-1.5 text-[11px] text-zinc-500 ${i === sel ? 'bg-zinc-900' : ''}`}>
                  ⏎ to run
                  {jarvis?.model?.status === 'ready' && !disclosed && (
                    <div className="mt-0.5 text-[10px] text-zinc-600">Text the box doesn’t know goes to Haiku: what you type and your tab/worktree names — never terminal output or $ lines.</div>
                  )}
                </div>
              );
            }
            if (item.type === 'choice') {
              lastKind = 'choice';
              return (
                <div key={`choice:${item.n}`} data-idx={i} data-testid={`jarvis-choice-${item.n}`} role="option" aria-selected={i === sel}
                  onClick={() => { setSel(i); activate(item); }} onMouseEnter={() => setSel(i)}
                  className={`flex cursor-default items-center gap-2 rounded-md py-1.5 pl-7 pr-2.5 text-sm ${i === sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'}`}>
                  <span className="w-3 shrink-0 text-[11px] text-zinc-500">{item.n + 1}</span>
                  <span className="min-w-0 truncate">{item.text}</span>
                  {i === sel && <span className="ml-auto shrink-0 text-[10px] text-zinc-500">⏎</span>}
                </div>
              );
            }
            if (item.type === 'model') {
              lastKind = 'jarvis';
              return (
                <div key="model" data-idx={i}>
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Commands</div>
                  <JarvisModelRow view={modelView!} selected={i === sel} onPick={() => { setSel(i); activate(item); }} onHover={() => setSel(i)}
                    onSettings={() => { dismiss(); jarvis?.model?.onOpenSettings(); }}
                    model={modelState?.text === query ? modelState.model : null}
                    ms={modelState?.text === query ? modelState.ms : null} />
                </div>
              );
            }
            const groupKey = item.type === 'nav' ? item.r.kind : item.type;
            const header = groupKey !== lastKind ? (item.type === 'nav' ? GROUP_LABEL[item.r.kind] : item.type === 'jarvis' ? 'Commands' : 'Recent') : null;
            lastKind = groupKey;
            const headerEl = header && (
              <div className="flex items-center justify-between px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                <span>{header}</span>
                {item.type === 'history' && jarvis && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); clearHistory(jarvis.wsId); setHistory([]); setSel(0); inputRef.current?.focus(); }}
                    className="normal-case tracking-normal text-zinc-500 hover:text-zinc-300"
                  >
                    Clear history
                  </button>
                )}
              </div>
            );
            if (item.type === 'jarvis') {
              return (
                <div key={`jarvis:${item.index}`} data-idx={i}>
                  {headerEl}
                  <JarvisRow
                    plan={item.plan}
                    index={item.index}
                    selected={i === sel}
                    state={stateOf(rowKey(item.index))}
                    model={item.index < modelPlans.length ? modelState?.model : null}
                    ms={item.index < modelPlans.length ? modelState?.ms : null}
                    onPick={() => { setSel(i); activate(item); }}
                    onHover={() => setSel(i)}
                    onSettings={jarvis?.model ? () => { dismiss(); jarvis.model!.onOpenSettings(); } : undefined}
                  />
                </div>
              );
            }
            if (item.type === 'history') {
              return (
                <div key={`history:${item.text}`}>
                  {headerEl}
                  <button
                    data-idx={i}
                    onClick={() => activate(item)}
                    onMouseEnter={() => setSel(i)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left font-mono text-xs ${i === sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
                  >
                    {item.text}
                  </button>
                </div>
              );
            }
            const r = item.r;
            return (
              <div key={`${r.kind}:${r.id}`}>
                {headerEl}
                <button
                  data-idx={i}
                  onClick={() => pick(r)}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${
                    i === sel ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
                  }`}
                >
                  {r.kind === 'worktree' && <ShellIcon className="shrink-0 text-zinc-600" />}
                  <span className={`shrink-0 ${r.kind === 'worktree' ? 'font-mono text-xs' : ''}`}>{r.label}</span>
                  {r.detail && <span className="min-w-0 truncate text-xs text-zinc-600">{r.detail}</span>}
                  {r.kind === 'worktree' && focusName && focusMemberIds?.has(r.remote ? `remote:${r.remote.runnerId}:${r.remote.path}` : `local:${r.worktree!.path}`) && (
                    <span title={`In ${focusName}`} className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">{focusName}</span>
                  )}
                  {r.kind === 'worktree' && r.worktree && (() => {
                    const w = r.worktree;
                    const running = w.process?.status === 'running';
                    const badges: React.ReactNode[] = [];
                    if (w.hasClaudeSession) badges.push(<span key="c" title="Claude"><ClaudeIcon size={12} /></span>);
                    if (w.hasCodexSession) badges.push(<span key="x" title="Codex"><CodexIcon size={12} /></span>);
                    if (w.hasShellSession) badges.push(<span key="s" title="Shell"><ShellIcon size={12} /></span>);
                    if (vscodeTabs.has(w.path)) badges.push(<span key="v" title="VS Code"><VsCodeIcon size={12} /></span>);
                    if (browserTabs.has(w.path)) badges.push(<span key="b" title="Browser"><GlobeIcon /></span>);
                    if (kbTabs.has(w.path)) badges.push(<span key="k" title="Knowledge Base"><BookIcon size={12} /></span>);
                    if (!running && badges.length === 0) return null;
                    return (
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-zinc-500">
                        {badges}
                        {running && (
                          <span title="dev server running" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        )}
                      </span>
                    );
                  })()}
                </button>
              </div>
            );
          })}
        </div>
        </div>
      )}
      {v.phase === 'error' && v.error && (
        <div role="alert" className={`absolute left-0 right-0 z-[60] rounded-lg border border-amber-900/60 bg-zinc-950 px-3 py-2 text-xs text-amber-300 shadow-2xl ${hero ? 'top-full mt-2' : 'bottom-full mb-1 sm:w-[36rem]'}`}>
          {VOICE_PERMISSION[v.error.code] ? (
            <>
              {`Strado needs ${VOICE_PERMISSION[v.error.code]!.what} permission — `}
              {/* Never navigates this window: the shell's open handler hands the URL to macOS. */}
              <a href={VOICE_PERMISSION[v.error.code]!.href} onClick={(e) => { e.preventDefault(); window.open(e.currentTarget.href, '_blank'); }}
                className="underline underline-offset-2 hover:text-amber-200">Open System Settings</a>
            </>
          ) : `Voice didn’t work: ${v.error.message ?? v.error.code}`}
        </div>
      )}
      <div className={hero ? 'flex min-h-12 items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 focus-within:border-zinc-500' : 'flex min-h-8 items-center gap-2'}>
        <svg aria-hidden width={hero ? 16 : 13} height={hero ? 16 : 13} viewBox="0 0 16 16" className="shrink-0 text-zinc-500">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <div className="relative min-w-0 flex-1">
        {chips.length > 0 && (
          // The same text under a transparent input, with chips marked; the caret stays the input's.
          <div ref={mirrorRef} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-zinc-100 ${(hero ? HERO_BOX : BAR_BOX).text}`}>
            {chipSegments(query, chips).map((seg, i) => (seg.chip
              ? <span key={i} data-testid={`chip-${chipKey(seg.chip)}`} className={`rounded-sm ${sigilOf(seg.chip) === '#' ? 'bg-emerald-900/60 text-emerald-100' : 'bg-sky-900/70 text-sky-100'}`}>{seg.text}</span>
              : <span key={i}>{seg.text}</span>))}
          </div>
        )}
        {listening && (
          // The cursor while listening (as in Claude Code): a live waveform
          // right after the words, in place of the blinking caret.
          <div ref={voiceCaretRef} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words pr-5 ${(hero ? HERO_BOX : BAR_BOX).text}`}>
            <span className="invisible">{query}</span>
            <VoiceCaret level={v.level} />
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          data-strado-bar=""
          value={query}
          onFocus={() => {
            if (open) return;
            focusedBeforeRef.current = jarvis?.context().focused ?? null;
            if (jarvis) setHistory(readHistoryEntries(jarvis.wsId));
            setOpen(true);
            onOpen?.();
          }}
          onBlur={() => {
            // Something the app did took the keyboard: take it back.
            if (keepKeyboard) {
              setTimeout(() => {
                if (keepKeyboard && !voiceRef.current.dialogOpen && document.hasFocus() && document.activeElement !== inputRef.current && reclaimable(document.activeElement)) inputRef.current?.focus();
              }, 0);
            }
            setOpen(false);
            setBrowse(false);
            // A confirm is for the state the user just saw; coming back later, ⏎ re-checks.
            setRowState(null);
          }}
          onPointerDown={() => setQuiet(false)}
          onChange={(e) => {
            setQuiet(false);
            setKeepKeyboard(true); // you are talking to Strado now
            if (v.phase === 'error') v.dismissError();
            // A command is one line: a pasted newline becomes a space.
            const val = e.target.value.replace(/\r?\n/g, ' ');
            spokenRef.current = null;
            setPasted(pasteRef.current ? true : val === '' ? false : pasted);
            pasteRef.current = false;
            setRecall(null);
            setQuery(val);
            setCaret(e.target.selectionStart ?? val.length);
            setChips((c) => pruneChips(val, c));
            setPickerOff(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onScroll={(e) => {
            if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            if (voiceCaretRef.current) voiceCaretRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onPaste={() => { pasteRef.current = true; }}
          onKeyDown={onKeyDown}
          // Listening: the waveform cursor stands where the words will go.
          placeholder={listening ? '' : hero ? 'Tell Strado…  e.g. open master and run dev   ⌘K' : jarvis ? 'Tell Strado what to do…  ⌘K' : 'Search focuses, worktrees, repos…  ⌘K'}
          aria-label="Global search"
          className={`relative block w-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent outline-none ${(hero ? HERO_BOX : BAR_BOX).text} placeholder:text-zinc-600 ${chips.length > 0 ? 'text-transparent caret-zinc-100' : 'text-zinc-100'}${listening ? ' caret-transparent pr-5' : ''}`}
        />
        </div>
        {listening && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-violet-300">
            <span>Listening…</span>
            <span role="meter" aria-label="Mic level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={v.level} className="relative h-1.5 w-10 overflow-hidden rounded-full bg-zinc-800">
              <span className="absolute inset-y-0 left-0 rounded-full bg-violet-400 transition-[width] duration-75" style={{ width: `${Math.round(Math.min(1, v.level) * 100)}%` }} />
            </span>
          </span>
        )}
        {open && <kbd className="shrink-0 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-500">esc</kbd>}
      </div>
    </div>
  );
}

// Bar shapes of the listening cursor: a soft wave, tallest in the middle.
const VOICE_BARS = [0.55, 0.85, 1, 0.75, 0.5];
/** The listening cursor: bars follow the mic level, and keep a slow ripple
 * when you are quiet so it still reads as "listening". */
function VoiceCaret({ level }: { level: number }) {
  const l = Math.min(1, Math.max(0, level));
  return (
    <span data-testid="voice-caret" className="ml-0.5 inline-flex h-4 items-center gap-[2px]">
      {VOICE_BARS.map((k, i) => (
        <span key={i} data-testid="voice-bar"
          className="voice-bar w-[2px] rounded-full bg-violet-300 transition-[height] duration-75"
          style={{ height: `${Math.round(3 + l * k * 11)}px`, animationDelay: `${i * 110}ms` }} />
      ))}
    </span>
  );
}
