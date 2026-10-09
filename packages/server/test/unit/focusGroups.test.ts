import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFocusGroupStore } from '../../src/focusGroups';

let tmp: string;
let file: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'focus-groups-'));
  file = path.join(tmp, 'groups.json');
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('focus group store', () => {
  it('lists nothing when the file is missing', async () => {
    expect(await createFocusGroupStore(file).list()).toEqual([]);
  });

  it('creates, renames and deletes groups, persisting to disk', async () => {
    const store = createFocusGroupStore(file);
    const g = await store.create({ name: '  FX-412  ', members: ['local:/a', 'local:/a', 'local:/b'] });
    expect(g.name).toBe('FX-412');
    expect(g.members).toEqual(['local:/a', 'local:/b']);
    expect(g.id).toMatch(/^[a-z0-9]{8,}$/);

    const renamed = await store.update(g.id, { name: 'checkout' });
    expect(renamed.name).toBe('checkout');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).groups[0].name).toBe('checkout');

    await store.remove(g.id);
    expect(await store.list()).toEqual([]);
  });

  it('adds and removes members in one atomic update, ignoring duplicates', async () => {
    const store = createFocusGroupStore(file);
    const g = await store.create({ name: 'g', members: ['local:/a'] });
    const next = await store.update(g.id, { addMembers: ['local:/a', 'remote:r1:/x'], removeMembers: ['local:/a'] });
    expect(next.members).toEqual(['remote:r1:/x']);
  });

  it('keeps both of two concurrent member additions', async () => {
    const store = createFocusGroupStore(file);
    const g = await store.create({ name: 'g' });
    await Promise.all([
      store.update(g.id, { addMembers: ['local:/a'] }),
      store.update(g.id, { addMembers: ['local:/b'] }),
    ]);
    expect((await store.list())[0]!.members.sort()).toEqual(['local:/a', 'local:/b']);
  });

  it('rejects blank and over-long names', async () => {
    const store = createFocusGroupStore(file);
    await expect(store.create({ name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(store.create({ name: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('404s on unknown ids', async () => {
    const store = createFocusGroupStore(file);
    await expect(store.update('nope', { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.remove('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removes a member from every group but keeps the (now empty) groups', async () => {
    const store = createFocusGroupStore(file);
    await store.create({ name: 'a', members: ['local:/x'] });
    await store.create({ name: 'b', members: ['local:/x', 'local:/y'] });
    await store.removeMemberEverywhere('local:/x');
    const groups = await store.list();
    expect(groups.map((g) => g.members)).toEqual([[], ['local:/y']]);
  });

  it('backs up a corrupt file and throws instead of treating it as empty', async () => {
    await fs.writeFile(file, '{not json');
    const store = createFocusGroupStore(file);
    await expect(store.list()).rejects.toThrow(/corrupt/);
    await expect(store.create({ name: 'g' })).rejects.toThrow(/corrupt/);
    const backups = (await fs.readdir(tmp)).filter((f) => f.startsWith('groups.json.corrupt-'));
    expect(backups.length).toBeGreaterThan(0);
    expect(await fs.readFile(file, 'utf8')).toBe('{not json');
  });
});
