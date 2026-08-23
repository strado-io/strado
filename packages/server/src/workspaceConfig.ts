import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupBeforeWrite } from './backups.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { ALLOWED_EDITORS } from './repoConfig.js';

export const WorkspaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must match ^[a-z0-9-]+$'),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: z.string().min(1).max(2),
  defaultEditor: z.enum(ALLOWED_EDITORS),
  defaultPortBase: z.number().int().min(1024).max(65535),
  logDir: z.string().nullable(),
  // `worktreeRoot` was removed: worktrees always go under
  // `<home>/worktrees/<repoId>` now. Existing workspaces.json files still
  // carry the key; zod's default (non-strict) parsing strips it on read.
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

const FileSchema = z.object({
  activeWorkspaceId: z.string().min(1),
  workspaces: z.array(WorkspaceSchema).min(1),
});

export type WorkspaceFile = {
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
};

export type WorkspaceConfigStore = {
  read(): Promise<WorkspaceFile>;
  list(): Promise<Workspace[]>;
  get(id: string): Promise<Workspace | null>;
  add(ws: Workspace): Promise<Workspace>;
  patch(id: string, patch: Partial<Omit<Workspace, 'id'>> & { id?: never }): Promise<Workspace>;
  remove(id: string): Promise<void>;
  getActive(): Promise<Workspace | null>;
  setActive(id: string): Promise<Workspace>;
  /** Rewrites the array order. `ids` must be a permutation of the ids on disk. */
  reorder(ids: string[]): Promise<Workspace[]>;
};

export function createWorkspaceConfigStore(filePath: string): WorkspaceConfigStore {
  let queue: Promise<void> = Promise.resolve();

  async function readRaw(): Promise<WorkspaceFile> {
    if (!fs.existsSync(filePath)) return { activeWorkspaceId: null, workspaces: [] };
    const raw = await fsp.readFile(filePath, 'utf8');
    try {
      const parsed = FileSchema.parse(JSON.parse(raw));
      return parsed;
    } catch (err) {
      throw new AppError('VALIDATION', `invalid workspaces.json: ${(err as Error).message}`);
    }
  }

  async function write(state: WorkspaceFile): Promise<void> {
    await backupBeforeWrite(filePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, filePath);
  }

  function runRead<T>(fn: (state: WorkspaceFile) => T): Promise<T> {
    const next = queue.then(async () => fn(await readRaw()));
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function runWrite<T>(fn: (state: WorkspaceFile) => Promise<{ state: WorkspaceFile; result: T }>): Promise<T> {
    const next = queue.then(async () => {
      const state = await readRaw();
      const { state: nextState, result } = await fn(state);
      await write(nextState);
      return result;
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function ensureValidActive(state: WorkspaceFile): WorkspaceFile {
    if (state.workspaces.length === 0) return { activeWorkspaceId: null, workspaces: [] };
    if (!state.activeWorkspaceId || !state.workspaces.find((w) => w.id === state.activeWorkspaceId)) {
      return { ...state, activeWorkspaceId: state.workspaces[0]!.id };
    }
    return state;
  }

  return {
    read: () => runRead((state) => state),
    list: () => runRead((state) => state.workspaces),
    get: (id) => runRead((state) => state.workspaces.find((w) => w.id === id) ?? null),
    add: (ws) =>
      runWrite(async (state) => {
        const parsed = WorkspaceSchema.safeParse(ws);
        if (!parsed.success) throw new AppError('VALIDATION', parsed.error.message);
        if (state.workspaces.some((w) => w.id === parsed.data.id)) {
          throw new AppError('VALIDATION', `workspace id ${parsed.data.id} already exists`);
        }
        const nextState: WorkspaceFile = {
          workspaces: [...state.workspaces, parsed.data],
          activeWorkspaceId: state.activeWorkspaceId ?? parsed.data.id,
        };
        return { state: nextState, result: parsed.data };
      }),
    patch: (id, patch) =>
      runWrite(async (state) => {
        if ('id' in patch && patch.id !== undefined && patch.id !== id) {
          throw new AppError('VALIDATION', 'id is not patchable');
        }
        const idx = state.workspaces.findIndex((w) => w.id === id);
        if (idx === -1) throw new AppError('NOT_FOUND', `workspace ${id} not found`);
        const merged = { ...state.workspaces[idx]!, ...patch, id };
        const parsed = WorkspaceSchema.safeParse(merged);
        if (!parsed.success) throw new AppError('VALIDATION', parsed.error.message);
        const next = [...state.workspaces];
        next[idx] = parsed.data;
        return { state: { ...state, workspaces: next }, result: parsed.data };
      }),
    remove: (id) =>
      runWrite(async (state) => {
        if (state.workspaces.length <= 1) {
          throw new AppError('VALIDATION', 'at least one workspace is required');
        }
        const next = state.workspaces.filter((w) => w.id !== id);
        if (next.length === state.workspaces.length) {
          throw new AppError('NOT_FOUND', `workspace ${id} not found`);
        }
        return { state: ensureValidActive({ ...state, workspaces: next }), result: undefined };
      }),
    getActive: () =>
      runRead((state) => {
        const fixed = ensureValidActive(state);
        return fixed.workspaces.find((w) => w.id === fixed.activeWorkspaceId) ?? null;
      }),
    setActive: (id) =>
      runWrite(async (state) => {
        const ws = state.workspaces.find((w) => w.id === id);
        if (!ws) throw new AppError('NOT_FOUND', `workspace ${id} not found`);
        return { state: { ...state, activeWorkspaceId: id }, result: ws };
      }),
    reorder: (ids) =>
      runWrite(async (state) => {
        const wanted = new Set(ids);
        // Same length, no duplicates, same members. A list that drops an id
        // would strand that workspace's directory on disk; one that invents
        // an id has nothing to point at. Neither is recoverable by guessing.
        if (
          ids.length !== state.workspaces.length ||
          wanted.size !== ids.length ||
          state.workspaces.some((w) => !wanted.has(w.id))
        ) {
          throw new AppError(
            'VALIDATION',
            'ids must be a permutation of the existing workspace ids',
          );
        }
        const byId = new Map(state.workspaces.map((w) => [w.id, w]));
        const workspaces = ids.map((id) => byId.get(id)!);
        return { state: { ...state, workspaces }, result: workspaces };
      }),
  };
}
