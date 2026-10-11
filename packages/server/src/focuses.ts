// Focuses: named, cross-repo sets of worktrees, one per task. The sidebar
// shows the active one. One file per workspace, written through the same
// serialized queue + atomic rename as state.json — two quick adds must both
// land.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupBeforeWrite } from './backups.js';
import { AppError } from './errors.js';

export type FocusTicket = { provider: string; key: string };
export type Focus = { id: string; name: string; members: string[]; createdAt: string; lastActiveAt: string; ticket?: FocusTicket };
type FocusesFile = { focuses: Focus[] };

export type FocusPatch = { name?: string; addMembers?: string[]; removeMembers?: string[]; touch?: boolean; ticket?: FocusTicket | null };
export type FocusStore = {
  list(): Promise<Focus[]>;
  create(input: { name: string; members?: string[]; ticket?: FocusTicket }): Promise<Focus>;
  /** `touch` stamps lastActiveAt: the client activated it. */
  update(id: string, patch: FocusPatch): Promise<Focus>;
  remove(id: string): Promise<void>;
  removeMemberEverywhere(memberId: string): Promise<void>;
};

const MAX_NAME = 80;

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME) {
    throw new AppError('VALIDATION', `focus name must be 1-${MAX_NAME} characters`);
  }
  return name;
}

const dedupe = (ids: string[]) => [...new Set(ids)];

// A hand-edited row missing its members array would take the whole sidebar
// down on render. It is dropped (and so gone after the next write) rather
// than fatal; the rest of the file still counts. A missing lastActiveAt
// falls back to createdAt.
function readRow(g: unknown): Focus | null {
  if (!g || typeof g !== 'object') return null;
  const r = g as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.members)) return null;
  const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString();
  const t = r.ticket as Record<string, unknown> | undefined;
  const ticket = t && typeof t === 'object' && typeof t.provider === 'string' && typeof t.key === 'string'
    ? { provider: t.provider, key: t.key } : undefined;
  return {
    id: r.id, name: r.name, members: r.members.filter((m): m is string => typeof m === 'string'), createdAt,
    lastActiveAt: typeof r.lastActiveAt === 'string' ? r.lastActiveAt : createdAt,
    ...(ticket ? { ticket } : {}),
  };
}

export function createFocusStore(filePath: string): FocusStore {
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<FocusesFile> {
    if (!fs.existsSync(filePath)) return { focuses: [] };
    const raw = await fsp.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as { focuses?: unknown };
      return { focuses: Array.isArray(parsed.focuses) ? parsed.focuses.map(readRow).filter((f): f is Focus => f !== null) : [] };
    } catch (err) {
      // Same rule as state.json: a corrupt file is never "no focuses" — the
      // next write would persist the empty list and erase every Focus.
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsp.copyFile(filePath, backup).catch(() => undefined);
      throw new Error(`focuses file ${filePath} is corrupt (backed up to ${backup}): ${(err as Error).message}`);
    }
  }

  async function write(file: FocusesFile): Promise<void> {
    await backupBeforeWrite(filePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(file, null, 2));
    await fsp.rename(tmp, filePath);
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function mutate<T>(fn: (file: FocusesFile) => T): Promise<T> {
    return enqueue(async () => {
      const file = await read();
      const result = fn(file);
      await write(file);
      return result;
    });
  }

  function find(file: FocusesFile, id: string): Focus {
    const f = file.focuses.find((x) => x.id === id);
    if (!f) throw new AppError('NOT_FOUND', `focus ${id} not found`);
    return f;
  }

  return {
    list: () => enqueue(async () => (await read()).focuses),
    // async so a bad name rejects rather than throwing synchronously
    create: async (input) => {
      const name = cleanName(input.name);
      return mutate((file) => {
        const now = new Date().toISOString();
        const focus: Focus = {
          id: crypto.randomBytes(6).toString('hex'),
          name,
          members: dedupe(input.members ?? []),
          createdAt: now,
          lastActiveAt: now,
          ...(input.ticket ? { ticket: input.ticket } : {}),
        };
        file.focuses.push(focus);
        return focus;
      });
    },
    update: async (id, patch) => {
      const name = patch.name === undefined ? undefined : cleanName(patch.name);
      return mutate((file) => {
        const f = find(file, id);
        if (name !== undefined) f.name = name;
        if (patch.touch) f.lastActiveAt = new Date().toISOString();
        if (patch.ticket === null) delete f.ticket;
        else if (patch.ticket) f.ticket = patch.ticket;
        const drop = new Set(patch.removeMembers ?? []);
        f.members = dedupe([...f.members, ...(patch.addMembers ?? [])]).filter((m) => !drop.has(m));
        return f;
      });
    },
    remove: (id) =>
      mutate((file) => {
        find(file, id);
        file.focuses = file.focuses.filter((f) => f.id !== id);
      }),
    removeMemberEverywhere: (memberId) =>
      mutate((file) => {
        for (const f of file.focuses) f.members = f.members.filter((m) => m !== memberId);
      }),
  };
}
