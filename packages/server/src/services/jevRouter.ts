import type { JarvisContext, JarvisResult, JarvisTurn } from './jarvisModel.js';
import { readRouterCredential } from './routerCredential.js';

// The command box's fast path (spec: 2026-10-17-jarvis-natural-language-design.md,
// "Jev"). Jev is a decision model: it never writes text, it picks among
// options we give it, with a probability. Most navigation is exactly that —
// "go to master", "put the shell next to claude", "close the second shell" —
// every argument is a name Strado already knows. One Decisions call answers
// "is this a single choice-only action?" plus every slot at once (~0.1 s).
// Only a confident, complete answer becomes a plan; anything else (free text:
// URLs, commands, prompts, messages; several steps; doubt; any error) returns
// null and the caller asks Haiku as before. Safety (confirms) stays in the box.

export const JEV_MODEL = 'typesafe/jev-1.14';
export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_TIMEOUT_MS = 1_500;
/** Below this (action and every slot) the request goes to Haiku. */
export const JEV_MIN_CONFIDENCE = 0.8;
/** At or above this, "has free text" / "several things" sends it to Haiku. */
export const JEV_MAX_DOUBT = 0.5;

const NONE = 'none';

type Action = 'tab_open' | 'tab_focus' | 'tab_place' | 'tab_close' | 'tab_interrupt' | 'nav_worktree' | 'nav_focus' | 'nav_page' | 'settings_open' | 'ui_sidebar' | 'server_start' | 'server_stop';

const ACTIONS: Record<Action, string> = {
  tab_open: 'open a NEW empty tab (a shell or a coding agent) next to or below a tab, with nothing to run or say in it',
  tab_focus: 'bring an existing tab to the front / switch to it',
  tab_place: 'move an existing tab next to (right of) or below another tab',
  tab_close: 'close an existing tab',
  tab_interrupt: 'press Ctrl-C in an existing tab (stop what runs in it) without closing it',
  nav_worktree: 'open / switch to a worktree',
  nav_focus: 'switch to a Focus (saved group of worktrees)',
  nav_page: 'open one of these app pages by its page name: home, code reviews, usage. NOT a worktree (a worktree name like main or master is nav_worktree)',
  settings_open: 'open Settings (or one section of it), without changing anything',
  ui_sidebar: 'show / open, or hide / close / collapse the left sidebar',
  server_start: "start a worktree's dev server",
  server_stop: "stop a worktree's dev server",
};

/** The slots each action needs, in the registry's argument names. */
const NEEDS: Record<Action, ('tab' | 'anchor' | 'split' | 'worktree' | 'focus' | 'mode' | 'page' | 'section' | 'show')[]> = {
  tab_open: ['mode'],
  tab_focus: ['tab'], tab_place: ['tab', 'anchor', 'split'], tab_close: ['tab'], tab_interrupt: ['tab'],
  nav_worktree: ['worktree'], nav_focus: ['focus'], nav_page: ['page'], settings_open: ['section'], ui_sidebar: ['show'], server_start: [], server_stop: [],
};

export type DecisionsFetch = (key: string, body: unknown, signal: AbortSignal) => Promise<unknown>;

const defaultFetch: DecisionsFetch = async (key, body, signal) => {
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`jev ${res.status}`);
  return res.json();
};

type ChoiceAnswer = { type: 'choice'; choice: string; confidence?: number };
type NoulAnswer = { type: 'noul'; noul: number };

const choices = (names: string[], extra: Record<string, string> = {}) =>
  Object.fromEntries([...names.map((n) => [n, null] as const), ...Object.entries(extra)]);

export type JevRouter = {
  /** A plan, or null = "ask Haiku". Never throws. */
  route(input: { text: string; context: JarvisContext; thread: JarvisTurn[] }, signal?: AbortSignal): Promise<JarvisResult | null>;
};

export function createJevRouter(deps: { fetch?: DecisionsFetch; readKey?: () => Promise<string | null>; timeoutMs?: number; log?: (m: string) => void } = {}): JevRouter {
  const doFetch = deps.fetch ?? defaultFetch;
  const readKey = deps.readKey ?? readRouterCredential;
  const timeoutMs = deps.timeoutMs ?? JEV_TIMEOUT_MS;

  return {
    async route({ text, context, thread }, signal) {
      const key = await readKey();
      if (!key) return null;
      const tabs = [...new Set(context.tabs.map((t) => t.name))];
      const worktrees = [...new Set(context.worktrees.map((w) => w.name))];
      const focuses = [...new Set(context.focuses.map((f) => f.name))];

      const questions: Record<string, unknown> = {
        // Two concrete checks instead of one composite "does it fit?": live,
        // a composite noul sat near 0.5 even when the action was 1.00 sure.
        free_text: {
          type: 'noul',
          instructions: 'Does the request contain text that must be passed on as-is: a URL or website, a shell command to run, a prompt or message for an agent, a file path, or a new name?',
          criteria: { true: 'yes, e.g. "open google.com", "run git status", "ask claude how are you"', false: 'no, only which tab / worktree / side, e.g. "close the shell", "open a shell below shell 1"' },
        },
        several: {
          type: 'noul',
          // Live: "can you close the shell?" scored 0.67 here when this said
          // "or a question" — a polite request is not a question.
          instructions: 'Does the request ask for two or more separate actions, or does it ask for INFORMATION (e.g. "which shells are busy?")? A polite request for one action ("can you close the shell?", "could you open a shell below shell 1?") counts as exactly one action.',
          criteria: { true: 'two or more actions ("open a shell and focus claude"), or a request for information', false: 'exactly one action, however it is phrased' },
        },
        action: { type: 'choice', instructions: 'Which action does the user want?', criteria: { ...ACTIONS, [NONE]: 'none of these' } },
        mode: { type: 'choice', instructions: 'For a new tab: what kind?', criteria: { shell: 'a shell / terminal', claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', [NONE]: 'not a new tab' } },
        show: { type: 'choice', instructions: 'For the sidebar: show or hide it?', criteria: { show: 'show / open / expand it', hide: 'hide / close / collapse it', toggle: 'toggle it', [NONE]: 'not about the sidebar' } },
        page: { type: 'choice', instructions: 'For opening a page of the app: which one?', criteria: { home: 'home / start screen (not a worktree called main or master)', reviews: 'code reviews / merge or pull requests', usage: 'usage / cost / tokens', [NONE]: 'not a page' } },
        section: { type: 'choice', instructions: 'For opening Settings: which section? Plain "settings" = profile.', criteria: { profile: 'profile / name / plain settings', organization: 'organization / team', appearance: 'appearance / theme / fonts', workspaces: 'workspaces', projects: 'projects / repos / repo settings / run commands', agents: 'coding agents config', runners: 'runners / remote machines', integrations: 'integrations in general', jira: 'Jira', linear: 'Linear', gitlab: 'GitLab', github: 'GitHub', privacy: 'privacy / telemetry', commandbox: 'command box / model / keys', [NONE]: 'not Settings' } },
        split: { type: 'choice', instructions: 'For a move or a new tab: where should it go relative to the other tab?', criteria: { tab: 'in a new tab / as its own tab / separate tab (not a split)', right: 'right of / next to / beside', down: 'below / under', [NONE]: 'not said' } },
      };
      const thisTab = context.focused ? { this: `the focused tab (${context.focused})` } : {};
      if (tabs.length > 0) {
        questions.tab = { type: 'choice', instructions: 'Which existing tab does the action act on (the one being moved, focused, closed or interrupted)?', criteria: { ...choices(tabs), ...thisTab, [NONE]: 'no tab' } };
        questions.anchor = { type: 'choice', instructions: 'For a move or a new tab: which tab should it go next to / below?', criteria: { ...choices(tabs), ...thisTab, [NONE]: 'not said' } };
      }
      if (worktrees.length > 0) questions.worktree = { type: 'choice', instructions: 'Which worktree (by name, branch or ticket)? For a dev server, the worktree it belongs to.', criteria: choices(worktrees, { [NONE]: 'none named (the current one)' }) };
      // Which run command, when the worktree has more than one (the first is the default).
      const runs = (context.runCommands ?? []).map((r) => r.name);
      if (runs.length > 1) questions.run = { type: 'choice', instructions: 'For starting or stopping: which run command (by name)? None named = the default dev server.', criteria: choices(runs, { [NONE]: 'none named (the default)' }) };
      if (focuses.length > 0) questions.focus = { type: 'choice', instructions: 'Which Focus?', criteria: choices(focuses, { [NONE]: 'no Focus' }) };

      const state = {
        request: text,
        recent_conversation: thread,
        current_worktree: context.worktree?.name ?? null,
        focused_tab: context.focused,
        tabs: context.tabs.map((t) => `${t.name} (${t.mode}${t.busy ? ', busy' : ''})`),
      };

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort);
      const started = Date.now();
      let raw: unknown;
      try {
        raw = await doFetch(key, { model: JEV_MODEL, state, questions }, ac.signal);
      } catch (err) {
        if (!signal?.aborted) deps.log?.(`jev failed after ${Date.now() - started} ms: ${(err as Error)?.message ?? err} → Haiku`);
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      // route() never throws: a malformed answer is a decline, Haiku decides.
      try {
        const ms = Date.now() - started;
        const answers = (raw as { answers?: Record<string, unknown> } | null)?.answers ?? {};
        const pick = (name: string): string | null => {
          const a = answers[name] as ChoiceAnswer | undefined;
          if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return null;
          if (typeof a.confidence !== 'number' || a.confidence < JEV_MIN_CONFIDENCE) return null;
          // Only an option we offered: anything else is a malformed answer.
          const offered = (questions[name] as { criteria?: Record<string, unknown> } | undefined)?.criteria;
          if (!offered || !Object.hasOwn(offered, a.choice)) return null;
          return a.choice;
        };
        /** An optional slot: null when not asked or confidently "not said";
         * undefined when Jev is unsure — then Haiku decides, never the default. */
        const optional = (name: string): string | null | undefined => {
          if (!(name in questions)) return null;
          const v = pick(name);
          if (v === null) return undefined;
          return v === NONE ? null : v;
        };
        const noul = (name: string): number => { const v = (answers[name] as NoulAnswer | undefined)?.noul; return typeof v === 'number' ? v : 1; };
        const freeText = noul('free_text');
        const several = noul('several');
        const action = pick('action') as Action | typeof NONE | null;
        // What Jev leaned to, even when unsure: the data for tuning thresholds.
        const lean = (() => { const a = answers.action as ChoiceAnswer | undefined; return a?.choice ? `${a.choice}@${(a.confidence ?? 0).toFixed(2)}` : '?'; })();
        const decline = (why: string) => { deps.log?.(`jev ${ms} ms: ${why} (action ${lean}) → Haiku`); return null; };
        if (freeText >= JEV_MAX_DOUBT) return decline(`free text ${freeText.toFixed(2)}`);
        if (several >= JEV_MAX_DOUBT) return decline(`several ${several.toFixed(2)}`);
        if (!action || action === NONE || !Object.hasOwn(NEEDS, action)) return decline(`action ${action ?? 'unsure'}`);

        const args: Record<string, unknown> = {};
        for (const slot of NEEDS[action]) {
          const v = pick(slot);
          if (!v || v === NONE) return decline(`${action}: ${slot} unsure`);
          if (slot === 'worktree' || slot === 'focus') args.name = v;
        else if (slot === 'show') args.show = v === 'show' ? true : v === 'hide' ? false : null;
        else args[slot] = v;
        }
        if (action === 'tab_open' || action === 'server_start' || action === 'server_stop') {
          // A named worktree is honoured ("open a shell in master"); on the home
          // screen one must be named, or Haiku asks which.
          const worktree = optional('worktree');
          if (worktree === undefined) return decline(`${action}: worktree unsure`);
          if (worktree === null && !context.worktree) return decline(`${action}: no worktree on the home screen`);
          args.worktree = worktree;
        }
        if (action === 'server_start' || action === 'server_stop') {
          const run = optional('run');
          if (run === undefined) return decline(`${action}: run command unsure`);
          args.run = run;
        }
        if (action === 'tab_open') {
          // Placement is optional for a new tab: unsaid = the default (right of the focus).
          const split = optional('split'); const anchor = optional('anchor');
          if (split === undefined || anchor === undefined) return decline('tab_open: placement unsure');
          Object.assign(args, { command: null, prompt: null, split, anchor });
        }
        deps.log?.(`jev ${ms} ms: ${action} ${JSON.stringify(args)}`);
        return { kind: 'plan', steps: [{ action: action.replace('_', '.'), args }], model: JEV_MODEL, ms };
      } catch (err) {
        deps.log?.(`jev answer unreadable: ${(err as Error)?.message ?? err} → Haiku`);
        return null;
      }
    },
  };
}
