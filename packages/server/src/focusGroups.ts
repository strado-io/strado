// Focus groups: named, cross-repo bundles of worktrees for one task. One file
// per workspace, written through the same serialized queue + atomic rename as
// state.json — two quick "Add to group" clicks must both land.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupBeforeWrite } from './backups.js';
import { AppError } from './errors.js';

export type FocusGroup = { id: string; name: string; members: string[]; createdAt: string };
type GroupsFile = { groups: FocusGroup[] };

export type FocusGroupStore = {
  list(): Promise<FocusGroup[]>;
  create(input: { name: string; members?: string[] }): Promise<FocusGroup>;
  update(id: string, patch: { name?: string; addMembers?: string[]; removeMembers?: string[] }): Promise<FocusGroup>;
  remove(id: string): Promise<void>;
  removeMemberEverywhere(memberId: string): Promise<void>;
};

const MAX_NAME = 80;

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME) {
    throw new AppError('VALIDATION', `group name must be 1-${MAX_NAME} characters`);
  }
  return name;
}

const dedupe = (ids: string[]) => [...new Set(ids)];

export function createFocusGroupStore(filePath: string): FocusGroupStore {
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<GroupsFile> {
    if (!fs.existsSync(filePath)) return { groups: [] };
    const raw = await fsp.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as GroupsFile;
      return { groups: Array.isArray(parsed.groups) ? parsed.groups : [] };
    } catch (err) {
      // Same rule as state.json: a corrupt file is never "no groups" — the
      // next write would persist the empty list and erase every group.
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsp.copyFile(filePath, backup).catch(() => undefined);
      throw new Error(`groups file ${filePath} is corrupt (backed up to ${backup}): ${(err as Error).message}`);
    }
  }

  async function write(file: GroupsFile): Promise<void> {
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

  function mutate<T>(fn: (file: GroupsFile) => T): Promise<T> {
    return enqueue(async () => {
      const file = await read();
      const result = fn(file);
      await write(file);
      return result;
    });
  }

  function find(file: GroupsFile, id: string): FocusGroup {
    const g = file.groups.find((x) => x.id === id);
    if (!g) throw new AppError('NOT_FOUND', `focus group ${id} not found`);
    return g;
  }

  return {
    list: () => enqueue(async () => (await read()).groups),
    // async so a bad name rejects rather than throwing synchronously
    create: async (input) => {
      const name = cleanName(input.name);
      return mutate((file) => {
        const group: FocusGroup = {
          id: crypto.randomBytes(6).toString('hex'),
          name,
          members: dedupe(input.members ?? []),
          createdAt: new Date().toISOString(),
        };
        file.groups.push(group);
        return group;
      });
    },
    update: async (id, patch) => {
      const name = patch.name === undefined ? undefined : cleanName(patch.name);
      return mutate((file) => {
        const g = find(file, id);
        if (name !== undefined) g.name = name;
        const drop = new Set(patch.removeMembers ?? []);
        g.members = dedupe([...g.members, ...(patch.addMembers ?? [])]).filter((m) => !drop.has(m));
        return g;
      });
    },
    remove: (id) =>
      mutate((file) => {
        find(file, id);
        file.groups = file.groups.filter((g) => g.id !== id);
      }),
    removeMemberEverywhere: (memberId) =>
      mutate((file) => {
        for (const g of file.groups) g.members = g.members.filter((m) => m !== memberId);
      }),
  };
}
