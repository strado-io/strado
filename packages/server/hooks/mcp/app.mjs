// App-control tools: an agent drives the Strado app itself — opens agent and
// shell tabs, places them in splits, opens Browser tabs, waits on a tab it
// started. Tabs are opened server-side (works with no window); placement is a
// best-effort command to one hub window, so "not placed" is a normal answer.
import { randomUUID } from 'node:crypto';
import { guarded, makeCall, required } from './intercom.mjs';
import { text } from './rpc.mjs';

// Spawn = installs + PTY start + a fresh shell settling (≤ 5 s) + the command
// cap (15 s) + the window ack (3 s); leave headroom over the sum.
const SPAWN_HTTP_TIMEOUT_MS = 40000;
const UI_HTTP_TIMEOUT_MS = 8000;
export const WAIT_POLL_MS = 2000;
export const WAIT_DEFAULT_MS = 300000;

const SPLITS = ['right', 'down', 'tab', 'none'];
const badRef = (s) => /[\s/%?#]/.test(s);

function placeOf(a) {
  if (a.split === 'none') return null;
  return { split: a.split ?? 'right', ...(a.anchor ? { anchor: a.anchor } : {}), ...(a.focus !== undefined ? { focus: a.focus } : {}) };
}

/** One line on where a tab ended up. */
export function renderPlacement(p, place) {
  if (!place) return 'not placed (split=none)';
  if (p.applied) {
    const where = place.split === 'tab' ? 'as a tab' : `${place.split === 'down' ? 'below' : 'right of'} ${place.anchor ?? 'you'}`;
    if (p.reason === 'stored') return `placed ${where} (window shows another worktree; it appears when that worktree is opened)`;
    if (p.reason === 'anchor_not_visible') return `placed beside the active pane (${place.anchor ?? 'your tab'} is not on screen)`;
    return `placed ${where}`;
  }
  return `not placed (${reasonText(p.reason)})`;
}

export function reasonText(reason) {
  return {
    no_window: 'no Strado window is open — the tab is running; it shows when the hub opens',
    timeout: 'the Strado window did not answer in time',
    window_closed: 'the Strado window closed',
    no_browser: 'Browser tabs only exist in the Strado desktop app; this window is a plain web browser',
    unknown_worktree: 'the Strado window does not list that worktree',
    hub_not_ready: 'the Strado window did not open that worktree in time',
    tab_not_found: 'the new tab did not show up in the Strado window in time',
    anchor_not_visible: 'the anchor tab is not on screen',
  }[reason] ?? reason;
}

const placeProps = {
  split: { type: 'string', enum: SPLITS, description: 'right (default) | down | tab (same pane) | none (do not place)' },
  anchor: { type: 'string', description: 'agent id or alias of the tab to split next to; default: you' },
  focus: { type: 'boolean', description: 'bring it to front (default false: never steal the user\'s focus)' },
};

export function appTools(env = process.env) {
  const call = makeCall(env);
  return [
    {
      name: 'agent_spawn',
      description: 'Open a new tab in the Strado app: a shell (optionally running one command) or an agent (claude/codex/opencode/pi, optionally with a first prompt), placed in a split next to you or another tab. Works even when no Strado window is open. Example: "shell to the right running npm run dev" → mode=shell command="npm run dev"; "below that, git status" → mode=shell command="git status" split=down anchor=<that shell>. A long-running command returns "still running" — that is expected.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['shell', 'claude', 'codex', 'opencode', 'pi'] },
          command: { type: 'string', description: 'shell only: one line to run once the shell is ready' },
          prompt: { type: 'string', description: 'agent only: first prompt, typed into the new agent once it is ready' },
          worktree: { type: 'string', description: 'absolute worktree path; default: your worktree' },
          ...placeProps,
        },
        required: ['mode'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'mode');
        if (a.anchor && badRef(a.anchor)) throw new Error('anchor must be an agent id or alias');
        const place = placeOf(a);
        const r = await call('POST', '/api/intercom/agents/spawn', {
          mode: a.mode,
          ...(a.command ? { command: a.command } : {}),
          ...(a.prompt ? { prompt: a.prompt } : {}),
          ...(a.worktree ? { worktreePath: a.worktree } : {}),
          place,
          idempotencyKey: randomUUID(),
        }, SPAWN_HTTP_TIMEOUT_MS);
        const name = r.agent.alias || r.agent.agentId;
        const lines = [`opened ${name} (${r.agent.mode}) in ${r.agent.worktreePath}; ${renderPlacement(r.placement, place)}`];
        if (r.command) {
          if (r.command.error) lines.push(`[command not run: ${r.command.error}]`);
          else {
            const out = r.command.output.endsWith('\n') || r.command.output === '' ? r.command.output : `${r.command.output}\n`;
            lines.push(`${out}${r.command.settled ? `[settled in ${r.command.durationMs} ms]` : `[still running after ${r.command.durationMs} ms — use read_tab ${name} to check on it]`}`);
          }
        }
        if (r.prompt) lines.push(`[first prompt queued; it is typed in once ${name} is ready — use agent_wait ${name} to wait for its answer]`);
        return text(lines.join('\n'));
      }),
    },
    {
      name: 'ui_place',
      description: 'Move an existing tab in the Strado window: split it right of / below another tab, or put it in the same pane as a tab. Best-effort: says "not placed" when no window can do it.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string', description: 'agent id or alias of the tab to place' }, ...placeProps },
        required: ['target'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'target');
        if (badRef(a.target) || (a.anchor && badRef(a.anchor))) throw new Error('target and anchor must be agent ids or aliases');
        const place = placeOf(a);
        if (!place) return text('nothing to do (split=none)');
        const r = await call('POST', '/api/intercom/ui/place', { target: a.target, ...place }, UI_HTTP_TIMEOUT_MS);
        return text(`${a.target}: ${renderPlacement(r, place)}`);
      }),
    },
    {
      name: 'preview_open',
      description: 'Open a new Browser tab in the Strado app at a URL (e.g. "google.com", "localhost:3000"), split right of you by default. Returns its tab id; pass it as `tab` to preview_* tools.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, worktree: { type: 'string', description: 'absolute worktree path; default: yours' }, ...placeProps },
        required: ['url'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'url');
        if (a.anchor && badRef(a.anchor)) throw new Error('anchor must be an agent id or alias');
        const place = placeOf(a);
        const r = await call('POST', '/api/intercom/ui/browser', { url: a.url, ...(a.worktree ? { worktreePath: a.worktree } : {}), place }, UI_HTTP_TIMEOUT_MS);
        if (!r.applied) return text(`could not open ${r.url}: ${r.reason === 'no_window' ? 'no Strado window is open' : r.reason === 'no_browser' ? 'Browser tabs only exist in the Strado desktop app — open Strado desktop' : reasonText(r.reason)}`);
        return text(`opened ${r.url}${r.tabId ? ` in Browser tab ${r.tabId}` : ''}`);
      }),
    },
    {
      name: 'ui_state',
      description: 'Which Strado windows are open, which worktree each shows, and which tabs are visible in each. Use before placing tabs when unsure.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: guarded(async () => {
        const r = await call('GET', '/api/intercom/ui/state');
        if (r.clients.length === 0) return text('no Strado window is open (tabs you open still run; they show when the hub opens)');
        return text(r.clients.map((c) => {
          const flags = [c.clientId === r.target ? 'target' : null, c.focused ? 'focused' : null, c.remote ? 'remote' : null].filter(Boolean).join(', ');
          const tabs = c.visible.length ? c.visible.map((v) => v.alias || v.agentId).join(', ') : '(none)';
          return `window ${c.clientId}${flags ? ` [${flags}]` : ''}\n  worktree: ${c.worktreePath ?? '(none)'}\n  visible: ${tabs}`;
        }).join('\n'));
      }),
    },
    ...[['agent_close', 'close', 'Close a tab in the Strado app (its process is stopped). Allowed right away only for tabs YOU opened with agent_spawn; for any other tab the human is asked instead, and you are told so — do not retry.'],
      ['shell_interrupt', 'interrupt', 'Press Ctrl-C in a tab (stop a running command, e.g. a dev server). Allowed right away only for tabs YOU opened with agent_spawn; for any other tab the human is asked instead.']].map(([name, verb, description]) => ({
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string', description: 'agent id or alias of the tab (see intercom_peers)' } },
        required: ['target'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'target');
        if (badRef(a.target)) throw new Error('target must be an agent id or alias');
        const r = await call('POST', `/api/intercom/agents/${a.target}/${verb}`, {}, UI_HTTP_TIMEOUT_MS);
        const t = r.target.alias || r.target.agentId;
        if (r.status === 'done') return text(verb === 'close' ? `closed ${t}` : `sent Ctrl-C to ${t}`);
        return text(`${t} is not a tab you opened, so the human was asked (escalation ${r.escalationId}); their answer arrives in your inbox`);
      }),
    })),
    {
      name: 'agent_wait',
      description: 'Wait for an agent tab (e.g. one you opened with agent_spawn) to finish its current work, then return its last reply. Default 300 s, max 600 s.',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 5000, maximum: 600000 } },
        required: ['agent'],
        additionalProperties: false,
      },
      run: guarded(async (a) => {
        required(a, 'agent');
        if (badRef(a.agent)) throw new Error('agent must be an agent id or alias');
        const timeoutMs = Math.min(600000, Math.max(5000, a.timeoutMs ?? WAIT_DEFAULT_MS));
        const status = () => call('GET', `/api/intercom/agents/${a.agent}/status`);
        const first = await status();
        if (first.mode === 'shell') return text(`${a.agent} is a shell; it has no turns to wait on — use read_tab or run_in_shell`);
        const startTurn = first.lastTurn ? first.lastTurn.endedAt : 0;
        const deadline = Date.now() + timeoutMs;
        let s = first;
        while (Date.now() < deadline) {
          if (!s.live) return text(`[${a.agent} is no longer running]${s.lastTurn ? `\n${s.lastTurn.reply}` : ''}`);
          const newTurn = s.lastTurn && s.lastTurn.endedAt > startTurn;
          if (newTurn && s.lifecycle !== 'working') {
            return text(`${s.lastTurn.reply}${s.lastTurn.replyTruncated ? '\n[truncated — see intercom_diary]' : ''}`);
          }
          await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
          s = await status();
        }
        return text(`[${a.agent} is still ${s.lifecycle} after ${Math.round(timeoutMs / 1000)} s]`);
      }),
    },
  ];
}
