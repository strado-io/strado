import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { detectSandboxManifest, majorOf } from './detect.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sbx-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe('detectSandboxManifest', () => {
  it('.nvmrc wins for node version', async () => {
    const dir = await repo({
      '.nvmrc': '22\n',
      'package.json': JSON.stringify({ engines: { node: '>=18' } }),
    });
    const m = await detectSandboxManifest(dir);
    expect(m.node).toBe('22');
    expect(m.nodeSource).toBe('.nvmrc');
  });

  it('engines.node is the fallback, major extracted', async () => {
    const dir = await repo({ 'package.json': JSON.stringify({ engines: { node: '>=20.10' } }) });
    const m = await detectSandboxManifest(dir);
    expect(m.node).toBe('20');
    expect(m.nodeSource).toBe('engines');
  });

  it('packageManager field beats lockfile', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
      'yarn.lock': '',
    });
    const m = await detectSandboxManifest(dir);
    expect(m.packageManager).toBe('pnpm');
    expect(m.pmSource).toBe('packageManager');
  });

  it('lockfile detection: pnpm-lock > yarn.lock > package-lock', async () => {
    expect((await detectSandboxManifest(await repo({ 'pnpm-lock.yaml': '' }))).packageManager).toBe('pnpm');
    expect((await detectSandboxManifest(await repo({ 'yarn.lock': '' }))).packageManager).toBe('yarn');
    expect((await detectSandboxManifest(await repo({ 'package-lock.json': '' }))).packageManager).toBe('npm');
  });

  it('lockfile precedence pins order with multiple lockfiles', async () => {
    // All three present: pnpm wins
    const all = await repo({
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
      'package-lock.json': '',
    });
    expect((await detectSandboxManifest(all)).packageManager).toBe('pnpm');

    // yarn + npm (no pnpm): yarn wins
    const yarnNpm = await repo({
      'yarn.lock': '',
      'package-lock.json': '',
    });
    expect((await detectSandboxManifest(yarnNpm)).packageManager).toBe('yarn');
  });

  it('.strado/sandbox.yml overrides everything', async () => {
    const dir = await repo({
      '.nvmrc': '18\n',
      '.strado/sandbox.yml': 'node: "22"\npackageManager: pnpm\n',
    });
    const m = await detectSandboxManifest(dir);
    expect(m.node).toBe('22');
    expect(m.nodeSource).toBe('sandbox.yml');
    expect(m.packageManager).toBe('pnpm');
  });

  it('nothing present yields defaults and says so', async () => {
    const m = await detectSandboxManifest(await repo({}));
    expect(m.node).toBeNull();
    expect(m.packageManager).toBe('npm');
    expect(m.summary).toContain('default');
  });
});

describe('majorOf', () => {
  it('reads a plain major, a v-prefixed version, and a range lower bound', () => {
    expect(majorOf('20')).toBe('20');
    expect(majorOf('v24.1.0')).toBe('24');
    expect(majorOf('>=20.10 <23')).toBe('20');
    expect(majorOf('20.x')).toBe('20');
  });
  it('picks the newest alternative, since one image serves the whole range', () => {
    expect(majorOf('^18 || ^20')).toBe('20');
  });
  it('names no number for lts/* and friends', () => {
    expect(majorOf('lts/*')).toBeNull();
    expect(majorOf('lts/iron')).toBeNull();
    expect(majorOf('node')).toBeNull();
    expect(majorOf('*')).toBeNull();
  });
});

describe('detectSandboxManifest: monorepo root and odd specs', () => {
  it('falls back to the worktree root .nvmrc when the project subdir declares nothing', async () => {
    const root = await repo({ '.nvmrc': '24\n', 'apps/web/package.json': '{"name":"web"}' });
    const m = await detectSandboxManifest(path.join(root, 'apps/web'), root);
    expect(m.node).toBe('24');
    expect(m.nodeSource).toBe('.nvmrc (root)');
  });
  it('the subdir still wins over the root', async () => {
    const root = await repo({ '.nvmrc': '24\n', 'apps/web/.nvmrc': '20\n' });
    const m = await detectSandboxManifest(path.join(root, 'apps/web'), root);
    expect(m.node).toBe('20');
    expect(m.nodeSource).toBe('.nvmrc');
  });
  it('says the .nvmrc exists but names no number, instead of "nothing declared"', async () => {
    const root = await repo({ '.nvmrc': 'lts/*\n' });
    const m = await detectSandboxManifest(root);
    expect(m.node).toBeNull();
    expect(m.summary).toContain('.nvmrc says lts/*, using default');
  });
  it('clamps a major below the oldest buildable image and says so', async () => {
    const root = await repo({ '.nvmrc': '14\n' });
    const m = await detectSandboxManifest(root);
    expect(m.node).toBe('18');
    expect(m.summary).toContain('asked for 14; image supports 18+');
  });
});
