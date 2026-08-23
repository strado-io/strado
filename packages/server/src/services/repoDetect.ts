import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../shell.js';
import { AppError } from '../errors.js';
import type { EnvProfile } from '../repoConfig.js';

export type DetectedRepo = {
  id: string;
  name: string;
  path: string;
  /** origin's URL, so this repo can be cloned onto another machine. */
  cloneUrl: string | null;
  projectSubdir: string | null;
  startCommand: string;
  defaultPort: number;
  editor: 'code';
  envProfiles: EnvProfile[];
  defaultEnvProfile?: string;
  warnings: string[];
};

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function prettyName(raw: string): string {
  const bare = raw.replace(/^@[^/]+\//, ''); // strip npm scope
  return bare
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** origin's fetch URL, or null when the repo has no remote (purely local). */
export async function readOriginUrl(gitRoot: string): Promise<string | null> {
  try {
    const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: gitRoot, timeoutMs: 5_000 });
    const url = r.stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function pickStartCommand(pkg: PackageJson | null): { command: string; script: string } | null {
  const scripts = pkg?.scripts ?? {};
  if (scripts.dev) return { command: 'npm run dev', script: scripts.dev };
  if (scripts.start) return { command: 'npm start', script: scripts.start };
  if (scripts.serve) return { command: 'npm run serve', script: scripts.serve };
  return null;
}

function detectPort(scriptText: string, pkg: PackageJson | null): number | null {
  const m = /(?:--port|-p)[ =](\d{2,5})/.exec(scriptText) ?? /\bPORT=(\d{2,5})/.exec(scriptText);
  if (m) return Number(m[1]);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps['vite']) return 5173;
  if (deps['next']) return 3000;
  if (deps['react-scripts']) return 3000;
  return null;
}

async function detectEnvProfiles(dir: string): Promise<EnvProfile[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /^\.env(\..+)?$/.test(f) && !/\.(example|sample|template)$/.test(f))
    .sort()
    .map((f) => ({
      name: f === '.env' ? 'DEFAULT' : f.slice('.env.'.length).toUpperCase(),
      envFile: f,
    }));
}

/**
 * Inspect a local directory and derive a ready-to-confirm repo config:
 * git root, worktrees dir convention, start command + port from
 * package.json, env profiles from .env.* files. Warnings flag anything
 * the user must fill in by hand.
 */
export async function detectRepo(inputPath: string): Promise<DetectedRepo> {
  const expanded = inputPath.startsWith('~')
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  const abs = path.resolve(expanded);

  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new AppError('VALIDATION', `${abs} is not a directory`);
  }

  let gitRoot: string;
  try {
    const r = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: abs, timeoutMs: 5_000 });
    gitRoot = r.stdout.trim();
  } catch {
    throw new AppError('VALIDATION', `${abs} is not inside a git repository`);
  }

  const warnings: string[] = [];

  // Prefer the package.json at the git root; fall back to the picked
  // subfolder (monorepo app dir) and record it as projectSubdir.
  let pkgDir = gitRoot;
  let pkg = await readPackageJson(gitRoot);
  let projectSubdir: string | null = null;
  if (!pkg && abs !== gitRoot) {
    const sub = await readPackageJson(abs);
    if (sub) {
      pkg = sub;
      pkgDir = abs;
      projectSubdir = path.relative(gitRoot, abs);
    }
  }

  const start = pickStartCommand(pkg);
  if (!pkg) warnings.push('no package.json found — set the start command manually');
  else if (!start) warnings.push('no dev/start/serve script in package.json — set the start command manually');

  const port = start ? detectPort(start.script, pkg) : null;
  if (start && port === null) warnings.push('could not detect a port — defaulted to 8080');

  const envProfiles = await detectEnvProfiles(pkgDir);
  const base = path.basename(gitRoot);
  // Deliberately not a warning: a repo with no remote is a normal local repo,
  // not a misconfiguration. Callers that need a URL (adding a repo to a
  // runner) surface its absence where it actually matters.
  const cloneUrl = await readOriginUrl(gitRoot);

  return {
    id: slugify(base),
    name: pkg?.name ? prettyName(pkg.name) : prettyName(base),
    path: gitRoot,
    cloneUrl,
    projectSubdir,
    startCommand: start?.command ?? 'npm run dev',
    defaultPort: port ?? 8080,
    editor: 'code',
    envProfiles,
    ...(envProfiles.length > 0 ? { defaultEnvProfile: envProfiles[0]!.name } : {}),
    warnings,
  };
}

/**
 * A repo id that no existing repo is using.
 *
 * The id is derived from the directory name, so `~/work/api` and `~/personal/api`
 * both want `api` — and ids must be unique (the store enforces it, and the id is
 * now a folder name under the shared worktree root). Rather than handing the user
 * a warning and making them invent a replacement, disambiguate by the parent
 * directory, which is both meaningful and stable. Only if that collides too do we
 * fall back to a short hash of the absolute path.
 */
export function uniqueRepoId(preferred: string, repoPath: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  const parent = slugify(path.basename(path.dirname(repoPath)));
  const withParent = parent && parent !== preferred ? `${parent}-${preferred}` : '';
  if (withParent && !taken.has(withParent)) return withParent;
  const hash = createHash('sha256').update(repoPath).digest('hex').slice(0, 4);
  let candidate = `${preferred}-${hash}`;
  // Astronomically unlikely, but a loop beats returning a duplicate.
  let n = 2;
  while (taken.has(candidate)) candidate = `${preferred}-${hash}-${n++}`;
  return candidate;
}
