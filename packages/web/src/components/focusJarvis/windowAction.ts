import { describeRun, planFromModel } from '../../lib/jarvis/model';
import { runPlan, type JarvisPorts } from '../../lib/jarvis/execute';
import { here } from '../../lib/jarvis/parse';
import { storedHubPort } from './storedHub';
import type { ParseContext, Plan, TabRef } from '../../lib/jarvis/types';
import type { JarvisUiActionArgs, JarvisUiActionResult, TabCardRef } from '../../types';

/** Jarvis's tools never move the window: no navigation, pages or settings. */
const WINDOW_ONLY = /^(nav|settings|ui)\./;
/** Actions that take a `worktree` arg and, without one, mean the one on screen. */
const IN_A_WORKTREE = new Set(['tab.open', 'browser.open', 'server.start', 'server.stop']);

/** One Focus Jarvis action, run in this window the way the ⌘K box runs a
 * model plan (model args → Step → runPlan), in the background: a step for a
 * worktree no hub shows works on its stored layout (storedHubPort), never by
 * showing it. With no worktree named and none on screen, the Focus's only
 * worktree is meant; with several, Jarvis is asked which. The ack says what happened with real tab names, the tab it
 * opened as a card, and agent.ask's question id. */
export async function runJarvisAction(
  { action, args: given }: JarvisUiActionArgs,
  deps: { context: () => ParseContext; ports: () => Omit<JarvisPorts, 'verify' | 'onStep' | 'ensureWorktree' | 'shellIdle'> },
): Promise<JarvisUiActionResult> {
  let args = given;
  if (WINDOW_ONLY.test(action)) return { ok: false, text: `${action} is not one of Jarvis's actions` };
  const ctx = deps.context();
  if (IN_A_WORKTREE.has(action) && args.worktree == null && !here(ctx)) {
    const paths = ctx.focuses.find((f) => f.id === ctx.currentFocus?.id)?.worktreePaths ?? [];
    const names = paths.map((p) => ctx.worktrees.find((w) => w.path === p)?.name).filter((n): n is string => !!n);
    if (names.length !== 1) return { ok: false, text: names.length ? `Which worktree? ${names.join(', ')}` : 'Which worktree? This Focus has none yet' };
    args = { ...args, worktree: names[0] };
  }
  const plan = planFromModel([{ action, args }], ctx);
  if (plan.steps.length === 0) return { ok: false, text: plan.summary };
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
