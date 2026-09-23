import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStradoExtension, stradoExtensionSource } from '../../src/services/vscodeExtensionInstall.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'vsx-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('installStradoExtension', () => {
  it('copies the bundled extension into the serve-web extensions dir, versioned like VS Code does', () => {
    const dest = installStradoExtension('code-insiders', { home });
    const pkg = JSON.parse(fs.readFileSync(path.join(stradoExtensionSource(), 'package.json'), 'utf8'));
    expect(dest).toBe(path.join(home, '.vscode-server-insiders', 'extensions', `strado.strado-window-${pkg.version}`));
    expect(fs.existsSync(path.join(dest!, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest!, 'extension.js'))).toBe(true);
    // Runs in the server's extension host (where process.pid is the window's
    // host), never in the browser's web worker.
    expect(pkg.extensionKind).toEqual(['workspace']);
    expect(pkg.main).toBe('./extension.js');
  });

  it('removes older copies so an upgrade does not leave two versions active', () => {
    const extDir = path.join(home, '.vscode-server', 'extensions');
    fs.mkdirSync(path.join(extDir, 'strado.strado-window-0.0.1'), { recursive: true });
    fs.mkdirSync(path.join(extDir, 'someone.else-1.0.0'), { recursive: true });
    installStradoExtension('code', { home });
    const dirs = fs.readdirSync(extDir).sort();
    expect(dirs.filter((d) => d.startsWith('strado.strado-window-'))).toHaveLength(1);
    expect(dirs).toContain('someone.else-1.0.0');
  });

  it('is a no-op for code-server (different layout) and never throws', () => {
    expect(installStradoExtension('code-server', { home })).toBeNull();
    expect(() => installStradoExtension('code', { home: '/dev/null/nope' })).not.toThrow();
  });
});
