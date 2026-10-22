// The one list of things Strado can be told to do — by an agent (MCP tools),
// by the human's command box (Jarvis), or by a shortcut. Each surface maps to
// these ids; contract tests fail when a surface grows an action this list
// does not name, or names one that no surface implements.
//
// `risk` drives confirmation: read < layout < spawn < exec < destructive.
// `where`: 'hub' actions run in the window (layout state lives there);
// 'server' actions need the server (PTYs, shells, the intercom).

export type ActionRisk = 'read' | 'layout' | 'spawn' | 'exec' | 'destructive';

export type ActionDef = {
  id: string;
  risk: ActionRisk;
  where: 'hub' | 'server';
  description: string;
  /** MCP tool(s) that expose it to agents, if any. */
  mcp?: string[];
  /** Jarvis human route under /api/w/:ws, if it needs the server. */
  jarvis?: string;
  /** Arguments the natural-language model fills, as a strict-tool JSON
   * schema (every property required; optional ones are nullable). Absent =
   * the model may not propose this action. Tab references are names from
   * the context the box sends ("shell-2@repo", "Shell 2"), "this" for the
   * focused tab, or "#N" for the tab step N of the same plan opens. */
  model?: { description: string; properties: Record<string, unknown> };
};

const str = (description: string) => ({ type: 'string', description });
const optStr = (description: string) => ({ type: ['string', 'null'], description });
const TAB = str('tab name from the context, "this" for the focused tab, or "#N" for the tab opened by step N of this plan');
// Strict tools refuse an enum on a ['string','null'] type: a nullable enum is anyOf.
const SPLIT = { anyOf: [{ type: 'string', enum: ['right', 'down', 'tab'] }, { type: 'null' }], description: 'where to put it: "tab" = its own new tab in the tab strip (not a split); "right" / "down" = a split right of / below the anchor; null = not said (a split right of the focused tab)' };
const ANCHOR = { type: ['string', 'null'], description: 'tab to place it next to (same reference rules as tab); null = the focused tab' };

export const ACTIONS: readonly ActionDef[] = [
  { id: 'nav.worktree', risk: 'read', where: 'hub', description: 'Open a worktree in the hub', model: { description: 'Open/switch to a worktree (by name, branch or ticket key).', properties: { name: str('worktree name, branch or ticket key from the context') } } },
  { id: 'nav.focus', risk: 'read', where: 'hub', description: 'Switch to a Focus', model: { description: 'Switch to a Focus (a saved group of worktrees).', properties: { name: str('Focus name from the context') } } },
  { id: 'nav.workspace', risk: 'read', where: 'hub', description: 'Switch workspace', model: { description: 'Switch to another workspace (context.workspaces).', properties: { name: str('workspace name exactly as in context.workspaces') } } },
  { id: 'nav.repo', risk: 'read', where: 'hub', description: 'Start a new worktree from a repo', model: { description: 'Start creating a new worktree from a repo (opens the new-worktree dialog).', properties: { name: str('repo name') } } },
  { id: 'tab.open', risk: 'spawn', where: 'server', description: 'Open a shell or agent tab, optionally running a command or a first prompt', mcp: ['agent_spawn'], jarvis: '/jarvis/spawn', model: { description: 'Open a new tab: a shell (optionally running one shell command) or a coding agent (optionally with a first prompt), placed next to a tab.', properties: { mode: { type: 'string', enum: ['shell', 'claude', 'codex', 'opencode', 'pi'] }, command: optStr('shell only: one shell command line to run, e.g. "npm run dev"'), prompt: optStr('agent only: the first instruction for the agent'), split: SPLIT, anchor: ANCHOR, worktree: optStr('worktree name to open it in; null = the current worktree') } } },
  { id: 'tab.place', risk: 'layout', where: 'hub', description: 'Put a tab in a split next to another tab', mcp: ['ui_place'], model: { description: 'Move an existing tab next to another tab.', properties: { tab: TAB, split: { type: 'string', enum: ['right', 'down', 'tab'] }, anchor: ANCHOR } } },
  { id: 'tab.focus', risk: 'layout', where: 'hub', description: 'Bring a tab to the front', model: { description: 'Bring a tab to the front / switch to it.', properties: { tab: TAB } } },
  { id: 'tab.close', risk: 'destructive', where: 'server', description: 'Close a tab and stop its process', mcp: ['agent_close'], jarvis: '/jarvis/close', model: { description: 'Close a tab (stops whatever runs in it).', properties: { tab: TAB } } },
  { id: 'tab.interrupt', risk: 'destructive', where: 'server', description: 'Press Ctrl-C in a tab', mcp: ['shell_interrupt'], jarvis: '/jarvis/interrupt', model: { description: 'Press Ctrl-C in a tab (stop the running command, e.g. a dev server) without closing it.', properties: { tab: TAB } } },
  { id: 'shell.run', risk: 'exec', where: 'server', description: 'Run one line in a shell tab', mcp: ['run_in_shell'], jarvis: '/jarvis/run', model: { description: 'Run one shell command line in an existing shell tab. Only when the user clearly asked to run that command.', properties: { tab: { type: ['string', 'null'], description: 'shell tab reference; null = the focused shell' }, command: str('one shell command line') } } },
  { id: 'browser.open', risk: 'layout', where: 'hub', description: 'Open a Browser tab at a URL', mcp: ['preview_open'], model: { description: 'Open a Browser tab at a URL (e.g. google.com, localhost:5173).', properties: { url: str('URL or host'), split: SPLIT, anchor: ANCHOR, worktree: optStr('worktree name to open it in; null = the current worktree') } } },
  { id: 'agent.message', risk: 'exec', where: 'server', description: 'Send a message to an agent', mcp: ['intercom_send'], jarvis: '/jarvis/message', model: { description: 'Send a message/instruction to an existing coding agent tab (it reads it at its next prompt).', properties: { to: str('agent tab name from the context, or "this"'), text: str('the message, in the user\'s words') } } },
  { id: 'agent.wait', risk: 'read', where: 'server', description: 'Wait for an agent to finish and read its answer', mcp: ['agent_wait'] },
  { id: 'ui.state', risk: 'read', where: 'hub', description: 'What each Strado window shows', mcp: ['ui_state'] },
  { id: 'server.start', risk: 'spawn', where: 'server', description: "Start one of the worktree's run commands (the dev server by default)", model: { description: "Start one of the worktree's run commands in its own Run tab: the default dev server, or one by name (context.runCommands).", properties: { worktree: optStr('worktree name; null = the current one'), run: str('run command name from context.runCommands; "" = the default (the dev server)') } } },
  { id: 'server.stop', risk: 'destructive', where: 'server', description: "Stop one of the worktree's run commands (the dev server by default)", model: { description: "Stop one of the worktree's run commands: the default dev server, or one by name.", properties: { worktree: optStr('worktree name; null = the current one'), run: str('run command name from context.runCommands; "" = the default (the dev server)') } } },
  // Calls are the human's own decision: the model may propose answering or
  // dismissing one when the user asks it to, but the box always confirms it.
  { id: 'call.answer', risk: 'exec', where: 'server', description: 'Answer a call (an agent waiting on the human)', model: { description: 'Answer a call: an agent in context.calls is waiting on the user; send the user\'s answer. Only when the user clearly answers it.', properties: { caller: str('the calling agent name from context.calls, or "this"'), text: str('the answer, in the user\'s words') } } },
  { id: 'call.dismiss', risk: 'exec', where: 'server', description: 'Dismiss a call without answering', model: { description: 'Dismiss a call without answering (the user says ignore / hang up / never mind).', properties: { caller: str('the calling agent name from context.calls, or "this"') } } },
  { id: 'nav.addRepo', risk: 'read', where: 'hub', description: 'Add a repo (opens the add-repo dialog, optionally with a path)', model: { description: 'Add a repository to Strado (opens the add-repo dialog).', properties: { path: optStr('filesystem path the user gave; null = let them pick') } } },
  { id: 'nav.newWorktree', risk: 'read', where: 'hub', description: 'Start a new worktree (opens the new-worktree dialog, optionally for a repo)', model: { description: 'Start creating a new worktree (opens the new-worktree dialog).', properties: { repo: optStr('the repo the user named, exactly as in context.repos (e.g. "Strado"); null ONLY when no repo was named') } } },
  // The rest of the app: its pages, Settings, and the plain settings there.
  // Keys and tokens are never set this way: the user types those in Settings.
  { id: 'nav.page', risk: 'read', where: 'hub', description: 'Open a page of the app (home, worktrees, code reviews, usage)', model: { description: 'Open a page of the app. Also closes Settings.', properties: { page: { type: 'string', enum: ['home', 'worktrees', 'reviews', 'usage'], description: 'home = the start screen; worktrees = all worktrees; reviews = code reviews (merge/pull requests); usage = usage and cost' } } } },
  { id: 'settings.open', risk: 'read', where: 'hub', description: 'Open Settings at a section', model: { description: 'Open Settings at a section.', properties: { section: { type: 'string', enum: ['profile', 'organization', 'appearance', 'workspaces', 'agents', 'runners', 'integrations', 'jira', 'linear', 'gitlab', 'github', 'privacy', 'commandbox'], description: 'profile = name; appearance = theme and fonts; agents = coding agent config; runners = remote machines; integrations or a named one (jira/linear/gitlab/github); privacy = telemetry; commandbox = this command box (model, keys)' } } } },
  { id: 'settings.set', risk: 'layout', where: 'hub', description: 'Change a plain setting (profile name, theme, fonts, telemetry, command box local-only)', model: { description: 'Change one setting. Never for API keys, tokens or passwords: for those open the section instead.', properties: { setting: { type: 'string', enum: ['profile.name', 'profile.callMe', 'appearance.theme', 'appearance.font', 'appearance.diffFont', 'appearance.terminalFont', 'privacy.telemetry', 'commandbox.localOnly'] }, value: str('profile.name / profile.callMe: the text; appearance.theme: true-black | graphite | ayu-dark | dracula | nord | github-light; appearance.font: jetbrains | inter | system; appearance.diffFont: jetbrains | system-mono; appearance.terminalFont: nerd | jetbrains | system-mono; privacy.telemetry and commandbox.localOnly: on | off') } } },
  // One tool for every Focus edit: the API caps strict tools at 20.
  { id: 'focus.edit', risk: 'layout', where: 'hub', description: 'Create, rename or delete a Focus, or add/remove worktrees in one', model: { description: 'Create, rename or delete a Focus (a saved group of worktrees), or add/remove worktrees in one. Deleting asks the user first.', properties: { op: { type: 'string', enum: ['create', 'rename', 'delete', 'add', 'remove'] }, focus: optStr('the existing Focus by its context name (rename, delete, add, remove); null for create'), name: optStr('create: the new Focus name; rename: the new name; else null'), worktrees: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], description: 'worktree names from the context: create (its first members), add, remove; else null' } } } },
  { id: 'ui.sidebar', risk: 'read', where: 'hub', description: 'Show, hide or toggle the sidebar', model: { description: 'Show, hide or toggle the left sidebar (worktrees and Focuses list).', properties: { show: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'true = show/open it, false = hide/close/collapse it, null = toggle' } } } },
  { id: 'agent.ask', risk: 'exec', where: 'server', description: 'Ask an agent a question; its answer comes back to the box', mcp: ['intercom_send'], jarvis: '/jarvis/message', model: { description: 'Ask an existing coding agent a question the user wants answered by it (why it did something, whether something works, its opinion). It answers through the intercom and the box shows the answer. Not for "what is it doing / what has it done": use agent_recap.', properties: { to: str('agent tab name from the context, or "this"'), question: str('the question, in the user\'s words') } } },
  { id: 'agent.recap', risk: 'read', where: 'server', description: 'What an agent is doing and has done, from its saved turns', jarvis: '/jarvis/recap', model: { description: 'Tell the user what an agent is working on now or has done ("what is claude-1 doing", "what did codex do", "what are all the agents doing"). Reads its saved turns; the agent is not disturbed.', properties: { agent: str('agent tab name from the context, or "all" for every agent'), focus: optStr('with agent "all": only the agents in this Focus (its context name); null otherwise') } } },
  { id: 'tab.rename', risk: 'layout', where: 'hub', description: "Rename a tab (its label in the tab strip)", model: { description: 'Rename a tab: the label shown in the tab strip ("rename this shell to test", "call claude 2 reviewer"). An empty name puts the default label back.', properties: { tab: str('tab name from the context, or "this" for the focused tab'), name: str('the new label, in the user\'s words (empty to reset)') } } },
  // Mission control: stop an agent mid-turn (its own Esc), or stop it and give it a new instruction now.
  { id: 'agent.interrupt', risk: 'exec', where: 'server', description: 'Stop an agent mid-turn (presses Esc in its own UI)', model: { description: 'Stop a working agent now ("stop claude-1", "interrupt codex"). Its own UI handles it like the user pressing Esc.', properties: { agent: str('agent tab name from the context, or "this"') } } },
  { id: 'agent.steer', risk: 'exec', where: 'server', description: 'Interrupt an agent and send it a new instruction at once', jarvis: '/jarvis/message', model: { description: 'Interrupt a working agent and give it a new instruction right away ("tell claude-1 to stop and use pnpm instead"). For a message that can wait until it finishes, use agent_message.', properties: { agent: str('agent tab name from the context, or "this"'), text: str('the new instruction, in the user\'s words') } } },
] as const;

export const ACTION_IDS: readonly string[] = ACTIONS.map((a) => a.id);
