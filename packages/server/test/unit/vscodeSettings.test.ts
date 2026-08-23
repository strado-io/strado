import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverSettingsPath, ensureTsServerMemory } from '../../src/services/vscodeSettings.js';

function home(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-home-')); }
function readSettings(cli: string, h: string) {
  return JSON.parse(fs.readFileSync(serverSettingsPath(cli, h)!, 'utf8'));
}

describe('serverSettingsPath', () => {
  it('maps code-insiders and code, and rejects others', () => {
    expect(serverSettingsPath('code-insiders', '/h')).toBe('/h/.vscode-server-insiders/data/Machine/settings.json');
    expect(serverSettingsPath('code', '/h')).toBe('/h/.vscode-server/data/Machine/settings.json');
    expect(serverSettingsPath('code-server', '/h')).toBeNull();
  });
});

describe('ensureTsServerMemory', () => {
  let h: string;
  beforeEach(() => { h = home(); });

  it('creates the file with the key when absent', () => {
    ensureTsServerMemory('code-insiders', { home: h, mb: 4096 });
    expect(readSettings('code-insiders', h)['typescript.tsserver.maxTsServerMemory']).toBe(4096);
  });

  it('preserves an existing user value', () => {
    const p = serverSettingsPath('code-insiders', h)!;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ 'typescript.tsserver.maxTsServerMemory': 8192, 'editor.fontSize': 15 }));
    ensureTsServerMemory('code-insiders', { home: h, mb: 4096 });
    const s = readSettings('code-insiders', h);
    expect(s['typescript.tsserver.maxTsServerMemory']).toBe(8192);
    expect(s['editor.fontSize']).toBe(15);
  });

  it('is a no-op for an unsupported cli', () => {
    expect(() => ensureTsServerMemory('code-server', { home: h })).not.toThrow();
  });
});
