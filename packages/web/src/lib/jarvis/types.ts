// Jarvis: the ⌘K command box. These types are the contract between the
// parser (parse.ts: text → Plan), the palette UI (renders a Plan as rows of
// chips) and execution (runs a Plan's steps in order). Spec:
// docs/specs/2026-10-17-jarvis-command-box-design.md (private repo).

/** Action ids of the server's registry (server/src/services/actions.ts). A
 * server contract test reads this union from source, so keep it a literal union. */
export type ActionId =
  | 'nav.worktree' | 'nav.focus' | 'nav.workspace' | 'nav.repo'
  | 'tab.open' | 'tab.place' | 'tab.focus' | 'tab.close' | 'tab.interrupt'
  | 'shell.run' | 'browser.open' | 'agent.message' | 'agent.wait' | 'ui.state'
  | 'server.start' | 'server.stop'
  | 'call.answer' | 'call.dismiss' | 'nav.line'
  | 'nav.addRepo' | 'nav.newWorktree'
  | 'nav.page' | 'settings.open' | 'settings.set'
  | 'focus.edit' | 'ui.sidebar'
  | 'agent.ask' | 'agent.recap' | 'tab.rename';

/** The same ids at runtime, in registry order. */
export const ACTION_IDS = [
  'nav.worktree', 'nav.focus', 'nav.workspace', 'nav.repo',
  'tab.open', 'tab.place', 'tab.focus', 'tab.close', 'tab.interrupt',
  'shell.run', 'browser.open', 'agent.message', 'agent.wait', 'ui.state',
  'server.start', 'server.stop',
  'call.answer', 'call.dismiss', 'nav.line',
  'nav.addRepo', 'nav.newWorktree',
  'nav.page', 'settings.open', 'settings.set',
  'focus.edit', 'ui.sidebar',
  'agent.ask', 'agent.recap', 'tab.rename',
] as const satisfies readonly ActionId[];

/** Pages of the app the box can open (nav.page). */
export const APP_PAGES = ['home', 'worktrees', 'reviews', 'usage'] as const;
export type AppPage = (typeof APP_PAGES)[number];
/** Settings sections (SettingsPage's SettingsSection). */
export const SETTINGS_SECTIONS = ['profile', 'organization', 'appearance', 'workspaces', 'agents', 'runners', 'integrations', 'jira', 'linear', 'gitlab', 'github', 'privacy', 'commandbox'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];
/** The plain settings the box may change, and the values each takes (null = free text). */
export const SETTINGS: Record<string, { section: SettingsSectionId; label: string; values: readonly string[] | null; max?: number }> = {
  'profile.name': { section: 'profile', label: 'Your name', values: null, max: 100 },
  'profile.callMe': { section: 'profile', label: 'What to call you', values: null, max: 50 },
  'appearance.theme': { section: 'appearance', label: 'Theme', values: ['true-black', 'graphite', 'ayu-dark', 'dracula', 'nord', 'github-light'] },
  'appearance.font': { section: 'appearance', label: 'Font', values: ['jetbrains', 'inter', 'system'] },
  'appearance.diffFont': { section: 'appearance', label: 'Diff font', values: ['jetbrains', 'system-mono'] },
  'appearance.terminalFont': { section: 'appearance', label: 'Terminal font', values: ['nerd', 'jetbrains', 'system-mono'] },
  'privacy.telemetry': { section: 'privacy', label: 'Telemetry', values: ['on', 'off'] },
  'commandbox.localOnly': { section: 'commandbox', label: 'Command box local-only', values: ['on', 'off'] },
};
export type SettingId = keyof typeof SETTINGS;
export const FOCUS_OPS = ['create', 'rename', 'delete', 'add', 'remove'] as const;
export type FocusOp = (typeof FOCUS_OPS)[number];

export type AgentMode = 'claude' | 'codex' | 'opencode' | 'pi';
export type TabMode = AgentMode | 'shell' | 'browser';

/** A tab, named structurally like app control's wire TabRef. A Browser tab's
 * `sessionId` is its browser tab id ('1', '2', …). Session numbers are reused
 * (lowest free), so `executionId`, when the hub knows it, pins the exact tab:
 * the server answers 409 tab_replaced and verifyTarget target_replaced when
 * the slot now holds another execution. */
export type TabRef = { worktreePath: string; mode: TabMode; sessionId: string; executionId?: string };

/** What a step acts on.
 * - `tab`: an existing tab, resolved at parse time.
 * - `step`: the tab an earlier step of the same plan opens ("shell right and then run dev in it").
 * - `none`: the action needs no tab (navigation, or a step that opens one). */
export type Target =
  | { kind: 'tab'; ref: TabRef }
  | { kind: 'step'; index: number }
  | { kind: 'none' };

export type Split = 'right' | 'down' | 'tab';
export type Place = { split: Split; anchor: Target; focus: boolean };

/** Per-action arguments. `Step` pairs each action with exactly its own args. */
export type ActionArgs = {
  'nav.worktree': { path: string };
  'nav.focus': { focusId: string };
  'nav.workspace': { wsId: string };
  'nav.repo': { repoPath: string };
  /** A new agent or shell tab. `command` is shell only; `prompt` agent modes only. */
  'tab.open': { mode: AgentMode | 'shell'; worktreePath: string; place: Place | null; command?: string; prompt?: string };
  'tab.place': { place: Place };
  'tab.focus': Record<string, never>;
  'tab.close': Record<string, never>;
  'tab.interrupt': Record<string, never>;
  /** Typed into the target shell, literally. */
  'shell.run': { command: string };
  /** `url` is already normalised to http(s). */
  'browser.open': { url: string; worktreePath: string; place: Place | null };
  /** Sent as the human through intercom. */
  'agent.message': { agentId: string; text: string };
  /** MCP-side actions the box does not produce in P0; typed so a Step can carry them. */
  'agent.wait': { agentId: string; timeoutMs?: number };
  'ui.state': Record<string, never>;
  /** A package.json script (or a literal command) as the worktree's dev server. */
  'server.start': { worktreePath: string; script: string | null; command: string };
  'server.stop': { worktreePath: string };
  /** Resolve an open call (an escalation to the human) with `text` as the answer. */
  'call.answer': { callId: string; agentId: string; text: string };
  /** Dismiss an open call without answering. */
  'call.dismiss': { callId: string; agentId: string };
  /** Open the Line view (all stations, the live feed). */
  'nav.line': Record<string, never>;
  /** Open the Add repo dialog, prefilled with `path` (as typed) when given. */
  'nav.addRepo': { path: string | null };
  /** Open the New worktree dialog, in `repoPath` when the text named a repo. */
  'nav.newWorktree': { repoPath: string | null };
  /** Open a page of the app (closes Settings). */
  'nav.page': { page: AppPage };
  /** Open Settings at a section. */
  'settings.open': { section: SettingsSectionId };
  /** Change one plain setting; `value` is checked against SETTINGS. */
  'settings.set': { setting: SettingId; value: string };
  /** A Focus (a saved group of worktrees): create (`name`, first members),
   * rename (`focusId` → `name`), delete, or add/remove worktrees. */
  'focus.edit': { op: FocusOp; focusId: string | null; name: string | null; worktreePaths: string[] };
  /** Show (true), hide (false) or toggle (null) the sidebar. */
  'ui.sidebar': { show: boolean | null };
  /** A question to an agent, sent as an intercom request; its reply comes back to the box. */
  'agent.ask': { agentId: string; question: string };
  /** What an agent is doing / has done (or every agent), read from saved turns. */
  /** `question`: the user's own words, so the answer fits what they asked. */
  /** `focus`: the Focus the agents were gathered from ("what are the agents in this focus doing"). */
  'agent.recap': { agentIds: string[] | 'all'; question?: string | null; focus?: string };
  /** The tab's label in the strip; '' puts the default back. */
  'tab.rename': { name: string };
};

export type Risk = 'read' | 'layout' | 'spawn' | 'exec' | 'destructive';
/** Where a step runs: the hub applies layout synchronously; the server owns resources. */
export type Where = 'hub' | 'server';

/** One editable piece of the interpretation row. `arg` is a dot path into the
 * step's args ('command', 'place' — whose candidates are whole Place values —
 * or a deeper 'place.split'), or 'target' for the step's target. Picking a
 * candidate sets that path to its `value`. */
export type Chip = {
  arg: string;
  label: string;
  /** ↑/↓ cycles these; the first is the current value. Empty = free text (the label is the value). */
  candidates: { label: string; value: unknown }[];
};

export type StepOf<A extends ActionId> = {
  action: A;
  args: ActionArgs[A];
  target: Target;
  risk: Risk;
  where: Where;
  /** False for shell commands and agent messages; the row says so. */
  undoable: boolean;
  /** A second confirm before running (destructive pattern, or busy target). */
  needsConfirm: boolean;
  /** Why, for the confirm prompt. */
  confirmReason?: string;
  /** The model wrote this step's shell command (the user never typed it): it
   * always needs a confirm, and safety re-checks keep that. */
  suggested?: boolean;
  /** The step came from the model. Model plans auto-run, so safety also
   * confirms any close/interrupt/server stop and any step on a tab the user is
   * typing in; re-checks keep it. */
  fromModel?: boolean;
  /** Said after the summary, in parentheses (e.g. how "left of" was done). */
  note?: string;
  chips: Chip[];
};
export type Step = { [A in ActionId]: StepOf<A> }[ActionId];

export type PlanSource = 'prefix' | 'rule' | 'nav' | 'fallback' | 'model';

export type Plan = {
  steps: Step[];
  source: PlanSource;
  /** One line for the row, e.g. "Open shell right of claude-1, run npm run dev". */
  summary: string;
  /** False when the input was pasted (or is multi-line): ⏎ opens the preview, never runs. */
  executable: boolean;
  /** Other readings, best first. An ambiguous target yields one alternative per
   * candidate and an empty `steps` on the plan itself (a pick list, never a guess). */
  alternatives?: Plan[];
};

/** What the parser may know about one tab. */
export type TabInfo = TabRef & {
  /** Registry agent id (claude-1@repo) when the tab is a registered agent or shell. */
  agentId?: string | null;
  alias?: string | null;
  /** What the strip shows ("Claude 2", "Shell 3", "Browser"). */
  label: string;
  /** A running process (shell) or a working agent: closing/interrupting needs a confirm. */
  busy: boolean;
  /** The user is typing in this tab right now (registry human_active). */
  humanActive?: boolean;
  /** Hub-local identity of what occupies the slot; changes when the tab is
   * closed and its number reused. Covers tabs without a registry executionId. */
  instance?: string;
  /** In the hub strip on screen; false for a live tab in another worktree (from the registry). */
  onScreen?: boolean;
};

export type ParseContext = {
  /** Tabs of every worktree this window knows, not just the shown one. */
  tabs: TabInfo[];
  focused: TabRef | null;
  /** The last tab the box acted on (for "it"/"that"). */
  lastActedOn: TabRef | null;
  /** The worktree the hub shows, if any. */
  currentWorktree: string | null;
  /** `lastUsedAt` (ms) orders them most recent first for the model (home's Recent). */
  worktrees: { path: string; name: string; branch?: string | null; ticketKey?: string | null; lastUsedAt?: number; /** The owning repo's display name. */ repoName?: string | null }[];
  /** `worktreePaths`: the Focus's member worktrees. */
  focuses: { id: string; name: string; worktreePaths?: string[] }[];
  /** The Focus open in this window ("this focus"), else null. */
  currentFocus?: { id: string; name: string } | null;
  workspaces?: { id: string; name: string }[];
  /** The workspace this window is in; null when unknown. */
  currentWorkspace?: { id: string; name: string } | null;
  repos?: { path: string; name: string }[];
  /** package.json scripts of the current worktree (name → command). */
  packageScripts: Record<string, string>;
  /** Runs those scripts (`<pm> run <script>`); npm when unknown. */
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  peers: { agentId: string; alias: string | null; mode: TabMode; worktreePath: string }[];
  /** Open calls to the human (escalations), from the stations feed. */
  calls?: { id: string; agentId: string; title: string }[];
};

export type ParseInput = { text: string; pasted?: boolean };
