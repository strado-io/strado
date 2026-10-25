import { describeRun, planFromModel } from '../../lib/jarvis/model';
import { runPlan, type JarvisPorts } from '../../lib/jarvis/execute';
import type { ParseContext, TabRef } from '../../lib/jarvis/types';
import type { JarvisUiActionArgs, JarvisUiActionResult, TabCardRef } from '../../types';

/** Jarvis's tools never move the window: no navigation, pages or settings. */
const WINDOW_ONLY = /^(nav|settings|ui)\./;

/** One Focus Jarvis action, run in this window the way the ⌘K box runs a
 * model plan (model args → Step → runPlan), in the background: the ports
 * carry no ensureWorktree, so a tab for a worktree not on screen is opened
 * off screen. The ack says what happened with real tab names, the tab it
 * opened as a card, and agent.ask's question id. */
export async function runJarvisAction(
  { action, args }: JarvisUiActionArgs,
  deps: { context: () => ParseContext; ports: () => Omit<JarvisPorts, 'verify' | 'onStep' | 'ensureWorktree'> },
): Promise<JarvisUiActionResult> {
  if (WINDOW_ONLY.test(action)) return { ok: false, text: `${action} is not one of Jarvis's actions` };
  const plan = planFromModel([{ action, args }], deps.context());
  if (plan.steps.length === 0) return { ok: false, text: plan.summary };
  const run = await runPlan(plan, deps.ports());
  const after = deps.context();
  const opened = run.opened.filter((t): t is TabRef => t != null).pop();
  const text = [describeRun(plan, run, after), run.recap ?? ''].filter(Boolean).join('\n\n');
  return {
    ok: run.ok,
    text,
    ...(opened ? { card: cardOf(opened, after, action === 'browser.open' ? String(args.url ?? '') : '') } : {}),
    ...(run.asks[0] ? { askId: run.asks[0].id } : {}),
  };
}

function cardOf(tab: TabRef, ctx: ParseContext, url: string): TabCardRef {
  const worktree = ctx.worktrees.find((w) => w.path === tab.worktreePath)?.name ?? tab.worktreePath.split('/').pop() ?? tab.worktreePath;
  return { kind: tab.mode, worktree, tab: `${tab.mode}-${tab.sessionId}`, ...(url ? { url } : {}) };
}
