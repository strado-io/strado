// Unsaved edits in the Files tab, per worktree and file, for this window's
// session: they outlive a tab or pane switch, the Files tab and the hub. The
// same file in both panes is one buffer. Each buffer carries its writer, so
// whatever closes files (a file tab, the Files tab in the hub) can save them.
import { useSyncExternalStore } from 'react';
import type { FileWriteBody, FileWriteResult } from '../../types';

export type Buffer = {
  /** The text on disk, as last read or saved. */
  base: string;
  /** Its version (FileContent.version); null from a server that sends none. */
  version: string | null;
  /** The text in the editor. */
  text: string;
  /** The file changed on disk under unsaved edits (a re-read found new text, or a save was refused). */
  conflict: { version: string | null } | null;
  saving: boolean;
  /** A save failed for another reason: fixed words for the bar. */
  error: string | null;
  /** Bumped by each save: the gutter re-reads its marks. */
  saved: number;
  write: (body: FileWriteBody) => Promise<FileWriteResult>;
};
export type SaveOutcome = 'saved' | 'conflict' | 'failed' | 'clean';

export const SAVE_FAILED = 'Couldn’t save. Your changes are still here.';
const NO_VERSION = 'Couldn’t save: reload the file first.';

const buffers = new Map<string, Buffer>();
const listeners = new Set<() => void>();
const keyOf = (worktree: string, path: string) => `${worktree}\0${path}`;
const emit = () => { for (const l of listeners) l(); };
const put = (worktree: string, path: string, b: Buffer | null) => {
  if (b) buffers.set(keyOf(worktree, path), b); else buffers.delete(keyOf(worktree, path));
  emit();
};

export const isDirty = (b: Buffer | undefined | null): boolean => !!b && b.text !== b.base;
export function getBuffer(worktree: string, path: string): Buffer | undefined {
  return buffers.get(keyOf(worktree, path));
}

/** A read of the file came back: start its buffer, or bring a clean one up to
 * the disk (quietly). Under unsaved edits a different disk is a conflict. */
export function openBuffer(worktree: string, path: string, disk: { text: string; version?: string }, write: Buffer['write']): Buffer {
  const b = getBuffer(worktree, path);
  const version = disk.version ?? null;
  let next: Buffer;
  if (!b) next = { base: disk.text, version, text: disk.text, conflict: null, saving: false, error: null, saved: 0, write };
  else if (!isDirty(b)) next = { ...b, base: disk.text, text: disk.text, version, conflict: null, write };
  else if (disk.text === b.base) next = { ...b, version: version ?? b.version, write };
  else next = { ...b, conflict: { version }, write };
  put(worktree, path, next);
  return next;
}

/** The person typed. */
export function editBuffer(worktree: string, path: string, text: string): void {
  const b = getBuffer(worktree, path);
  if (b && b.text !== text) put(worktree, path, { ...b, text, error: null });
}

/** Back to what is on disk (Reload, after the person confirmed). */
export function reloadBuffer(worktree: string, path: string, disk: { text: string; version?: string }): void {
  const b = getBuffer(worktree, path);
  if (b) put(worktree, path, { ...b, base: disk.text, text: disk.text, version: disk.version ?? null, conflict: null, error: null });
}

/** Don't save: the edits go. */
export function discardBuffer(worktree: string, path: string): void {
  if (buffers.has(keyOf(worktree, path))) put(worktree, path, null);
}

/** ⌘S. `force` writes over a file that changed on disk (Overwrite). */
export async function saveBuffer(worktree: string, path: string, force = false): Promise<SaveOutcome> {
  const b = getBuffer(worktree, path);
  if (!b || b.saving || (!isDirty(b) && !force)) return 'clean';
  if (b.version === null) { put(worktree, path, { ...b, error: NO_VERSION }); return 'failed'; }
  const text = b.text;
  put(worktree, path, { ...b, saving: true, error: null });
  try {
    const r = await b.write({ path, text, baseVersion: b.version, ...(force ? { force: true } : {}) });
    const now = getBuffer(worktree, path);
    // Typing during the save keeps those edits dirty: the base is what was written.
    if (now) put(worktree, path, { ...now, base: text, version: r.version, conflict: null, saving: false, error: null, saved: now.saved + 1 });
    return 'saved';
  } catch (err) {
    const now = getBuffer(worktree, path);
    const e = err as { code?: string; details?: { version?: string } };
    if (e?.code === 'CONFLICT') {
      if (now) put(worktree, path, { ...now, saving: false, conflict: { version: e.details?.version ?? null } });
      return 'conflict';
    }
    if (now) put(worktree, path, { ...now, saving: false, error: SAVE_FAILED });
    return 'failed';
  }
}

/** Save several; true when every one was written. */
export async function saveAll(worktree: string, paths: string[]): Promise<boolean> {
  const results = await Promise.all(paths.map((p) => saveBuffer(worktree, p)));
  return results.every((r) => r === 'saved' || r === 'clean');
}

/** The files with unsaved edits in a worktree, sorted. */
export function dirtyFiles(worktree: string): string[] {
  const prefix = `${worktree}\0`;
  return [...buffers.entries()].filter(([k, b]) => k.startsWith(prefix) && isDirty(b)).map(([k]) => k.slice(prefix.length)).sort();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useBuffer(worktree: string, path: string, on = true): Buffer | undefined {
  return useSyncExternalStore(subscribe, () => (on ? getBuffer(worktree, path) : undefined));
}
/** The dirty files of a worktree, as a set (stable while it doesn't change). */
export function useDirtyFiles(worktree: string): ReadonlySet<string> {
  const joined = useSyncExternalStore(subscribe, () => dirtyFiles(worktree).join('\0'));
  let set = dirtySets.get(joined);
  if (!set) {
    if (dirtySets.size > 64) dirtySets.clear();
    set = new Set(joined ? joined.split('\0') : []);
    dirtySets.set(joined, set);
  }
  return set;
}
const dirtySets = new Map<string, ReadonlySet<string>>();

/** Tests: start empty. */
export function __resetBuffers(): void {
  buffers.clear();
  dirtySets.clear();
  emit();
}
