import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupBeforeWrite } from './backups.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { assertPathSegment } from './services/worktreeRoot.js';

export const ALLOWED_EDITORS = ['code', 'cursor', 'subl', 'webstorm'] as const;
export type Editor = (typeof ALLOWED_EDITORS)[number];

export const EnvProfileSchema = z.object({
  name: z.string().min(1),
  envFile: z.string().min(1),
});
export type EnvProfile = z.infer<typeof EnvProfileSchema>;

export const RepoConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  // Machine-independent identity: `path` only means something on the machine
  // that registered it, so a repo cannot be materialized anywhere else from
  // it. The clone URL can — that's what lets a runner provision a repo on
  // demand instead of the user SSHing in to clone by hand. Read from
  // `git remote get-url origin` at registration; null for repos with no remote.
  cloneUrl: z.string().min(1).nullable().optional(),
  // `worktreesDir` was removed: a repo's worktrees always live at
  // `<home>/worktrees/<repoId>`, computed from the id. Old repos.json files
  // still carry the key; read() strips it and rewrites the file once.
  projectSubdir: z.string().nullable(),
  startCommand: z.string().min(1),
  defaultPort: z.number().int().positive(),
  fixedPort: z.boolean().optional(),
  editor: z.enum(ALLOWED_EDITORS),
  openUrl: z.string().url().nullable().optional(),
  envProfiles: z.array(EnvProfileSchema).optional(),
  defaultEnvProfile: z.string().optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

const FileSchema = z.object({
  repos: z.array(RepoConfigSchema),
});

export type RepoConfigStore = {
  list(): Promise<RepoConfig[]>;
  get(id: string): Promise<RepoConfig | null>;
  add(repo: RepoConfig): Promise<RepoConfig>;
  patch(id: string, patch: Partial<RepoConfig>): Promise<RepoConfig>;
  remove(id: string): Promise<void>;
};

export function createRepoConfigStore(filePath: string): RepoConfigStore {
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<{ repos: RepoConfig[] }> {
    if (!fs.existsSync(filePath)) return { repos: [] };
    const raw = await fsp.readFile(filePath, 'utf8');
    let json: unknown;
    let parsed: { repos: RepoConfig[] };
    try {
      json = JSON.parse(raw);
      parsed = FileSchema.parse(json);
    } catch (err) {
      throw new AppError('VALIDATION', `invalid repos.json: ${(err as Error).message}`);
    }
    // One-time cleanup: strip the retired `worktreesDir` key from files written
    // by older versions. This is the ONLY case where a read writes back — the
    // parse SUCCEEDED on an existing file, so unlike a bad read (which must
    // never persist an empty list) this cannot lose data.
    const entries = (json as { repos?: unknown[] }).repos;
    if (Array.isArray(entries) && entries.some((r) => r && typeof r === 'object' && 'worktreesDir' in r)) {
      await write(parsed.repos);
    }
    return parsed;
  }

  async function write(repos: RepoConfig[]): Promise<void> {
    await backupBeforeWrite(filePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ repos }, null, 2));
    await fsp.rename(tmp, filePath);
  }

  function run<T>(fn: (state: RepoConfig[]) => Promise<{ state: RepoConfig[]; result: T }>): Promise<T> {
    const next = queue.then(async () => {
      const { repos } = await read();
      const { state, result } = await fn(repos);
      await write(state);
      return result;
    });
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // Reads never write the file back: a rewrite after a bad read (e.g. a
  // transient existsSync=false) would persist an empty repo list.
  function view<T>(fn: (repos: RepoConfig[]) => T): Promise<T> {
    const next = queue.then(async () => fn((await read()).repos));
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    list: () => view((repos) => repos),
    get: (id) => view((repos) => repos.find((r) => r.id === id) ?? null),
    add: (repo) =>
      run(async (repos) => {
        const parsed = RepoConfigSchema.safeParse(repo);
        if (!parsed.success) {
          throw new AppError('VALIDATION', parsed.error.message);
        }
        if (repos.some((r) => r.id === parsed.data.id)) {
          throw new AppError('VALIDATION', `repo id ${parsed.data.id} already exists`);
        }
        // Write-path only: the id becomes a directory name under the shared
        // worktree root. The schema itself stays permissive because repos.json is
        // validated on read, so a stricter rule there would make an existing
        // nonconforming id fail the whole config load.
        assertPathSegment(parsed.data.id, 'repo id');
        const next = [...repos, parsed.data];
        return { state: next, result: parsed.data };
      }),
    patch: (id, patch) =>
      run(async (repos) => {
        const idx = repos.findIndex((r) => r.id === id);
        if (idx === -1) throw new AppError('NOT_FOUND', `repo ${id} not found`);
        const merged = { ...repos[idx]!, ...patch };
        const parsed = RepoConfigSchema.safeParse(merged);
        if (!parsed.success) throw new AppError('VALIDATION', parsed.error.message);
        const next = [...repos];
        next[idx] = parsed.data;
        return { state: next, result: parsed.data };
      }),
    remove: (id) =>
      run(async (repos) => {
        const next = repos.filter((r) => r.id !== id);
        if (next.length === repos.length) throw new AppError('NOT_FOUND', `repo ${id} not found`);
        return { state: next, result: undefined };
      }),
  };
}
