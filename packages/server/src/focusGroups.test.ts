import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFocusGroupStore } from './focusGroups';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'focus-groups-'));
  file = path.join(dir, 'groups.json');
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('focus group store', () => {
  it('drops a row without a members array instead of failing every read', async () => {
    await fs.writeFile(file, JSON.stringify({ groups: [
      { id: 'ok', name: 'Good', members: ['local:/a'], createdAt: 't' },
      { id: 'bad', name: 'Hand edited', createdAt: 't' },
    ] }));
    const store = createFocusGroupStore(file);
    expect((await store.list()).map((g) => g.id)).toEqual(['ok']);
  });

  it('creates groups without a state and patches it to parked and back', async () => {
    const store = createFocusGroupStore(file);
    const g = await store.create({ name: 'FX-1' });
    expect(g.state).toBeUndefined();
    expect((await store.update(g.id, { state: 'parked' })).state).toBe('parked');
    expect((await store.update(g.id, { state: 'working' })).state).toBe('working');
    // A patch without state leaves it alone.
    expect((await store.update(g.id, { name: 'FX-2' })).state).toBe('working');
  });
});
