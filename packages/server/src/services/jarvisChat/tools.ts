// Focus Jarvis's tools: their MCP schemas (from ACTIONS[].model, the box's
// own), argument checks, the exact one-line summary of each call, and the
// approval rule. The rule is enforced here, on the server, never in the UI.
import { ACTIONS, type ActionDef } from '../actions.js';
import { destructiveCommand } from './safety.js';
import { JARVIS_TOOLS, WORKTREE_CREATE, type JarvisToolSpec } from './types.js';

const WORKTREE_CREATE_MODEL = {
  description: 'Propose a new worktree from a repo and add it to this Focus. Always waits for the person\'s approval.',
  properties: {
    repo: { type: 'string', description: 'the repo name, exactly as in context.repos' },
    branch: { type: 'string', description: 'a short new branch name, e.g. "fix-login-redirect"' },
  },
};

const defOf = (action: string): Pick<ActionDef, 'risk' | 'model'> | undefined =>
  action === WORKTREE_CREATE ? { risk: 'destructive', model: WORKTREE_CREATE_MODEL } : ACTIONS.find((a) => a.id === action);

/** The tools jarvis.mjs serves: exactly JARVIS_TOOLS, each with its action's model schema. */
export function jarvisToolSpecs(): JarvisToolSpec[] {
  return Object.entries(JARVIS_TOOLS).map(([name, action]) => {
    const model = defOf(action)?.model;
    if (!model) throw new Error(`jarvis tool ${name}: ${action} has no model schema`);
    return {
      name,
      description: model.description,
      inputSchema: { type: 'object', properties: model.properties, required: Object.keys(model.properties), additionalProperties: false },
    };
  });
}

type Schema = { type?: string | string[]; enum?: unknown[]; anyOf?: Schema[]; items?: Schema };

const TEXT_MAX = 16 * 1024;

function fits(s: Schema, v: unknown): boolean {
  if (s.anyOf) return s.anyOf.some((x) => fits(x, v));
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const typed = types.some((t) =>
    t === 'null' ? v === null
      : t === 'string' ? typeof v === 'string' && v.length <= TEXT_MAX
        : t === 'boolean' ? typeof v === 'boolean'
          : t === 'array' ? Array.isArray(v) && v.length <= 50 && (!s.items || v.every((x) => fits(s.items!, x)))
            : false);
  return typed && (!s.enum || v === null || s.enum.includes(v));
}

const nullable = (s: Schema): boolean => (s.anyOf ? s.anyOf.some(nullable) : Array.isArray(s.type) ? s.type.includes('null') : s.type === 'null');

/** The args, checked against the action's schema: unknown keys refused, an
 *  omitted nullable filled with null. Fixed error text (no arg echoed). */
export function checkArgs(action: string, raw: unknown): Record<string, unknown> {
  const props = defOf(action)?.model?.properties as Record<string, Schema> | undefined;
  if (!props || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad arguments');
  const args = raw as Record<string, unknown>;
  if (Object.keys(args).some((k) => !(k in props))) throw new Error('bad arguments');
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(props)) {
    const v = args[k] === undefined && nullable(s) ? null : args[k];
    if (!fits(s, v)) throw new Error(`bad argument: ${k}`);
    out[k] = v;
  }
  return out;
}

const q = (s: unknown) => `“${String(s)}”`;
const code = (s: unknown) => `\`${String(s)}\``;
const where = (w: unknown) => (w ? `in ${w}` : 'in this worktree');
const run = (r: unknown) => (r ? `${r}` : 'the dev server');

/** Exactly what the call will do, for the log and the approval card. */
export function summarize(action: string, a: Record<string, unknown>): string {
  switch (action) {
    case 'tab.open':
      return `Open ${a.mode === 'shell' ? 'a shell' : a.mode} ${where(a.worktree)}${a.command ? `, running ${code(a.command)}` : ''}${a.prompt ? `, asking: ${q(a.prompt)}` : ''}`;
    case 'tab.place': return `Move ${a.tab} ${a.split === 'tab' ? 'to its own tab' : `${a.split === 'down' ? 'below' : 'right of'} ${a.anchor ?? 'the focused tab'}`}`;
    case 'tab.focus': return `Bring ${a.tab} to the front`;
    case 'tab.rename': return a.name ? `Rename ${a.tab} to ${q(a.name)}` : `Reset ${a.tab}'s name`;
    case 'tab.close': return `Close ${a.tab}${(a.target as { kind?: string } | undefined)?.kind === 'browser' ? '' : ' (stops what runs in it)'}`;
    case 'tab.interrupt': return `Press Ctrl-C in ${a.tab}`;
    case 'shell.run': return `Run ${code(a.command)} in ${a.tab ?? 'the focused shell'}`;
    case 'browser.open': return `Open ${a.url} in a Browser tab ${where(a.worktree)}`;
    case 'server.start': return `Start ${run(a.run)} ${where(a.worktree)}`;
    case 'server.stop': return `Stop ${run(a.run)} ${where(a.worktree)}`;
    case 'agent.message': return `Message ${a.to}: ${q(a.text)}`;
    case 'agent.ask': return `Ask ${a.to}: ${q(a.question)}`;
    case 'agent.steer': return `Interrupt ${a.agent} and tell it: ${q(a.text)}`;
    case 'agent.interrupt': return `Interrupt ${a.agent}`;
    case 'agent.recap': return `Recap ${a.agent === 'all' ? 'every agent' : a.agent}${a.focus ? ` in ${a.focus}` : ''}`;
    case 'call.answer': return `Answer ${a.caller}: ${q(a.text)}`;
    case 'call.dismiss': return `Dismiss ${a.caller}'s call`;
    case 'focus.edit': {
      const wts = Array.isArray(a.worktrees) && a.worktrees.length ? ` ${(a.worktrees as string[]).join(', ')}` : '';
      if (a.op === 'create') return `Create the Focus ${q(a.name)}${wts ? ` with${wts}` : ''}`;
      if (a.op === 'rename') return `Rename the Focus ${a.focus} to ${q(a.name)}`;
      if (a.op === 'delete') return `Delete the Focus ${a.focus}`;
      return `${a.op === 'add' ? 'Add' : 'Remove'}${wts} ${a.op === 'add' ? 'to' : 'from'} ${a.focus}`;
    }
    case WORKTREE_CREATE: return `Create the worktree ${a.branch} from ${a.repo} and add it to this Focus`;
    default: return action;
  }
}

/** Why this call waits for the person, or null to run it now. `danger`: a
 *  destructive shell line's reason, for the card's red line. */
export function approvalFor(action: string, a: Record<string, unknown>, o: { wake: boolean }): { danger?: string } | null {
  const command = action === 'shell.run' || action === 'tab.open' ? (typeof a.command === 'string' ? a.command : null) : null;
  const danger = command ? destructiveCommand(command) ?? undefined : undefined;
  const risk = defOf(action)?.risk;
  const needs =
    risk === 'exec' || risk === 'destructive'
    // A new shell that runs a line is running a shell line.
    || (action === 'tab.open' && !!command)
    // Adding a worktree widens what Jarvis may act in: the person decides (D1).
    || (action === 'focus.edit' && (a.op === 'delete' || a.op === 'add'))
    // A wake turn must not start or question agents on its own: wakes cannot loop.
    || (o.wake && ((action === 'tab.open' && a.mode !== 'shell') || action === 'agent.ask'));
  return needs ? (danger ? { danger } : {}) : null;
}
