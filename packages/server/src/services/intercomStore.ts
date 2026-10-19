import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { AppError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import {
  ASK_TIMEOUT_MAX_MS, ASK_TIMEOUT_MIN_MS, ASK_TIMEOUT_MS, BODY_MAX, CONTEXT_ITEMS_MAX, CONTEXT_MAX, Context,
  ESCALATION_BODY_MAX, ESCALATION_LIST_DEFAULT, ESCALATION_LIST_MAX, ESCALATION_TITLE_MAX, EXPIRES_MAX_MS,
  HUMAN_AGENT_ID, PULL_DEFAULT, PULL_MAX,
  REDELIVERY_AFTER_MS, RETENTION_MS, SCOPE_CAP, TASK_DEPS_MAX, TASK_LIST_DEFAULT, TASK_LIST_MAX, TASK_OPEN_CAP,
  TASK_TITLE_MAX, TASK_BODY_MAX, TURNS_PER_AGENT, UI_LIST_DEFAULT, UI_LIST_MAX,
  type ContextItem, type EscalationStatus, type MessageKind,
} from './intercomSchema.js';

export const SCHEMA_VERSION = 5;
export const INTERCOM_CHANNEL = 'intercom';

export type Actor = { agentId: string; executionId: string };
export const HUMAN: Actor = { agentId: HUMAN_AGENT_ID, executionId: HUMAN_AGENT_ID };
export type TaskStatus = 'open' | 'claimed' | 'done' | 'cancelled';
export type Task = {
  id: string;
  scopeId: string;
  title: string;
  body: string;
  ticketKey: string | null;
  worktreePath: string | null;
  dependsOn: string[];
  status: TaskStatus;
  createdBy: Actor;
  claimedBy: Actor | null;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  doneAt: number | null;
};
export type TaskInput = {
  scopeId: string;
  by: Actor;
  title: string;
  body?: string;
  ticketKey?: string | null;
  dependsOn?: string[];
  worktreePath?: string | null;
};

export type Escalation = {
  id: string;
  scopeId: string;
  from: Actor;
  /** The human (`HUMAN_AGENT_ID`) or a peer agent id. */
  to: string;
  title: string;
  body: string;
  context: ContextItem[];
  taskId: string | null;
  status: EscalationStatus;
  resolution: string | null;
  resolvedBy: string | null;
  /** The `request` delivered to a peer target; null for a human escalation. */
  askMessageId: string | null;
  /** The message that carried the resolution back to the asker. */
  replyMessageId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  /** When a peer ask gets retargeted to the human; null once it is human-bound. */
  expiresAt: number | null;
};
export type EscalationInput = {
  scopeId: string;
  from: Actor;
  to: string;
  title: string;
  body: string;
  context: ContextItem[];
  taskId?: string | null;
  timeoutMs?: number | null;
};

export type MessageState = 'queued' | 'delivered' | 'acknowledged' | 'expired';

export type Receipt = {
  id: string;
  state: MessageState;
  createdAt: number;
  expiresAt: number | null;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
  deliveryCount: number;
  confirmedAt: number | null;
  /** Set on a `request` once its reply exists. */
  replyId: string | null;
};

export type Message = {
  id: string;
  scopeId: string;
  from: { agentId: string; executionId: string };
  to: string;
  kind: MessageKind;
  replyTo: string | null;
  body: string;
  context: ContextItem[];
  state: MessageState;
  createdAt: number;
  expiresAt: number | null;
  deliveryCount: number;
  /** True when a pull hands back a message that was delivered before and never acknowledged. */
  redelivery: boolean;
  batchId: string | null;
  confirmed: boolean;
  /** Set when this message was sent as part of an escalation (an ask or its reply). */
  escalationId: string | null;
};

export type SendInput = {
  scopeId: string;
  fromAgentId: string;
  fromExecutionId: string;
  toAgentId: string;
  kind: MessageKind;
  replyTo?: string | null;
  body: string;
  context: ContextItem[];
  idempotencyKey?: string | null;
  expiresInMs?: number | null;
  escalationId?: string | null;
};

export type SendResult = { receipt: Receipt; replayed: boolean };

export type PullResult = { batchId: string | null; messages: Message[] };

/** A message with the sender's current alias joined by the route layer. */
export type MessageWithAlias = Omit<Message, 'from'> & { from: Message['from'] & { alias: string | null } };

export type Turn = {
  id: string;
  scopeId: string;
  agentId: string;
  providerSessionId: string;
  turnIndex: number;
  prompt: string;
  promptTruncated: boolean;
  reply: string;
  replyTruncated: boolean;
  startedAt: number;
  endedAt: number;
  recordedAt: number;
};
export type TurnInput = Omit<Turn, 'id' | 'scopeId' | 'agentId' | 'providerSessionId' | 'recordedAt'>;
export type RecordTurnsResult = { inserted: string[]; updated: string[] };

export type SweepResult = {
  expired: number;
  deleted: number;
  turnsDeleted: number;
  tasksDeleted: number;
  escalationsDeleted: number;
  escalationsRetargeted: number;
};

export type IntercomStore = {
  /** Queue a message. Idempotent per (scope, sender, idempotencyKey). */
  send(input: SendInput): SendResult;
  /** State of one message, visible to its sender and recipient only. */
  receipt(scopeId: string, agentId: string, id: string): Receipt;
  /** Hand the caller its queued messages (now delivered) plus redeliveries, oldest first, as one delivery batch. */
  pull(scopeId: string, agentId: string, executionId: string, limit?: number): PullResult;
  /** The oldest deliverable rows (queued + redeliverable), oldest first, redeliveries flagged. Read-only, no events. */
  peek(scopeId: string, agentId: string, limit: number): Message[];
  /** Atomically deliver exactly these ids (those still claimable) as one batch. Rows another pull took are simply absent. */
  claim(scopeId: string, agentId: string, executionId: string, ids: string[]): PullResult;
  /** Mark a batch as handed to the agent. Only this agent's + execution's unconfirmed delivered rows; returns the count. */
  confirm(scopeId: string, agentId: string, executionId: string, batchId: string): number;
  /** Acknowledge every confirmed, delivered row this execution received. Returns the count. */
  ackAll(scopeId: string, agentId: string, executionId: string): number;
  /** Recipient marks a message handled. queued|delivered → acknowledged; idempotent. */
  ack(scopeId: string, agentId: string, id: string): Receipt;
  /** Read-only view of a workspace's traffic for the UI, newest first, every state. */
  /** `agent`: only messages that agent sent or received (one station's line). */
  listScope(scopeId: string, opts?: { since?: number; limit?: number; agent?: string }): Message[];
  /** Upsert one conversation's turns. New turn_index → insert; existing with a different reply → update reply/reply_truncated/ended_at; identical → untouched. */
  recordTurns(scopeId: string, agentId: string, providerSessionId: string, turns: TurnInput[]): RecordTurnsResult;
  /** Newest first: recorded_at, then turn_index, then id. `before` is an exclusive cursor (a turn id); unknown or foreign → []. */
  listTurns(scopeId: string, agentId: string, opts: { limit: number; before?: string }): Turn[];
  /** Expire overdue queued rows (with events), delete acknowledged/expired rows older than 7 days, and trim turns to TURNS_PER_AGENT and 7 days. */
  sweep(): SweepResult;
  /** Create a shared task. Rejects with BACKPRESSURE past the scope's open-task cap. */
  createTask(input: TaskInput): Task;
  /** Scope-bound lookup; NOT_FOUND outside the scope or unknown. */
  getTask(scopeId: string, id: string): Task;
  /** Open first, then claimed, then closed; newest first within each group. */
  listTasks(scopeId: string, opts?: { status?: TaskStatus; claimedBy?: string; limit?: number }): Task[];
  /** Claim an open task with no unfinished dependency, binding the claim to this execution. */
  claimTask(scopeId: string, id: string, by: Actor): Task;
  /** Human-only reassignment: releases any existing claim first. CONFLICT not_open if done/cancelled. */
  assignTask(scopeId: string, id: string, to: Actor): Task;
  /** Only the claimer or the human may release a claimed task back to open. */
  releaseTask(scopeId: string, id: string, by: Actor): Task;
  /** Only the claimer or the human may finish a claimed task. */
  doneTask(scopeId: string, id: string, by: Actor): Task;
  /** Cancel a task; idempotent once cancelled, CONFLICT already_done once done. */
  cancelTask(scopeId: string, id: string): Task;
  /** Release every claim held by a vanished execution, across every scope. */
  releaseClaimsOf(executionId: string): Task[];
  /** Open an escalation. A peer target also gets the question as a tagged `request`; the human gets none. */
  createEscalation(input: EscalationInput): Escalation;
  /** Scope-bound lookup; NOT_FOUND outside the scope or unknown. */
  getEscalation(scopeId: string, id: string): Escalation;
  /** Open first, then closed; newest first within each group. */
  listEscalations(scopeId: string, opts?: { status?: EscalationStatus; limit?: number }): Escalation[];
  /** Answer an escalation, sending exactly one message to the asker. Idempotent once resolved; CONFLICT not_open once dismissed. */
  resolveEscalation(scopeId: string, id: string, by: Actor, resolution: string): Escalation;
  /** Drop an open escalation unanswered; idempotent. */
  dismissEscalation(scopeId: string, id: string): Escalation;
  /** Move an open peer ask to the human; no-op once human-bound or closed. */
  retargetEscalation(scopeId: string, id: string): Escalation;
  /** Move this workspace's open asks addressed to a departed agent to the human. */
  retargetOpenAsksTo(scopeId: string, agentId: string): Escalation[];
  /** Scope-bound lookup that also retargets an overdue peer ask first, using
   * the store's own clock — for an asker polling its own question between
   * hourly sweeps. When `askerAgentId` is the asker and the row is resolved,
   * the reply copy in the asker's inbox is acknowledged: the poll itself
   * handed the answer over, so the inbox must not deliver (and nudge) it twice. */
  pollEscalation(scopeId: string, id: string, askerAgentId?: string): Escalation;
  close(): void;
};

export type IntercomStoreOptions = {
  file: string;
  bus: EventBus;
  now?: () => number;
  /** Test seam; production uses SCOPE_CAP. */
  scopeCap?: number;
  /** Test seam; production uses TASK_OPEN_CAP. */
  taskOpenCap?: number;
  /** Test seam; production uses TASK_OPEN_CAP (escalations intentionally
   * share the task cap in production, but a test that lowers one must not
   * silently lower the other). */
  escalationOpenCap?: number;
};

type Row = {
  id: string;
  scope_id: string;
  from_agent_id: string;
  from_execution_id: string;
  to_agent_id: string;
  kind: MessageKind;
  reply_to: string | null;
  body: string;
  context_json: string;
  idempotency_key: string | null;
  content_hash: string;
  state: MessageState;
  created_at: number;
  expires_at: number | null;
  delivered_at: number | null;
  acknowledged_at: number | null;
  delivery_count: number;
  delivery_batch: string | null;
  delivered_to_execution: string | null;
  delivery_confirmed_at: number | null;
  escalation_id: string | null;
};

type TaskRow = {
  id: string;
  scope_id: string;
  title: string;
  body: string;
  ticket_key: string | null;
  worktree_path: string | null;
  depends_on: string;
  status: TaskStatus;
  created_by_agent: string;
  created_by_execution: string;
  claimed_by_agent: string | null;
  claimed_by_execution: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  done_at: number | null;
};

type EscalationRow = {
  id: string;
  scope_id: string;
  from_agent: string;
  from_execution: string;
  to_agent: string;
  title: string;
  body: string;
  context_json: string;
  task_id: string | null;
  status: EscalationStatus;
  resolution: string | null;
  resolved_by: string | null;
  ask_message_id: string | null;
  reply_message_id: string | null;
  created_at: number;
  resolved_at: number | null;
  expires_at: number | null;
};

const toEscalation = (r: EscalationRow): Escalation => ({
  id: r.id, scopeId: r.scope_id, from: { agentId: r.from_agent, executionId: r.from_execution }, to: r.to_agent, title: r.title, body: r.body,
  context: JSON.parse(r.context_json) as ContextItem[], taskId: r.task_id, status: r.status, resolution: r.resolution, resolvedBy: r.resolved_by,
  askMessageId: r.ask_message_id, replyMessageId: r.reply_message_id, createdAt: r.created_at, resolvedAt: r.resolved_at, expiresAt: r.expires_at,
});

type TurnRow = {
  id: string;
  scope_id: string;
  agent_id: string;
  provider_session_id: string;
  turn_index: number;
  prompt: string;
  prompt_truncated: number;
  reply: string;
  reply_truncated: number;
  started_at: number;
  ended_at: number;
  recorded_at: number;
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char Crockford base32 id: 10 chars of ms timestamp (time-ordered) + 16 chars from 80 random bits. */
export function newMessageId(now: number, random: Buffer = randomBytes(10)): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let out = time;
  let acc = 0;
  let bits = 0;
  for (const byte of random.subarray(0, 10)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  return out.slice(0, 26);
}

const MESSAGES_DDL = `
CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  from_agent_id     TEXT NOT NULL,
  from_execution_id TEXT NOT NULL,
  to_agent_id       TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('message','request','reply')),
  reply_to          TEXT REFERENCES messages(id) ON DELETE SET NULL,
  body              TEXT NOT NULL,
  context_json      TEXT NOT NULL DEFAULT '[]',
  idempotency_key   TEXT,
  content_hash      TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','delivered','acknowledged','expired')),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER,
  delivered_at      INTEGER,
  acknowledged_at   INTEGER,
  delivery_count    INTEGER NOT NULL DEFAULT 0,
  delivery_batch    TEXT,
  delivered_to_execution TEXT,
  delivery_confirmed_at  INTEGER
);
CREATE UNIQUE INDEX messages_idem ON messages (scope_id, from_agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_inbox ON messages (scope_id, to_agent_id, state, created_at);
CREATE INDEX messages_pressure ON messages (scope_id, state);
CREATE UNIQUE INDEX messages_one_reply ON messages (reply_to) WHERE kind = 'reply';
CREATE INDEX messages_scope_time ON messages (scope_id, created_at);
CREATE INDEX messages_batch ON messages (delivery_batch);
`;

const MIGRATE_1_TO_2 = `
ALTER TABLE messages ADD COLUMN delivery_batch TEXT;
ALTER TABLE messages ADD COLUMN delivered_to_execution TEXT;
ALTER TABLE messages ADD COLUMN delivery_confirmed_at INTEGER;
CREATE INDEX messages_batch ON messages (delivery_batch);
`;

const TURNS_DDL = `
CREATE TABLE turns (
  id                  TEXT PRIMARY KEY,
  scope_id            TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  turn_index          INTEGER NOT NULL,
  prompt              TEXT NOT NULL,
  prompt_truncated    INTEGER NOT NULL DEFAULT 0,
  reply               TEXT NOT NULL,
  reply_truncated     INTEGER NOT NULL DEFAULT 0,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER NOT NULL,
  recorded_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX turns_identity ON turns (agent_id, provider_session_id, turn_index);
CREATE INDEX turns_list ON turns (scope_id, agent_id, recorded_at DESC, turn_index DESC, id DESC);
`;

const TASKS_DDL = `
CREATE TABLE tasks (
  id                    TEXT PRIMARY KEY,
  scope_id              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL DEFAULT '',
  ticket_key            TEXT,
  worktree_path         TEXT,
  depends_on            TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL CHECK (status IN ('open','claimed','done','cancelled')),
  created_by_agent      TEXT NOT NULL,
  created_by_execution  TEXT NOT NULL,
  claimed_by_agent      TEXT,
  claimed_by_execution  TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  claimed_at            INTEGER,
  done_at               INTEGER
);
CREATE INDEX tasks_scope_status ON tasks (scope_id, status, created_at DESC);
CREATE INDEX tasks_claimed_execution ON tasks (claimed_by_execution) WHERE claimed_by_execution IS NOT NULL;
`;
const ESCALATIONS_DDL = `
CREATE TABLE escalations (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  from_agent        TEXT NOT NULL,
  from_execution    TEXT NOT NULL,
  to_agent          TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  context_json      TEXT NOT NULL DEFAULT '[]',
  task_id           TEXT,
  status            TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  resolution        TEXT,
  resolved_by       TEXT,
  ask_message_id    TEXT,
  reply_message_id  TEXT,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  expires_at        INTEGER
);
CREATE INDEX escalations_scope_status ON escalations (scope_id, status, created_at DESC);
CREATE INDEX escalations_ask ON escalations (ask_message_id) WHERE ask_message_id IS NOT NULL;
CREATE INDEX escalations_expiry ON escalations (expires_at) WHERE expires_at IS NOT NULL;
`;
const MESSAGES_ADD_ESCALATION = `ALTER TABLE messages ADD COLUMN escalation_id TEXT;`;
// Schema v5 belonged to the removed intercom fork feature. Nothing reads or
// writes `forks` or `messages.fork_id` any more, but both are still created so
// the schema at user_version 5 stays identical for every build: an older build
// opening a store this one created prepares statements against them, and a
// v5 store must never be missing a table it expects.
const FORKS_DDL = `
CREATE TABLE forks (
  id                 TEXT PRIMARY KEY,
  scope_id           TEXT NOT NULL,
  from_agent         TEXT NOT NULL,
  from_execution     TEXT NOT NULL,
  source_agent       TEXT NOT NULL,
  source_worktree    TEXT NOT NULL,
  source_mode        TEXT NOT NULL,
  source_session     TEXT NOT NULL,
  target_kind        TEXT NOT NULL CHECK (target_kind IN ('peer','new')),
  target_agent       TEXT,
  target_mode        TEXT,
  target_worktree    TEXT,
  notes              TEXT NOT NULL DEFAULT '',
  task_id            TEXT,
  summary_source     TEXT,
  summary            TEXT,
  status             TEXT NOT NULL CHECK (status IN ('summarising','queued','delivered','accepted','failed','cancelled')),
  summary_message_id TEXT,
  message_id         TEXT,
  package_bytes      INTEGER,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  summary_deadline   INTEGER,
  delivered_at       INTEGER,
  accepted_at        INTEGER
);
CREATE INDEX forks_scope_status ON forks (scope_id, status, created_at DESC);
CREATE INDEX forks_summary_msg ON forks (summary_message_id) WHERE summary_message_id IS NOT NULL;
CREATE INDEX forks_msg ON forks (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX forks_deadline ON forks (summary_deadline) WHERE summary_deadline IS NOT NULL;
`;
const MESSAGES_ADD_FORK = `ALTER TABLE messages ADD COLUMN fork_id TEXT;`;

const DDL = MESSAGES_DDL + MESSAGES_ADD_ESCALATION + MESSAGES_ADD_FORK + TURNS_DDL + TASKS_DDL + ESCALATIONS_DDL + FORKS_DDL;
const MIGRATE_2_TO_3 = TURNS_DDL;
const MIGRATE_3_TO_4 = TASKS_DDL + ESCALATIONS_DDL;
const MIGRATE_4_TO_5 = FORKS_DDL;

/** `table` is always a module-private literal below, never caller input: PRAGMA
 * cannot take a bound parameter. */
const hasColumn = (db: DatabaseSync, table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

function migrate(db: DatabaseSync): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version >= SCHEMA_VERSION) return;
  // Wrapped in its own transaction (not the store's `tx` helper — that
  // closes over prepared statements that don't exist yet): a crash between
  // the DDL and the user_version bump must not leave user_version at 0 with
  // the tables already created, which would make every future open fail on
  // "table messages already exists" and permanently brick the store.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (user_version === 0) db.exec(DDL);
    else {
      if (user_version === 1) db.exec(MIGRATE_1_TO_2);
      if (user_version <= 2) db.exec(MIGRATE_2_TO_3);
      // Idempotent column adds: a store whose tables were dropped but whose
      // messages columns survived (SQLite < 3.35 cannot drop columns) must
      // still open.
      if (user_version <= 3) {
        db.exec(MIGRATE_3_TO_4);
        if (!hasColumn(db, 'messages', 'escalation_id')) db.exec(MESSAGES_ADD_ESCALATION);
      }
      if (user_version <= 4) {
        db.exec(MIGRATE_4_TO_5);
        if (!hasColumn(db, 'messages', 'fork_id')) db.exec(MESSAGES_ADD_FORK);
      }
    }
    // PRAGMA cannot take a bound parameter; SCHEMA_VERSION is a module constant.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function validate(input: SendInput, contextJson: string): void {
  const bad = (m: string) => new AppError('VALIDATION', m);
  if (input.body.length === 0) throw bad('body is empty');
  if (Buffer.byteLength(input.body, 'utf8') > BODY_MAX) throw bad(`body exceeds ${BODY_MAX} bytes`);
  if (input.context.length > CONTEXT_ITEMS_MAX) throw bad(`more than ${CONTEXT_ITEMS_MAX} context items`);
  if (Buffer.byteLength(contextJson, 'utf8') > CONTEXT_MAX) throw bad(`context exceeds ${CONTEXT_MAX} bytes`);
  // The route validates context shape via the same schema, but the store is
  // called directly by tests and must not trust an already-serialized input.
  const parsed = Context.safeParse(input.context);
  if (!parsed.success) throw bad('invalid context items');
  const exp = input.expiresInMs ?? 0;
  if (!Number.isInteger(exp) || exp < 0 || exp > EXPIRES_MAX_MS) throw bad('expiresInMs out of range');
  if (input.kind === 'reply' && !input.replyTo) throw bad('replyTo is required for a reply');
  if (input.kind !== 'reply' && input.replyTo) throw bad('replyTo is only allowed on a reply');
  if (input.toAgentId === input.fromAgentId) throw bad('cannot send a message to yourself');
}

const contentHash = (input: SendInput, contextJson: string): string =>
  createHash('sha256')
    .update(JSON.stringify([input.toAgentId, input.kind, input.replyTo ?? null, input.body, contextJson]))
    .digest('hex');

export async function createIntercomStore(opts: IntercomStoreOptions): Promise<IntercomStore> {
  // Loaded via createRequire rather than `import('node:sqlite')`: on a Node
  // without node:sqlite only this call throws, not the module load — app.ts
  // imports this file statically and falls back to the disabled store.
  // createRequire delegates straight to Node's native loader, which also
  // sidesteps a real bug in this project's installed vite-node: its builtin
  // allowlist predates node:sqlite, so under vitest a dynamic `import()` of
  // it (literal or computed) is mis-resolved as the bare package "sqlite"
  // and fails even when node:sqlite is present.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  const db = new DatabaseSync(opts.file);
  // Must run before the WAL pragma below: SQLite creates the -wal and -shm
  // sidecar files with the database file's current mode, so chmod'ing the
  // main file after WAL mode is on leaves message bodies world-readable in
  // those sidecars until the next restart.
  fs.chmodSync(opts.file, 0o600);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  const now = opts.now ?? Date.now;
  const scopeCap = opts.scopeCap ?? SCOPE_CAP;

  const stmts = {
    byId: db.prepare('SELECT * FROM messages WHERE id = ?'),
    byIdem: db.prepare('SELECT * FROM messages WHERE scope_id = ? AND from_agent_id = ? AND idempotency_key = ?'),
    replyOf: db.prepare("SELECT id FROM messages WHERE reply_to = ? AND kind = 'reply'"),
    // A row past its expiresAt is dead weight until the next sweep flips it;
    // it must not hold the scope at its cap in the meantime.
    pressure: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE scope_id = ? AND state IN ('queued','delivered') AND (expires_at IS NULL OR expires_at > ?)"),
    insert: db.prepare(`
      INSERT INTO messages (id, scope_id, from_agent_id, from_execution_id, to_agent_id, kind, reply_to, body,
                            context_json, idempotency_key, content_hash, state, created_at, expires_at, escalation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`),
    peekQueued: db.prepare(`
      SELECT * FROM messages
      WHERE scope_id = ? AND to_agent_id = ? AND state = 'queued' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at, id LIMIT ?`),
    peekRedeliver: db.prepare(`
      SELECT * FROM messages
      WHERE scope_id = ? AND to_agent_id = ? AND state = 'delivered' AND delivered_at <= ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at, id LIMIT ?`),
    claimOne: db.prepare(`
      UPDATE messages SET state = 'delivered', delivered_at = ?, delivery_count = delivery_count + 1,
                          delivery_batch = ?, delivered_to_execution = ?, delivery_confirmed_at = NULL
      WHERE id = ? AND scope_id = ? AND to_agent_id = ?
        AND (state = 'queued' OR (state = 'delivered' AND delivered_at <= ?))
        AND (expires_at IS NULL OR expires_at > ?)
      RETURNING *`),
    confirmBatch: db.prepare(`
      UPDATE messages SET delivery_confirmed_at = ?
      WHERE delivery_batch = ? AND scope_id = ? AND to_agent_id = ? AND delivered_to_execution = ?
        AND state = 'delivered' AND delivery_confirmed_at IS NULL
      RETURNING id`),
    ackAll: db.prepare(`
      UPDATE messages SET state = 'acknowledged', acknowledged_at = ?
      WHERE scope_id = ? AND to_agent_id = ? AND delivered_to_execution = ?
        AND state = 'delivered' AND delivery_confirmed_at IS NOT NULL
      RETURNING *`),
    ack: db.prepare("UPDATE messages SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?"),
    listScope: db.prepare('SELECT * FROM messages WHERE scope_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    listScopeAgent: db.prepare('SELECT * FROM messages WHERE scope_id = ? AND created_at >= ? AND (from_agent_id = ? OR to_agent_id = ?) ORDER BY created_at DESC, id DESC LIMIT ?'),
    expire: db.prepare(`
      UPDATE messages SET state = 'expired'
      WHERE state IN ('queued','delivered') AND expires_at IS NOT NULL AND expires_at <= ?
      RETURNING *`),
    purge: db.prepare(`
      DELETE FROM messages
      WHERE (state = 'acknowledged' AND acknowledged_at <= ?) OR (state = 'expired' AND expires_at <= ?)`),
    turnByIdentity: db.prepare('SELECT id, reply FROM turns WHERE agent_id = ? AND provider_session_id = ? AND turn_index = ?'),
    insertTurn: db.prepare(`
      INSERT INTO turns (id, scope_id, agent_id, provider_session_id, turn_index, prompt, prompt_truncated, reply, reply_truncated, started_at, ended_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTurn: db.prepare('UPDATE turns SET reply = ?, reply_truncated = ?, ended_at = ?, scope_id = ? WHERE id = ?'),
    turnById: db.prepare('SELECT * FROM turns WHERE id = ?'),
    listTurns: db.prepare(`
      SELECT * FROM turns WHERE scope_id = ? AND agent_id = ?
      ORDER BY recorded_at DESC, turn_index DESC, id DESC LIMIT ?`),
    listTurnsBefore: db.prepare(`
      SELECT * FROM turns WHERE scope_id = ? AND agent_id = ?
        AND (recorded_at < ? OR (recorded_at = ? AND turn_index < ?) OR (recorded_at = ? AND turn_index = ? AND id < ?))
      ORDER BY recorded_at DESC, turn_index DESC, id DESC LIMIT ?`),
    purgeTurnsOld: db.prepare('DELETE FROM turns WHERE recorded_at < ?'),
    purgeTurnsExcess: db.prepare(`
      DELETE FROM turns WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY scope_id, agent_id ORDER BY recorded_at DESC, turn_index DESC, id DESC) AS rn
          FROM turns
        ) WHERE rn > ?
      )`),
    taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    taskInsert: db.prepare(`INSERT INTO tasks (id, scope_id, title, body, ticket_key, worktree_path, depends_on, status, created_by_agent, created_by_execution, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`),
    taskOpenCount: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE scope_id = ? AND status IN ('open','claimed')"),
    taskStatusOf: db.prepare('SELECT status FROM tasks WHERE id = ? AND scope_id = ?'),
    taskClaim: db.prepare("UPDATE tasks SET status = 'claimed', claimed_by_agent = ?, claimed_by_execution = ?, claimed_at = ?, updated_at = ? WHERE id = ?"),
    taskRelease: db.prepare("UPDATE tasks SET status = 'open', claimed_by_agent = NULL, claimed_by_execution = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?"),
    taskDone: db.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?"),
    taskCancel: db.prepare("UPDATE tasks SET status = 'cancelled', claimed_by_agent = NULL, claimed_by_execution = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?"),
    tasksClaimedBy: db.prepare('SELECT * FROM tasks WHERE claimed_by_execution = ? AND status = \'claimed\''),
    taskList: db.prepare(`SELECT * FROM tasks WHERE scope_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR claimed_by_agent = ?)
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END, created_at DESC, id DESC LIMIT ?`),
    taskPurge: db.prepare("DELETE FROM tasks WHERE status IN ('done','cancelled') AND updated_at <= ?"),
    escById: db.prepare('SELECT * FROM escalations WHERE id = ?'),
    escByAsk: db.prepare("SELECT * FROM escalations WHERE ask_message_id = ? AND status = 'open'"),
    escInsert: db.prepare(`INSERT INTO escalations (id, scope_id, from_agent, from_execution, to_agent, title, body, context_json, task_id, status, ask_message_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`),
    escOpenCount: db.prepare("SELECT COUNT(*) AS n FROM escalations WHERE scope_id = ? AND status = 'open'"),
    escResolve: db.prepare("UPDATE escalations SET status = 'resolved', resolution = ?, resolved_by = ?, reply_message_id = ?, resolved_at = ?, expires_at = NULL WHERE id = ?"),
    escDismiss: db.prepare("UPDATE escalations SET status = 'dismissed', resolved_by = 'human', resolved_at = ?, expires_at = NULL WHERE id = ?"),
    escRetarget: db.prepare("UPDATE escalations SET to_agent = 'human', expires_at = NULL WHERE id = ?"),
    escExpired: db.prepare("SELECT * FROM escalations WHERE status = 'open' AND to_agent <> 'human' AND expires_at IS NOT NULL AND expires_at <= ?"),
    escOpenAsksTo: db.prepare("SELECT * FROM escalations WHERE scope_id = ? AND status = 'open' AND to_agent = ? AND to_agent <> 'human'"),
    escList: db.prepare(`SELECT * FROM escalations WHERE scope_id = ? AND (? IS NULL OR status = ?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT ?`),
    escPurge: db.prepare("DELETE FROM escalations WHERE status IN ('resolved','dismissed') AND resolved_at <= ?"),
  } satisfies Record<string, StatementSync>;

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const emit = (type: string, r: Row, extra: Record<string, unknown> = {}): void =>
    opts.bus.emit(INTERCOM_CHANNEL, { type, data: { id: r.id, scopeId: r.scope_id, from: r.from_agent_id, to: r.to_agent_id, ...extra } });

  const emitEsc = (type: string, r: EscalationRow, extra: Record<string, unknown> = {}): void =>
    opts.bus.emit(INTERCOM_CHANNEL, { type, data: { scopeId: r.scope_id, id: r.id, from: r.from_agent, to: r.to_agent, title: r.title, status: r.status, taskId: r.task_id, ...extra } });

  const emitTurn = (type: 'turn.recorded' | 'turn.updated', scopeId: string, agentId: string, turnId: string): void =>
    opts.bus.emit(INTERCOM_CHANNEL, { type, data: { scopeId, agentId, turnId } });

  const toTurn = (r: TurnRow): Turn => ({
    id: r.id,
    scopeId: r.scope_id,
    agentId: r.agent_id,
    providerSessionId: r.provider_session_id,
    turnIndex: r.turn_index,
    prompt: r.prompt,
    promptTruncated: r.prompt_truncated === 1,
    reply: r.reply,
    replyTruncated: r.reply_truncated === 1,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    recordedAt: r.recorded_at,
  });

  const replyIdOf = (r: Row): string | null =>
    r.kind === 'request' ? ((stmts.replyOf.get(r.id) as { id: string } | undefined)?.id ?? null) : null;

  const toReceipt = (r: Row): Receipt => ({
    id: r.id,
    state: r.state,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    deliveredAt: r.delivered_at,
    acknowledgedAt: r.acknowledged_at,
    deliveryCount: r.delivery_count,
    confirmedAt: r.delivery_confirmed_at,
    replyId: replyIdOf(r),
  });

  const toMessage = (r: Row, redelivery: boolean): Message => ({
    id: r.id,
    scopeId: r.scope_id,
    from: { agentId: r.from_agent_id, executionId: r.from_execution_id },
    to: r.to_agent_id,
    kind: r.kind,
    replyTo: r.reply_to,
    body: r.body,
    context: JSON.parse(r.context_json) as ContextItem[],
    state: r.state,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    deliveryCount: r.delivery_count,
    redelivery,
    batchId: r.delivery_batch,
    confirmed: r.delivery_confirmed_at !== null,
    escalationId: r.escalation_id,
  });

  const toTask = (r: TaskRow): Task => ({
    id: r.id, scopeId: r.scope_id, title: r.title, body: r.body, ticketKey: r.ticket_key, worktreePath: r.worktree_path,
    dependsOn: JSON.parse(r.depends_on) as string[], status: r.status,
    createdBy: { agentId: r.created_by_agent, executionId: r.created_by_execution },
    claimedBy: r.claimed_by_agent && r.claimed_by_execution ? { agentId: r.claimed_by_agent, executionId: r.claimed_by_execution } : null,
    createdAt: r.created_at, updatedAt: r.updated_at, claimedAt: r.claimed_at, doneAt: r.done_at,
  });

  /** A row the caller may see: same scope, and caller is sender or recipient. */
  const visible = (scopeId: string, agentId: string, id: string): Row => {
    const r = stmts.byId.get(id) as Row | undefined;
    if (!r || r.scope_id !== scopeId || (r.from_agent_id !== agentId && r.to_agent_id !== agentId)) {
      throw new AppError('NOT_FOUND', `no message "${id}"`);
    }
    return r;
  };

  /**
   * The whole of `send`'s write, callable from inside a transaction another
   * operation already opened (`createEscalation` and `resolveEscalation` insert
   * their message this way, so the message and the escalation row commit or
   * roll back together). Callers own the transaction and the events.
   */
  const insertMessage = (input: SendInput, t: number): { row: Row; replayed: boolean } => {
    const contextJson = JSON.stringify(input.context);
    validate(input, contextJson);
    const hash = contentHash(input, contextJson);
    if (input.idempotencyKey) {
      const prior = stmts.byIdem.get(input.scopeId, input.fromAgentId, input.idempotencyKey) as Row | undefined;
      if (prior) {
        if (prior.content_hash !== hash) throw new AppError('CONFLICT', 'idempotencyKey reused with different content');
        return { row: prior, replayed: true };
      }
    }
    if (input.kind === 'reply') {
      const req = stmts.byId.get(input.replyTo!) as Row | undefined;
      if (
        !req || req.scope_id !== input.scopeId || req.kind !== 'request' ||
        req.to_agent_id !== input.fromAgentId || req.from_agent_id !== input.toAgentId
      ) throw new AppError('CONFLICT', 'replyTo must name a request addressed to you by the recipient');
      if (req.state === 'expired') throw new AppError('CONFLICT', 'the request has expired');
      if (stmts.replyOf.get(req.id)) throw new AppError('CONFLICT', 'the request already has a reply');
    }
    const { n } = stmts.pressure.get(input.scopeId, t) as { n: number };
    if (n >= scopeCap) throw new AppError('BACKPRESSURE', `scope has ${n} unacknowledged messages`);
    const id = newMessageId(t);
    // Omitted means "until retention": a message to an agent that never comes
    // back must not hold the scope's pressure budget forever. 0 means never.
    const expiresIn = input.expiresInMs ?? RETENTION_MS;
    const expiresAt = expiresIn ? t + expiresIn : null;
    stmts.insert.run(
      id, input.scopeId, input.fromAgentId, input.fromExecutionId, input.toAgentId, input.kind,
      input.replyTo ?? null, input.body, contextJson, input.idempotencyKey ?? null, hash, t, expiresAt,
      input.escalationId ?? null,
    );
    return { row: stmts.byId.get(id) as Row, replayed: false };
  };

  const send = (input: SendInput): SendResult => {
    const t = now();
    const { row, replayed, resolved } = tx(() => {
      const { row, replayed } = insertMessage(input, t);
      // An ordinary reply to an escalation's ask *is* the answer: resolve the
      // escalation in the same transaction rather than making the peer call
      // resolveEscalation as well. A retargeted ask no longer names the peer
      // as its target, so a late reply lands as a plain reply and nothing more.
      let resolved: EscalationRow | null = null;
      if (!replayed && input.kind === 'reply') {
        const ask = stmts.escByAsk.get(input.replyTo!) as EscalationRow | undefined;
        if (ask && ask.to_agent === input.fromAgentId) {
          stmts.escResolve.run(input.body, input.fromAgentId, row.id, t, ask.id);
          resolved = stmts.escById.get(ask.id) as EscalationRow;
        }
      }
      return { row, replayed, resolved };
    });
    if (!replayed) emit('message.queued', row, { kind: input.kind, ...(row.reply_to ? { replyTo: row.reply_to } : {}) });
    if (resolved) emitEsc('escalation.resolved', resolved, { resolvedBy: input.fromAgentId });
    return { receipt: toReceipt(row), replayed };
  };

  const receipt = (scopeId: string, agentId: string, id: string): Receipt => toReceipt(visible(scopeId, agentId, id));

  const byCreated = (a: Row, b: Row): number => (a.created_at - b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const peek = (scopeId: string, agentId: string, limit: number): Message[] => {
    const lim = Math.min(Math.max(1, Math.floor(limit)), PULL_MAX);
    const t = now();
    const fresh = (stmts.peekQueued.all(scopeId, agentId, t, lim) as Row[]).map((r) => ({ r, redelivery: false }));
    const redo = (stmts.peekRedeliver.all(scopeId, agentId, t - REDELIVERY_AFTER_MS, t, lim) as Row[]).map((r) => ({ r, redelivery: true }));
    return [...fresh, ...redo]
      .sort((x, y) => byCreated(x.r, y.r))
      .slice(0, lim)
      .map(({ r, redelivery }) => toMessage(r, redelivery));
  };

  /** Deliver the ids `select` names (read inside the same transaction) as one batch. */
  const claimRows = (scopeId: string, agentId: string, executionId: string, select: () => string[]): PullResult => {
    const t = now();
    const batchId = newMessageId(t);
    const rows = tx(() => {
      const out: Row[] = [];
      for (const id of select()) {
        const r = stmts.claimOne.get(t, batchId, executionId, id, scopeId, agentId, t - REDELIVERY_AFTER_MS, t) as Row | undefined;
        if (r) out.push(r);
      }
      return out.sort(byCreated);
    });
    for (const r of rows) emit('message.delivered', r, { redelivery: r.delivery_count > 1 });
    return { batchId: rows.length ? batchId : null, messages: rows.map((r) => toMessage(r, r.delivery_count > 1)) };
  };

  const claim = (scopeId: string, agentId: string, executionId: string, ids: string[]): PullResult =>
    ids.length === 0 ? { batchId: null, messages: [] } : claimRows(scopeId, agentId, executionId, () => ids);

  /** Exactly what peek would hand back, oldest first across fresh and
   * redeliverable rows: serving queued rows first would starve an
   * unacknowledged older message for as long as new ones keep arriving. */
  const pull = (scopeId: string, agentId: string, executionId: string, limit = PULL_DEFAULT): PullResult =>
    claimRows(scopeId, agentId, executionId, () => peek(scopeId, agentId, limit).map((m) => m.id));

  const confirm = (scopeId: string, agentId: string, executionId: string, batchId: string): number =>
    tx(() => (stmts.confirmBatch.all(now(), batchId, scopeId, agentId, executionId) as { id: string }[]).length);

  const ackAll = (scopeId: string, agentId: string, executionId: string): number => {
    const t = now();
    const acked = tx(() => stmts.ackAll.all(t, scopeId, agentId, executionId) as Row[]);
    for (const row of acked) emit('message.acknowledged', row);
    return acked.length;
  };

  const ack = (scopeId: string, agentId: string, id: string): Receipt => {
    const t = now();
    const { row, changed } = tx(() => {
      const r = stmts.byId.get(id) as Row | undefined;
      if (!r || r.scope_id !== scopeId || r.to_agent_id !== agentId) throw new AppError('NOT_FOUND', `no message "${id}"`);
      if (r.state === 'acknowledged') return { row: r, changed: false };
      if (r.state === 'expired') throw new AppError('CONFLICT', 'message has expired');
      stmts.ack.run(t, id);
      return { row: stmts.byId.get(id) as Row, changed: true };
    });
    if (changed) emit('message.acknowledged', row);
    return toReceipt(row);
  };

  const listScope = (scopeId: string, opts: { since?: number; limit?: number; agent?: string } = {}): Message[] => {
    const lim = Math.min(Math.max(1, Math.floor(opts.limit ?? UI_LIST_DEFAULT)), UI_LIST_MAX);
    const rows = opts.agent === undefined
      ? stmts.listScope.all(scopeId, opts.since ?? 0, lim)
      : stmts.listScopeAgent.all(scopeId, opts.since ?? 0, opts.agent, opts.agent, lim);
    return (rows as Row[]).map((r) => toMessage(r, false));
  };

  const recordTurns = (scopeId: string, agentId: string, providerSessionId: string, turns: TurnInput[]): RecordTurnsResult => {
    const t = now();
    const out = tx(() => {
      const inserted: string[] = [];
      const updated: string[] = [];
      for (const turn of turns) {
        const existing = stmts.turnByIdentity.get(agentId, providerSessionId, turn.turnIndex) as { id: string; reply: string } | undefined;
        if (!existing) {
          const id = newMessageId(t);
          stmts.insertTurn.run(
            id, scopeId, agentId, providerSessionId, turn.turnIndex,
            turn.prompt, turn.promptTruncated ? 1 : 0, turn.reply, turn.replyTruncated ? 1 : 0,
            turn.startedAt, turn.endedAt, t,
          );
          inserted.push(id);
        } else if (existing.reply !== turn.reply) {
          // scope_id is refreshed on every update: a tab reconciled as an
          // orphan under scope "default" and later re-scoped must not keep
          // its rows stuck under the identity's original scope.
          stmts.updateTurn.run(turn.reply, turn.replyTruncated ? 1 : 0, turn.endedAt, scopeId, existing.id);
          updated.push(existing.id);
        }
      }
      return { inserted, updated };
    });
    for (const id of out.inserted) emitTurn('turn.recorded', scopeId, agentId, id);
    for (const id of out.updated) emitTurn('turn.updated', scopeId, agentId, id);
    return out;
  };

  const listTurns = (scopeId: string, agentId: string, opts: { limit: number; before?: string }): Turn[] => {
    const lim = Math.max(1, Math.floor(opts.limit));
    if (opts.before === undefined) return (stmts.listTurns.all(scopeId, agentId, lim) as TurnRow[]).map(toTurn);
    const cursor = stmts.turnById.get(opts.before) as TurnRow | undefined;
    if (!cursor || cursor.scope_id !== scopeId || cursor.agent_id !== agentId) return [];
    const { recorded_at: ra, turn_index: ti, id } = cursor;
    return (stmts.listTurnsBefore.all(scopeId, agentId, ra, ra, ti, ra, ti, id, lim) as TurnRow[]).map(toTurn);
  };

  const sweep = (): SweepResult => {
    const t = now();
    const { expiredRows, deleted, turnsDeleted, tasksDeleted, escalationsDeleted, asksBefore, asksAfter } = tx(() => {
      const expiredRows = stmts.expire.all(t) as Row[];
      // Before the purge: an ask nobody answered in time becomes the human's
      // problem, and retargeting leaves it open, so it survives the purge below.
      const asksBefore = stmts.escExpired.all(t) as EscalationRow[];
      const asksAfter = retargetInTx(asksBefore);
      const cutoff = t - RETENTION_MS;
      const deleted = Number(stmts.purge.run(cutoff, cutoff).changes);
      const turnsDeleted = Number(stmts.purgeTurnsOld.run(cutoff).changes) + Number(stmts.purgeTurnsExcess.run(TURNS_PER_AGENT).changes);
      const tasksDeleted = Number(stmts.taskPurge.run(cutoff).changes);
      const escalationsDeleted = Number(stmts.escPurge.run(cutoff).changes);
      return { expiredRows, deleted, turnsDeleted, tasksDeleted, escalationsDeleted, asksBefore, asksAfter };
    });
    for (const r of expiredRows) emit('message.expired', r);
    emitRetargeted(asksBefore, asksAfter);
    return { expired: expiredRows.length, deleted, turnsDeleted, tasksDeleted, escalationsDeleted, escalationsRetargeted: asksAfter.length };
  };

  const taskOpenCap = opts.taskOpenCap ?? TASK_OPEN_CAP;
  const escalationOpenCap = opts.escalationOpenCap ?? TASK_OPEN_CAP;
  const emitTask = (type: string, r: TaskRow, extra: Record<string, unknown> = {}): void =>
    opts.bus.emit(INTERCOM_CHANNEL, { type, data: { scopeId: r.scope_id, id: r.id, status: r.status, title: r.title, claimedBy: r.claimed_by_agent, worktreePath: r.worktree_path, ...extra } });
  const taskRow = (scopeId: string, id: string): TaskRow => {
    const r = stmts.taskById.get(id) as TaskRow | undefined;
    if (!r || r.scope_id !== scopeId) throw new AppError('NOT_FOUND', `no task "${id}"`);
    return r;
  };
  const conflict = (reason: string, message: string): never => { throw new AppError('CONFLICT', message, { reason }); };
  const mayTouchClaim = (r: TaskRow, by: Actor): void => {
    if (by.agentId !== HUMAN_AGENT_ID && r.claimed_by_agent !== by.agentId) throw new AppError('FORBIDDEN', 'only the claimer or the human may change this task');
  };

  const createTask = (input: TaskInput): Task => {
    const title = input.title.trim();
    if (title.length === 0 || title.length > TASK_TITLE_MAX) throw new AppError('VALIDATION', 'title is empty or too long');
    const body = input.body ?? '';
    if (Buffer.byteLength(body, 'utf8') > TASK_BODY_MAX) throw new AppError('VALIDATION', `body exceeds ${TASK_BODY_MAX} bytes`);
    const deps = input.dependsOn ?? [];
    if (deps.length > TASK_DEPS_MAX) throw new AppError('VALIDATION', `more than ${TASK_DEPS_MAX} dependencies`);
    const t = now();
    const row = tx(() => {
      const { n } = stmts.taskOpenCount.get(input.scopeId) as { n: number };
      if (n >= taskOpenCap) throw new AppError('BACKPRESSURE', `scope has ${n} open tasks`);
      const id = newMessageId(t);
      stmts.taskInsert.run(id, input.scopeId, title, body, input.ticketKey ?? null, input.worktreePath ?? null, JSON.stringify(deps), input.by.agentId, input.by.executionId, t, t);
      return stmts.taskById.get(id) as TaskRow;
    });
    emitTask('task.created', row);
    return toTask(row);
  };
  const getTask = (scopeId: string, id: string): Task => toTask(taskRow(scopeId, id));
  const listTasks = (scopeId: string, o: { status?: TaskStatus; claimedBy?: string; limit?: number } = {}): Task[] => {
    const lim = Math.min(Math.max(1, Math.floor(o.limit ?? TASK_LIST_DEFAULT)), TASK_LIST_MAX);
    return (stmts.taskList.all(scopeId, o.status ?? null, o.status ?? null, o.claimedBy ?? null, o.claimedBy ?? null, lim) as TaskRow[]).map(toTask);
  };
  const claimTask = (scopeId: string, id: string, by: Actor): Task => {
    const t = now();
    const row = tx(() => {
      const r = taskRow(scopeId, id);
      if (r.status === 'claimed') conflict('already_claimed', `task is claimed by ${r.claimed_by_agent}`);
      if (r.status !== 'open') conflict('not_open', `task is ${r.status}`);
      for (const dep of JSON.parse(r.depends_on) as string[]) {
        const d = stmts.taskStatusOf.get(dep, scopeId) as { status: TaskStatus } | undefined;
        if (d && d.status !== 'done') conflict('deps_open', `dependency ${dep} is ${d.status}`);
      }
      stmts.taskClaim.run(by.agentId, by.executionId, t, t, id);
      return stmts.taskById.get(id) as TaskRow;
    });
    emitTask('task.claimed', row);
    return toTask(row);
  };
  const assignTask = (scopeId: string, id: string, to: Actor): Task => {
    const t = now();
    const { row, displaced } = tx(() => {
      const r = taskRow(scopeId, id);
      if (r.status === 'done' || r.status === 'cancelled') conflict('not_open', `task is ${r.status}`);
      // Reassigning an already-claimed task releases the previous claim
      // first (spec 1.1): captured before the write so the released event
      // below carries the claimer who lost it, not the new one.
      const displaced = r.status === 'claimed' ? r : null;
      stmts.taskClaim.run(to.agentId, to.executionId, t, t, id);
      return { row: stmts.taskById.get(id) as TaskRow, displaced };
    });
    if (displaced) emitTask('task.released', displaced, { reason: 'reassigned' });
    emitTask('task.assigned', row);
    return toTask(row);
  };
  const releaseTask = (scopeId: string, id: string, by: Actor): Task => {
    const t = now();
    const row = tx(() => {
      const r = taskRow(scopeId, id);
      if (r.status !== 'claimed') conflict('not_claimed', `task is ${r.status}`);
      mayTouchClaim(r, by);
      stmts.taskRelease.run(t, id);
      return stmts.taskById.get(id) as TaskRow;
    });
    emitTask('task.released', row, { reason: by.agentId === HUMAN_AGENT_ID ? 'human' : 'claimer' });
    return toTask(row);
  };
  const doneTask = (scopeId: string, id: string, by: Actor): Task => {
    const t = now();
    const row = tx(() => {
      const r = taskRow(scopeId, id);
      if (r.status !== 'claimed') conflict('not_claimed', `task is ${r.status}`);
      mayTouchClaim(r, by);
      stmts.taskDone.run(t, t, id);
      return stmts.taskById.get(id) as TaskRow;
    });
    emitTask('task.done', row);
    return toTask(row);
  };
  const cancelTask = (scopeId: string, id: string): Task => {
    const t = now();
    const { row, changed } = tx(() => {
      const r = taskRow(scopeId, id);
      if (r.status === 'done') conflict('already_done', 'task is done');
      if (r.status === 'cancelled') return { row: r, changed: false };
      stmts.taskCancel.run(t, id);
      return { row: stmts.taskById.get(id) as TaskRow, changed: true };
    });
    if (changed) emitTask('task.cancelled', row);
    return toTask(row);
  };
  const releaseClaimsOf = (executionId: string): Task[] => {
    const t = now();
    const rows = tx(() => {
      const claimed = stmts.tasksClaimedBy.all(executionId) as TaskRow[];
      for (const r of claimed) stmts.taskRelease.run(t, r.id);
      return claimed.map((r) => stmts.taskById.get(r.id) as TaskRow);
    });
    for (const r of rows) emitTask('task.released', r, { reason: 'execution_gone' });
    return rows.map(toTask);
  };

  const escRow = (scopeId: string, id: string): EscalationRow => {
    const r = stmts.escById.get(id) as EscalationRow | undefined;
    if (!r || r.scope_id !== scopeId) throw new AppError('NOT_FOUND', `no escalation "${id}"`);
    return r;
  };

  /** The retarget writes only; the caller owns the transaction and the events. */
  const retargetInTx = (rows: EscalationRow[]): EscalationRow[] =>
    rows.map((r) => { stmts.escRetarget.run(r.id); return stmts.escById.get(r.id) as EscalationRow; });
  const emitRetargeted = (before: EscalationRow[], after: EscalationRow[]): void => {
    after.forEach((r, i) => emitEsc('escalation.retargeted', r, { previousTo: before[i]!.to_agent }));
  };
  /** Reads the candidate rows fresh inside the same transaction that
   * retargets them, so a read-then-write cannot act on a row that changed
   * between the read and the write. `select` runs inside the transaction. */
  const retargetSelected = (select: () => EscalationRow[]): EscalationRow[] => {
    const { before, after } = tx(() => {
      const before = select();
      return { before, after: retargetInTx(before) };
    });
    emitRetargeted(before, after);
    return after;
  };

  const createEscalation = (input: EscalationInput): Escalation => {
    const title = input.title.trim();
    if (title.length === 0 || title.length > ESCALATION_TITLE_MAX) throw new AppError('VALIDATION', 'title is empty or too long');
    if (input.body.length === 0 || Buffer.byteLength(input.body, 'utf8') > ESCALATION_BODY_MAX) throw new AppError('VALIDATION', 'body is empty or too long');
    if (input.to === HUMAN_AGENT_ID && input.timeoutMs != null) throw new AppError('VALIDATION', 'timeoutMs is only allowed with a peer target');
    const contextJson = JSON.stringify(input.context);
    if (!Context.safeParse(input.context).success || Buffer.byteLength(contextJson, 'utf8') > CONTEXT_MAX) throw new AppError('VALIDATION', 'invalid context');
    const t = now();
    const timeout = input.to === HUMAN_AGENT_ID ? null : Math.min(ASK_TIMEOUT_MAX_MS, Math.max(ASK_TIMEOUT_MIN_MS, input.timeoutMs ?? ASK_TIMEOUT_MS));
    const { row, ask } = tx(() => {
      const { n } = stmts.escOpenCount.get(input.scopeId) as { n: number };
      if (n >= escalationOpenCap) throw new AppError('BACKPRESSURE', `scope has ${n} open escalations`);
      const id = newMessageId(t);
      let askRow: Row | null = null;
      if (input.to !== HUMAN_AGENT_ID) {
        askRow = insertMessage({
          scopeId: input.scopeId, fromAgentId: input.from.agentId, fromExecutionId: input.from.executionId,
          toAgentId: input.to, kind: 'request', body: input.body, context: input.context, escalationId: id, expiresInMs: null,
        }, t).row;
      }
      stmts.escInsert.run(id, input.scopeId, input.from.agentId, input.from.executionId, input.to, title, input.body, contextJson, input.taskId ?? null, askRow?.id ?? null, t, timeout === null ? null : t + timeout);
      return { row: stmts.escById.get(id) as EscalationRow, ask: askRow };
    });
    if (ask) emit('message.queued', ask, { kind: 'request' });
    emitEsc('escalation.opened', row);
    return toEscalation(row);
  };
  const getEscalation = (scopeId: string, id: string): Escalation => toEscalation(escRow(scopeId, id));
  const listEscalations = (scopeId: string, o: { status?: EscalationStatus; limit?: number } = {}): Escalation[] => {
    const lim = Math.min(Math.max(1, Math.floor(o.limit ?? ESCALATION_LIST_DEFAULT)), ESCALATION_LIST_MAX);
    return (stmts.escList.all(scopeId, o.status ?? null, o.status ?? null, lim) as EscalationRow[]).map(toEscalation);
  };
  const resolveEscalation = (scopeId: string, id: string, by: Actor, resolution: string): Escalation => {
    if (resolution.length === 0 || Buffer.byteLength(resolution, 'utf8') > ESCALATION_BODY_MAX) throw new AppError('VALIDATION', 'resolution is empty or too long');
    const t = now();
    const { row, message, changed } = tx(() => {
      const r = escRow(scopeId, id);
      // The status check precedes the permission one on purpose: once resolved
      // the row is a settled fact and any caller may read it back unchanged,
      // including a peer whose reply already resolved it through `send`.
      if (r.status === 'resolved') return { row: r, message: null as Row | null, changed: false };
      if (r.status !== 'open') conflict('not_open', `escalation is ${r.status}`);
      if (by.agentId !== HUMAN_AGENT_ID && r.to_agent !== by.agentId) throw new AppError('FORBIDDEN', 'only the target or the human may resolve this escalation');
      const input: SendInput = by.agentId === HUMAN_AGENT_ID
        ? { scopeId, fromAgentId: HUMAN_AGENT_ID, fromExecutionId: HUMAN_AGENT_ID, toAgentId: r.from_agent, kind: 'message', body: resolution, context: [], escalationId: id }
        : { scopeId, fromAgentId: by.agentId, fromExecutionId: by.executionId, toAgentId: r.from_agent, kind: 'reply', replyTo: r.ask_message_id, body: resolution, context: [] };
      const m = insertMessage(input, t).row;
      stmts.escResolve.run(resolution, by.agentId, m.id, t, id);
      return { row: stmts.escById.get(id) as EscalationRow, message: m, changed: true };
    });
    if (changed && message) emit('message.queued', message, { kind: message.kind });
    if (changed) emitEsc('escalation.resolved', row, { resolvedBy: by.agentId });
    return toEscalation(row);
  };
  const dismissEscalation = (scopeId: string, id: string): Escalation => {
    const t = now();
    const { row, changed } = tx(() => {
      const r = escRow(scopeId, id);
      if (r.status === 'dismissed') return { row: r, changed: false };
      if (r.status !== 'open') conflict('not_open', `escalation is ${r.status}`);
      stmts.escDismiss.run(t, id);
      return { row: stmts.escById.get(id) as EscalationRow, changed: true };
    });
    if (changed) emitEsc('escalation.dismissed', row);
    return toEscalation(row);
  };
  /** Retargets iff the row is still an open, non-human-bound peer ask at the
   * moment the transaction runs — the row is re-read inside `retargetSelected`
   * rather than trusted from an outer read, so a status change racing this
   * call cannot be acted on stale. */
  const retargetEscalation = (scopeId: string, id: string): Escalation => {
    escRow(scopeId, id); // NOT_FOUND / scope check only; the retarget decision is made fresh below
    retargetSelected(() => {
      const r = stmts.escById.get(id) as EscalationRow | undefined;
      return r && r.status === 'open' && r.to_agent !== HUMAN_AGENT_ID ? [r] : [];
    });
    return toEscalation(escRow(scopeId, id));
  };
  const retargetOpenAsksTo = (scopeId: string, agentId: string): Escalation[] =>
    retargetSelected(() => stmts.escOpenAsksTo.all(scopeId, agentId) as EscalationRow[]).map(toEscalation);
  /** Retargets an overdue peer ask on read rather than waiting for the hourly
   * sweep, comparing the deadline against the store's own clock (`now()`,
   * injectable in tests) — never `Date.now()`, which would disagree with it
   * under an injected clock. */
  const pollEscalation = (scopeId: string, id: string, askerAgentId?: string): Escalation => {
    const r = escRow(scopeId, id);
    if (r.status !== 'open' || r.to_agent === HUMAN_AGENT_ID || r.expires_at === null || r.expires_at > now()) {
      return consumeAnswer(r, askerAgentId);
    }
    retargetSelected(() => {
      const fresh = stmts.escById.get(id) as EscalationRow | undefined;
      return fresh && fresh.status === 'open' && fresh.to_agent !== HUMAN_AGENT_ID && fresh.expires_at !== null && fresh.expires_at <= now()
        ? [fresh]
        : [];
    });
    return toEscalation(escRow(scopeId, id));
  };
  /** Acknowledge a resolved escalation's reply on the asker's behalf. Only the
   * asker's own unacknowledged copy moves; anyone else's poll is a plain read. */
  const consumeAnswer = (r: EscalationRow, askerAgentId: string | undefined): Escalation => {
    if (r.status !== 'resolved' || askerAgentId !== r.from_agent || r.reply_message_id === null) return toEscalation(r);
    const t = now();
    const acked = tx(() => {
      const m = stmts.byId.get(r.reply_message_id!) as Row | undefined;
      if (!m || m.to_agent_id !== askerAgentId || (m.state !== 'queued' && m.state !== 'delivered')) return null;
      stmts.ack.run(t, m.id);
      return stmts.byId.get(m.id) as Row;
    });
    if (acked) emit('message.acknowledged', acked);
    return toEscalation(r);
  };

  return {
    send,
    receipt,
    pull,
    peek,
    claim,
    confirm,
    ackAll,
    ack,
    listScope,
    recordTurns,
    listTurns,
    sweep,
    createTask,
    getTask,
    listTasks,
    claimTask,
    assignTask,
    releaseTask,
    doneTask,
    cancelTask,
    releaseClaimsOf,
    createEscalation,
    getEscalation,
    listEscalations,
    resolveEscalation,
    dismissEscalation,
    retargetEscalation,
    retargetOpenAsksTo,
    pollEscalation,
    close: () => db.close(),
  };
}

/** Stand-in when the database could not open: routes answer 503, timers and shutdown are no-ops. */
export function createDisabledIntercomStore(reason: string): IntercomStore {
  const fail = (): never => {
    throw new AppError('UNAVAILABLE', `intercom unavailable: ${reason}`);
  };
  return {
    send: fail,
    receipt: fail,
    pull: fail,
    peek: fail,
    claim: fail,
    confirm: fail,
    ackAll: fail,
    ack: fail,
    listScope: fail,
    recordTurns: fail,
    listTurns: fail,
    sweep: () => ({ expired: 0, deleted: 0, turnsDeleted: 0, tasksDeleted: 0, escalationsDeleted: 0, escalationsRetargeted: 0 }),
    createTask: fail,
    getTask: fail,
    listTasks: fail,
    claimTask: fail,
    assignTask: fail,
    releaseTask: fail,
    doneTask: fail,
    cancelTask: fail,
    releaseClaimsOf: () => [],
    createEscalation: fail,
    getEscalation: fail,
    listEscalations: fail,
    resolveEscalation: fail,
    dismissEscalation: fail,
    retargetEscalation: fail,
    retargetOpenAsksTo: () => [],
    pollEscalation: fail,
    close: () => {},
  };
}
