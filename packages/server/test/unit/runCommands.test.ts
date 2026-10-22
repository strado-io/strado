import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepoConfigStore, deriveRunCommands, validateRunCommands, type RepoConfig } from '../../src/repoConfig';

// Named run commands replace env profiles: each profile becomes a run
// command; a repo without profiles gets one "dev" from its start command.

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runcmd-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const repo = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  id: 'r', name: 'r', path: '/tmp/r', projectSubdir: null, startCommand: 'npm run dev', defaultPort: 3000, editor: 'code', ...over,
});

describe('deriveRunCommands: migrating env profiles', () => {
  it('no profiles: one "dev" with the start command', () => {
    expect(deriveRunCommands(repo())).toEqual([{ id: 'dev', name: 'dev', command: 'npm run dev' }]);
  });
  it('no start command and no profiles: none', () => {
    expect(deriveRunCommands(repo({ startCommand: '  ' }))).toEqual([]);
  });
  it('a command naming {ENV_FILE}: one per profile, the file written into the command', () => {
    const r = repo({ startCommand: 'node --env-file={ENV_FILE} server.js', envProfiles: [{ name: 'Local', envFile: '.env' }, { name: 'Staging', envFile: '.env.staging' }] });
    expect(deriveRunCommands(r)).toEqual([
      { id: 'local', name: 'Local', command: 'node --env-file=.env server.js' },
      { id: 'staging', name: 'Staging', command: 'node --env-file=.env.staging server.js' },
    ]);
  });
  it('a command that does not name the file: the file is injected at start (envFile)', () => {
    const r = repo({ envProfiles: [{ name: 'local', envFile: '.env' }] });
    expect(deriveRunCommands(r)).toEqual([{ id: 'local', name: 'local', command: 'npm run dev', envFile: '.env' }]);
  });
  it('the default profile comes first (it is the default run); ids stay unique', () => {
    const r = repo({ envProfiles: [{ name: 'a b', envFile: '.a' }, { name: 'A-B', envFile: '.b' }, { name: 'prod', envFile: '.p' }], defaultEnvProfile: 'prod' });
    expect(deriveRunCommands(r).map((c) => [c.id, c.name])).toEqual([['prod', 'prod'], ['a-b', 'a b'], ['a-b-2', 'A-B']]);
  });
  it('a repo that already has run commands keeps them', () => {
    const own = [{ id: 'web', name: 'web', command: 'vite' }];
    expect(deriveRunCommands(repo({ runCommands: own, envProfiles: [{ name: 'x', envFile: '.x' }] }))).toBe(own);
  });
});

describe('validateRunCommands', () => {
  const ok = { id: 'a', name: 'api', command: 'npm run api' };
  it('accepts a good list (and an empty one)', () => {
    expect(() => validateRunCommands([ok, { id: 'b', name: 'web', command: 'vite' }])).not.toThrow();
    expect(() => validateRunCommands([])).not.toThrow();
  });
  it.each([
    ['name_required', [{ ...ok, name: '  ' }], 0],
    ['command_required', [ok, { id: 'b', name: 'web', command: ' ' }], 1],
    ['name_taken', [ok, { id: 'b', name: 'API', command: 'x' }], 1],
    ['id_taken', [ok, { id: 'a', name: 'web', command: 'x' }], 1],
  ])('%s, with the row', (reason, list, index) => {
    expect(() => validateRunCommands(list)).toThrow(expect.objectContaining({ code: 'VALIDATION', details: { reason, index } }));
  });
});

describe('the repo store', () => {
  const file = () => path.join(tmp, 'repos.json');
  const writeRaw = (repos: unknown[]) => fs.writeFile(file(), JSON.stringify({ repos }));

  it('reads an old repo with run commands derived and the profile fields gone', async () => {
    await writeRaw([{ ...repo(), envProfiles: [{ name: 'local', envFile: '.env' }], defaultEnvProfile: 'local' }]);
    const [r] = await createRepoConfigStore(file()).list();
    expect(r!.runCommands).toEqual([{ id: 'local', name: 'local', command: 'npm run dev', envFile: '.env' }]);
    expect(r).not.toHaveProperty('envProfiles');
    expect(r).not.toHaveProperty('defaultEnvProfile');
  });

  it('a read never writes; the first write persists the migration', async () => {
    await writeRaw([{ ...repo(), envProfiles: [{ name: 'local', envFile: '.env' }] }]);
    const store = createRepoConfigStore(file());
    await store.list();
    expect(JSON.parse(await fs.readFile(file(), 'utf8')).repos[0]).not.toHaveProperty('runCommands');
    await store.patch('r', { name: 'renamed' });
    const saved = JSON.parse(await fs.readFile(file(), 'utf8')).repos[0];
    expect(saved.runCommands).toEqual([{ id: 'local', name: 'local', command: 'npm run dev', envFile: '.env' }]);
    expect(saved).not.toHaveProperty('envProfiles');
  });

  it('patching runCommands validates, and keeps startCommand = the first command', async () => {
    const store = createRepoConfigStore(file());
    await store.add(repo());
    const r = await store.patch('r', { runCommands: [{ id: 'web', name: 'web', command: 'vite' }, { id: 'api', name: 'api', command: 'node api.js' }] });
    expect(r.startCommand).toBe('vite');
    await expect(store.patch('r', { runCommands: [{ id: 'x', name: '', command: 'y' }] })).rejects.toMatchObject({ details: { reason: 'name_required' } });
    expect((await store.get('r'))!.runCommands!.map((c) => c.id)).toEqual(['web', 'api']);
  });

  it('patching only startCommand (older clients) updates the first command', async () => {
    const store = createRepoConfigStore(file());
    await store.add(repo());
    const r = await store.patch('r', { startCommand: 'pnpm dev' });
    expect(r.runCommands).toEqual([{ id: 'dev', name: 'dev', command: 'pnpm dev' }]);
  });
  it('clearing startCommand (a library) drops the default command', async () => {
    const store = createRepoConfigStore(file());
    await store.add(repo());
    expect((await store.patch('r', { startCommand: '' })).runCommands).toEqual([]);
  });

  it('a repo added with profiles (detection, older clients) is stored as run commands', async () => {
    const store = createRepoConfigStore(file());
    const r = await store.add({ ...repo(), envProfiles: [{ name: 'local', envFile: '.env' }] });
    expect(r.runCommands).toEqual([{ id: 'local', name: 'local', command: 'npm run dev', envFile: '.env' }]);
    expect(r).not.toHaveProperty('envProfiles');
  });
});
