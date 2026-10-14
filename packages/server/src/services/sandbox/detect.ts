import fsp from 'node:fs/promises';
import path from 'node:path';

export type SandboxManifest = {
  node: string | null;
  nodeSource: string | null;
  packageManager: 'pnpm' | 'yarn' | 'npm';
  pmSource: string;
  summary: string;
};

async function readIf(p: string): Promise<string | null> {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}
async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Minimal `key: "value"` / `key: value` reader — sandbox.yml is flat in
 * Phase 1, and a YAML dependency for two keys is not worth it. */
function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*"?([^"#]*?)"?\s*(#.*)?$/);
    const key = m?.[1];
    const value = m?.[2];
    if (key && value) out[key] = value.trim();
  }
  return out;
}

/** The oldest major the sandbox image can be built for: node:<major>-bookworm
 * exists from 18 up. A repo pinned lower gets this, and the summary says so. */
export const MIN_NODE_MAJOR = 18;

/**
 * The node major a version spec asks for, or null when it names no number
 * (`lts/*`, `node`, `latest`). A range picks its lower bound (`>=20 <23` is
 * 20); alternatives pick the newest (`^18 || ^20` is 20 — one image has to
 * serve the whole range, and the newest satisfies the most of it).
 */
export const majorOf = (spec: string): string | null => {
  const s = spec.trim();
  if (!s || /^(lts|node|latest|\*|stable|current)/i.test(s)) return null;
  const majors = s
    .split('||')
    .map((alt) => alt.match(/(\d+)/)?.[1])
    .filter((m): m is string => m !== undefined)
    .map(Number);
  if (majors.length === 0) return null;
  return String(Math.max(...majors));
};

export async function detectSandboxManifest(
  worktreePath: string,
  /** The worktree root, when `worktreePath` is a monorepo's project subdir:
   * a root `.nvmrc` / engines applies to every package under it. */
  rootPath?: string,
): Promise<SandboxManifest> {
  let node: string | null = null;
  let nodeSource: string | null = null;
  let packageManager: SandboxManifest['packageManager'] = 'npm';
  let pmSource = 'default';

  const readPkg = async (dir: string) => {
    const raw = await readIf(path.join(dir, 'package.json'));
    return raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
  };
  const pkg = await readPkg(worktreePath);

  // Nearest declaration wins: the project dir first, then the worktree root.
  const dirs: { dir: string; label: string }[] = [{ dir: worktreePath, label: '' }];
  if (rootPath && path.resolve(rootPath) !== path.resolve(worktreePath)) dirs.push({ dir: rootPath, label: ' (root)' });
  for (const { dir, label } of dirs) {
    const nvmrc = await readIf(path.join(dir, '.nvmrc'));
    if (nvmrc?.trim()) {
      node = majorOf(nvmrc);
      nodeSource = node ? `.nvmrc${label}` : `.nvmrc${label} says ${nvmrc.trim()}, using default`;
      break;
    }
    const engines = (dir === worktreePath ? pkg : await readPkg(dir))?.engines?.node;
    if (typeof engines === 'string') {
      node = majorOf(engines);
      nodeSource = node ? `engines${label}` : `engines${label} say ${engines}, using default`;
      break;
    }
  }

  if (typeof pkg?.packageManager === 'string') {
    const pm = pkg.packageManager.split('@')[0];
    if (pm === 'pnpm' || pm === 'yarn' || pm === 'npm') { packageManager = pm; pmSource = 'packageManager'; }
  } else if (await exists(path.join(worktreePath, 'pnpm-lock.yaml'))) { packageManager = 'pnpm'; pmSource = 'lockfile'; }
  else if (await exists(path.join(worktreePath, 'yarn.lock'))) { packageManager = 'yarn'; pmSource = 'lockfile'; }
  else if (await exists(path.join(worktreePath, 'package-lock.json'))) { packageManager = 'npm'; pmSource = 'lockfile'; }

  const override = await readIf(path.join(worktreePath, '.strado', 'sandbox.yml'));
  if (override) {
    const y = parseFlatYaml(override);
    if (y.node) { node = majorOf(y.node); nodeSource = 'sandbox.yml'; }
    if (y.packageManager === 'pnpm' || y.packageManager === 'yarn' || y.packageManager === 'npm') {
      packageManager = y.packageManager; pmSource = 'sandbox.yml';
    }
  }

  // Below the oldest image we can build: say what was asked and what it gets.
  if (node && Number(node) < MIN_NODE_MAJOR) {
    nodeSource = `${nodeSource} asked for ${node}; image supports ${MIN_NODE_MAJOR}+`;
    node = String(MIN_NODE_MAJOR);
  }

  const parts = [
    node ? `node ${node} (${nodeSource})` : `node default (${nodeSource ?? 'nothing declared'})`,
    `${packageManager} (${pmSource})`,
  ];
  return { node, nodeSource, packageManager, pmSource, summary: parts.join(' · ') };
}
