// Focus Jarvis: every Focus has a chat in the main area, run by the person's
// own agent CLI in headless mode with Strado's actions as its only tools.
// Spec: docs/specs/2026-10-26-focus-jarvis-design.md (private repo).
//
// Rules:
// - The server owns the chat log (one jsonl per Focus); the web only reads it
//   and posts messages and approvals.
// - Jarvis acts only through JARVIS_TOOLS. read / layout / spawn run at once;
//   exec / destructive become an `approval` entry, which ends the turn.
//   Approve or No starts the next (resumed) turn. Enforced on the server.
// - Jarvis's own session is never a tab and never one of the Focus's agents.

import type { JarvisContext } from '../jarvisModel.js';

export type { JarvisContext };

/** The agent CLI that runs a Focus's Jarvis. Codex, Pi and OpenCode follow. */
export type JarvisAgent = 'claude';
export const JARVIS_AGENTS: readonly JarvisAgent[] = ['claude'];

export type CardKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'shell' | 'run' | 'browser';
/** A tab Jarvis opened, as the chat's live card finds it again. `tab` is the
 * tab's session name ("claude-1"); `worktree` the worktree name. */
export type TabCardRef = { kind: CardKind; worktree: string; tab: string; label?: string; url?: string };

export type ApprovalState = 'pending' | 'approved' | 'declined' | 'superseded';
export type TurnState = 'running' | 'done' | 'interrupted' | 'failed' | 'stopped';

export type ChatEntry =
  | { id: string; at: string; type: 'user'; text: string; windowId: string }
  /** Streamed: the same id is upserted while `done` is false. */
  | { id: string; at: string; type: 'jarvis'; turnId: string; text: string; done: boolean }
  | { id: string; at: string; type: 'action'; turnId: string; action: string; summary: string; ok: boolean; error?: string; card?: TabCardRef }
  | {
      id: string; at: string; type: 'approval'; turnId: string; action: string; args: Record<string, unknown>;
      /** Exactly what will happen, for the card ("Stop dev in fleetx-api"). */
      summary: string;
      /** destructiveCommand() reason for a shell line, shown in red. */
      danger?: string;
      state: ApprovalState;
      result?: string;
    }
  /** Something that happened outside a turn: an agent finished, an answer came back. */
  | { id: string; at: string; type: 'event'; text: string }
  | { id: string; at: string; type: 'turn'; turnId: string; state: TurnState; wake?: boolean; error?: string; fix?: string }
  /** "Now on …" divider: the Focus switched agents (a fresh session). */
  | { id: string; at: string; type: 'agent'; agent: JarvisAgent };

/** A new entry as callers hand it to the store: id and at are filled in. */
export type NewChatEntry = ChatEntry extends infer E ? (E extends ChatEntry ? Omit<E, 'id' | 'at'> & { id?: string } : never) : never;

export type JarvisMeta = {
  focusId: string;
  agent: JarvisAgent;
  /** The agent CLI's own session id, resumed by every later turn. */
  sessionId: string | null;
  lastActiveAt: string | null;
  pendingApprovals: number;
  running: boolean;
};

export const JARVIS_LIMITS = {
  turnMs: 300_000,
  wakeGapMs: 30_000,
  logEntries: 2_000,
  logBytes: 2 * 1024 * 1024,
  messageMax: 16 * 1024,
  pageMax: 200,
} as const;

export const JARVIS_ROUTES = {
  log: '/api/w/:ws/focuses/:id/jarvis', // GET ?before=<entryId>&limit=100 → { entries: ChatEntry[]; meta: JarvisMeta }
  send: '/api/w/:ws/focuses/:id/jarvis/messages', // POST { text, windowId, context: JarvisContext } → 202 { entry }   (assertLocalHub)
  stop: '/api/w/:ws/focuses/:id/jarvis/stop', // POST → 204   (assertLocalHub)
  approve: '/api/w/:ws/focuses/:id/jarvis/approvals/:entryId', // POST { approve, windowId, context } → 202; 404 unknown, 409 not pending
  agent: '/api/w/:ws/focuses/:id/jarvis/agent', // PUT { agent } → JarvisMeta   (assertLocalHub)
  stream: '/api/w/:ws/focuses/:id/jarvis/events', // GET SSE: event `entry` (ChatEntry, upsert by id), event `meta` (JarvisMeta)
  tool: '/api/jarvis-tools/:tool', // POST, header JARVIS_TOKEN_HEADER, body = tool args → { text }; 401 unknown token
} as const;

export const JARVIS_TOKEN_HEADER = 'x-strado-jarvis-token';
/** Env var the `strado` MCP server reads; when set it serves only the Jarvis tools. */
export const JARVIS_TOKEN_ENV = 'STRADO_JARVIS_TOKEN';

/** Jarvis-only action: a new worktree from a repo, added to the Focus. Not in
 * ACTIONS (the ⌘K box opens the dialog instead); always an approval. */
export const WORKTREE_CREATE = 'worktree.create';

/** MCP tool name → action id (ACTIONS, or WORKTREE_CREATE). Exactly these are
 * Jarvis's tools: no nav.*, no settings.*. */
export const JARVIS_TOOLS: Readonly<Record<string, string>> = {
  jarvis_open_tab: 'tab.open',
  jarvis_place_tab: 'tab.place',
  jarvis_focus_tab: 'tab.focus',
  jarvis_rename_tab: 'tab.rename',
  jarvis_close_tab: 'tab.close',
  jarvis_interrupt_tab: 'tab.interrupt',
  jarvis_run_in_shell: 'shell.run',
  jarvis_open_browser: 'browser.open',
  jarvis_start_server: 'server.start',
  jarvis_stop_server: 'server.stop',
  jarvis_message_agent: 'agent.message',
  jarvis_ask_agent: 'agent.ask',
  jarvis_steer_agent: 'agent.steer',
  jarvis_interrupt_agent: 'agent.interrupt',
  jarvis_recap: 'agent.recap',
  jarvis_answer_call: 'call.answer',
  jarvis_dismiss_call: 'call.dismiss',
  jarvis_edit_focus: 'focus.edit',
  jarvis_new_worktree: WORKTREE_CREATE,
};

/** Claude's `--allowedTools` names for the tools above. */
export const jarvisAllowedTools = (): string[] => Object.keys(JARVIS_TOOLS).map((t) => `mcp__strado__${t}`);
