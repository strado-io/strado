import { describeRun, planFromModel } from '../../lib/jarvis/model';
import { runPlan, type JarvisPorts } from '../../lib/jarvis/execute';
import { here } from '../../lib/jarvis/parse';
import { storedHubPort } from './storedHub';
import type { ParseContext, Plan, Step, TabRef } from '../../lib/jarvis/types';
import type { JarvisUiActionArgs, JarvisUiActionResult, TabCardRef } from '../../types';

/** Jarvis's tools never move the window: no navigation, pages or settings. */
const WINDOW_ONLY = /^(nav|settings|ui)\./;
/** Actions that take a `worktree` arg and, without one, mean the one on screen. */
const IN_A_WORKTREE = new Set(['tab.open', 'browser.open', 'server.start', 'server.stop']);
/** Fixed words: what Jarvis is told when a step reaches outside its Focus. */
export const OUT_OF_SCOPE = "That worktree isn't in this Focus.";
export const OTHER_FOCUS = "That Focus isn't this one.";

/** Every worktree a step acts in: its own, its tab's, its anchor's, and the
 * worktree of any agent (or call's agent) it addresses. Unknown agents count
 * as outside (''), so they are refused too. */
function worktreesOf(step: Step, ctx: ParseContext): string[] {
  const out: string[] = [];
  const agentWt = (agentId: string) => ctx.peers.find((p) => p.agentId === agentId)?.worktreePath ?? '';
  if (step.target.kind === 'tab') out.push(step.target.ref.worktreePath);
  const a = step.args as Record<string, unknown>;
  if (typeof a.worktreePath === 'string') out.push(a.worktreePath);
  const place = a.place as { anchor?: { kind: string; ref?: TabRef } } | null | undefined;
  if (place?.anchor?.kind === 'tab' && place.anchor.ref) out.push(place.anchor.ref.worktreePath);
  if (typeof a.agentId === 'string') out.push(agentWt(a.agentId));
  if (Array.isArray(a.agentIds)) for (const id of a.agentIds) out.push(agentWt(String(id)));
  return out;
}

/** D1: Jarvis acts only inside its Focus — the server's `scope` (the Focus's
 * worktree paths) — and edits only this Focus (a new one may be created).
 * A recap of "all" agents is narrowed to the agents in scope. Returns the
 * plan to run, or the fixed refusal. */
function confine(plan: Plan, ctx: ParseContext, scope: Set<string>, focusId: string | null): { plan: Plan } | { refuse: string } {
  const steps: Step[] = [];
  for (const step of plan.steps) {
    if (step.action === 'focus.edit') {
      if (step.args.op !== 'create' && (!focusId || step.args.focusId !== focusId)) return { refuse: OTHER_FOCUS };
      steps.push(step);
      continue;
    }
    if (step.action === 'agent.recap' && step.args.agentIds === 'all') {
      const ids = ctx.peers.filter((p) => scope.has(p.worktreePath)).map((p) => p.agentId);
      steps.push({ ...step, args: { ...step.args, agentIds: ids } });
      continue;
    }
    if (worktreesOf(step, ctx).some((wt) => !scope.has(wt))) return { refuse: OUT_OF_SCOPE };
    steps.push(step);
  }
  return { plan: { ...plan, steps } };
}

/** One Focus Jarvis action, run in this window the way the ⌘K box runs a
 * model plan (model args → Step → runPlan), in the background: a step for a
 * worktree no hub shows works on its stored layout (storedHubPort), never by
 * showing it. Every step must stay inside the Focus (`scope`, see confine).
 * With no worktree named and none of the Focus's on screen, its only worktree
 * is meant; with several, Jarvis is asked which. The ack says what happened
 * with real tab names, the tab it opened as a card, and agent.ask's question id. */
/** W2: what Jarvis hears when the window itself failed, never the error's own text. */
export const WINDOW_FAILED = "The Strado window couldn't do that.";

export async function runJarvisAction(input: JarvisUiActionArgs, deps: ActionDeps): Promise<JarvisUiActionResult> {
  try {
    return await runAction(input, deps);
  } catch {
    return { ok: false, text: WINDOW_FAILED };
  }
}

type ActionDeps = {
  context: () => ParseContext;
  ports: () => Omit<JarvisPorts, 'verify' | 'onStep' | 'ensureWorktree' | 'shellIdle'>;
  /** The Focus this chat belongs to: the only one focus.edit may change. */
  focusId: string | null;
};

async function runAction(
  { action, args: given, scope: scopePaths }: JarvisUiActionArgs,
  deps: ActionDeps,
): Promise<JarvisUiActionResult> {
  let args = given;
  if (WINDOW_ONLY.test(action)) return { ok: false, text: `${action} is not one of Jarvis's actions` };
  const scope = new Set(scopePaths);
  const ctx = deps.context();
  // No worktree named and none on screen in this Focus: its only one, else ask.
  const shown = here(ctx);
  if (IN_A_WORKTREE.has(action) && args.worktree == null && !(shown && scope.has(shown))) {
    const names = scopePaths.map((p) => ctx.worktrees.find((w) => w.path === p)?.name).filter((n): n is string => !!n);
    if (names.length !== 1) return { ok: false, text: names.length ? `Which worktree? ${names.join(', ')}` : 'Which worktree? This Focus has none yet' };
    args = { ...args, worktree: names[0] };
  }
  const planned = planFromModel([{ action, args }], ctx);
  if (planned.steps.length === 0) return { ok: false, text: planned.summary };
  const confined = confine(planned, ctx, scope, deps.focusId);
  if ('refuse' in confined) return { ok: false, text: confined.refuse };
  const plan = confined.plan;
  const ports = deps.ports();
  const run = await runPlan(plan, {
    ...ports,
    // The on-screen hub when it shows that worktree, else its stored layout: never navigate.
    ensureWorktree: async (path) => (ports.hub?.path === path ? ports.hub : storedHubPort(path)),
  });
  const after = deps.context();
  const opened = run.opened.filter((t): t is TabRef => t != null).pop();
  const text = [describeRun(plan, run, after), run.recap ?? ''].filter(Boolean).join('\n\n');
  return {
    ok: run.ok,
    text,
    ...(opened ? { card: cardOf(opened, after, openedUrl(plan.steps)) } : {}),
    ...(run.asks[0] ? { askId: run.asks[0].id } : {}),
  };
}

/** The url a browser.open step opened, as the step normalised it. */
const openedUrl = (steps: Plan['steps']): string => {
  const s = steps.find((x) => x.action === 'browser.open');
  return s?.action === 'browser.open' ? s.args.url : '';
};

function cardOf(tab: TabRef, ctx: ParseContext, url: string): TabCardRef {
  const worktree = ctx.worktrees.find((w) => w.path === tab.worktreePath)?.name ?? tab.worktreePath.split('/').pop() ?? tab.worktreePath;
  return { kind: tab.mode, worktree, worktreePath: tab.worktreePath, tab: `${tab.mode}-${tab.sessionId}`, ...(url ? { url } : {}) };
}
