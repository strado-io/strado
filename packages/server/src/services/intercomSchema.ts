import { z } from 'zod';

// Every size limit for the intercom lives here so the store and the routes
// cannot drift. Bytes are UTF-8 bytes (Buffer.byteLength), never characters.
export const BODY_MAX = 64 * 1024;
export const CONTEXT_MAX = 256 * 1024;
export const CONTEXT_ITEMS_MAX = 32;
export const IDEMPOTENCY_KEY_MAX = 128;
export const EXPIRES_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const SCOPE_CAP = 10_000;
export const REDELIVERY_AFTER_MS = 5 * 60 * 1000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PULL_DEFAULT = 20;
export const PULL_MAX = 50;
export const UI_LIST_DEFAULT = 50;
export const UI_LIST_MAX = 200;

const utf8Max = (max: number, what: string) => (s: string, ctx: z.RefinementCtx): void => {
  if (Buffer.byteLength(s, 'utf8') > max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${what} exceeds ${max} bytes` });
  }
};

export const ContextItem = z.object({
  kind: z.enum(['text', 'file', 'url', 'reference']),
  value: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const Context = z
  .array(ContextItem)
  .max(CONTEXT_ITEMS_MAX)
  .superRefine((items, ctx) => utf8Max(CONTEXT_MAX, 'context')(JSON.stringify(items), ctx));

export const MessageKind = z.enum(['message', 'request', 'reply']);
export type MessageKind = z.infer<typeof MessageKind>;

// Unknown keys (e.g. a `from`) are stripped, never honoured: identity comes
// from the bearer token in the route.
export const SendBody = z
  .object({
    to: z.string().min(1).max(256),
    kind: MessageKind.default('message'),
    replyTo: z.string().min(1).max(64).optional(),
    body: z.string().min(1).superRefine(utf8Max(BODY_MAX, 'body')),
    context: Context.default([]),
    idempotencyKey: z.string().min(1).max(IDEMPOTENCY_KEY_MAX).optional(),
    expiresInMs: z.number().int().min(0).max(EXPIRES_MAX_MS).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'reply' && !v.replyTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replyTo'], message: 'replyTo is required for a reply' });
    }
    if (v.kind !== 'reply' && v.replyTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replyTo'], message: 'replyTo is only allowed on a reply' });
    }
  });
export type SendBody = z.infer<typeof SendBody>;

export const PullBody = z
  .object({ limit: z.number().int().min(1).max(PULL_MAX).default(PULL_DEFAULT) })
  .default({ limit: PULL_DEFAULT });

export const ListQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(UI_LIST_MAX).default(UI_LIST_DEFAULT),
});

// Hook delivery (step 4): how many candidates one prompt may consider and how
// many UTF-8 bytes the whole injected block may occupy.
export const HOOK_PULL_LIMIT = 10;
export const HOOK_CONTEXT_BUDGET = 32 * 1024;

export const HookEvent = z.enum(['SessionStart', 'UserPromptSubmit', 'Stop']);
export type HookEvent = z.infer<typeof HookEvent>;
export const HookBody = z.object({
  event: HookEvent,
  transport: z.enum(['port', 'socket']).default('port'),
});
export const ConfirmBody = z.object({ batchId: z.string().min(1).max(64) });

// Turn diary (step 4b): per-turn excerpt caps, retention and listing.
export const TURN_PROMPT_MAX = 6 * 1024;
export const TURN_REPLY_MAX = 12 * 1024;
export const TURNS_PER_AGENT = 50;
export const TURNS_PER_REFRESH_MAX = 50;
export const TURN_SETTLE_MS = 2000;
export const DIARY_LIST_DEFAULT = 10;
export const DIARY_LIST_MAX = 50;

export const DiaryQuery = z.object({
  agent: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(DIARY_LIST_MAX).default(DIARY_LIST_DEFAULT),
  before: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
});
export type DiaryQuery = z.infer<typeof DiaryQuery>;

// Push delivery (step 5): quiet windows before a nudge is written into an idle
// Claude tab, and the server-wide kill switch.
export const PUSH_INPUT_QUIET_MS = 5000;
export const PUSH_OUTPUT_QUIET_MS = 1000;
export const PUSH_OUTPUT_RETRY_MS = 1000;
/** A push skipped at a quiet gate is retried at this cadence… */
export const PUSH_RETRY_MS = 5_000;
/** …this many times (about a minute) before the pusher gives up until the next trigger. */
export const PUSH_RETRY_MAX = 12;
/** A hook-less harness (Codex, OpenCode, Pi) marked `working` whose PTY has printed
 * nothing for this long is at its prompt: a slash command or an interrupted turn
 * never produces the turn-complete post that would have cleared the mark. */
export const WORKING_STALE_OUTPUT_MS = 20_000;
// Claude's input box can treat a single burst ending in `\r` as a paste and
// leave it unsubmitted; writing Enter as a second, later write avoids that.
export const PUSH_ENTER_DELAY_MS = 150;
export const PUSH_ENV = 'STRADO_INTERCOM_PUSH';

// Shell adapters (step 6): an agent runs a command in a peer shell tab and
// gets the output back once the shell echoes the run's completion sentinel, or
// a prefix of it at the cap. The keystroke gate reuses the push value on
// purpose: "the user is typing" means the same thing for both.
// The per-run completion sentinel is RUN_MARKER_PREFIX + 8 hex chars + '__',
// appended to the command as `; echo <sentinel>` so the target shell echoes it
// on its own line once the command is done.
export const RUN_MARKER_PREFIX = '__strado_done_';
export const RUN_TIMEOUT_MS = 15000;
export const RUN_TIMEOUT_MIN_MS = 1000;
export const RUN_TIMEOUT_MAX_MS = 60000;
export const RUN_INPUT_QUIET_MS = PUSH_INPUT_QUIET_MS;
export const RUN_COMMAND_MAX = 4096;
export const RUN_OUTPUT_MAX = 64 * 1024;
export const RUN_TRUNCATED_MARKER = '…[truncated]\n';
export const READ_LINES_DEFAULT = 40;
export const READ_LINES_MAX = 400;
export const SHELL_RUN_ENV = 'STRADO_INTERCOM_SHELL_RUN';

export const RunBody = z.object({
  target: z.string().min(1).max(256),
  // One line only: a newline would submit a second command the caller never named.
  command: z.string().min(1).superRefine(utf8Max(RUN_COMMAND_MAX, 'command')).refine((s) => !/[\r\n]/.test(s), { message: 'command must be a single line' }),
  timeoutMs: z.number().int().optional(),
});
export type RunBody = z.infer<typeof RunBody>;

export const ReadQuery = z.object({
  lines: z.coerce.number().int().min(1).optional(),
});
export type ReadQuery = z.infer<typeof ReadQuery>;

// Step 8: shared tasks + escalation.
export const HUMAN_AGENT_ID = 'human';
export const TASKS_ENV = 'STRADO_INTERCOM_TASKS';
export const TASK_TITLE_MAX = 200;
export const TASK_BODY_MAX = 16 * 1024;
export const TASK_DEPS_MAX = 16;
export const TASK_OPEN_CAP = 5000;
export const TASK_LIST_DEFAULT = 50;
export const TASK_LIST_MAX = 200;
export const TICKET_KEY_MAX = 64;
export const ESCALATION_TITLE_MAX = 200;
export const ESCALATION_BODY_MAX = 16 * 1024;
export const ESCALATION_LIST_DEFAULT = 50;
export const ESCALATION_LIST_MAX = 200;
export const ASK_TIMEOUT_MS = 120_000;
export const ASK_TIMEOUT_MIN_MS = 5_000;
export const ASK_TIMEOUT_MAX_MS = 600_000;
export const ASK_POLL_MS = 2000;

export const TaskStatus = z.enum(['open', 'claimed', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;
const TaskId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const TaskCreateBody = z.object({
  title: z.string().min(1).max(TASK_TITLE_MAX),
  body: z.string().superRefine(utf8Max(TASK_BODY_MAX, 'body')).default(''),
  ticketKey: z.string().min(1).max(TICKET_KEY_MAX).optional(),
  dependsOn: z.array(TaskId).max(TASK_DEPS_MAX).default([]),
  worktreePath: z.string().min(1).max(4096).optional(),
});
export type TaskCreateBody = z.infer<typeof TaskCreateBody>;
export const TaskListQuery = z.object({
  status: TaskStatus.optional(),
  mine: z.enum(['1', '0']).optional(),
  limit: z.coerce.number().int().min(1).max(TASK_LIST_MAX).optional(),
});
export const TaskAssignBody = z.object({ agent: z.string().min(1).max(256) });

export const EscalationStatus = z.enum(['open', 'resolved', 'dismissed']);
export type EscalationStatus = z.infer<typeof EscalationStatus>;
export const EscalationCreateBody = z
  .object({
    title: z.string().min(1).max(ESCALATION_TITLE_MAX),
    body: z.string().min(1).superRefine(utf8Max(ESCALATION_BODY_MAX, 'body')),
    context: Context.default([]),
    taskId: TaskId.optional(),
    to: z.string().min(1).max(256).optional(),
    timeoutMs: z.number().int().min(ASK_TIMEOUT_MIN_MS).max(ASK_TIMEOUT_MAX_MS).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.timeoutMs !== undefined && v.to === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timeoutMs'], message: 'timeoutMs is only allowed with a peer `to`' });
    }
  });
export type EscalationCreateBody = z.infer<typeof EscalationCreateBody>;
export const EscalationResolveBody = z.object({
  resolution: z.string().min(1).superRefine(utf8Max(ESCALATION_BODY_MAX, 'resolution')),
});
export const EscalationListQuery = z.object({
  status: EscalationStatus.optional(),
  limit: z.coerce.number().int().min(1).max(ESCALATION_LIST_MAX).optional(),
});

// Step 9a: cross-agent fork. A source agent hands its working context to a
// peer (or to a freshly spawned tab) as one packaged `request`; `strado` is the
// synthetic sender the server uses for the summary ask and the hand-over.
export const STRADO_SENDER_ID = 'strado';
export const FORK_SUMMARY_TIMEOUT_MS = 60_000;
export const FORK_SUMMARY_MAX = 4096;
export const FORK_NOTES_MAX = 4096;
export const FORK_PACKAGE_MAX = 32 * 1024;
export const FORK_TURNS = 6;
export const FORK_TURN_PROMPT_MAX = 2048;
export const FORK_TURN_REPLY_MAX = 4096;
export const FORK_DIARY_TURNS = 12;
export const FORK_LIST_DEFAULT = 50;
export const FORK_LIST_MAX = 200;
export const FORK_NUDGE = 'A fork hand-over is waiting in your Strado inbox: call intercom_inbox, then continue the work.';

export const ForkStatus = z.enum(['summarising', 'queued', 'delivered', 'accepted', 'failed', 'cancelled']);
export type ForkStatus = z.infer<typeof ForkStatus>;
export const AgentModeEnum = z.enum(['claude', 'codex', 'opencode', 'pi']);
export const ForkCreateBody = z
  .object({
    to: z.string().min(1).max(256).optional(),
    newTab: z.object({ mode: AgentModeEnum, worktreePath: z.string().min(1).max(4096).optional() }).optional(),
    notes: z.string().superRefine(utf8Max(FORK_NOTES_MAX, 'notes')).default(''),
    taskId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
    source: z.string().min(1).max(256).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.to === undefined) === (v.newTab === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'exactly one of to / newTab is required' });
    }
  });
export type ForkCreateBody = z.infer<typeof ForkCreateBody>;
export const ForkListQuery = z.object({
  status: ForkStatus.optional(),
  limit: z.coerce.number().int().min(1).max(FORK_LIST_MAX).optional(),
});
