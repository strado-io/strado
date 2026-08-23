import fsp from 'node:fs/promises';
import path from 'node:path';

export type NodeModulesStatus =
  | { status: 'symlink'; source: string }
  | { status: 'directory' }
  | { status: 'missing' };

export async function detectNodeModules(
  worktreePath: string,
  projectSubdir: string | null,
): Promise<NodeModulesStatus> {
  const projectDir = projectSubdir ? path.join(worktreePath, projectSubdir) : worktreePath;
  const nmPath = path.join(projectDir, 'node_modules');
  try {
    const lst = await fsp.lstat(nmPath);
    if (lst.isSymbolicLink()) {
      try {
        const target = await fsp.readlink(nmPath);
        return { status: 'symlink', source: target };
      } catch {
        return { status: 'symlink', source: '' };
      }
    }
    if (lst.isDirectory()) {
      return { status: 'directory' };
    }
    return { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
}
