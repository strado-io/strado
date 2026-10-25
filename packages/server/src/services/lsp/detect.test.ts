import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDetect, installOptions } from './detect.js';
import { createLspEnabledStore } from './store.js';
import type { LspServerSpec } from './types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-detect-')));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function exe(dir: string, name: string, mode = 0o755) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), '#!/bin/sh\n', { mode });
  return path.join(dir, name);
}

describe('createDetect', () => {
  it('finds a binary on PATH first, then the common bin dirs, then npm -g bin', async () => {
    const home = path.join(tmp, 'home');
    const onPath = await exe(path.join(tmp, 'p'), 'gopls');
    await exe(path.join(home, 'go', 'bin'), 'gopls');
    const cargo = await exe(path.join(home, '.cargo', 'bin'), 'rust-analyzer');
    const npm = await exe(path.join(tmp, 'npm-prefix', 'bin'), 'pyright-langserver');
    const d = createDetect({ env: { PATH: path.join(tmp, 'p') }, home, npmBin: async () => path.join(tmp, 'npm-prefix', 'bin') });
    expect(await d.which('gopls')).toBe(onPath);
    expect(await d.which('rust-analyzer')).toBe(cargo);
    expect(await d.which('pyright-langserver')).toBe(npm);
    expect(await d.which('nope-ls')).toBeNull();
  });

  it('finds node version managers a dock launch has no PATH for: nvm newest first, volta, fnm, asdf', async () => {
    const home = path.join(tmp, 'home');
    const v18 = await exe(path.join(home, '.nvm', 'versions', 'node', 'v18.20.4', 'bin'), 'typescript-language-server');
    const v22 = await exe(path.join(home, '.nvm', 'versions', 'node', 'v22.22.1', 'bin'), 'typescript-language-server');
    await exe(path.join(home, '.nvm', 'versions', 'node', 'v9.0.0', 'bin'), 'typescript-language-server');
    const volta = await exe(path.join(home, '.volta', 'bin'), 'pyright-langserver');
    const fnm = await exe(path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'), 'zls');
    const asdf = await exe(path.join(home, '.asdf', 'shims'), 'texlab');
    const d = createDetect({ env: { PATH: '' }, home, npmBin: async () => null });
    expect(await d.which('typescript-language-server')).toBe(v22);
    expect(await d.which('pyright-langserver')).toBe(volta);
    expect(await d.which('zls')).toBe(fnm);
    expect(await d.which('texlab')).toBe(asdf);
    // $NVM_BIN (the shell's chosen version) wins over newest.
    const pinned = createDetect({ env: { PATH: '', NVM_BIN: path.dirname(v18) }, home, npmBin: async () => null });
    expect(await pinned.which('typescript-language-server')).toBe(v18);
  });

  it('skips files that are not executable, and relative PATH entries', async () => {
    const home = path.join(tmp, 'home');
    await exe(path.join(tmp, 'p'), 'zls', 0o644);
    await exe(path.join(tmp, 'rel'), 'zls');
    const d = createDetect({ env: { PATH: `${path.join(tmp, 'p')}:rel` }, home, npmBin: async () => null });
    expect(await d.which('zls')).toBeNull();
  });

  it('an absolute argv[0] is checked as is; a relative path never', async () => {
    const bin = await exe(path.join(tmp, 'x'), 'srv');
    const d = createDetect({ env: { PATH: '' }, home: tmp, npmBin: async () => null });
    expect(await d.which(bin)).toBe(bin);
    expect(await d.which('x/srv')).toBeNull();
  });
});

describe('installOptions', () => {
  const spec = {
    id: 'gopls', lang: 'Go', cmd: ['gopls'], extensions: ['.go'],
    install: [
      { command: 'go install x', needs: 'go' },
      { command: 'brew install gopls', os: 'darwin', needs: 'brew' },
      { command: 'apt-get install gopls', os: 'linux', needs: 'apt-get' },
    ],
  } as LspServerSpec;
  const detect = { dirs: async () => [], which: async (n: string) => (n === 'go' ? '/usr/bin/go' : null) };

  it('keeps this OS only, with available = its tool is here', async () => {
    expect(await installOptions(spec, detect, 'linux')).toEqual([
      { command: 'go install x', needs: 'go', available: true },
      { command: 'apt-get install gopls', os: 'linux', needs: 'apt-get', available: false },
    ]);
    expect((await installOptions(spec, detect, 'darwin')).map((i) => i.command)).toEqual(['go install x', 'brew install gopls']);
  });
});

describe('createLspEnabledStore', () => {
  it('everything is on until turned off; survives a new store', async () => {
    const file = path.join(tmp, 'h', 'lsp-servers.json');
    const s = createLspEnabledStore(() => file);
    expect(await s.isEnabled('gopls')).toBe(true);
    await Promise.all([s.setEnabled('gopls', false), s.setEnabled('zls', false)]);
    expect(await createLspEnabledStore(() => file).isEnabled('gopls')).toBe(false);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ disabled: ['gopls', 'zls'] });
    await s.setEnabled('gopls', true);
    expect(await s.isEnabled('gopls')).toBe(true);
    expect(await s.isEnabled('zls')).toBe(false);
  });

  it('an unreadable file means all on', async () => {
    const file = path.join(tmp, 'bad.json');
    await fs.writeFile(file, '{nope');
    expect(await createLspEnabledStore(() => file).isEnabled('clangd')).toBe(true);
  });
});
