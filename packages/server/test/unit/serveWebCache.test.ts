import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliDataDir, pinnedCommit } from '../../src/services/serveWebCache.js';

function home(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cache-')); }
function seed(dataDir: string, lru: string[], dirs: string[] = lru) {
  const root = path.join(dataDir, 'serve-web');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'lru.json'), JSON.stringify(lru));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
}

describe('cliDataDir', () => {
  it('maps each CLI to its data dir under home, honouring VSCODE_CLI_DATA_DIR', () => {
    expect(cliDataDir('code', { home: '/h', env: {} })).toBe('/h/.vscode/cli');
    expect(cliDataDir('code-insiders', { home: '/h', env: {} })).toBe('/h/.vscode-insiders/cli');
    expect(cliDataDir('code', { home: '/h', env: { VSCODE_CLI_DATA_DIR: '/x' } })).toBe('/x');
    expect(cliDataDir('code-server', { home: '/h', env: {} })).toBeNull();
  });
});

describe('pinnedCommit', () => {
  let h: string;
  beforeEach(() => { h = home(); });

  it('returns the most-recently-used cached commit', () => {
    seed(path.join(h, '.vscode-insiders', 'cli'), ['a'.repeat(40), 'b'.repeat(40)]);
    expect(pinnedCommit('code-insiders', { home: h, env: {} })).toBe('a'.repeat(40));
  });

  it('skips lru entries whose build directory is missing (incomplete download)', () => {
    seed(path.join(h, '.vscode', 'cli'), ['a'.repeat(40), 'b'.repeat(40)], ['b'.repeat(40)]);
    expect(pinnedCommit('code', { home: h, env: {} })).toBe('b'.repeat(40));
  });

  it('returns null when nothing is cached, lru is malformed, or the CLI has no cache', () => {
    expect(pinnedCommit('code', { home: h, env: {} })).toBeNull();
    fs.mkdirSync(path.join(h, '.vscode', 'cli', 'serve-web'), { recursive: true });
    fs.writeFileSync(path.join(h, '.vscode', 'cli', 'serve-web', 'lru.json'), '{not json');
    expect(pinnedCommit('code', { home: h, env: {} })).toBeNull();
    expect(pinnedCommit('code-server', { home: h, env: {} })).toBeNull();
  });

  it('rejects entries that are not plain commit shas (no path tricks in --commit-id)', () => {
    seed(path.join(h, '.vscode', 'cli'), ['../evil', 'c'.repeat(40)], ['c'.repeat(40)]);
    expect(pinnedCommit('code', { home: h, env: {} })).toBe('c'.repeat(40));
  });
});
