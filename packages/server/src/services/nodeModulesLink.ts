import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { compareLockfiles } from '../lockfile.js';

export type LinkOptions = {
  sourceProjectDir: string;
  targetProjectDir: string;
  replace: boolean;
};

export type LinkResult = {
  symlink: string;
  source: string;
  warnings: string[];
};

export type NodeModulesLinkService = {
  link(opts: LinkOptions): Promise<LinkResult>;
  unlink(targetProjectDir: string): Promise<void>;
  relink(opts: LinkOptions): Promise<LinkResult>;
};

export function createNodeModulesLinkService(): NodeModulesLinkService {
  const service: NodeModulesLinkService = {
    async link({ sourceProjectDir, targetProjectDir, replace }) {
      const sourceNm = path.join(sourceProjectDir, 'node_modules');
      const targetNm = path.join(targetProjectDir, 'node_modules');

      const sourceStat = await safeStat(sourceNm);
      if (!sourceStat || !sourceStat.isDirectory()) {
        throw new AppError('SOURCE_MISSING', `source node_modules not found: ${sourceNm}`);
      }

      const targetExists = await safeLstat(targetNm);
      if (targetExists) {
        if (!replace) {
          throw new AppError('VALIDATION', `target already has node_modules: ${targetNm}`);
        }
        const backup = `${targetNm}.bak.${Date.now()}`;
        await fsp.rename(targetNm, backup);
      }

      await fsp.symlink(sourceNm, targetNm, 'dir');

      const cmp = await compareLockfiles(
        path.join(sourceProjectDir, 'package-lock.json'),
        path.join(targetProjectDir, 'package-lock.json'),
      );
      const warnings = cmp.equal ? [] : ['LOCKFILE_MISMATCH'];
      return { symlink: targetNm, source: sourceNm, warnings };
    },
    async unlink(targetProjectDir) {
      const targetNm = path.join(targetProjectDir, 'node_modules');
      const lst = await safeLstat(targetNm);
      if (!lst) return;
      if (!lst.isSymbolicLink()) {
        throw new AppError('NOT_SYMLINK', `node_modules is a real directory, refusing to remove: ${targetNm}`);
      }
      await fsp.unlink(targetNm);
    },
    async relink(opts) {
      await service.unlink(opts.targetProjectDir);
      return service.link(opts);
    },
  };
  return service;
}

async function safeStat(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function safeLstat(p: string) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}
