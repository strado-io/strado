// Runs a Jarvis plan: steps in order, stopping at the first failure. Layout
// steps go to the hub (synchronous, in this window); resources go to the
// server; navigation to the board. Ports are injected so this stays pure and
// testable — the palette wires the real ones.
import type { UiTabRef } from '../../api';
import { applyStoredPlace } from '../uiCommands';
import type { ActionArgs, AppPage, Place, SettingId, SettingsSectionId, Split, Step, TabRef, Target } from './types';

/** A placement with its anchor resolved to a tab (null = the focused pane). */
export type ResolvedPlace = { split: Split; anchor: TabRef | null; focus: boolean };

export type JarvisHubPort = {
  /** The worktree the hub shows. */
  path: string;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
  place(tab: TabRef, place: ResolvedPlace, deadline: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  focus(tab: TabRef): boolean;
  openBrowser(url: string, place: ResolvedPlace | null, deadline: number): Promise<TabRef | null>;
  /** Drop a tab from this window (a Browser tab, or a pty the server just killed). */
  closeLocal(tab: TabRef): void;
};
export type JarvisServerPort = {
  spawn(input: { mode: Exclude<TabRef['mode'], 'browser'>; worktreePath: string; prompt?: string }): Promise<{ tab: TabRef }>;
  run(tab: TabRef, command: string): Promise<unknown>;
  interrupt(tab: TabRef): Promise<unknown>;
  close(tab: TabRef): Promise<unknown>;
  /** `ask`: an intercom request whose reply comes back to the box. */
  message(agentId: string, text: string, opts?: { ask?: boolean }): Promise<unknown>;
  /** A short recap of what the agents are doing / have done, from their saved turns. */
  recap?(agents: string[] | 'all', question?: string | null): Promise<{ text: string }>;
  startServer(worktreePath: string, command: string, script: string | null): Promise<unknown>;
  stopServer(worktreePath: string): Promise<unknown>;
  /** A call to the human (an open escalation): answer it, or hang up. */
  answerCall(callId: string, text: string): Promise<unknown>;
  dismissCall(callId: string): Promise<unknown>;
};
/** How the server delivered a message to an agent, always through the
 * intercom: 'sent' (at rest, told it has mail just now) or 'queued' (busy,
 * reads it after its turn). Nothing is typed into its prompt. */
export type MessageDelivery = { delivered: 'sent' | 'queued'; to: { agentId: string; alias: string | null } };
const asDelivery = (v: unknown): MessageDelivery | null => {
  const d = v as { delivered?: unknown; to?: { agentId?: unknown; alias?: string | null } } | null;
  // An older server says 'typed' for what is now 'sent'.
  const delivered = d?.delivered === 'typed' ? 'sent' : d?.delivered;
  if (!d || (delivered !== 'sent' && delivered !== 'queued') || typeof d.to?.agentId !== 'string') return null;
  return { delivered, to: { agentId: d.to.agentId, alias: d.to.alias ?? null } };
};

export type JarvisNavPort = {
  worktree(path: string): void;
  focus(focusId: string): void;
  workspace(wsId: string): void;
  repo(repoPath: string): void;
  /** The Line view: every station, the live feed, the board. */
  line(): void;
  /** The Add repo dialog, prefilled with a path when one was typed. */
  addRepo(path: string | null): void;
  /** The New worktree dialog, in that repo when one was named. */
  newWorktree(repoPath: string | null): void;
};
/** The rest of the app: its pages, Settings, and the plain settings there. */
export type JarvisAppPort = {
  page(page: AppPage): void;
  settings(section: SettingsSectionId): void;
  /** Saves it, then shows its Settings section so the change is seen. */
  set(setting: SettingId, value: string): Promise<void>;
  /** Edit a Focus: the step's args as they are. A create resolves with the new Focus's id. */
  focus?(edit: ActionArgs['focus.edit']): Promise<{ focusId: string } | void>;
  /** Show, hide, or (null) toggle the sidebar. */
  sidebar?(show: boolean | null): void;
};
export type StepStatus = 'running' | 'done' | 'failed';
export type JarvisPorts = {
  hub: JarvisHubPort | null;
  server: JarvisServerPort;
  nav: JarvisNavPort;
  /** Opens a worktree in the hub and resolves with its port once it is ready
   * (null when it would not open). A plan for a worktree that is not on screen
   * (home, or another worktree) shows it first, so its new tabs appear there. */
  ensureWorktree?: (path: string) => Promise<JarvisHubPort | null>;
  app?: JarvisAppPort;
  /** Whether a shell sits at its prompt (nothing running in it). */
  shellIdle?: (tab: TabRef) => Promise<boolean>;
  /** Re-checks a step's bound target right before it runs (safety.ts). */
  verify?: (index: number) => { ok: true } | { ok: false; reason: string };
  onStep?: (index: number, status: StepStatus) => void;
};

/** `restore` belongs to one worktree's layout (`path`) and only ever goes back onto a hub showing it. */
export type UndoOp = { kind: 'restore'; path: string; snapshot: unknown } | { kind: 'close'; tab: TabRef } | { kind: 'closeLocal'; tab: TabRef };
export type RunResult = {
  ok: boolean;
  /** Steps that completed. */
  done: number;
  /** `code`: the server's reason when it gave one (no_key, local_only, …), for a Settings link. */
  failed?: { index: number; reason: string; code?: string };
  /** Applied in reverse by runUndo. */
  undo: UndoOp[];
  /** The tab the plan last acted on ("it" for the next command). */
  lastActedOn: TabRef | null;
  /** Per step, the tab it opened (tab.open / browser.open), else null; steps not reached are absent. */
  opened: (TabRef | null)[];
  /** How each agent.message that ran was delivered, in order (when the server said). */
  messages: MessageDelivery[];
  /** Questions asked (agent.ask): a delivery plus the request id whose reply (replyTo) the box waits for. */
  asks: (MessageDelivery & { id: string })[];
  /** The recap's text to show (agent.recap; several are joined by a blank line), else null. */
  recap: string | null;
};

// A layout step that waits for a just-spawned tab gives up after this long.
const HUB_STEP_BUDGET_MS = 3_000;
/** A view's Shell 1 starts its pty when it mounts: wait this long for it to go live. */
export const SHELL_LIVE_WAIT_MS = 6_000;
const SHELL_LIVE_POLL_MS = 200;
class StepError extends Error {}
const fail = (reason: string): never => { throw new StepError(reason); };

export async function runPlan(plan: { steps: Step[] }, ports: JarvisPorts): Promise<RunResult> {
  const opened: (TabRef | null)[] = [];
  const messages: MessageDelivery[] = [];
  const asks: RunResult['asks'] = [];
  const answers: string[] = [];
  const undo: UndoOp[] = [];
  const snapshotted = new Set<string>();
  let lastActedOn: TabRef | null = null;

  const resolve = (t: Target): TabRef | null => (t.kind === 'tab' ? t.ref : t.kind === 'step' ? opened[t.index] ?? null : null);
  const targetOf = (s: Step): TabRef => resolve(s.target) ?? fail('That tab is not there any more');
  const resolvePlace = (p: Place): ResolvedPlace => ({ split: p.split, anchor: resolve(p.anchor), focus: p.focus });
  // The hub on screen; a plan for another worktree swaps it (ensureWorktree).
  let shown: JarvisHubPort | null = ports.hub;
  const hub = (): JarvisHubPort => shown ?? fail('Open a worktree first');
  // Worktrees this plan brought on screen. Their view always shows its own
  // Shell 1, which the plan could not see — so the first "open a shell" there
  // uses it (when idle) instead of adding Shell 2 beside it.
  const broughtUp = new Set<string>();
  /** The worktree a step shows something in, if any (server-only steps show nothing). */
  const showsIn = (s: Step): string | null => {
    if (s.action === 'tab.open' || s.action === 'browser.open') return s.args.worktreePath;
    if (s.action === 'tab.place' || s.action === 'tab.focus') return resolve(s.target)?.worktreePath ?? null;
    return null;
  };
  // One snapshot per worktree, before the plan's first layout change there,
  // undoes every layout step in it (a plan can move from one worktree to another).
  /** run, retried while the server has no live tab yet (a just-shown Shell 1). */
  const runWhenLive = async (tab: TabRef, command: string) => {
    const until = Date.now() + SHELL_LIVE_WAIT_MS;
    for (;;) {
      try { return await ports.server.run(tab, command); } catch (err) {
        if (!/no live tab/i.test(String((err as Error)?.message ?? err)) || Date.now() >= until) throw err;
        await new Promise((r) => setTimeout(r, SHELL_LIVE_POLL_MS));
      }
    }
  };
  const beforeLayout = (h: JarvisHubPort) => {
    if (snapshotted.has(h.path)) return;
    snapshotted.add(h.path);
    undo.push({ kind: 'restore', path: h.path, snapshot: h.snapshot() });
  };

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]!;
    opened[i] = null;
    ports.onStep?.(i, 'running');
    try {
      // Open the step's worktree first: its tabs (and so the target check) exist only then.
      const wt = showsIn(s);
      if (wt && shown?.path !== wt && ports.ensureWorktree) {
        shown = (await ports.ensureWorktree(wt)) ?? fail('Could not open that worktree');
        broughtUp.add(wt);
      }
      if (s.target.kind !== 'none' && ports.verify) {
        const v = ports.verify(i);
        if (!v.ok) fail(v.reason);
      }
      const deadline = Date.now() + HUB_STEP_BUDGET_MS;
      switch (s.action) {
        case 'tab.open': {
          const { mode, worktreePath, command, prompt, place } = s.args;
          if (mode === 'shell' && broughtUp.delete(worktreePath) && shown?.path === worktreePath && ports.shellIdle) {
            const own: TabRef = { worktreePath, mode: 'shell', sessionId: '1' };
            if (await ports.shellIdle(own).catch(() => false)) {
              beforeLayout(shown);
              shown.focus(own);
              opened[i] = own;
              if (command) await runWhenLive(own, command);
              lastActedOn = own;
              break;
            }
          }
          // Spawn bare and place first, so the tab shows at once; the command
          // runs after (a dev server never "finishes").
          const { tab } = await ports.server.spawn({ mode, worktreePath, ...(prompt ? { prompt } : {}) });
          opened[i] = tab;
          undo.push({ kind: 'close', tab });
          const h = shown;
          if (place && h && h.path === worktreePath) {
            beforeLayout(h);
            const r = await h.place(tab, resolvePlace(place), deadline);
            if (!r.ok) fail(r.reason);
          } else if (place) {
            const p = resolvePlace(place);
            applyStoredPlace({ op: 'place', worktreePath, tab: tab as UiTabRef, split: p.split, anchor: p.anchor as UiTabRef | null, focus: p.focus });
          }
          if (command) await ports.server.run(tab, command);
          lastActedOn = tab;
          break;
        }
        case 'tab.place': {
          const h = hub();
          const tab = targetOf(s);
          beforeLayout(h);
          const r = await h.place(tab, resolvePlace(s.args.place), deadline);
          if (!r.ok) fail(r.reason);
          lastActedOn = tab;
          break;
        }
        case 'tab.focus': {
          const h = hub();
          const tab = targetOf(s);
          beforeLayout(h);
          if (!h.focus(tab)) fail('That tab is not open here');
          lastActedOn = tab;
          break;
        }
        case 'browser.open': {
          const h = hub();
          if (h.path !== s.args.worktreePath) fail('Open that worktree first');
          beforeLayout(h);
          const tab = await h.openBrowser(s.args.url, s.args.place ? resolvePlace(s.args.place) : null, deadline);
          if (!tab) fail('Browser tabs need the Strado desktop app');
          undo.push({ kind: 'closeLocal', tab: tab! });
          opened[i] = tab;
          lastActedOn = tab;
          break;
        }
        case 'tab.close': {
          const tab = targetOf(s);
          if (s.where === 'server') await ports.server.close(tab);
          shown?.closeLocal(tab);
          lastActedOn = null;
          break;
        }
        case 'tab.interrupt': {
          const tab = targetOf(s);
          await ports.server.interrupt(tab);
          lastActedOn = tab;
          break;
        }
        case 'shell.run': {
          const tab = targetOf(s);
          await ports.server.run(tab, s.args.command);
          lastActedOn = tab;
          break;
        }
        case 'agent.message': {
          const d = asDelivery(await ports.server.message(s.args.agentId, s.args.text));
          if (d) messages.push(d);
          break;
        }
        case 'agent.ask': {
          const raw = await ports.server.message(s.args.agentId, s.args.question, { ask: true });
          const d = asDelivery(raw);
          const id = (raw as { id?: unknown } | null)?.id;
          if (d && typeof id === 'string') asks.push({ id, ...d });
          break;
        }
        case 'agent.recap': {
          const r = await (ports.server.recap ?? fail('Recaps are not available here'))(s.args.agentIds, s.args.question);
          if (r && typeof r.text === 'string' && r.text.trim()) answers.push(r.text.trim());
          break;
        }
        case 'server.start':
          await ports.server.startServer(s.args.worktreePath, s.args.command, s.args.script);
          break;
        case 'server.stop':
          await ports.server.stopServer(s.args.worktreePath);
          break;
        case 'nav.worktree': ports.nav.worktree(s.args.path); break;
        case 'nav.focus': ports.nav.focus(s.args.focusId); break;
        case 'nav.workspace': ports.nav.workspace(s.args.wsId); break;
        case 'nav.repo': ports.nav.repo(s.args.repoPath); break;
        case 'nav.line': ports.nav.line(); break;
        case 'nav.page': (ports.app ?? fail('Pages are not available here')).page(s.args.page); break;
        case 'settings.open': (ports.app ?? fail('Settings are not available here')).settings(s.args.section); break;
        case 'ui.sidebar': {
          const app = ports.app;
          if (!app?.sidebar) fail('The sidebar is not available here');
          app!.sidebar!(s.args.show);
          break;
        }
        case 'focus.edit': {
          const app = ports.app;
          if (!app?.focus) fail('Focuses are not available here');
          await app!.focus!(s.args);
          break;
        }
        case 'settings.set': await (ports.app ?? fail('Settings are not available here')).set(s.args.setting, s.args.value); break;
        case 'nav.addRepo': ports.nav.addRepo(s.args.path); break;
        case 'nav.newWorktree': ports.nav.newWorktree(s.args.repoPath); break;
        case 'call.answer': await ports.server.answerCall(s.args.callId, s.args.text); break;
        case 'call.dismiss': await ports.server.dismissCall(s.args.callId); break;
        // Agent-side tools in the shared registry; the box never runs them.
        case 'agent.wait':
        case 'ui.state':
          fail('Not available from the command box');
          break;
        default: {
          const unknown: never = s;
          fail(`Unknown action ${(unknown as Step).action}`);
        }
      }
      ports.onStep?.(i, 'done');
    } catch (err) {
      ports.onStep?.(i, 'failed');
      const reason = err instanceof Error ? err.message : String(err);
      const code = (err as { reason?: unknown } | null)?.reason;
      return { ok: false, done: i, failed: { index: i, reason, ...(typeof code === 'string' ? { code } : {}) }, undo, lastActedOn, opened, messages, asks, recap: answers.join('\n\n') || null };
    }
  }
  return { ok: true, done: plan.steps.length, undo, lastActedOn, opened, messages, asks, recap: answers.join('\n\n') || null };
}

/** Undo in reverse: close the tabs the plan opened, then restore the layout —
 * unless `restoreLayout` is false (the user rearranged things since; their
 * changes win, only the plan's own tabs go). */
export async function runUndo(ops: UndoOp[], ports: Pick<JarvisPorts, 'hub' | 'server'>, opts: { restoreLayout?: boolean } = {}): Promise<void> {
  for (const op of [...ops].reverse()) {
    if (op.kind === 'close') {
      try { await ports.server.close(op.tab); } catch { /* already gone */ }
      ports.hub?.closeLocal(op.tab);
    } else if (op.kind === 'closeLocal') {
      ports.hub?.closeLocal(op.tab);
    } else if (opts.restoreLayout !== false && ports.hub?.path === op.path) {
      ports.hub.restore(op.snapshot);
    }
  }
}
