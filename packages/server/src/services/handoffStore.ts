import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupBeforeWrite } from '../backups.js';

export type AgentMode = 'claude' | 'codex' | 'opencode';

export type HandoffConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type HandoffContextSource = 'claude-history' | 'codex-history' | 'opencode-history' | 'none';

export type HandoffRepositorySnapshot = {
  branch: string;
  head: string;
  status: string[];
  diffStat: string;
};

export type HandoffRecord = {
  id: string;
  workspaceId: string;
  worktreePath: string;
  taskLabel: string;
  source: { mode: AgentMode; sessionId: string };
  target: { mode: AgentMode; sessionId: string };
  status: 'ready' | 'accepted' | 'cancelled';
  notes: string;
  conversation: HandoffConversationMessage[];
  contextSource: HandoffContextSource;
  // Compatibility only for packets created by the early PTY-snapshot
  // prototype. It is intentionally never included in a target prompt.
  transcript?: string[];
  repository: HandoffRepositorySnapshot;
  createdAt: string;
  acceptedAt: string | null;
};

type HandoffFile = { handoffs: HandoffRecord[] };

export type HandoffStore = {
  list(worktreePath?: string): Promise<HandoffRecord[]>;
  get(id: string): Promise<HandoffRecord | null>;
  create(input: Omit<HandoffRecord, 'id' | 'status' | 'createdAt' | 'acceptedAt'>): Promise<HandoffRecord>;
  accept(id: string): Promise<HandoffRecord>;
  cancel(id: string): Promise<HandoffRecord>;
};

export function createHandoffStore(filePath: string): HandoffStore {
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<HandoffFile> {
    if (!fs.existsSync(filePath)) return { handoffs: [] };
    const raw = await fsp.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as Partial<HandoffFile>;
      return { handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs : [] };
    } catch (err) {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsp.copyFile(filePath, backup).catch(() => undefined);
      throw new Error(`handoff file ${filePath} is corrupt (backed up to ${backup}): ${(err as Error).message}`);
    }
  }

  async function write(state: HandoffFile): Promise<void> {
    await backupBeforeWrite(filePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, filePath);
  }

  function view<T>(fn: (state: HandoffFile) => T): Promise<T> {
    const next = queue.then(async () => fn(await read()));
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function update<T>(fn: (state: HandoffFile) => T): Promise<T> {
    const next = queue.then(async () => {
      const state = await read();
      const result = fn(state);
      await write(state);
      return result;
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  const transition = (id: string, status: 'accepted' | 'cancelled') =>
    update((state) => {
      const record = state.handoffs.find((h) => h.id === id);
      if (!record) throw new Error(`handoff ${id} not found`);
      if (record.status === status) return record;
      if (record.status !== 'ready') throw new Error(`handoff ${id} is already ${record.status}`);
      record.status = status;
      if (status === 'accepted') record.acceptedAt = new Date().toISOString();
      return record;
    });

  return {
    list: (worktreePath) =>
      view((state) => state.handoffs.filter((h) => !worktreePath || h.worktreePath === worktreePath)),
    get: (id) => view((state) => state.handoffs.find((h) => h.id === id) ?? null),
    create: (input) =>
      update((state) => {
        const record: HandoffRecord = {
          ...input,
          id: randomUUID(),
          status: 'ready',
          createdAt: new Date().toISOString(),
          acceptedAt: null,
        };
        state.handoffs.push(record);
        // Keep local history useful without letting a long-lived workspace
        // grow forever. The newest 100 handoffs are enough for recovery/audit.
        if (state.handoffs.length > 100) state.handoffs.splice(0, state.handoffs.length - 100);
        return record;
      }),
    accept: (id) => transition(id, 'accepted'),
    cancel: (id) => transition(id, 'cancelled'),
  };
}

export function handoffPrompt(record: HandoffRecord): string {
  const repo = record.repository;
  const status = repo.status.length ? repo.status.join('\n') : '(clean)';
  const conversation = record.conversation?.length
    ? record.conversation.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n')
    : '(no clean provider conversation was available; use the notes and repository state below)';
  const notes = record.notes.trim() || '(none supplied)';
  return [
    `You are taking over task ${record.taskLabel} from ${record.source.mode} session ${record.source.sessionId}.`,
    'Continue the existing work in this worktree. Do not restart the task from scratch.',
    'First inspect the repository and verify the handoff claims against the files and git diff.',
    '',
    'USER HANDOFF NOTES',
    notes,
    '',
    'REPOSITORY SNAPSHOT',
    `Branch: ${repo.branch}`,
    `HEAD: ${repo.head}`,
    'Working tree:',
    status,
    `Diff summary: ${repo.diffStat || '(no diff)'}`,
    '',
    `RECENT SOURCE CONVERSATION (${record.contextSource ?? 'none'})`,
    conversation,
    '',
    'Continue from the latest unfinished point. Preserve existing user changes, run relevant verification, and report any mismatch you discover.',
  ].join('\n');
}
