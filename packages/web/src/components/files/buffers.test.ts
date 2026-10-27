import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBuffers, dirtyFiles, discardBuffer, editBuffer, getBuffer, isDirty, openBuffer, reloadBuffer, saveBuffer } from './buffers';

const WT = '/wt';
const ok = (version: string) => vi.fn(async (b: { path: string; text: string }) => ({ path: b.path, version, size: b.text.length }));

beforeEach(() => { __resetBuffers(); });

describe('buffers', () => {
  it('typing makes it dirty; the same text again is clean', () => {
    openBuffer(WT, 'a.ts', { text: 'one', version: 'v1' }, ok('v2'));
    expect(isDirty(getBuffer(WT, 'a.ts'))).toBe(false);
    editBuffer(WT, 'a.ts', 'one!');
    expect(isDirty(getBuffer(WT, 'a.ts'))).toBe(true);
    expect(dirtyFiles(WT)).toEqual(['a.ts']);
    editBuffer(WT, 'a.ts', 'one');
    expect(dirtyFiles(WT)).toEqual([]);
  });

  it('⌘S posts the text with its base version; then clean, at the new version, and the gutter is told', async () => {
    const write = ok('v2');
    openBuffer(WT, 'a.ts', { text: 'one', version: 'v1' }, write);
    editBuffer(WT, 'a.ts', 'two');
    expect(await saveBuffer(WT, 'a.ts')).toBe('saved');
    expect(write).toHaveBeenCalledWith({ path: 'a.ts', text: 'two', baseVersion: 'v1' });
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ base: 'two', text: 'two', version: 'v2', saved: 1, saving: false });
    expect(await saveBuffer(WT, 'a.ts')).toBe('clean');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('typing while a save is in flight stays dirty: the base is what was written', async () => {
    let done: (v: { path: string; version: string; size: number }) => void = () => {};
    const write = vi.fn(() => new Promise<{ path: string; version: string; size: number }>((r) => { done = r; }));
    openBuffer(WT, 'a.ts', { text: 'one', version: 'v1' }, write);
    editBuffer(WT, 'a.ts', 'two');
    const saving = saveBuffer(WT, 'a.ts');
    expect(getBuffer(WT, 'a.ts')!.saving).toBe(true);
    editBuffer(WT, 'a.ts', 'two and more');
    done({ path: 'a.ts', version: 'v2', size: 3 });
    await saving;
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ base: 'two', text: 'two and more', version: 'v2' });
    expect(isDirty(getBuffer(WT, 'a.ts'))).toBe(true);
  });

  it('a 409 is a conflict (the edits stay); Overwrite re-posts with force', async () => {
    const write = vi.fn(async (b: { path: string; text: string; force?: boolean }) => {
      if (!b.force) throw Object.assign(new Error('conflict'), { code: 'CONFLICT', details: { error: 'conflict', path: 'a.ts', version: 'disk' } });
      return { path: 'a.ts', version: 'v3', size: 1 };
    });
    openBuffer(WT, 'a.ts', { text: 'one', version: 'v1' }, write);
    editBuffer(WT, 'a.ts', 'mine');
    expect(await saveBuffer(WT, 'a.ts')).toBe('conflict');
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ text: 'mine', conflict: { version: 'disk' } });
    expect(await saveBuffer(WT, 'a.ts', true)).toBe('saved');
    expect(write).toHaveBeenLastCalledWith({ path: 'a.ts', text: 'mine', baseVersion: 'v1', force: true });
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ base: 'mine', version: 'v3', conflict: null });
  });

  it('another failure keeps the edits and says so in fixed words', async () => {
    openBuffer(WT, 'a.ts', { text: 'one', version: 'v1' }, vi.fn(async () => { throw new Error('EACCES /secret'); }));
    editBuffer(WT, 'a.ts', 'two');
    expect(await saveBuffer(WT, 'a.ts')).toBe('failed');
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ text: 'two', error: 'Couldn’t save. Your changes are still here.' });
  });

  it('a re-read: a clean buffer follows the disk quietly; a dirty one gets a conflict; the same disk is no conflict', () => {
    const w = ok('x');
    openBuffer(WT, 'a.ts', { text: 'one', version: 'v1' }, w);
    openBuffer(WT, 'a.ts', { text: 'one, by an agent', version: 'v2' }, w);
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ base: 'one, by an agent', text: 'one, by an agent', version: 'v2', conflict: null });
    editBuffer(WT, 'a.ts', 'mine');
    openBuffer(WT, 'a.ts', { text: 'one, by an agent', version: 'v2' }, w);
    expect(getBuffer(WT, 'a.ts')!.conflict).toBeNull();
    openBuffer(WT, 'a.ts', { text: 'changed again', version: 'v3' }, w);
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ text: 'mine', conflict: { version: 'v3' } });
    // Reload takes the disk; Don't save drops the buffer.
    reloadBuffer(WT, 'a.ts', { text: 'changed again', version: 'v3' });
    expect(getBuffer(WT, 'a.ts')).toMatchObject({ text: 'changed again', base: 'changed again', version: 'v3', conflict: null });
    discardBuffer(WT, 'a.ts');
    expect(getBuffer(WT, 'a.ts')).toBeUndefined();
  });

  it('dirty files are per worktree', () => {
    openBuffer('/a', 'x.ts', { text: '1', version: 'v' }, ok('v'));
    openBuffer('/b', 'x.ts', { text: '1', version: 'v' }, ok('v'));
    editBuffer('/b', 'x.ts', '2');
    expect(dirtyFiles('/a')).toEqual([]);
    expect(dirtyFiles('/b')).toEqual(['x.ts']);
  });
});
