// Jarvis safety: which steps need a second confirm, and the preview-time
// binding that refuses to run a step whose target moved under it.
import type { ParseContext, Plan, Step, TabRef } from './types';

/** One shell segment's words, with leading `sudo`, `env X=y`, `nice` etc. dropped. */
function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && (/^(sudo|doas|nice|nohup|time|command|exec|env)$/.test(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) words.shift();
  return words;
}

/** Short flags of a word list merged into one set: `-r -f` and `-rf` both give {r,f}. */
const shortFlags = (words: string[]): Set<string> =>
  new Set(words.filter((w) => /^-[A-Za-z]+$/.test(w)).flatMap((w) => [...w.slice(1)]));

type Rule = (words: string[], segment: string) => string | null;

const RULES: Rule[] = [
  (w) => {
    if (w[0] !== 'rm') return null;
    const f = shortFlags(w);
    const recursive = f.has('r') || f.has('R') || w.includes('--recursive');
    const force = f.has('f') || w.includes('--force');
    return recursive && force ? 'recursive delete (rm -rf)' : null;
  },
  (w) => {
    if (w[0] !== 'git') return null;
    const sub = w[1];
    const f = shortFlags(w);
    if (sub === 'push' && (w.some((x) => x.startsWith('--force')) || f.has('f') || w.slice(2).some((x) => /^\+[^\s]/.test(x)))) return 'force push';
    if (sub === 'reset' && w.includes('--hard')) return 'hard reset (discards changes)';
    if (sub === 'clean' && (f.has('f') || w.includes('--force'))) return 'git clean (deletes untracked files)';
    if (sub === 'branch' && (f.has('D') || (w.includes('--delete') && w.includes('--force')))) return 'force-delete a branch';
    if ((sub === 'checkout' && w.includes('--') && w.includes('.')) || (sub === 'restore' && w.includes('.'))) return 'discard all working-tree changes';
    return null;
  },
  (_w, s) => (/\bdrop\s+(table|database|schema|index|view|keyspace)\b/i.test(s) ? 'SQL DROP' : null),
  (w) => (['kill', 'killall', 'pkill'].includes(w[0] ?? '') ? 'kills processes' : null),
  (w) => (/^mkfs(\.|$)/.test(w[0] ?? '') ? 'formats a disk' : null),
  (w) => (w[0] === 'dd' && w.some((x) => x.startsWith('of=')) ? 'raw disk write (dd)' : null),
  (w) => {
    if (w[0] !== 'chmod' && w[0] !== 'chown') return null;
    return shortFlags(w).has('R') || w.includes('--recursive') ? `recursive ${w[0]}` : null;
  },
  (w) => (w[0] === 'truncate' ? 'truncates a file' : null),
  (w) => (w[0] === 'docker' && w.includes('prune') ? 'docker prune' : null),
  (w) => (w[0] === 'kubectl' && w[1] === 'delete' ? 'kubectl delete' : null),
  (_w, s) => (/>\s*\/dev\/(sd|disk|nvme|hd)/.test(s) ? 'writes to a raw disk' : null),
];

/** The first destructive pattern in a shell command line, or null. Checked
 * per `;`/`&&`/`||`/`|` segment, so `cd x && rm -rf y` is caught. */
export function destructiveCommand(command: string): string | null {
  for (const segment of command.split(/;|&&|\|\||\|/)) {
    const words = commandWords(segment);
    for (const rule of RULES) {
      const hit = rule(words, segment);
      if (hit) return hit;
    }
  }
  return null;
}

const sameRef = (a: TabRef, b: TabRef): boolean =>
  a.worktreePath === b.worktreePath && a.mode === b.mode && a.sessionId === b.sessionId;

const tabOf = (ctx: ParseContext, ref: TabRef) => ctx.tabs.find((t) => sameRef(t, ref));

/** Why `step` needs a second confirm, or null. */
export function isDestructive(step: Step, ctx: ParseContext): string | null {
  const command = step.action === 'shell.run' ? step.args.command
    : step.action === 'tab.open' || step.action === 'server.start' ? step.args.command
      : undefined;
  if (command) {
    const hit = destructiveCommand(command);
    if (hit) return hit;
    if (step.suggested) return 'suggested by the model — check the command before running it';
  }
  if ((step.action === 'tab.close' || step.action === 'tab.interrupt') && step.target.kind === 'tab') {
    const t = tabOf(ctx, step.target.ref);
    // Only live work earns a confirm: an idle tab closes/stops at once.
    if (t?.busy) {
      const name = t.alias ?? t.agentId?.split('@')[0] ?? `${t.mode}-${t.sessionId}`;
      const verb = step.action === 'tab.close' ? 'close' : 'interrupt';
      return `${name} is ${t.mode === 'shell' ? 'running something' : 'working'} — ${verb} it anyway?`;
    }
  }
  if (step.action === 'focus.edit' && step.args.op === 'delete') {
    return `Delete Focus ${ctx.focuses.find((f) => f.id === step.args.focusId)?.name ?? 'this'}?`;
  }
  if (step.fromModel) {
    // The model never answers for the user: a call is always a yes/no.
    const who = (id: string) => id.split('@')[0];
    if (step.action === 'call.answer') return `Answer ${who(step.args.agentId)}'s call: "${step.args.text}"`;
    if (step.action === 'call.dismiss') return `Dismiss ${who(step.args.agentId)}'s call`;
    // Sharing usage data is the user's own decision, not a model's guess.
    if (step.action === 'settings.set' && step.args.setting === 'privacy.telemetry' && step.args.value === 'on') return 'Turn telemetry on (shares usage data)?';
    const anchor = 'place' in step.args ? step.args.place?.anchor : undefined;
    for (const target of [step.target, anchor]) {
      if (target?.kind === 'tab' && tabOf(ctx, target.ref)?.humanActive) return "you're using that tab right now";
    }
  }
  return null;
}

/** `step` with needsConfirm/confirmReason recomputed against `ctx`. Call it
 * after anything changes a step (a chip edit can swap in a busy target). */
export function withSafety(step: Step, ctx: ParseContext): Step {
  const { confirmReason: _stale, ...rest } = step;
  const reason = isDestructive(step, ctx);
  return (reason ? { ...rest, needsConfirm: true, confirmReason: reason } : { ...rest, needsConfirm: false }) as Step;
}

/** `*Instance`: the hub instance the preview saw in that slot (TabInfo.instance). */
export type BoundStep = { step: Step; ref: TabRef | null; anchor: TabRef | null; busy: boolean; refInstance?: string; anchorInstance?: string };
export type Verdict = { ok: true } | { ok: false; reason: 'target_gone' | 'target_busy' | 'target_replaced' };

/** The tab a step places itself beside, when it names one. */
function anchorOf(step: Step): TabRef | null {
  const place = 'place' in step.args ? step.args.place : null;
  return place && place.anchor.kind === 'tab' ? place.anchor.ref : null;
}

/** Snapshot what the step depends on: its tab, its anchor tab, and whether the tab was busy. */
export function bindTarget(step: Step, ctx: ParseContext): BoundStep {
  const ref = step.target.kind === 'tab' ? step.target.ref : null;
  const anchor = anchorOf(step);
  const seen = ref ? tabOf(ctx, ref) : undefined;
  return { step, ref, anchor, busy: !!seen?.busy, refInstance: seen?.instance, anchorInstance: anchor ? tabOf(ctx, anchor)?.instance : undefined };
}

/** The tab is still there, and still the same occupant. Same slot with
 * another execution (registry) or another hub instance means the tab was
 * closed and its number reused; each is decidable only when both sides know it. */
function stillThere(ref: TabRef, instance: string | undefined, now: ParseContext): Verdict & { info?: ReturnType<typeof tabOf> } {
  const t = tabOf(now, ref);
  if (!t) return { ok: false, reason: 'target_gone' };
  if (ref.executionId && t.executionId && t.executionId !== ref.executionId) return { ok: false, reason: 'target_replaced' };
  if (instance && t.instance && t.instance !== instance) return { ok: false, reason: 'target_replaced' };
  return { ok: true, info: t };
}

/** Right before running: the tabs the step uses must still be there (and the
 * same), and a close/interrupt confirmed on an idle tab must not now hit a busy
 * one. Nothing else about the layout matters — a moved pane or a re-render is
 * not a reason to refuse (it false-fired on auto-run). */
export function verifyTarget(bound: BoundStep, now: ParseContext): Verdict {
  if (bound.ref) {
    const v = stillThere(bound.ref, bound.refInstance, now);
    if (!v.ok) return { ok: false, reason: v.reason };
    const a = bound.step.action;
    if ((a === 'tab.close' || a === 'tab.interrupt') && v.info?.busy && !bound.busy) return { ok: false, reason: 'target_busy' };
  }
  if (bound.anchor) {
    const v = stillThere(bound.anchor, bound.anchorInstance, now);
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  return { ok: true };
}

export type BoundPlan = { plan: Plan; steps: BoundStep[] };

export const bindPlan = (plan: Plan, ctx: ParseContext): BoundPlan => ({ plan, steps: plan.steps.map((s) => bindTarget(s, ctx)) });

/** Verify every step up front; the first failure names its index. */
export function verifyPlan(bound: BoundPlan, now: ParseContext): Verdict | { ok: false; reason: string; step: number } {
  for (const [i, s] of bound.steps.entries()) {
    const v = verifyTarget(s, now);
    if (!v.ok) return { ...v, step: i };
  }
  return { ok: true };
}
