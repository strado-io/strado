import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupBeforeWrite } from './backups.js';

export type WorktreeMeta = {
  repoId: string;
  ticketId: string;
  title: string;
  linkedFrom: string | null;
  linkedAt: string | null;
  port: number | null;
  env: Record<string, string>;
  lastStartedAt: string | null;
  activeEnvProfile?: string | null;
  workflowStatus?: 'todo' | 'in_progress' | 'ready_for_qa' | 'retest_failed' | 'verified' | 'done' | null;
  note?: string | null;
  order?: number | null;
  // per-worktree overrides; null/absent falls back to the repo config
  startCommand?: string | null;
  previewUrl?: string | null;
  // Which ticket system owns ticketId; absent/null = jira (pre-Linear worktrees).
  ticketProvider?: 'jira' | 'linear' | null;
  // Set only once a container exists for this worktree (a runner with a
  // container runtime). Null/absent means the ordinary host worktree every
  // desktop has — this is the flag every sandbox-aware path keys off, so it is
  // written AFTER the container starts, never in anticipation of it.
  sandbox?: { slug: string } | null;
};

export type WorktreeEntry = { path: string; meta: WorktreeMeta };

export type StateFile = {
  worktrees: Record<string, WorktreeMeta>;
};

export type StateStore = {
  list(): Promise<WorktreeEntry[]>;
  get(path: string): Promise<WorktreeMeta | null>;
  upsert(path: string, meta: WorktreeMeta): Promise<void>;
  patch(path: string, patch: Partial<WorktreeMeta>): Promise<WorktreeMeta>;
  remove(path: string): Promise<void>;
};

export function createStateStore(filePath: string): StateStore {
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<StateFile> {
    if (!fs.existsSync(filePath)) return { worktrees: {} };
    const raw = await fsp.readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw) as StateFile;
    } catch (err) {
      // Never treat a corrupt (but present) file as empty: a later write
      // would persist the empty state and destroy every worktree's meta.
      // Preserve the bytes for recovery and fail the operation loudly.
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsp.copyFile(filePath, backup).catch(() => undefined);
      throw new Error(`state file ${filePath} is corrupt (backed up to ${backup}): ${(err as Error).message}`);
    }
  }

  async function write(state: StateFile): Promise<void> {
    await backupBeforeWrite(filePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, filePath);
  }

  function run<T>(fn: (state: StateFile) => Promise<{ state: StateFile; result: T }>): Promise<T> {
    const next = queue.then(async () => {
      const state = await read();
      const { state: nextState, result } = await fn(state);
      await write(nextState);
      return result;
    });
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // Reads must never write the file back: every rewrite is a chance to
  // persist a bad read (the dashboard polls list() continuously).
  function view<T>(fn: (state: StateFile) => T): Promise<T> {
    const next = queue.then(async () => fn(await read()));
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    list: () =>
      view((state) => Object.entries(state.worktrees).map(([p, meta]) => ({ path: p, meta }))),
    get: (p) => view((state) => state.worktrees[p] ?? null),
    upsert: (p, meta) =>
      run(async (state) => {
        state.worktrees[p] = meta;
        return { state, result: undefined };
      }),
    patch: (p, patch) =>
      run(async (state) => {
        const existing = state.worktrees[p];
        if (!existing) throw new Error(`unknown worktree path ${p}`);
        const merged: WorktreeMeta = { ...existing, ...patch };
        state.worktrees[p] = merged;
        return { state, result: merged };
      }),
    remove: (p) =>
      run(async (state) => {
        delete state.worktrees[p];
        return { state, result: undefined };
      }),
  };
}
