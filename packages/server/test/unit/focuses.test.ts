import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFocusStore } from '../../src/focuses';

let tmp: string;
let file: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'focuses-'));
  file = path.join(tmp, 'focuses.json');
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('focus store', () => {
  it('lists nothing when the file is missing', async () => {
    expect(await createFocusStore(file).list()).toEqual([]);
  });

  it('creates, renames and deletes focuses, persisting to disk', async () => {
    const store = createFocusStore(file);
    const g = await store.create({ name: '  FX-412  ', members: ['local:/a', 'local:/a', 'local:/b'] });
    expect(g.name).toBe('FX-412');
    expect(g.members).toEqual(['local:/a', 'local:/b']);
    expect(g.id).toMatch(/^[a-z0-9]{8,}$/);

    const renamed = await store.update(g.id, { name: 'checkout' });
    expect(renamed.name).toBe('checkout');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).focuses[0].name).toBe('checkout');

    await store.remove(g.id);
    expect(await store.list()).toEqual([]);
  });

  it('adds and removes members in one atomic update, ignoring duplicates', async () => {
    const store = createFocusStore(file);
    const g = await store.create({ name: 'g', members: ['local:/a'] });
    const next = await store.update(g.id, { addMembers: ['local:/a', 'remote:r1:/x'], removeMembers: ['local:/a'] });
    expect(next.members).toEqual(['remote:r1:/x']);
  });

  it('keeps both of two concurrent member additions', async () => {
    const store = createFocusStore(file);
    const g = await store.create({ name: 'g' });
    await Promise.all([
      store.update(g.id, { addMembers: ['local:/a'] }),
      store.update(g.id, { addMembers: ['local:/b'] }),
    ]);
    expect((await store.list())[0]!.members.sort()).toEqual(['local:/a', 'local:/b']);
  });

  it('rejects blank and over-long names', async () => {
    const store = createFocusStore(file);
    await expect(store.create({ name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(store.create({ name: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('404s on unknown ids', async () => {
    const store = createFocusStore(file);
    await expect(store.update('nope', { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.remove('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removes a member from every focus but keeps the (now empty) focuses', async () => {
    const store = createFocusStore(file);
    await store.create({ name: 'a', members: ['local:/x'] });
    await store.create({ name: 'b', members: ['local:/x', 'local:/y'] });
    await store.removeMemberEverywhere('local:/x');
    const focuses = await store.list();
    expect(focuses.map((f) => f.members)).toEqual([[], ['local:/y']]);
  });

  it('backs up a corrupt file and throws instead of treating it as empty', async () => {
    await fs.writeFile(file, '{not json');
    const store = createFocusStore(file);
    await expect(store.list()).rejects.toThrow(/corrupt/);
    await expect(store.create({ name: 'g' })).rejects.toThrow(/corrupt/);
    const backups = (await fs.readdir(tmp)).filter((f) => f.startsWith('focuses.json.corrupt-'));
    expect(backups.length).toBeGreaterThan(0);
    expect(await fs.readFile(file, 'utf8')).toBe('{not json');
  });

  it('drops a row without a members array instead of failing every read, and backfills lastActiveAt', async () => {
    await fs.writeFile(file, JSON.stringify({ focuses: [
      { id: 'ok', name: 'Good', members: ['local:/a'], createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bad', name: 'Hand edited', createdAt: 't' },
    ] }));
    const store = createFocusStore(file);
    const rows = await store.list();
    expect(rows.map((f) => f.id)).toEqual(['ok']);
    expect(rows[0]!.lastActiveAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stamps lastActiveAt on create and on touch, and leaves it alone otherwise', async () => {
    const store = createFocusStore(file);
    const f = await store.create({ name: 'FX-1' });
    expect(f.lastActiveAt).toBe(f.createdAt);
    const renamed = await store.update(f.id, { name: 'FX-2' });
    expect(renamed.lastActiveAt).toBe(f.createdAt);
    await new Promise((r) => setTimeout(r, 5));
    const touched = await store.update(f.id, { touch: true });
    expect(touched.lastActiveAt > f.createdAt).toBe(true);
  });
});
