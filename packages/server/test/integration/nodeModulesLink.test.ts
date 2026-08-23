import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeModulesLinkService } from '../../src/services/nodeModulesLink';

let tmp: string;
let source: string;
let target: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'link-'));
  source = path.join(tmp, 'source');
  target = path.join(tmp, 'target');
  await fs.mkdir(path.join(source, 'node_modules', 'lodash'), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"src"}');
  await fs.writeFile(path.join(source, 'package-lock.json'), '{"v":1}');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'package.json'), '{"name":"tgt"}');
  await fs.writeFile(path.join(target, 'package-lock.json'), '{"v":1}');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('node modules link', () => {
  it('creates symlink from target to source node_modules', async () => {
    const svc = createNodeModulesLinkService();
    const result = await svc.link({ sourceProjectDir: source, targetProjectDir: target, replace: false });
    expect(result.warnings).toEqual([]);
    const linkPath = path.join(target, 'node_modules');
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linkPath)).toBe(path.join(source, 'node_modules'));
  });

  it('warns when lockfiles differ but still links', async () => {
    await fs.writeFile(path.join(target, 'package-lock.json'), '{"v":2}');
    const svc = createNodeModulesLinkService();
    const result = await svc.link({ sourceProjectDir: source, targetProjectDir: target, replace: false });
    expect(result.warnings).toContain('LOCKFILE_MISMATCH');
  });

  it('refuses to overwrite existing node_modules without replace', async () => {
    await fs.mkdir(path.join(target, 'node_modules'));
    const svc = createNodeModulesLinkService();
    await expect(
      svc.link({ sourceProjectDir: source, targetProjectDir: target, replace: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('renames existing node_modules to .bak when replace=true', async () => {
    await fs.mkdir(path.join(target, 'node_modules'));
    const svc = createNodeModulesLinkService();
    await svc.link({ sourceProjectDir: source, targetProjectDir: target, replace: true });
    const entries = await fs.readdir(target);
    expect(entries.some((e) => e.startsWith('node_modules.bak.'))).toBe(true);
  });

  it('unlinks only symlinks', async () => {
    const svc = createNodeModulesLinkService();
    await svc.link({ sourceProjectDir: source, targetProjectDir: target, replace: false });
    await svc.unlink(target);
    expect(await fs.readdir(target)).not.toContain('node_modules');
  });

  it('refuses to unlink a real directory', async () => {
    await fs.mkdir(path.join(target, 'node_modules'));
    const svc = createNodeModulesLinkService();
    await expect(svc.unlink(target)).rejects.toMatchObject({ code: 'NOT_SYMLINK' });
  });

  it('errors when source node_modules missing', async () => {
    await fs.rm(path.join(source, 'node_modules'), { recursive: true });
    const svc = createNodeModulesLinkService();
    await expect(
      svc.link({ sourceProjectDir: source, targetProjectDir: target, replace: false }),
    ).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
  });
});
