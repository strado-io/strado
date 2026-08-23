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

const majorOf = (spec: string): string | null =>
  spec.match(/(\d+)/)?.[1] ?? null;

export async function detectSandboxManifest(worktreePath: string): Promise<SandboxManifest> {
  let node: string | null = null;
  let nodeSource: string | null = null;
  let packageManager: SandboxManifest['packageManager'] = 'npm';
  let pmSource = 'default';

  const pkgRaw = await readIf(path.join(worktreePath, 'package.json'));
  const pkg = pkgRaw ? (() => { try { return JSON.parse(pkgRaw); } catch { return {}; } })() : {};

  const nvmrc = await readIf(path.join(worktreePath, '.nvmrc'));
  if (nvmrc?.trim()) { node = majorOf(nvmrc.trim()); nodeSource = '.nvmrc'; }
  else if (typeof pkg?.engines?.node === 'string') { node = majorOf(pkg.engines.node); nodeSource = 'engines'; }

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

  const parts = [
    node ? `node ${node} (${nodeSource})` : 'node default (nothing declared)',
    `${packageManager} (${pmSource})`,
  ];
  return { node, nodeSource, packageManager, pmSource, summary: parts.join(' · ') };
}
